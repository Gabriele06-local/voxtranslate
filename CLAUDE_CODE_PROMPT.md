# VoxTranslate — Claude Code Build Prompt (Plan → Execute)

## Context

Build **VoxTranslate**, a real-time voice translation webapp.
Target latency: **< 800ms end-to-end** (speaker talks → listener hears translation).

Stack:
- **Backend**: Rust (Axum 0.8 + Tokio) — WebSocket relay + API orchestration
- **Frontend**: Astro 5 — vanilla JS islands, zero framework deps
- **STT**: Deepgram Nova-2 streaming via WebSocket (real-time interim + final transcripts)
- **Translation**: Groq Llama 3.1 8B Instant (`llama-3.1-8b-instant`)
- **TTS**: Browser `SpeechSynthesis` API (zero cost, client-side)
- **Audio codec**: Opus via WebM container, 32kbps mono, chunked every 250ms

## Architecture — Data Flow

```
Browser A (Speaker)
│
├─ navigator.mediaDevices.getUserMedia (mono, 16kHz, noise suppression)
├─ MediaRecorder (audio/webm;codecs=opus, 32kbps)
├─ ondataavailable every 250ms
│
└─► WebSocket (binary frames) ──────────────────────────►┐
                                                          │
                                            ┌─────────────▼──────────────────┐
                                            │        AXUM SERVER              │
                                            │                                 │
                                            │  1. Receive binary audio chunk  │
                                            │     from speaker WS             │
                                            │                                 │
                                            │  2. Pipe raw bytes to           │
                                            │     Deepgram WS connection      │
                                            │     (persistent, per-speaker)   │
                                            │                                 │
                                            │  3. Deepgram sends back:        │
                                            │     - interim transcripts       │
                                            │       (partial, low confidence) │
                                            │     - final transcripts         │
                                            │       (sentence complete)       │
                                            │                                 │
                                            │  4. On FINAL transcript:        │
                                            │     a) Broadcast original text  │
                                            │        to room listeners        │
                                            │     b) Spawn async task:        │
                                            │        Groq Llama translate     │
                                            │     c) Broadcast translated     │
                                            │        text to room listeners   │
                                            │                                 │
                                            │  5. On INTERIM transcript:      │
                                            │     Broadcast as "interim" type │
                                            │     (UI shows gray preview)     │
                                            │                                 │
                                            └──────────────┬─────────────────┘
                                                           │
◄──── WebSocket (JSON text frames) ◄───────────────────────┘
│
Browser B (Listener)
├─ Display interim transcript (gray, updating in-place)
├─ Display final transcript (original language)
├─ Display translated text (target language, highlighted)
└─ SpeechSynthesis.speak(translatedText) — auto TTS
```

## Latency Budget

| Step | Target |
|------|--------|
| MediaRecorder chunk interval | 250ms |
| WebSocket upload (browser→server) | ~15ms |
| Server→Deepgram WS pipe | ~5ms |
| Deepgram Nova-2 streaming final | ~300ms from speech end |
| Groq Llama 3.1 8B translate | ~120ms (single sentence) |
| Server→Listener WS | ~10ms |
| Browser TTS init | ~30ms |
| **Total from speech-end to TTS** | **~480ms** |

The 250ms chunk interval is just transport granularity. Deepgram processes audio as it arrives, so there's NO buffering on our side. The real latency is from when the speaker finishes a phrase to when the listener hears TTS.

## Project Structure

```
voxtranslate/
├── server/
│   ├── Cargo.toml
│   ├── .env.example          # DEEPGRAM_API_KEY, GROQ_API_KEY
│   └── src/
│       ├── main.rs            # Axum router, WS upgrade handler
│       ├── config.rs          # Env config struct (dotenvy)
│       ├── rooms.rs           # DashMap<RoomId, Vec<ListenerTx>>
│       ├── deepgram.rs        # Persistent WS client to Deepgram
│       ├── groq.rs            # Groq chat completion (translate)
│       └── protocol.rs        # Shared message types (serde)
├── client/
│   ├── package.json
│   ├── astro.config.mjs
│   └── src/
│       ├── layouts/
│       │   └── Base.astro
│       └── pages/
│           └── index.astro    # Full SPA: setup + session screens
├── .env.example
├── docker-compose.yml         # Dev: server + client
├── Dockerfile.server          # Multi-stage Rust build
└── README.md
```

## Implementation Details — Server (Rust)

### Cargo.toml dependencies

```toml
[dependencies]
axum = { version = "0.8", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = { version = "0.24", features = ["native-tls"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }
futures = "0.3"
dashmap = "6"
uuid = { version = "1", features = ["v4"] }
tower-http = { version = "0.6", features = ["cors", "trace"] }
tracing = "0.1"
tracing-subscriber = "0.3"
dotenvy = "0.15"
url = "2"
```

### config.rs

Simple struct loading `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `PORT` (default 3001) from env via dotenvy.

### protocol.rs

Define these message types for client↔server communication:

```rust
// Server → Listener messages (JSON over WS text frames)
enum ServerMessage {
    Interim { text: String, lang: String },
    Transcript { text: String, lang: String },
    Translation { original: String, translated: String, source_lang: String, target_lang: String },
    Error { message: String },
}
```

### rooms.rs

- `RoomManager` with `DashMap<String, Vec<mpsc::UnboundedSender<String>>>`
- `join(room_id, sender)` — adds listener
- `broadcast(room_id, message)` — sends to all, `.retain()` to prune dead senders
- No persistence needed, rooms are ephemeral

### deepgram.rs — CRITICAL COMPONENT

This is the core innovation. Each speaker gets a **persistent Deepgram WebSocket connection** that stays open for the entire session.

```
Speaker connects → spawn Deepgram WS task
Speaker sends audio chunk → forward to Deepgram WS
Deepgram sends transcript → parse, broadcast to room
Speaker disconnects → close Deepgram WS
```

Deepgram WebSocket endpoint:
```
wss://api.deepgram.com/v1/listen?encoding=opus&container=webm&sample_rate=16000&channels=1&model=nova-2&language={source_lang}&punctuate=true&interim_results=true&utterance_end_ms=1000&vad_events=true&smart_format=true
```

Query params breakdown:
- `encoding=opus&container=webm` — matches our MediaRecorder output
- `model=nova-2` — best accuracy/speed ratio
- `language={source_lang}` — from room config (it, en, es, etc.)
- `punctuate=true` — adds punctuation for better translation
- `interim_results=true` — get partial transcripts as user speaks
- `utterance_end_ms=1000` — detect end-of-utterance after 1s silence
- `vad_events=true` — voice activity detection events
- `smart_format=true` — format numbers, dates, etc.

Auth: `Authorization: Token {DEEPGRAM_API_KEY}` header on WS handshake.

**Implementation approach:**
1. Use `tokio_tungstenite::connect_async` with auth header to open Deepgram WS
2. Split into sink (send audio) and stream (receive transcripts)
3. Create an `mpsc::unbounded_channel<Vec<u8>>` for the speaker to feed audio chunks
4. Spawn two tasks:
   - **Audio forwarder**: reads from channel, writes binary frames to Deepgram sink
   - **Transcript receiver**: reads from Deepgram stream, parses JSON responses
5. On Deepgram response:
   - If `is_final == false` → broadcast as `ServerMessage::Interim`
   - If `is_final == true` → broadcast as `ServerMessage::Transcript` + spawn translation task
   - If `type == "UtteranceEnd"` → (optional) signal UI to commit current interim

**Deepgram response JSON structure:**
```json
{
  "type": "Results",
  "channel_index": [0, 1],
  "duration": 1.5,
  "start": 0.0,
  "is_final": true,
  "channel": {
    "alternatives": [{
      "transcript": "ciao come stai",
      "confidence": 0.98,
      "words": [...]
    }]
  }
}
```

Parse only: `type`, `is_final`, `channel.alternatives[0].transcript`, `channel.alternatives[0].confidence`. Ignore transcripts with confidence < 0.4 or empty text.

### groq.rs

Groq chat completion for translation. Non-streaming (single sentence = fast enough, ~120ms).

Endpoint: `POST https://api.groq.com/openai/v1/chat/completions`
Auth: `Bearer {GROQ_API_KEY}`

```json
{
  "model": "llama-3.1-8b-instant",
  "messages": [
    {
      "role": "system",
      "content": "You are a real-time speech translator. Translate from {source_lang} to {target_lang}. Output ONLY the translation. No quotes, no explanation, no preamble. Preserve tone, register, and speech patterns. Handle informal/spoken language naturally. If text is already in target language, return it unchanged."
    },
    { "role": "user", "content": "{transcript}" }
  ],
  "temperature": 0.2,
  "max_tokens": 256
}
```

Use `reqwest` client with connection pooling (keep-alive). Temperature 0.2 for consistency.

### main.rs — WebSocket Handler

WebSocket upgrade route: `GET /ws?room={id}&role={speaker|listener}&source_lang={code}&target_lang={code}`

**Speaker flow:**
1. Accept WS upgrade
2. Open Deepgram WS connection (pass source_lang)
3. Spawn Deepgram audio forwarder + transcript receiver tasks
4. On transcript receiver:
   - Interim → `rooms.broadcast(room, ServerMessage::Interim)`
   - Final → `rooms.broadcast(room, ServerMessage::Transcript)` then spawn:
     - `groq.translate(text, source, target)` → `rooms.broadcast(room, ServerMessage::Translation)`
5. Main loop: read binary frames from speaker WS → send to Deepgram audio channel
6. On speaker disconnect: close Deepgram WS, clean up

**Listener flow:**
1. Accept WS upgrade
2. Create `mpsc::unbounded_channel`, register sender in room
3. Forward all received messages from channel to WS as text frames
4. On disconnect: sender is dropped, cleaned up on next broadcast

**IMPORTANT concurrency pattern:**
```rust
// Speaker handler pseudocode
async fn handle_speaker(ws, room_id, source_lang, target_lang, state) {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (dg_audio_tx, dg_audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // Open Deepgram connection
    let (dg_sink, dg_stream) = open_deepgram_ws(source_lang, &state.config).await?;

    // Task 1: Pipe audio from channel to Deepgram
    let audio_task = tokio::spawn(async move {
        forward_audio(dg_audio_rx, dg_sink).await;
    });

    // Task 2: Receive Deepgram transcripts, broadcast + translate
    let rooms = state.rooms.clone();
    let groq = state.groq.clone();
    let transcript_task = tokio::spawn(async move {
        process_transcripts(dg_stream, rooms, groq, room_id, source_lang, target_lang).await;
    });

    // Main loop: browser audio → Deepgram channel
    while let Some(Ok(Message::Binary(data))) = ws_rx.next().await {
        let _ = dg_audio_tx.send(data.to_vec());
    }

    // Cleanup
    drop(dg_audio_tx); // signals audio_task to end
    audio_task.abort();
    transcript_task.abort();
}
```

## Implementation Details — Client (Astro)

### UI Screens

**Screen 1: Setup**
- Room code input (auto-generated random, copyable)
- Role toggle: Speaker / Listener (big toggle buttons)
- Language selectors: From → To (IT, EN, ES, FR, DE, PT, JA, ZH)
- Connect button
- Dark theme, minimal, clean

**Screen 2: Session (Speaker)**
- Header: room badge + language pair + disconnect button
- **Big circular mic button** — push-to-talk OR toggle mode
- Recording state: pulsing red ring animation
- Live transcript log below (scrollable):
  - Gray: interim text (updates in-place, replaces previous interim)
  - White: finalized original text
  - Blue accent: translated text

**Screen 2: Session (Listener)**
- Header: same as speaker
- Auto-TTS toggle + voice selector dropdown
- Message log:
  - Interim text shown in gray italic (replaced on each update)
  - Final transcript in muted color
  - Translation in accent color, larger font weight
- Each translation auto-spoken via SpeechSynthesis (if enabled)

### Audio Capture — Key Details

```javascript
// Request mic with specific constraints for Deepgram compatibility
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
});

// MediaRecorder with Opus
const recorder = new MediaRecorder(stream, {
  mimeType: 'audio/webm;codecs=opus',
  audioBitsPerSecond: 32000,
});

// Chunk every 250ms, send as binary over WS
recorder.ondataavailable = (e) => {
  if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(e.data); // binary frame
  }
};

recorder.start(250); // 250ms timeslice
```

IMPORTANT: The WebSocket must use `binaryType = 'arraybuffer'` only for receiving if needed. Sending Blob (from ondataavailable) is fine — the browser handles it.

### Interim Transcript UI Pattern

```javascript
let interimElement = null;

function handleMessage(data) {
  switch (data.type) {
    case 'interim':
      // Replace existing interim element (don't stack them)
      if (!interimElement) {
        interimElement = document.createElement('div');
        interimElement.className = 'msg msg-interim';
        log.appendChild(interimElement);
      }
      interimElement.textContent = data.text;
      break;

    case 'transcript':
      // Commit interim → final
      if (interimElement) {
        interimElement.remove();
        interimElement = null;
      }
      appendMessage('msg-original', data.text);
      break;

    case 'translation':
      appendMessage('msg-translated', data.translated);
      if (autoTtsEnabled) speak(data.translated, data.target_lang);
      break;
  }
}
```

### TTS — SpeechSynthesis

```javascript
function speak(text, lang) {
  // Cancel any ongoing speech to prevent queue buildup
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();

  // Try user-selected voice first, then match by language
  const selectedVoice = voices[selectedVoiceIndex];
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  } else {
    const match = voices.find(v => v.lang.startsWith(lang));
    if (match) utterance.voice = match;
  }

  utterance.rate = 1.1; // Slightly faster for real-time feel
  speechSynthesis.speak(utterance);
}
```

### WebSocket Connection

```javascript
// Production-ready WS URL resolution
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = import.meta.env.PUBLIC_WS_HOST || location.host;
const WS_BASE = `${wsProtocol}//${wsHost}`;

// Connect with params
const params = new URLSearchParams({ room, role, source_lang, target_lang });
const ws = new WebSocket(`${WS_BASE}/ws?${params}`);

// Auto-reconnect on unexpected close
ws.onclose = (e) => {
  if (e.code !== 1000) { // not clean close
    setTimeout(() => reconnect(), 2000);
  }
};
```

## Visual Design

- **Background**: `#0c0e14` (deep dark)
- **Surface**: `#161923` (cards, inputs)
- **Border**: `#252836`
- **Text**: `#e2e4ec`
- **Text muted**: `#6b7089`
- **Accent (blue)**: `#3b82f6` — translations, active states
- **Recording (red)**: `#ef4444` — mic active, pulse animation
- **Success (green)**: `#22c55e` — connection status
- **Radius**: 12px cards, 50% for mic button
- **Font**: system-ui stack

The mic button is the centerpiece: 140×140px circle, animating pulse ring on recording. Everything else is minimal and functional.

## Deployment

### Docker (server)

Multi-stage build:
1. `rust:1.80-slim-bookworm` builder
2. `debian:bookworm-slim` runtime
3. Copy binary, expose port 3001

### docker-compose.yml (dev)

```yaml
services:
  server:
    build:
      context: ./server
      dockerfile: ../Dockerfile.server
    ports:
      - "3001:3001"
    env_file: ./server/.env
  client:
    build:
      context: ./client
    ports:
      - "4321:4321"
    environment:
      - PUBLIC_WS_HOST=localhost:3001
```

### Production

- **Server**: Railway or Fly.io (supports WebSocket, Rust binary)
- **Client**: `astro build` → Vercel or Cloudflare Pages
- Set `PUBLIC_WS_HOST` to server domain

## .env.example

```
DEEPGRAM_API_KEY=your_deepgram_key_here
GROQ_API_KEY=gsk_your_groq_key_here
PORT=3001
```

## Constraints & Edge Cases

1. **Deepgram WS keepalive**: Send a `{"type": "KeepAlive"}` JSON message every 8 seconds if no audio is flowing, to prevent Deepgram from closing the connection after 10s of silence.
2. **Deepgram close protocol**: When speaker stops, send a `{"type": "CloseStream"}` message to Deepgram to flush final transcripts, then close the WS.
3. **Empty transcripts**: Deepgram may return empty alternatives on silence. Filter these out.
4. **Rate limiting**: Groq has rate limits. Handle 429 responses with exponential backoff.
5. **Browser TTS queue**: Always call `speechSynthesis.cancel()` before `.speak()` to prevent overlapping audio from translations arriving faster than TTS can play them.
6. **Mobile Safari**: `getUserMedia` may require HTTPS. Plan for this in dev (use `localhost` which is exempt).
7. **WebSocket binary**: Speaker sends binary (audio), listener receives text (JSON). Don't mix.
8. **Room cleanup**: When last listener disconnects, the room entry in DashMap should be cleaned. Use `retain()` during broadcast and periodic cleanup task.
9. **CORS**: Axum needs `CorsLayer::permissive()` for dev. Lock down in production.
10. **Graceful shutdown**: Handle SIGTERM — close all Deepgram WS connections, drain rooms.

## Execution Order

1. `cargo init` the server, add dependencies
2. Implement `config.rs` + `protocol.rs` (types first)
3. Implement `rooms.rs` (simple, testable)
4. Implement `groq.rs` (test with curl first)
5. Implement `deepgram.rs` (the hard part — test WS connection independently)
6. Wire up `main.rs` — speaker and listener handlers
7. Test server with `websocat` or a simple script before touching frontend
8. Scaffold Astro client
9. Build setup screen (static, no WS yet)
10. Add WebSocket connection + audio capture
11. Add message display + TTS
12. Add interim transcript UI
13. Test end-to-end with two browser tabs
14. Dockerize
15. Write README

## Testing Commands

```bash
# Test Deepgram connection manually
# (send a pre-recorded webm file)
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -c:a opus -b:a 32k test.webm

# Test Groq translation
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"system","content":"Translate from Italian to English. Output ONLY the translation."},{"role":"user","content":"ciao come stai"}],"temperature":0.2}'
```
