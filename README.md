# VoxTranslate

Real-time, multilingual voice translation rooms. Everyone in a room **speaks and
listens** in their own language — each person's speech is transcribed and
translated into every other participant's language in parallel, then spoken aloud.

```
Each participant (browser)
  ├─ mic → MediaRecorder (webm/opus, 250ms) ──binary WS──► Axum server
  │                                                          └─► per-speaker Deepgram WS (STT)
  │                                                                 │ interim → back to speaker
  │                                                                 │ final → Groq translate (per target lang, in parallel)
  └─ ◄──── JSON text frames ───────────────────────────────────────┘
         transcript (own language) + translation (your language) → SpeechSynthesis TTS
```

## Features

- 🎙️ **Symmetric rooms** — every participant can talk and hear; no speaker/listener roles.
- 🌍 **Per-recipient translation** — N people, N languages; each utterance is translated
  into every other language in the room **in parallel**.
- 🏠 **Lobby** — public rooms list their online members; tap to join. Rooms can be
  **public** (listed) or **private** (join by code only).
- 🗣️ **Auto TTS** — translations are spoken via the browser `SpeechSynthesis` API.
- 🌐 **Localized UI** — interface in all 8 supported languages, auto-detected from the
  browser (fallback English), following your chosen language.
- 📱 **Mobile-first** — responsive, large tap targets, push-to-talk or toggle.

Supported languages: Italian, English, Spanish, French, German, Portuguese, Japanese, Chinese.

## Stack

| Layer        | Tech                                                        |
|--------------|------------------------------------------------------------|
| Backend      | Rust — Axum 0.8 + Tokio (WebSocket relay)                   |
| STT          | Deepgram Nova-2 streaming WebSocket                         |
| Translation  | Groq `llama-3.1-8b-instant`                                 |
| Frontend     | Astro 5, vanilla JS (no framework islands)                 |
| TTS          | Browser `SpeechSynthesis` API (client-side, zero cost)     |
| Audio        | Opus / WebM, 32 kbps mono, 250 ms chunks                   |

Audio is **never buffered on the server** — chunks are piped straight to a per-speaker
Deepgram WebSocket. Rooms are ephemeral (in-memory `DashMap`, no DB).

## How it works

Every participant opens one WebSocket and both sends audio and receives messages:

- `GET /ws?room=..&lang=..&name=..&id=..&public=..` — `lang` is the single language you
  speak and receive in. `public=true` makes a newly-created room appear in the lobby.
- Speaking is bracketed by `{"type":"start"}` / `{"type":"stop"}` text frames; each
  session opens a fresh Deepgram connection (clean WebM stream).
- On a **final** transcript the server sends the original to everyone sharing the
  speaker's language, and spawns one Groq translation **per distinct other language**,
  delivered to that language's participants.
- `GET /rooms` — lobby: public rooms with their online members (polled by the home screen).
- `GET /health` — health check.

Server → client messages (JSON text frames), each speech message tagged with `from` / `from_id`:

```jsonc
{ "type": "interim",     "from": "Alice", "from_id": "…", "text": "…", "lang": "it" }
{ "type": "transcript",  "from": "Alice", "from_id": "…", "text": "…", "lang": "it" }
{ "type": "translation", "from": "Alice", "from_id": "…", "original": "…",
  "translated": "…", "source_lang": "it", "target_lang": "en" }
{ "type": "error",       "message": "…" }
```

## Prerequisites

- Rust (stable) and Cargo · Node 18+ and npm
- API keys: **`DEEPGRAM_API_KEY`** (Nova-2 STT) and **`GROQ_API_KEY`** (Llama translation)

## Run locally

```bash
cp server/.env.example server/.env     # add your keys
```

**Terminal 1 — server (port 3001):**

```bash
cd server && cargo run
```

**Terminal 2 — client (port 4321):**

```bash
cd client && npm install
PUBLIC_WS_HOST=localhost:3001 npm run dev
```

Open **http://localhost:4321** in two tabs (or two devices on your LAN), pick a language
in each, join the same room, and talk. `PUBLIC_WS_HOST` tells the client where the
WebSocket server is.

> **Mic note:** `getUserMedia` needs a secure context. `localhost` is exempt; for
> LAN/remote use HTTPS.

## Run with Docker

```bash
cp server/.env.example server/.env     # add your keys
docker compose up --build
```

Client → http://localhost:4321 · Server → ws://localhost:3001/ws

## Deploy (production, autodeploy on `main`)

The frontend and backend deploy separately — Vercel is serverless and **cannot host a
persistent WebSocket server**, so the Rust relay runs on a WS-capable host (Railway).

### Backend → Railway

1. New Project → Deploy from GitHub repo → pick this repo.
2. In the service settings, set **Root Directory = `server`** (it picks up
   `server/Dockerfile` + `server/railway.toml`, with a `/health` healthcheck).
3. Add variables: `DEEPGRAM_API_KEY`, `GROQ_API_KEY`. Railway injects `PORT` automatically.
4. Deploy, then copy the public domain (e.g. `voxtranslate-server-production.up.railway.app`).

Pushes to `main` auto-deploy the backend.

### Frontend → Vercel

1. New Project → import this repo.
2. Set **Root Directory = `client`** (Astro is auto-detected).
3. Add environment variable **`PUBLIC_WS_HOST`** = your Railway domain (host only, no
   protocol — e.g. `voxtranslate-server-production.up.railway.app`). It's inlined at build
   time; the client uses `wss://`/`https://` automatically over HTTPS.
4. Deploy.

Pushes to `main` auto-deploy the frontend to production. (Vercel only creates preview
deployments for other branches/PRs — none are needed here.)

> Lock down `CorsLayer::permissive()` to your Vercel origin before going wide.

## Testing

**Groq smoke test:**

```bash
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"system","content":"Translate from Italian to English. Output ONLY the translation."},{"role":"user","content":"ciao come stai"}],"temperature":0.2}'
```

**Multi-party pipeline (no microphone)** — three participants (it/en/es), each speaks,
each receives translations in their own language. See `scripts/pipeline-test.mjs`:

```bash
# generate samples (macOS)
say -v Alice    -o it.aiff "Ciao a tutti, come va oggi?"
say -v Samantha -o en.aiff "Hello everyone, how is it going today?"
ffmpeg -y -i it.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 it.webm
ffmpeg -y -i en.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 en.webm
node scripts/pipeline-test.mjs it.webm en.webm
```

## Project layout

```
server/   Rust/Axum WS relay — src/{main,config,protocol,rooms,deepgram,groq}.rs
          Dockerfile · railway.toml · .env.example
client/   Astro 5 SPA — src/pages/index.astro (UI + audio + WS + TTS + i18n + lobby)
scripts/  pipeline-test.mjs (multi-party E2E harness)
docker-compose.yml · LICENSE (MIT)
```

## Notes

- **Deepgram input**: send `container=webm` only and let Deepgram auto-detect the Opus
  encoding/sample rate from the WebM header (passing explicit `encoding`/`sample_rate`
  breaks container demuxing). See `server/src/deepgram.rs`.
- **Mic modes**: *toggle* (tap start/stop) keeps one continuous stream — most reliable;
  *push-to-talk* (hold) restarts per press.
- The Groq model id lives in `server/src/groq.rs`. Deepgram auth uses `Token <key>`, Groq `Bearer <key>`.

## License

[MIT](./LICENSE) © 2026 Alessandro Micelli
