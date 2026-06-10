# 0009 — Session transcript download (PDF + JSON)

| | |
|---|---|
| **Status** | In progress |
| **Owner** | Micio Dev |
| **Created** | 2026-06-10 |
| **Shipped** | — |
| **Version** | — |
| **Commits** | — |
| **Depends on** | [0001](../0001-voice-translation-rooms/spec.md), [0002](../0002-video-calls-translated-chat/spec.md), [0005](../0005-accounts-credits-billing/spec.md), [0006](../0006-trust-safety-gdpr/spec.md) |

## 1. Context & Problem

Transcripts are ephemeral today: Deepgram finals are translated (Groq fan-out) and
broadcast as `subtitle_final`, chat as `chat_message`, then discarded — nothing is
persisted. Users in multilingual meetings need a durable record of who said what,
when, in which language, and how it was translated. The DB layer (Supabase Postgres,
sqlx, migrations `001`–`003`) and auth (JWT + `AuthUser`) from 0005/0006 make
persistence and access control possible.

## 2. Goals / Non-Goals

**Goals**
- Persist speech finals + chat per call session (room lifetime) when the DB is configured.
- `GET /api/sessions/{id}/transcript.json` and `…/transcript.pdf` downloads, restricted to participants.
- `GET /api/sessions` history list; post-call summary modal + Transcripts tab in the client.
- PDF renders all 8 UI languages including CJK (typst + bundled Noto fonts).
- GDPR: transcript data included in `/api/user/data`; erased on account deletion; guest-only sessions purged.

**Non-Goals**
- Audio/video recording (see [0010](../0010-composite-recording/spec.md) — client-side).
- Transcript search, editing, sharing links, retention policies (follow-up).
- Localized PDF labels (English-only chrome in v1; transcript content is multilingual).

## 3. Requirements

- **R1 — Persistence.** As a participant, I want my session's speech and chat recorded server-side, so that I can download it later.
  - *Given* a DB-configured server, *when* a room is created, *then* a `call_sessions` row exists and finals/chat insert as `transcript_events` (batched ≤3s).
  - *Given* a moderation-blocked message, *then* it is never persisted.
- **R2 — JSON export.** As an authenticated participant, I want a machine-readable transcript.
  - *Given* a session I participated in, *when* I GET `transcript.json`, *then* I receive pretty-printed JSON (session metadata, participants, chronological events with full translation maps, `exported_at`) as an attachment.
- **R3 — PDF export.** As an authenticated participant, I want a printable transcript.
  - *Given* the same session, *when* I GET `transcript.pdf?tz=Europe/Rome&lang=it`, *then* I receive a valid PDF: header (room, date, duration, participants), chronological entries `[HH:MM:SS] Speaker` in local time, original (gray) + chosen translation (bold), `[CHAT]` rows, ≤4 speaker colors, footer with page numbers + export stamp; CJK text renders.
- **R4 — Access control.** *Given* a non-participant's JWT → **403**; unknown id → **404**; no token → **401**; >5 PDF req/min/user → **429**.
- **R5 — Guest privacy.** *Given* a session whose participants were all guests, *when* it ends, *then* its rows are purged (guests can never download; storing is pure liability).
- **R6 — Client UX.** *Given* a recorded call ends, *then* a summary modal offers Download PDF (primary) / JSON (secondary), disabled with a tooltip when 0 events; past sessions downloadable from the Usage→Transcripts tab; a subtle indicator shows during recorded calls.
- **R7 — GDPR.** `/api/user/data` includes the user's sessions + own utterances; account deletion cascades transcript rows.

## 4. Design & Architecture

- **Components / files:**
  - `server/src/rooms.rs` — `Room.session_id`; `join → Joined{session_id, existing}`, `remove → Option<Uuid>`, `prune → Vec<Uuid>` (dropped sessions).
  - `server/src/transcripts.rs` — `TranscriptService`: mpsc recorder task (3s/64-event batch `INSERT…SELECT FROM UNNEST` inner-joined to `call_sessions`), `flush()` oneshot barrier, `finalize_session` (flush → `ended_at` → guest-only purge), `access`/`export`/`list_sessions` queries.
  - `server/src/pdf.rs` + `server/src/templates/transcript.typ` — typst engine (`typst-as-lib`, `OnceLock`, fonts `include_bytes!`); all user data crosses as one JSON string via `sys.inputs` (never interpolated into markup — injection safety).
  - `server/src/api.rs` — `sessions_list`, `transcript_json`, `transcript_pdf` handlers.
  - `client/src/scripts/auth.ts` (`fetchSessions`, `downloadTranscript`, shared `downloadBlob`), `app.ts` (session id, event counter, post-call modal), `index.astro`, `i18n.ts`.
- **Data model:** `call_sessions(id, room, started_at, ended_at)`; `session_participants(id, session_id FK, peer_id, user_id FK NULL→guest, name, lang, joined_at, left_at)`; `transcript_events(id, session_id FK, event_type speech|chat, speaker_peer_id, speaker_user_id FK, speaker_name, original_text, original_lang, translations JSONB, ts, created_at)` — all user FKs `ON DELETE CASCADE` (R7). Migration `004_transcripts.sql`.
- **Protocol / API:** `room_joined` gains optional `session_id` (present ⇔ recording on); REST: `GET /api/sessions`, `GET /api/sessions/{id}/transcript.json`, `GET /api/sessions/{id}/transcript.pdf?tz&lang`.
- **Sequence (happy path):** 1. first peer joins → room + session row; 2. participants upserted on join/leave; 3. Deepgram final / chat → moderation → translate fan-out → `record()` → broadcast; 4. recorder batch-inserts; 5. last peer leaves → finalize (flush, `ended_at`, guest purge); 6. client modal → authenticated fetch → flush barrier → access check → export.
- **Key decisions:**
  - *Full translation map stored/exported* (JSONB) instead of the single-translation shape — the fan-out produces N translations; dropping data was rejected. PDF picks one via `?lang`.
  - *typst over printpdf/genpdf* — per-glyph font fallback gives CJK correctness; output stays small via glyph subsetting. Cost: +~25 MB binary, slower cold build. Pinned exact versions (API churn risk).
  - *Record-all + guest-only purge* over record-only-with-auth-present — late-joining authed users still get a full transcript.
  - *Endpoint-side `flush().await` barrier* kills the leave-then-download race without tight batch intervals.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Specs 0009/0010 + README rows | `specs/` |
| S1 | Migration, session ids, TranscriptService, capture wiring | `migrations/004_transcripts.sql`, `rooms.rs`, `transcripts.rs`, `lib.rs`, `deepgram.rs`, `protocol.rs` |
| S2 | JSON export + sessions list + GDPR | `api.rs`, `safety.rs`, `tests/transcripts.rs` |
| S3 | PDF: fonts, template, engine, endpoint, Docker | `pdf.rs`, `templates/transcript.typ`, `assets/fonts/`, `Dockerfile` |
| S4 | Client UI + i18n | `auth.ts`, `app.ts`, `index.astro`, `i18n.ts` |

## 6. Testing & Verification

- Unit: rooms session-id lifecycle (R1), protocol session_id serialization, PDF magic bytes/page counts/CJK/markup-injection fixtures (R3), DB-gated recorder tests incl. guest purge + late-event drop (R1, R5).
- Integration (`tests/transcripts.rs`, DB-gated, 127.0.0.1, no env mutation): WS join → chat → leave → JSON structure (R2), PDF headers + `%PDF-` (R3), 401/403/404/429 (R4), guest purge (R5).
- Client: vitest fetch/download helpers; Playwright guest backend asserts indicator hidden + no modal (R6 guest path).

## 7. Deployment & Operations

- No new env vars. Migration `004` auto-applies at startup (idempotent).
- `server/Dockerfile` must `COPY assets ./assets` (compile-time `include_bytes!`).
- Railway cold build +3–5 min (typst deps); binary +~25 MB.
- Disabled automatically in guest-only deployments (no `DATABASE_URL`) — endpoints 503, no UI affordances.

## 8. Risks / Open Items

- `typst-as-lib` API churn → exact-pinned; fallback is a vendored ~150-line `typst::World`.
- Unbounded retention → follow-up: 90-day purge (cron or Directus Flow).
- Privacy page should mention transcript recording + participant export (Directus content, 0008).
- Orphaned sessions when the only authed participant deletes their account (events cascade away; session row remains).
- CJK bold falls back to Regular weight (only Regular CJK bundled) — cosmetic.

## 9. References

- Files: `server/src/transcripts.rs`, `server/src/pdf.rs`, `server/migrations/004_transcripts.sql`
- External: typst (typst.app/docs), typst-as-lib (github.com/Relacibo/typst-as-lib), Noto fonts (github.com/notofonts)
