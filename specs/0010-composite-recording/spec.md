# 0010 — Composite video recording (client-side)

| | |
|---|---|
| **Status** | In progress |
| **Owner** | Micio Dev |
| **Created** | 2026-06-10 |
| **Shipped** | — |
| **Version** | — |
| **Commits** | — |
| **Depends on** | [0002](../0002-video-calls-translated-chat/spec.md), [0003](../0003-client-experience-pwa/spec.md) |

## 1. Context & Problem

The in-call record button captures only the **local** stream (`app.ts`
`startRecording`): a meeting recording without the other participants is nearly
useless. The server never touches A/V (P2P mesh, by design), so recording must stay
100% client-side: composite every participant's video onto one canvas, mix all
audio, and let MediaRecorder produce a single downloadable WebM.

## 2. Goals / Non-Goals

**Goals**
- One WebM containing **all** participants: tiled video (1280×720@30fps) + mixed audio.
- Adaptive layout for 1–4 participants that re-tiles on join/leave without restarting the recorder.
- Camera-off participants render a placeholder tile (initials + name), never a frozen/black frame.
- Record button with elapsed timer + on-grid `REC ●` badge; auto-stop + download on hang-up.
- Graceful degradation: button hidden where unsupported (Safari); partial file saved on mid-session failure.

**Non-Goals**
- Server-side or cloud recording, transcoding, or storage (file stays on the recorder's machine).
- Capturing TTS/SpeechSynthesis output (not capturable; recording carries peers' original voices).
- Recording screen-share at native resolution (the share is drawn into the normal tile).
- Streaming chunks to disk (File System Access API) — v1 keeps chunks in memory.
- External libraries — canvas + AudioContext + MediaRecorder only.

## 3. Requirements

- **R1 — Composite video.** As the recording participant, I want everyone in one video.
  - *Given* n∈1..4 participants, *when* recording, *then* the canvas tiles them: 1 = full frame, 2 = side-by-side columns, 3 = two top + one centered bottom, 4 = 2×2 grid; 4px gaps; each feed contain-fit letterboxed (no distortion); name pill (white ~14px on dark) bottom-left of each tile.
  - *Given* a participant with camera off (or no video frames), *then* their tile is a dark placeholder with centered initials disc + name.
- **R2 — Adaptive layout.** *Given* an active recording, *when* a participant joins or leaves, *then* the layout adapts on the next frame — no recorder restart, no blank frames.
- **R3 — Mixed audio.** *Given* a recording, *then* the track mixes every participant's audio (local = raw mic only, never speaker/TTS output) via AudioContext at unity gain.
- **R4 — Output file.** *Given* recording stops, *then* a WebM (vp9 → vp8 → bare `video/webm` fallback; 2.5 Mbps video / 128 kbps audio; 1s chunks) downloads as `voxtranslate-{room}-{YYYY-MM-DD-HHmm}.webm`.
- **R5 — Controls & status.** *Given* recording is active, *then* the record button pulses red with an `MM:SS` elapsed timer and a `REC ●` badge shows top-left of the video grid.
- **R6 — Hang-up safety.** *Given* an active recording, *when* the user leaves the call, *then* stop + download happen before media teardown.
- **R7 — Degradation.** *Given* a browser without MediaRecorder/captureStream/AudioContext, *then* the record button is hidden (no error); *given* a mid-session recorder failure, *then* collected chunks are saved and a "partial file" toast shows.

## 4. Design & Architecture

- **Components / files** (`client/src/scripts/recording/` — CLAUDE.md mandates `src/scripts/`, overriding the spec's `src/lib/` suggestion):
  - `types.ts` — `ParticipantSource { peerId, name, stream, videoOff }`, options/events.
  - `utils.ts` — pure helpers: `pickMimeType` (injectable `isTypeSupported`), `recordingFilename`, `formatElapsed`, `isRecordingSupported`.
  - `canvas-compositor.ts` — hidden 1280×720 canvas; `computeLayout(n)` pure tile math; rAF draw loop throttled to 30fps **plus a 1s setInterval safety tick** (rAF pauses in background tabs); hidden `<video muted playsinline>` per participant; contain-fit; placeholder + name-pill drawing.
  - `audio-mixer.ts` — `MediaStreamSource → GainNode(1.0) → MediaStreamDestination` per participant; `add/remove/close`; skips streams without audio tracks.
  - `composite-recorder.ts` — orchestrator: compositor + mixer + MediaRecorder + chunk buffer; `start/stop(): Promise<Blob>`, `addParticipant/removeParticipant/updateStream/setVideoOff`; full cleanup on stop (cancel rAF + interval, remove video elements, close AudioContext, stop captureStream tracks, drop refs).
- **Integration (observer pattern — zero changes to `webrtc.ts`):** `app.ts` gains a `remoteStreams: Map<peerId, MediaStream>` registry (streams aren't stored anywhere today); `mesh.onRemoteStream` / `peer_left` / cam-toggle / screen-share call sites forward into `recorder?.…`. Old `startRecording`/`stopRecording` bodies replaced; `leaveCall()` stops + downloads before `mesh.destroy()`.
- **Sequence:** 1. click record (user gesture → AudioContext allowed) → build compositor + mixer from self + `remoteStreams`; 2. `canvas.captureStream(30)` video track + mixer destination audio track → `MediaRecorder.start(1000)`; 3. participants join/leave → sources updated → next frame re-tiles; 4. stop (button or hang-up) → `onstop` → Blob → `downloadBlob` (shared helper, see 0009) → cleanup.
- **Key decisions:**
  - *Canvas compositing over multi-track recording* — MediaRecorder can't encode multiple video tracks into one file; canvas is the only no-library client-side compositor.
  - *Self tile follows `mesh.setLocalStream`* — during screen share the recording shows what peers see.
  - *In-memory chunks (v1)* — 10 min ≈ 190 MB is acceptable; FS Access streaming is a follow-up.
  - *Recording mixes peers' original voices* even when local TTS playback mutes them in the UI — SpeechSynthesis is not capturable; documented behavior.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S5 | Recording modules + unit tests | `client/src/scripts/recording/*` |
| S6 | app.ts integration, UI (timer, `#rec-badge`), i18n; remove single-stream recording | `app.ts`, `index.astro`, `i18n.ts` |

## 6. Testing & Verification

- Vitest (pure logic, injected deps): `computeLayout` n=1..4 exact positions/sizes/gaps (R1, R2), contain-fit math wide-in-tall + tall-in-wide (R1), `pickMimeType` fallback chain (R4), `recordingFilename` format (R4), `formatElapsed` (R5).
- Manual checklist: 1/2/3/4-participant layouts; third joins mid-recording → adapts; leave mid-recording → no crash; camera-off placeholder; hang-up downloads before cleanup; 10-min soak (≈180 MB file, stable memory, ≤15% CPU).

## 7. Deployment & Operations

- Pure client change — ships with the Vercel frontend deploy; no server, env, or schema impact.
- Supported: Chrome/Firefox/Edge 90+. Safari: button hidden via `isRecordingSupported()`.

## 8. Risks / Open Items

- Background-tab rAF throttling → 1s safety tick keeps frames flowing at reduced rate (documented limitation).
- In-memory chunks bound long recordings by RAM — follow-up: File System Access streaming.
- `#rec-badge` (this spec) vs `#transcript-indicator` (0009) are deliberately distinct ids/styles — both can show at once.
- CPU on low-end devices: 30fps canvas + encode targets ≤15%; if exceeded, drop draw rate (not resolution) first.

## 9. References

- Files: `client/src/scripts/recording/`, `client/src/scripts/app.ts`
- Related: [0009](../0009-session-transcripts/spec.md) (shares `downloadBlob`, distinct status indicators)
- External: MDN MediaRecorder, HTMLCanvasElement.captureStream, Web Audio API
