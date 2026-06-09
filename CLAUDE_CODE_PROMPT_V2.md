# VoxTranslate — Feature: Video Call P2P + Translated Chat

## Context

VoxTranslate already has a working audio-only real-time translation pipeline:
- Axum WebSocket server with room management
- Deepgram streaming STT per speaker
- Groq Llama 3.1 8B Instant translation
- Astro frontend with audio capture + subtitle display + TTS

This prompt adds **P2P video calling via WebRTC** (max 4 participants) and **auto-translated text chat** on top of the existing codebase.

## What Changes

### Server-side additions

1. **WebRTC signaling relay** — new message types in the WS handler for offer/answer/ICE candidate relay between peers. Pure passthrough, zero SDP processing.

2. **Room model upgrade** — each peer now has `user_name` and `lang` stored in the room. Rooms enforce max 4 peers. On join, server sends full peer list so the new peer can establish WebRTC connections with everyone.

3. **Chat translation** — when a peer sends a `{ type: "chat", text: "..." }` message, the server uses the existing `translator`/`groq` module to translate the text to all unique target languages in the room, then broadcasts the message with a `translations: Record<string, string>` map.

4. **Peer state broadcasts** — mute/unmute audio and camera on/off are broadcast to all peers so the UI can update indicators.

### Client-side additions

1. **WebRTC mesh manager** — manages `RTCPeerConnection` per remote peer. Full mesh topology: each peer connects to every other peer directly. Max 4 peers = max 6 connections.

2. **Dual audio path** — the local mic track feeds TWO consumers simultaneously:
   - **WebRTC**: added to all peer connections (remote peers hear you in real-time, P2P)
   - **MediaRecorder**: captures the same track, sends opus/webm chunks to server via WS binary frames for Deepgram STT (existing flow, unchanged)
   This works because MediaStream tracks support multiple consumers natively.

3. **Video grid UI** — responsive grid that adapts to peer count (1→centered, 2→side by side, 3→2+1, 4→2×2). Each cell has video element + name/lang badge + subtitle overlay area.

4. **Translated chat panel** — sidebar on desktop, bottom-sheet drawer on mobile. Messages show translation in viewer's language with original text small below.

5. **Setup screen upgrade** — add camera preview, device selectors (camera/mic dropdowns), name input.

6. **Control bar** — mic mute, camera toggle, TTS toggle, chat toggle (with unread badge), leave button. Glassmorphism style.

## New Protocol Messages

Add these to the existing WebSocket protocol:

### Client → Server (new)

```json
// WebRTC signaling
{ "type": "offer", "to": "peer_id", "sdp": "..." }
{ "type": "answer", "to": "peer_id", "sdp": "..." }
{ "type": "ice", "to": "peer_id", "candidate": { RTCIceCandidateInit } }

// Chat
{ "type": "chat", "text": "ciao a tutti" }

// State
{ "type": "mute_audio", "muted": true }
{ "type": "mute_video", "muted": true }
```

### Server → Client (new)

```json
// Room lifecycle
{ "type": "room_joined", "peer_id": "your_id", "peers": [{ "id": "...", "user_name": "...", "lang": "..." }] }
{ "type": "peer_joined", "peer_id": "...", "user_name": "...", "lang": "..." }
{ "type": "peer_left", "peer_id": "..." }
{ "type": "room_full" }

// Signaling relay (server adds "from" field)
{ "type": "offer", "from": "peer_id", "sdp": "..." }
{ "type": "answer", "from": "peer_id", "sdp": "..." }
{ "type": "ice", "from": "peer_id", "candidate": { ... } }

// Chat (translated)
{ "type": "chat_message", "sender_id": "...", "sender_name": "...", "sender_lang": "it",
  "original": "ciao a tutti",
  "translations": { "en": "hello everyone", "es": "hola a todos" },
  "timestamp": 1718000000 }

// Peer state
{ "type": "peer_muted", "peer_id": "...", "kind": "audio|video", "muted": true }
```

### Existing messages (unchanged)

Audio binary frames (speaker → server), `subtitle_interim`, `subtitle_final` — these stay exactly as they are.

**Update subtitle_final** to include a `translations` map instead of a single translated string, so each peer can pick their own language:
```json
{ "type": "subtitle_final", "speaker_id": "...", "speaker_name": "...",
  "original": "ciao come stai", "lang": "it",
  "translations": { "it": "ciao come stai", "en": "hi how are you", "es": "hola cómo estás" } }
```

This means the translation step now uses a **fan-out**: for each final transcript, translate in parallel to all unique target languages in the room. Use `tokio::spawn` per language, collect results into a HashMap.

## Server Implementation Guide

### 1. Update rooms.rs

Add to the `Peer` struct:
```rust
struct Peer {
    id: String,
    user_name: String,     // NEW
    lang: String,          // NEW
    tx: mpsc::UnboundedSender<String>,
    audio_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
}
```

Add to `RoomManager`:
```rust
fn join(&self, room_id: &str, peer: Peer) -> Result<Vec<PeerInfo>, RoomError>
// Returns Err if room has 4 peers already. Returns Ok with list of existing peers.

fn get_room_languages(&self, room_id: &str, exclude_peer_id: &str) -> Vec<String>
// Returns deduplicated list of languages in room, excluding the given peer.
// Used by translation fan-out to know which languages to translate to.

fn relay_to_peer(&self, room_id: &str, target_peer_id: &str, message: &str) -> bool
// Send a message to a specific peer. Used for signaling relay.
```

### 2. Add signaling relay to ws_handler.rs

In the main message dispatch loop, handle the new message types:
```rust
ClientMessage::Offer { to, sdp } => {
    let msg = json!({ "type": "offer", "from": peer_id, "sdp": sdp }).to_string();
    state.rooms.relay_to_peer(&room_id, &to, &msg);
}
ClientMessage::Answer { to, sdp } => {
    let msg = json!({ "type": "answer", "from": peer_id, "sdp": sdp }).to_string();
    state.rooms.relay_to_peer(&room_id, &to, &msg);
}
ClientMessage::Ice { to, candidate } => {
    let msg = json!({ "type": "ice", "from": peer_id, "candidate": candidate }).to_string();
    state.rooms.relay_to_peer(&room_id, &to, &msg);
}
```

### 3. Add chat handler

```rust
ClientMessage::Chat { text } => {
    let target_langs = state.rooms.get_room_languages(&room_id, &peer_id);
    let translations = state.translator.translate_fanout(&text, &lang, &target_langs).await;
    let msg = json!({
        "type": "chat_message",
        "sender_id": peer_id,
        "sender_name": user_name,
        "sender_lang": lang,
        "original": text,
        "translations": translations,
        "timestamp": now_unix_secs()
    }).to_string();
    state.rooms.broadcast(&room_id, &msg, None); // send to ALL including sender
}
```

### 4. Update subtitle translation to fan-out

In the Deepgram transcript handler, when `is_final == true`:
```rust
let target_langs = rooms.get_room_languages(&room_id, &speaker_peer_id);
let translations = translator.translate_fanout(&transcript, &speaker_lang, &target_langs).await;
let msg = json!({
    "type": "subtitle_final",
    "speaker_id": speaker_peer_id,
    "speaker_name": speaker_name,
    "original": transcript,
    "lang": speaker_lang,
    "translations": translations
}).to_string();
rooms.broadcast(&room_id, &msg, None);
```

### 5. Create translator.rs (new module)

```rust
pub struct Translator {
    groq: Arc<GroqClient>,
}

impl Translator {
    pub async fn translate_fanout(
        &self,
        text: &str,
        source_lang: &str,
        target_langs: &[String],
    ) -> HashMap<String, String> {
        let mut translations = HashMap::new();
        translations.insert(source_lang.to_string(), text.to_string());

        let mut tasks = Vec::new();
        for tgt in target_langs {
            if tgt == source_lang { continue; }
            let groq = self.groq.clone();
            let text = text.to_string();
            let src = source_lang.to_string();
            let tgt = tgt.clone();
            tasks.push(tokio::spawn(async move {
                (tgt.clone(), groq.translate(&text, &src, &tgt).await)
            }));
        }

        for task in tasks {
            if let Ok((lang, Ok(translated))) = task.await {
                translations.insert(lang, translated);
            }
        }
        translations
    }
}
```

### 6. Update WS query params

Change from `?room={id}&role={speaker|listener}&source_lang=...&target_lang=...`
to: `?room={id}&user={name}&lang={code}`

No more speaker/listener distinction. Every peer is both — they send audio for STT AND receive subtitles/chat.

## Client Implementation Guide

### 1. New file: src/scripts/webrtc.ts

```typescript
export class MeshManager {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private localStream: MediaStream;
  private ws: WebSocket;
  public onRemoteStream: (peerId: string, stream: MediaStream) => void = () => {};
  public onPeerRemoved: (peerId: string) => void = () => {};

  constructor(localStream: MediaStream, ws: WebSocket) {
    this.localStream = localStream;
    this.ws = ws;
  }

  async addPeer(peerId: string, isInitiator: boolean): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    });

    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));

    pc.ontrack = (e) => this.onRemoteStream(peerId, e.streams[0]);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: e.candidate.toJSON() }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.removePeer(peerId);
      }
    };

    this.peers.set(peerId, pc);

    // The peer already in the room initiates the offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: offer.sdp }));
    }
  }

  async handleOffer(fromId: string, sdp: string): Promise<void> {
    if (!this.peers.has(fromId)) await this.addPeer(fromId, false);
    const pc = this.peers.get(fromId)!;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.ws.send(JSON.stringify({ type: 'answer', to: fromId, sdp: answer.sdp }));
  }

  async handleAnswer(fromId: string, sdp: string): Promise<void> {
    const pc = this.peers.get(fromId);
    if (pc) await pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async handleIce(fromId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.peers.get(fromId);
    if (pc) await pc.addIceCandidate(candidate);
  }

  removePeer(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) { pc.close(); this.peers.delete(peerId); }
    this.onPeerRemoved(peerId);
  }

  // Toggle local tracks (mute/camera off)
  setAudioEnabled(enabled: boolean): void {
    this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
  }

  setVideoEnabled(enabled: boolean): void {
    this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
  }

  destroy(): void {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
  }
}
```

### 2. New file: src/scripts/audio-capture.ts

Dual audio path: same mic track goes to both WebRTC AND server STT.

```typescript
export class AudioCapture {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream;
  private ws: WebSocket;

  constructor(stream: MediaStream, ws: WebSocket) {
    this.stream = stream;
    this.ws = ws;
  }

  start(): void {
    const audioTrack = this.stream.getAudioTracks()[0];
    if (!audioTrack) return;
    const sttStream = new MediaStream([audioTrack]);

    this.recorder = new MediaRecorder(sttStream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32000,
    });

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(e.data);
      }
    };

    this.recorder.start(250);
  }

  stop(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  setMuted(muted: boolean): void {
    if (muted) this.stop();
    else this.start();
  }
}
```

### 3. New file: src/scripts/chat.ts

```typescript
export class ChatManager {
  private myLang: string;
  private myPeerId: string;
  private container: HTMLElement;
  private ws: WebSocket;
  public onUnread: (count: number) => void = () => {};
  private unreadCount = 0;
  private isOpen = false;

  addMessage(data: {
    sender_id: string, sender_name: string, sender_lang: string,
    original: string, translations: Record<string, string>, timestamp: number
  }): void {
    const translated = data.translations[this.myLang] || data.original;
    const isMine = data.sender_id === this.myPeerId;
    const isTranslated = data.sender_lang !== this.myLang;

    // Create message element with:
    // - sender name (skip if mine)
    // - translated text (primary, larger)
    // - original text (secondary, smaller, muted — only if translated)
    // - timestamp
    // Right-align own messages with accent bg, left-align others with surface bg

    if (!this.isOpen) {
      this.unreadCount++;
      this.onUnread(this.unreadCount);
    }
  }

  sendMessage(text: string): void {
    this.ws.send(JSON.stringify({ type: 'chat', text }));
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    if (open) { this.unreadCount = 0; this.onUnread(0); }
  }
}
```

### 4. Update getUserMedia call

Request both audio AND video:
```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 30 },
  }
});
```

This single stream is used for:
- WebRTC: all tracks added to peer connections
- AudioCapture: grabs just the audio track for STT
- Setup preview: shown in local video element before joining

### 5. Video Grid UI

Dynamic CSS grid that adapts to peer count:

```css
.video-grid {
  display: grid;
  gap: 2px;
  flex: 1;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}

/* Adapt grid to peer count via data attribute */
.video-grid[data-peers="1"] { grid-template: 1fr / 1fr; }
.video-grid[data-peers="2"] { grid-template: 1fr / 1fr 1fr; }
.video-grid[data-peers="3"] { grid-template: 1fr 1fr / 1fr 1fr; }
.video-grid[data-peers="3"] .video-cell:nth-child(3) { grid-column: 1 / -1; justify-self: center; max-width: 50%; }
.video-grid[data-peers="4"] { grid-template: 1fr 1fr / 1fr 1fr; }
```

Each video cell:
```html
<div class="video-cell" data-peer="{peer_id}">
  <video autoplay playsinline></video>
  <div class="avatar" hidden style="background: linear-gradient(...)">
    <span class="avatar-initials">AM</span>
  </div>
  <div class="video-overlay">
    <span class="peer-name">Alessandro</span>
    <span class="peer-lang">IT</span>
    <span class="mute-indicator" hidden>🔇</span>
  </div>
  <div class="subtitle-area">
    <!-- subtitles injected here per speaker -->
  </div>
</div>
```

Self-video rules:
- Mirror with `transform: scaleX(-1)` 
- Subtle blue border (2px solid var(--accent))
- "You" badge next to name

Camera-off state:
- Hide `<video>`, show `.avatar` with initials on deterministic gradient:
```typescript
function getAvatarGradient(name: string): string {
  let hash = 0;
  for (const char of name) hash = char.charCodeAt(0) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 60%, 25%), hsl(${(hue + 40) % 360}, 60%, 15%))`;
}
```

### 6. Update subtitle rendering

Now subtitles attach to the speaker's video cell (not a global log).

Each video cell has `.subtitle-area` at the bottom. When a `subtitle_final` arrives:
- Find the video cell with `data-peer={speaker_id}`
- Pick `translations[myLang]` (or `original` if my lang matches speaker's lang)
- Show translated text, with original smaller below
- Auto-fade after 5-6 seconds

```css
.subtitle-area {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  padding: 8px 12px;
  display: flex; flex-direction: column; align-items: center;
  pointer-events: none;
}

.subtitle {
  background: rgba(0, 0, 0, 0.75);
  color: white;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.85rem;
  max-width: 90%;
  text-align: center;
  backdrop-filter: blur(4px);
}

.subtitle-interim { opacity: 0.6; font-style: italic; }
.subtitle-translation { display: block; font-weight: 500; }
.subtitle-original { display: block; font-size: 0.7rem; opacity: 0.6; }
```

### 7. Control bar

Fixed at bottom of video area. Glassmorphism style.

```css
.control-bar {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 12px 20px;
  background: rgba(19, 20, 28, 0.8);
  backdrop-filter: blur(12px);
  border-radius: 16px;
  margin: 8px auto;
  width: fit-content;
}

.control-btn {
  width: 48px; height: 48px;
  border-radius: 50%;
  border: none;
  background: var(--surface-elevated);
  color: var(--text);
  font-size: 1.2rem;
  cursor: pointer;
  position: relative;
  transition: background 0.15s;
}

.control-btn.active-danger { background: var(--danger); }  /* muted mic, cam off */
.control-btn.active-success { background: var(--success); color: white; }  /* TTS on */

.chat-badge {
  position: absolute;
  top: -4px; right: -4px;
  background: var(--danger);
  color: white;
  font-size: 0.65rem;
  width: 18px; height: 18px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
}
```

Buttons: 🎤 Mute | 📷 Camera | 🔊 TTS | 💬 Chat | 🚪 Leave

### 8. Chat panel

Desktop: right sidebar, 320px wide, slides in/out.
Mobile: bottom-sheet drawer that slides up.

```css
.chat-panel {
  width: 320px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transition: margin-right 0.3s;
}

.chat-panel.closed { margin-right: -320px; }

@media (max-width: 768px) {
  .chat-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    width: 100%;
    max-height: 60vh;
    border-left: none;
    border-top: 1px solid var(--border);
    border-radius: 16px 16px 0 0;
    transform: translateY(100%);
    transition: transform 0.3s;
  }
  .chat-panel.open { transform: translateY(0); }
}
```

Chat messages:
```css
.chat-msg {
  padding: 8px 12px;
  border-radius: 12px;
  max-width: 80%;
  font-size: 0.9rem;
}
.chat-msg-mine { align-self: flex-end; background: var(--accent-soft); }
.chat-msg-other { align-self: flex-start; background: var(--surface-elevated); }
.chat-sender { font-size: 0.75rem; font-weight: 600; color: var(--accent); margin-bottom: 2px; }
.chat-text { line-height: 1.4; }
.chat-original { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; font-style: italic; }
```

### 9. Setup screen upgrade

Add before joining:
- Name input (persist to localStorage)
- Camera preview (live video from getUserMedia)
- Camera and microphone dropdowns (from `navigator.mediaDevices.enumerateDevices()`)
- Room code with copy-to-clipboard button
- Language selector
- "Join Room" button

### 10. App flow on join

```typescript
// 1. Get user media (audio + video)
const stream = await navigator.mediaDevices.getUserMedia({ audio: {...}, video: {...} });

// 2. Connect WebSocket
const ws = new WebSocket(`${WS_BASE}/ws?room=${room}&user=${name}&lang=${lang}`);

// 3. On "room_joined" message:
//    - Store own peer_id
//    - Create MeshManager with localStream
//    - Create AudioCapture, start it
//    - Add self video cell (local stream)
//    - For each existing peer in the list: mesh.addPeer(peerId, true)
//      (we are initiator because we just joined and they were already there)

// 4. On "peer_joined":
//    - Add video cell placeholder
//    - Wait for their offer (they will initiate since they're new... NO)
//    ACTUALLY: existing peers initiate toward the new peer.
//    So when WE receive "peer_joined", WE create the offer:
//    mesh.addPeer(newPeerId, true)

// 5. On "offer" from someone:
//    - mesh.handleOffer(fromId, sdp)

// 6. On "answer":
//    - mesh.handleAnswer(fromId, sdp)

// 7. On "ice":
//    - mesh.handleIce(fromId, candidate)

// 8. MeshManager.onRemoteStream callback:
//    - Attach stream to the peer's video element

// 9. On "peer_left":
//    - mesh.removePeer(peerId)
//    - Remove video cell from grid
//    - Update grid layout
```

## Design Tokens

```css
:root {
  --bg: #0a0b10;
  --surface: #13141c;
  --surface-elevated: #1a1b26;
  --border: #252836;
  --text: #e2e4ec;
  --text-muted: #6b7089;
  --accent: #3b82f6;
  --accent-soft: rgba(59, 130, 246, 0.15);
  --danger: #ef4444;
  --success: #22c55e;
  --warning: #f59e0b;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --font: 'Inter', system-ui, -apple-system, sans-serif;
}
```

## Edge Cases

1. **Max 4 peers**: server rejects with `room_full`, client shows message.
2. **Echo**: `echoCancellation: true` on getUserMedia is mandatory.
3. **Duplicate translations**: `get_room_languages()` deduplicates. 2 English peers → translate to English once.
4. **Self-subtitles**: speaker sees own original text (no translation) as confirmation.
5. **Camera off**: hide `<video>`, show avatar with initials on gradient.
6. **Mute**: stop MediaRecorder when muted (no audio to server). Toggle audio track on WebRTC connections.
7. **Peer disconnect**: remove video cell with transition, remove from mesh, notify others.
8. **Late joiner**: no chat/subtitle history. Fresh start from join moment.
9. **Simultaneous speakers**: each has own Deepgram connection, independent subtitles on their video cell.
10. **Mobile**: video grid responsive, chat as bottom-sheet, controls float at bottom.
11. **HTTPS**: required for getUserMedia on mobile. localhost exempt for dev.
12. **STUN only** (no TURN): works for ~85% of connections. For production add TURN server.

## Execution Order

1. Add `translator.rs` module (fan-out translation)
2. Update `rooms.rs` — add `user_name`, `lang` to Peer, max 4 enforcement, `relay_to_peer()`, `get_room_languages()`
3. Update `protocol.rs` — add all new message types
4. Add signaling relay to `ws_handler.rs` (offer/answer/ice passthrough)
5. Add chat handler to `ws_handler.rs`
6. Add peer state broadcast (mute/video) to `ws_handler.rs`
7. Update subtitle broadcast to use fan-out translations map
8. Update WS query params (`?room=&user=&lang=` instead of role/source_lang/target_lang)
9. Test server changes with websocat
10. Create `webrtc.ts` — mesh manager
11. Create `audio-capture.ts` — dual path capture
12. Create `chat.ts` — chat panel manager
13. Upgrade setup screen — camera preview, name, device selectors
14. Build video grid with dynamic layout
15. Update subtitle rendering to per-video-cell
16. Build control bar with mute/camera/tts/chat/leave
17. Build chat panel UI (desktop sidebar + mobile drawer)
18. Wire up `app.ts` — connect all modules
19. Test with 2 browser tabs
20. Test with 4 tabs
21. Add camera-off avatar state
22. Mobile responsive polish