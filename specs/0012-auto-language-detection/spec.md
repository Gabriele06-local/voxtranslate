# 0012 — Auto language detection (join with "auto")

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-11 *(retroactive backfill)* |
| **Shipped** | 2026-06-10 |
| **Version** | post-v1.0.0 AI bundle |
| **Commits** | `a594e94` |
| **Depends on** | [0001](../0001-voice-translation-rooms/spec.md) |

*Authored retroactively on 2026-06-11 from the shipped code and commit history (backfill of the AI-bundle specs).*

## 1. Context & Problem

Every peer must declare a spoken language at join (spec 0001) — it drives the
Deepgram stream, the translation fan-out, subtitles, and TTS. Pick wrong (or
join in a hurry and keep the default) and STT transcribes garbage, every
translation in the room is wrong, and nothing self-corrects.

Deepgram's `detect_language` exists only on the **REST** (prerecorded) API —
the streaming WebSocket has no equivalent — so detection can't simply be a
query param on the existing stream. This spec adds a `lang=auto` join option:
the server buffers the first few seconds of the speaker's audio, probes it
via REST, opens the real streaming connection in the detected language, and
replays the buffer so no speech is lost. The result is broadcast to the room,
and the speaker can correct a wrong guess with one click.

## 2. Goals / Non-Goals

**Goals**
- Join with `lang=auto` and have the spoken language resolved from the first
  `AUTO_DETECT_BUFFER_MS` (default 3 s) of real speech — no setup screen.
- Zero speech loss: the probe clip is also the stream prefix (MediaRecorder
  chunk #1 carries the WebM header), so buffered audio is replayed into the
  detected-language stream and transcribed normally.
- Room-wide consistency while detection is pending: `"auto"` is never a
  translation fan-out target; chat still works (the model self-detects).
- One-click manual correction (`set_lang`) that beats a slow/wrong probe and
  is reflected in badges, transcripts, and the next Deepgram stream.
- Graceful degradation: probe failure falls back to English with a visible
  `detect_failed` error instead of a dead microphone.

**Non-Goals**
- No UI-language detection — the interface language is independent
  (`setUiLang` guards on `SUPPORTED` and ignores `"auto"`).
- No continuous / per-utterance re-detection: detection is one-shot at
  speaking start; switching languages mid-call is a manual `set_lang`.
- No confidence threshold — Deepgram's best guess is applied as-is (the
  Change toast exists precisely to fix low-confidence misses).
- No new persistence: the existing `session_participants.lang` column is
  updated in place; detection events are not stored.

## 3. Requirements

- **R1 — Join with auto & automatic resolution.** As a caller who doesn't
  want to (or can't correctly) pick a language, I join with "Auto-detect 🌐".
  - *Given* I joined with `lang=auto`, *when* I start speaking, *then* the
    server buffers up to `AUTO_DETECT_BUFFER_MS` of WebM chunks (256 KiB cap),
    probes them via Deepgram REST `detect_language`, and broadcasts
    `language_detected { peer_id, lang, confidence }` to everyone in the room.
  - *Given* the broadcast is for me, *then* my tile badge, the participants
    list, `session.lang`, and my chat language all update, and I see a
    "Detected language: … [Change]" toast.
- **R2 — No speech lost during detection.** *Given* the probe succeeded,
  *when* the streaming Deepgram WS opens in the detected language, *then* the
  buffered chunks are replayed in order before live chunks are bridged — the
  first ~3 s of speech appear in subtitles/transcripts (as a slightly delayed
  burst), not dropped.
- **R3 — Pending-state semantics.** As any peer, the room keeps working while
  someone's language is still `"auto"`.
  - *Given* a peer in `"auto"`, *then* `"auto"` is excluded from translation
    fan-out targets (nobody receives an "auto" translation).
  - *Given* I chat before my probe resolves, *then* the Groq prompt asks the
    model to detect the source language itself instead of naming one.
  - *Given* my own lang is still `"auto"`, *then* TTS of others' speech is
    paused (no valid voice/translation to pick) until it resolves.
  - *Given* a peer list/badge, *then* pending peers render as "🌐 AUTO".
- **R4 — Manual correction.** As the speaker, I can override a wrong guess.
  - *Given* the detected-language toast, *when* I click Change and pick a
    language, *then* the client sends `set_lang` and restarts capture so the
    next Deepgram stream opens in the corrected language with a fresh WebM
    header.
  - *Given* `set_lang`, *then* the server trims + lowercases the code and
    rejects empty, `"auto"`, >8 chars, or non `[a-z0-9-]` codes with
    `Error{code:"bad_lang"}`; valid codes update the room peer, update the
    `session_participants` row, and broadcast `language_detected` **without**
    `confidence` (the manual marker — the client shows "Language updated"
    instead of re-opening the toast, which would loop).
  - *Given* a manual `set_lang` lands while the probe is in flight, *then* the
    manual choice wins: the probe result is discarded if the peer is no longer
    `"auto"` (apply-if-still-auto check).
- **R5 — Failure fallback.** *Given* the REST probe fails (network, non-2xx,
  unparseable body), *then* the server logs a warning, sends the speaker
  `Error{code:"detect_failed"}` (client toast: "Language detection failed —
  using English"), and proceeds with `en` so STT still works.
- **R6 — Transcript accuracy.** *Given* a session being recorded (spec 0009),
  *when* detection or a manual correction resolves my language, *then* my
  `session_participants.lang` row is updated so exports/PDF defaults reflect
  what was actually spoken, not `"auto"`.

## 4. Design & Architecture

- **Components / files:**
  - `server/src/deepgram.rs` — `detect_language()` REST probe (POST
    `/v1/listen?detect_language=true&model=nova-2`, `audio/webm` body, 10 s
    timeout) + pure `parse_detect_response()` reading
    `results.channels[0].detected_language` / `language_confidence`.
  - `server/src/lib.rs` — `start_detecting_session()` (the 4-phase pipeline,
    below), the `SetLang` handler, and live-language lookups: `Start` and chat
    paths read `rooms.peer_lang()` instead of the join-time `lang`, which goes
    stale the moment detection resolves.
  - `server/src/protocol.rs` — `ClientMessage::SetLang { lang }`;
    `ServerMessage::LanguageDetected { peer_id, lang, confidence? }`
    (`confidence` is `skip_serializing_if = None`).
  - `server/src/rooms.rs` — `set_peer_lang()` / `peer_lang()`;
    `get_room_languages()` skips peers still in `"auto"`.
  - `server/src/groq.rs` — `translation_prompt()` emits "Detect the source
    language yourself, then translate" when source is `"auto"`.
  - `server/src/transcripts.rs` — `update_participant_lang()`.
  - `server/src/config.rs` — `auto_detect_buffer_ms` (`AUTO_DETECT_BUFFER_MS`,
    default 3000).
  - `client/src/scripts/lang-detect.ts` — `initLangDetect` (deps: socket
    `send` + `restartCapture`), `onLanguageDetected` (interactive toast with
    the Change → endonym picker), `dismissLangToast` (call teardown).
  - `client/src/scripts/audio-capture.ts` — `restart()`: chains the new
    `start()` inside the old recorder's async `onstop` so the `stop`/`start`
    control frames stay ordered on the wire.
  - `client/src/scripts/app.ts` — `language_detected` / `detect_failed`
    handling, TTS guard on own `"auto"`, `initLangDetect` wiring;
    `client/src/pages/index.astro` — "Auto-detect" first `<option>` +
    `.lang-toast` styles; `client/src/scripts/i18n.ts` — `FLAG.auto = 🌐` and
    5 keys × 8 languages.
- **Data model:** none added. `session_participants.lang` is updated in place
  on resolution/correction.
- **Protocol / API:** `set_lang` (client→server) and `language_detected`
  (server→all) JSON text frames; error codes `bad_lang` (to sender) and
  `detect_failed` (to speaker only). No REST endpoints.
- **Sequence (happy path):**
  1. Client joins WS with `lang=auto`; the peers list shows `"auto"`.
  2. Speaker unmutes → `start` control frame → `live_lang == "auto"` routes
     to `start_detecting_session` instead of the normal speaking session.
  3. *Phase 1 — buffer:* WebM chunks accumulate until `AUTO_DETECT_BUFFER_MS`
     elapses, the 256 KiB cap hits, or the channel closes (early mute).
  4. *Phase 2 — probe:* the concatenated clip goes to the Deepgram REST
     endpoint; failure → fall back to `en` + `detect_failed` to the speaker.
  5. *Phase 3 — apply:* if the peer is still `"auto"`, set the room lang,
     update the participant row, broadcast `language_detected` with
     confidence; otherwise keep the (manually set) live language.
  6. *Phase 4 — stream:* open the streaming Deepgram WS in the final
     language, replay the buffered chunks in order, then bridge live chunks
     until the speaker stops.
  7. Clients update badges/participants; the speaker gets the Change toast.
  8. If the guess is wrong: Change → `set_lang` → server broadcast (no
     confidence) → client `restart()`s capture → next stream opens correctly.
- **Key decisions:**
  - *Buffer → REST probe → replay* (vs. opening the stream in a guessed
    language and switching) — Deepgram streaming cannot detect or switch
    language mid-connection; replaying the header-bearing buffer means the
    probe clip doubles as a valid stream prefix and nothing is lost.
  - *`confidence` as the auto/manual discriminator* — one message type for
    both paths; the client only opens the Change toast when confidence is
    present, so a manual-correction echo can't re-open it in a loop.
  - *Manual `set_lang` wins the probe race* (apply-if-still-auto) — the
    user's explicit choice is always more trustworthy than a 3 s clip.
  - *Server never restarts the audio session on `set_lang`* — only a fresh
    client MediaRecorder can produce the WebM header chunk a new Deepgram
    stream needs, so the client owns the restart; `restart()` chains inside
    `onstop` because a naive `stop(); start()` would emit the new `start`
    frame before the old `stop`, killing the new session.
  - *English fallback on probe failure* (vs. blocking STT) — a wrong-language
    transcript the user can correct beats a silent microphone.
  - *256 KiB buffer cap* — ~3 s of 32 kbps Opus is ~12 KiB; the cap only
    guards memory against pathological encoders.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Config knob `AUTO_DETECT_BUFFER_MS` (default 3000) | `server/src/config.rs` |
| S1 | REST probe + pure response parser | `server/src/deepgram.rs` |
| S2 | Live room language state; `"auto"` excluded from fan-out; self-detect prompt clause | `server/src/rooms.rs`, `server/src/groq.rs` |
| S3 | Detecting-session pipeline, `SetLang` handler, protocol messages, participant-row update | `server/src/lib.rs`, `server/src/protocol.rs`, `server/src/transcripts.rs` |
| S4 | Capture `restart()` + detected-language toast module | `client/src/scripts/audio-capture.ts`, `lang-detect.ts` |
| S5 | App wiring, Auto-detect option, toast styles, i18n (5 keys × 8 langs) | `client/src/scripts/app.ts`, `i18n.ts`, `pages/index.astro` |

## 6. Testing & Verification

- **Unit (server):** `deepgram.rs` — `parse_detect_response` extracts
  lang+confidence, tolerates missing confidence, rejects missing/empty
  `detected_language` (R1/R5); `groq.rs` — auto-source prompt contains the
  self-detect clause and no "Translate from" (R3); `rooms.rs` — `"auto"`
  excluded from fan-out targets until `set_peer_lang`, unknown peer/room
  return false/None (R3/R4); `protocol.rs` — `set_lang` deserializes,
  `language_detected` serializes confidence when present and omits the key
  entirely when manual (R4).
- **Integration (DB-gated,
  `tests/transcripts.rs::set_lang_resolves_auto_and_updates_participant_row`):**
  auto peer joins and the second peer sees `"auto"` in the roster; chat sent
  while pending fans out to the source-language echo only (no `"auto"` key,
  no Groq target) (R3); garbage codes (`auto`, empty, 9 chars, `p?q`) →
  `bad_lang` (R4); `" ES "` trims/lowercases to `es`, broadcasts to **both**
  sockets without `confidence`, and the `session_participants` row reads `es`
  (R4/R6).
- **Manual:** the live probe → replay → stream path needs a real Deepgram key
  and microphone audio, so R1/R2/R5 network behavior is verified manually;
  unit tests pin the parser and the pipeline's pure seams.

## 7. Deployment & Operations

- **Env:** `AUTO_DETECT_BUFFER_MS` (optional, default `3000`). Reuses the
  existing `DEEPGRAM_API_KEY` — no new secrets, no migration, no flag: the
  feature is always on (it only activates for peers who choose Auto-detect).
- **Cost note:** each auto-detect speaking start issues one extra Deepgram
  *prerecorded* request (the ~3 s probe clip) on top of the streaming
  session. Raising the buffer improves accuracy but delays first subtitles.
- Rollout as usual: server via `railway up` from `server/`; client
  autodeploys on push to `main`.

## 8. Risks / Open Items

- Detection is one-shot per speaking session: a speaker who switches language
  mid-call must use Change (or rejoin) — no continuous re-detection.
- 3 s of audio can be too little in noisy rooms or for similar languages, and
  there is no confidence floor: a low-confidence guess is applied anyway and
  relies on the Change toast for correction.
- The English fallback after `detect_failed` is only surfaced to the speaker;
  other peers just see an EN badge with no hint it was a fallback.
- First subtitles for an auto peer arrive as a small delayed burst (the
  replayed buffer) — accepted tradeoff for zero speech loss.
- If the speaker mutes before any audio is buffered, detection silently
  defers to the next unmute (the peer stays `"auto"` until then).

## 9. References

- Commits: `a594e94` (code unchanged behaviorally since; later commits only
  reformatted `deepgram.rs`/`groq.rs` and made `lang_name` `pub`)
- Files: `server/src/deepgram.rs`, `server/src/lib.rs`,
  `server/src/protocol.rs`, `server/src/rooms.rs`, `server/src/groq.rs`,
  `server/src/transcripts.rs`, `server/src/config.rs`,
  `client/src/scripts/lang-detect.ts`, `client/src/scripts/audio-capture.ts`,
  `client/src/scripts/app.ts`, `client/src/scripts/i18n.ts`,
  `client/src/pages/index.astro`
- Tests: `server/tests/transcripts.rs`
  (`set_lang_resolves_auto_and_updates_participant_row`)
- External: Deepgram language detection —
  https://developers.deepgram.com/docs/language-detection
- Numbering: canonical 0012 per the [README feature map](../README.md)
  (commit messages reused 0011–0015 inconsistently)
