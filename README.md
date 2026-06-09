# VoxTranslate

Real-time **translated video calls**. Up to 4 people talk face-to-face over P2P
WebRTC, each in their own language — speech is transcribed, translated into every
participant's language in parallel, and shown as live subtitles on each speaker's
video. Includes an auto-translated text chat.

```
Each peer (browser)
  ├─ camera + mic ──► WebRTC mesh ──► other peers hear/see you directly (P2P)
  └─ same mic track ──► MediaRecorder (webm/opus, 250ms) ──binary WS──► Axum server
                                                                          └─► per-speaker Deepgram WS (STT)
                                                                                 interim → subtitle_interim (broadcast)
                                                                                 final  → Groq fan-out → subtitle_final
                                                                                          { it, en, es… } → each peer picks its lang
  WebRTC signaling (offer/answer/ice) and chat are relayed by the server.
```

## Features

- 📹 **P2P video calls** — WebRTC full mesh, up to 4 peers (server never touches media).
- 🌍 **Live translated subtitles** — each utterance is transcribed and translated into
  every language in the room **in parallel**, shown on the speaker's video cell in your language.
- 💬 **Auto-translated chat** — messages arrive in your language, original shown below.
- 🎚️ **Controls** — mute mic, camera on/off, speak-translations (TTS), chat, leave.
- 🏠 **Lobby** — public rooms list their online members; tap to join. Rooms can be public or private.
- 🎛️ **Pre-join** — camera preview + camera/mic device selectors before entering.
- 🌐 **Localized UI** — all 8 supported languages, auto-detected from the browser (fallback English).
- 📱 **Mobile-first** — responsive video grid, chat as a bottom-sheet drawer.

Supported languages: Italian, English, Spanish, French, German, Portuguese, Japanese, Chinese.

## Stack

| Layer        | Tech                                                        |
|--------------|------------------------------------------------------------|
| Backend      | Rust — Axum 0.8 + Tokio (WS relay + signaling)             |
| Video/Audio  | WebRTC mesh (P2P), STUN-only                                |
| STT          | Deepgram Nova-2 streaming WebSocket                         |
| Translation  | Groq `llama-3.1-8b-instant` (parallel fan-out)             |
| Frontend     | Astro 5 + vanilla TypeScript modules (`src/scripts/`)      |
| TTS          | Browser `SpeechSynthesis` API                              |

Audio/video flows **peer-to-peer**; the server only relays signaling, runs STT, fans
out translations, and relays chat. Rooms are ephemeral (in-memory `DashMap`, no DB).

## Protocol

Peers connect to `GET /ws?room=..&lang=..&name=..&id=..&public=..` and exchange JSON
text frames (audio is sent as binary frames):

- **Client → server:** `start` / `stop` (speaking session), `offer` / `answer` / `ice`
  (WebRTC, relayed to `to`), `chat`, `mute_audio` / `mute_video`.
- **Server → client:** `room_joined` (your id + existing peers), `peer_joined`,
  `peer_left`, `room_full`, relayed `offer` / `answer` / `ice` (with `from`),
  `chat_message` (with a `translations` map), `peer_muted`, `subtitle_interim`,
  `subtitle_final` (with a `translations` map).
- `GET /rooms` — lobby (public rooms + online members). `GET /health` — health check.

Existing peers initiate the WebRTC offer toward a newcomer (avoids offer glare).

## Prerequisites

- Rust (stable) + Cargo · Node 18+ + npm
- API keys: **`DEEPGRAM_API_KEY`** (Nova-2 STT) and **`GROQ_API_KEY`** (Llama translation)

## Run locally

```bash
cp server/.env.example server/.env     # add your keys
```

**Server (port 3001):** `cd server && cargo run`

**Client (port 4321):** `cd client && npm install && PUBLIC_WS_HOST=localhost:3001 npm run dev`

Open **http://localhost:4321** in two tabs (or two devices on your LAN), pick a language
in each, join the same room, and you're on a translated call.

> **HTTPS:** `getUserMedia` and WebRTC need a secure context. `localhost` is exempt for
> dev; use HTTPS for LAN/remote.

## Run with Docker

```bash
cp server/.env.example server/.env
docker compose up --build       # client :4321 · server :3001
```

## Deploy (production, autodeploy on `main`)

Frontend and backend deploy separately — Vercel is serverless and **cannot host the
persistent WebSocket relay**, so the Rust server runs on Railway.

### Backend → Railway
1. New Project → Deploy from GitHub → this repo. Service **Root Directory = `server`**
   (uses `server/Dockerfile` + `server/railway.toml`, `/health` healthcheck).
2. Variables: `DEEPGRAM_API_KEY`, `GROQ_API_KEY` (Railway injects `PORT`).
3. Deploy, copy the public domain.

### Frontend → Vercel
1. Import this repo. **Root Directory = `client`** (Astro auto-detected).
2. Env **`PUBLIC_WS_HOST`** = your Railway domain (host only, no protocol).
3. Deploy.

Pushes to `main` auto-deploy both.

> **Production WebRTC:** this uses STUN only (~85% of NATs connect). For reliable
> connectivity across symmetric NATs, add a TURN server to the `ICE_SERVERS` list in
> `client/src/scripts/webrtc.ts`. Also restrict `CorsLayer::permissive()` to your origin.

## Testing

**Multi-party subtitle pipeline (no mic/camera)** — `scripts/pipeline-test.mjs` connects
three peers (it/en/es), each speaks, and asserts the `subtitle_final` fan-out reaches
everyone in their language:

```bash
say -v Alice    -o it.aiff "Ciao a tutti, come va oggi?"
say -v Samantha -o en.aiff "Hello everyone, how is it going today?"
ffmpeg -y -i it.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 it.webm
ffmpeg -y -i en.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 en.webm
node scripts/pipeline-test.mjs it.webm en.webm
```

## Project layout

```
server/   Rust/Axum relay
  src/{main,config,protocol,rooms,deepgram,groq,translator}.rs
  Dockerfile · railway.toml · .env.example
client/   Astro 5 SPA
  src/pages/index.astro          screens + styles
  src/scripts/{app,webrtc,audio-capture,chat,i18n}.ts
  src/layouts/Base.astro
scripts/  pipeline-test.mjs · docker-compose.yml · LICENSE (MIT)
```

## Notes

- **Deepgram input**: send `container=webm` only and let Deepgram auto-detect Opus/sample
  rate from the header (explicit `encoding`/`sample_rate` break container demuxing).
- **Dual audio path**: the same mic track feeds WebRTC (peers hear you live) and a
  MediaRecorder (server STT) — a MediaStreamTrack supports multiple consumers.
- The Groq model id lives in `server/src/groq.rs`. Deepgram auth uses `Token <key>`, Groq `Bearer <key>`.

## License

[MIT](./LICENSE) © 2026 Alessandro Micelli
