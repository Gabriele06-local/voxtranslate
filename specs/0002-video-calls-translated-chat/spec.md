# 0002 — P2P video calls (WebRTC mesh ≤4) + auto-translated chat

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-09 |
| **Shipped** | 2026-06-09 |
| **Version** | V2 |
| **Commits** | `a2c0f2b` |
| **Depends on** | [0001](../0001-voice-translation-rooms/spec.md) |

## 1. Context & Problem

The audio-only pipeline ([0001](../0001-voice-translation-rooms/spec.md)) proved the
translation loop. V2 turns it into a **video meeting**: peers see and hear each other
directly (P2P), keep the live-translation subtitles on each speaker's tile, and get a
**text chat that is auto-translated** into every language in the room. The server must
stay out of the media path for cost and privacy, so video/audio go peer-to-peer over a
WebRTC **mesh** while the server only relays signaling, fans out translations, and
relays chat.

## 2. Goals / Non-Goals

**Goals**
- Up to **4 peers** in a room, full mesh: each peer holds a direct `RTCPeerConnection` to every other.
- The server **relays signaling only** (offer/answer/ICE) and **never touches** media streams.
- **Dual audio path:** WebRTC carries audio to peers (they hear you P2P) *and* a
  `MediaRecorder` stream feeds the server for STT — both from the same mic.
- Live subtitles render on the **speaker's video cell** (interim) and finalize with translations.
- **Text chat** is translated into every room language and broadcast to all (including sender).
- Mute state (audio/video) propagates to peers for UI indicators.

**Non-Goals**
- SFU/MCU or rooms larger than 4 (mesh degrades beyond ~4 peers — explicit cap).
- Recording or persisting media/chat.
- Server-side media processing of any kind.

## 3. Requirements

- **R1 — Mesh connect.** As a peer, I establish a direct connection to every existing peer.
  - *Given* `room_joined` lists peers, *when* I join, *then* I create an `RTCPeerConnection`
    per peer and exchange `offer`/`answer`/`ice` relayed by the server (`to`/`from` injected).
- **R2 — Cap at 4.** *Given* a room already has 4 peers, *when* a 5th connects, *then* the
  server replies `room_full` and the join is rejected.
- **R3 — See & hear peers P2P.** *Given* a connected peer, *when* their tracks arrive,
  *then* their video tile shows their camera and plays their audio without the server relaying media.
- **R4 — Subtitles on the right tile.** *Given* a speaker's `subtitle_interim`/`subtitle_final`,
  *when* it arrives, *then* it renders on that speaker's cell (interim live, final translated to my lang).
- **R5 — Translated chat.** As a chatter, I send `chat { text }`.
  - *Given* a chat message, *when* the server receives it, *then* it translates into every
    distinct room language and broadcasts `chat_message { original, translations, sender_* }`
    to everyone; each client shows `translations[my_lang]` (falling back to `original`).
- **R6 — Mute signaling.** `mute_audio`/`mute_video` from a peer broadcast `peer_muted { kind, muted }`.

## 4. Design & Architecture

**Topology.** Full WebRTC **mesh** (no SFU). With N≤4 peers each holds N−1 peer
connections. Server = signaling relay + translation/chat fan-out only.

**Protocol additions (`server/src/protocol.rs`)**
- Client→Server: `offer { to, sdp }`, `answer { to, sdp }`, `ice { to, candidate }`,
  `chat { text }`, `mute_audio { muted }`, `mute_video { muted }`.
- Server→Client: `offer { from, sdp }`, `answer { from, sdp }`, `ice { from, candidate }`,
  `chat_message { sender_id, sender_name, sender_lang, original, translations, timestamp }`,
  `peer_muted { peer_id, kind, muted }`, `room_full`.
- Signaling is **relayed verbatim**: client addresses a peer with `to`; server strips it and
  delivers with `from` set. The server does not parse SDP/ICE.

**Client (`client/src/scripts/`)**
- `webrtc.ts` — peer-connection lifecycle, offer/answer glare handling, ICE, track wiring,
  mesh bookkeeping (add on `peer_joined`, tear down on `peer_left`).
- `audio-capture.ts` — single mic → two consumers: WebRTC sender track + `MediaRecorder`
  (Opus/WebM, 32 kbps mono, 250 ms chunks) streamed to the server for STT.
- `chat.ts` — send/receive chat; render original + translated with a bold inline sender.
- `app.ts` — orchestrates room join, the call grid, subtitles, mute toggles.

**Dual audio path (the crux).** The same `MediaStream` feeds (a) the WebRTC sender so peers
hear you directly, and (b) a `MediaRecorder` whose chunks go to the server as binary WS frames
for Deepgram. The server therefore gets audio for STT **without** sitting in the media path.

**Sequence (peer A joins a room with B, C)**
1. A connects → `room_joined { peers: [B, C] }`.
2. A creates RTCPeerConnections to B and C; sends `offer { to: B }`, `offer { to: C }`.
3. Server relays each as `offer { from: A }`; B/C answer; ICE flows both ways.
4. Media is direct A↔B, A↔C. A also streams MediaRecorder audio to the server → STT → translated subtitles fan out.
5. Anyone types chat → server translates → `chat_message` to all.

**Key decisions**
- **Mesh, not SFU**, capped at 4 → zero media-server cost/complexity; cap keeps fan-out bandwidth sane.
- **Verbatim signaling relay** → server stays codec/SDP-agnostic and never parses media.
- **One mic, two sinks** → peers get low-latency P2P audio while the server still gets a clean STT feed.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Signaling relay + `room_full` + mute relay | `server/src/{lib,rooms,protocol}.rs` |
| S1 | Mesh peer-connection manager | `client/src/scripts/webrtc.ts` |
| S2 | Dual audio path (WebRTC + MediaRecorder) | `client/src/scripts/audio-capture.ts` |
| S3 | Translated chat | `server/src/translator.rs`, `client/src/scripts/chat.ts` |
| S4 | Call grid + per-tile subtitles + mute UI | `client/src/scripts/app.ts` |

## 6. Testing & Verification

- `client/src/scripts/webrtc.test.ts` and `audio-capture.test.ts` cover the mesh and
  capture logic (formalized in [0004](../0004-quality-testing-ci/spec.md), all files ≥85%).
- `protocol.rs` tests assert signaling/chat/mute message tags and round-trips.

## 7. Deployment & Operations

- No new server env vars. STUN/TURN configuration lives client-side in `webrtc.ts`.
- Mesh bandwidth scales O(N²) in the worst case → the hard cap of 4 is a load-bearing constraint, not cosmetic.

## 8. Risks / Open Items

- No TURN relay → peers behind symmetric NAT may fail to connect (STUN-only happy path).
- Mesh quality degrades on weak uplinks with 4 peers; no adaptive simulcast (out of scope).

## 9. References

- Commit: `a2c0f2b` "V2: P2P video calls (WebRTC mesh, max 4) + auto-translated chat"
- Files: `server/src/{lib,rooms,protocol,translator}.rs`, `client/src/scripts/{webrtc,audio-capture,chat,app}.ts`
- External: WebRTC mesh topology, MediaRecorder API (Opus/WebM)
