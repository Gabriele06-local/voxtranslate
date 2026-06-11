# 0013 — In-call bookmarks: labels, side panel, exports

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-11 *(retroactive backfill)* |
| **Shipped** | 2026-06-10 |
| **Version** | post-v1.0.0 AI bundle |
| **Commits** | `f6eb14a` |
| **Depends on** | [0009](../0009-session-transcripts/spec.md) (bookmarks interleave into transcript exports) |

*Authored retroactively on 2026-06-11 from the shipped code and commit history (backfill of the AI-bundle specs).*

## 1. Context & Problem

Spec 0009 made calls durable: speech finals and chat persist per session and
come back as JSON/PDF transcripts. But a one-hour multilingual meeting yields
hundreds of transcript rows, and "the moment we agreed on the budget" is buried
somewhere in the middle. Participants need a way to flag *this moment matters*
**while it is happening** — without breaking their flow to type — and to find
those moments again afterwards, both in the app and in the exported documents.

This spec adds in-call bookmarks: a one-tap 🔖 pin that the server timestamps,
an optional label added right after (or later), a side panel to review and edit
pins during the call, pinned-moments on the post-call session screen, and gold
marker rows interleaved chronologically into the JSON and PDF transcript
exports. Bookmarks also become anchors for the rest of the AI bundle (report
prompt section, sentiment-chart markers — see §8).

## 2. Goals / Non-Goals

**Goals**
- One-tap pin: the instant the button is pressed is what gets stamped — the
  client sends no timestamp, the server stamps "now" (no client clock skew).
  Labeling is a separate, optional follow-up step.
- Shared visibility, owned mutations: every participant sees every pin (with
  creator's display name); only the creator can relabel or delete their own.
- Exports: `transcript.json` gains a `bookmarks` array; the PDF interleaves
  gold "BOOKMARK" marker rows chronologically among events, injection-safe.
- **Privacy:** creators are exposed by display name only — user UUIDs never
  leave the server (same contract as the 0009 exports).
- Auth-only: guests have no `users` row, so the button never appears for them
  and the API is JWT-gated.

**Non-Goals**
- No bookmarks for guests (FK to `users` is NOT NULL by design).
- No live push of other participants' pins over the room WebSocket — the side
  panel re-pulls on open instead.
- No bookmarks in the SRT/VTT subtitle exports (markers would corrupt cue
  timing); JSON + PDF only.
- No seeking/deep-linking the composite recording (spec 0010) to a bookmark.
- No per-session cap on pin count (only the 200-char label cap).

## 3. Requirements

- **R1 — Instant pin.** As a logged-in participant in a transcript-backed
  call, I want to pin the current moment with one tap, so I don't lose it
  while talking.
  - *Given* an active session, *when* I POST
    `/api/sessions/{id}/bookmarks` with an empty body, *then* I get 201 with
    `{id, ts, label: null, by, mine: true}` and `ts` is the **server's** now
    (`COALESCE($ts, now())`); an explicit `ts` in the body is honored (used by
    tests / future backfill).
- **R2 — Optional label, capped and trimmed.** As the pin's creator, I can
  attach a short label after pinning.
  - *Given* a label on create or PATCH, *then* it is trimmed; empty/whitespace
    becomes `NULL` (clears it); more than 200 chars (counted as `chars()`, not
    bytes) → 400 "label too long".
- **R3 — Shared list, viewer-relative ownership.** As a participant, I see
  everyone's pins; the UI knows which are mine.
  - *Given* pins by multiple participants, *when* anyone GETs the list, *then*
    all pins return chronologically (`ORDER BY ts`) with creator display name
    in `by` and `mine` computed against the viewer (`b.user_id = $viewer`).
  - *Given* a non-participant, *then* GET/POST → 403 "not a participant";
    unknown session → 404; no JWT → 401; transcripts service absent (no
    `DATABASE_URL`) → 503.
- **R4 — Owner-only mutations with honest status codes.** As the creator, only
  I can relabel (PATCH) or delete my pin.
  - *Given* someone else's bookmark id, *when* I PATCH/DELETE, *then* 403 "not
    your bookmark"; *given* an unknown id, *then* 404 "no such bookmark";
    success → 204. (Implemented as a single owner-scoped UPDATE/DELETE; on 0
    rows affected an EXISTS probe disambiguates 403 vs 404.)
- **R5 — Exports carry bookmarks.** As a participant downloading the
  transcript, I find the pinned moments in it.
  - *Given* pins exist, *when* I GET `transcript.json`, *then* the document has
    a `bookmarks: [{ts, label, by}]` array (no ids of any kind), chronological.
  - *Given* the PDF export, *then* each bookmark renders as a gold-badge
    marker row (`BOOKMARK` + creator + italic label) interleaved
    chronologically among speech/chat rows; labels are user text and must
    render literally — Typst markup/code in a label cannot execute or alter
    layout (it crosses via the same `sys.inputs` JSON channel as all events).
- **R6 — In-call UX.** As an authed user in a call, the flow never interrupts me.
  - *Given* the call screen, *then* a 🔖 button shows in the control bar (hidden
    for guests and when the session is not transcript-backed); *when* pressed,
    the pin POSTs immediately, then a popover offers a label input that
    auto-dismisses after ~3 s (typing/focus re-arms the timer; Enter saves via
    PATCH; Escape closes); an "All bookmarks" button opens the side panel.
  - *Given* the side panel (chat/participants-panel pattern, bottom sheet on
    mobile), *then* it re-pulls the full list on open (other participants' pins
    appear), and my own rows get inline edit (Enter saves, empty clears,
    Escape cancels, blur saves) and delete controls — gated by `mine`.
  - *Given* I leave the call, *then* the button hides and the panel closes.
- **R7 — Post-call review + i18n.** *Given* the session detail screen, *then*
  pinned moments render above the transcript (gold left-border rows: time,
  creator, label), hidden when none exist. All 11 new UI strings
  (`bookmarkTip`, `bookmarkAdded`, `bookmarkFailed`, `bookmarkLabelPh`,
  `bookmarksTitle`, `bookmarksEmpty`, `bookmarkNoLabel`, `bookmarkEdit`,
  `bookmarkDelete`, `saveBtn`, `showAllBookmarks`) are localized in all 8 UI
  languages.

## 4. Design & Architecture

- **Components / files:**
  - `server/src/transcripts.rs` — `Bookmark` (API shape, with `mine`),
    `ExportBookmark` (export shape, no ids), `BookmarkMutation`
    (`Ok|Forbidden|NotFound`); `add_bookmark`, `list_bookmarks`,
    `update_bookmark_label`, `delete_bookmark`, private `bookmark_gate`
    (EXISTS probe for 403-vs-404); `export()` embeds the bookmarks array.
  - `server/src/api.rs` — `bookmarks_list`, `bookmark_add`, `bookmark_update`,
    `bookmark_delete` handlers; `clean_label` (trim/clear/cap),
    `session_gate` (shared 404/403 participant gate, also reused by later
    session-scoped AI endpoints), `bookmark_mutation_response`.
  - `server/src/lib.rs` — routes under `/api/sessions/{id}/bookmarks[/{bid}]`.
  - `server/src/pdf.rs` — events + bookmarks merged into one
    `(ts, json)` timeline, sorted, emitted as rows with a `marker` flag;
    `server/src/templates/transcript.typ` — marker branch renders the gold
    badge (`#fdf3d7` fill / `#8a6d1a` text) + creator + italic label.
  - `client/src/scripts/api.ts` — `Bookmark`/`ExportBookmark` types,
    `fetchBookmarks` / `addBookmark` / `updateBookmarkLabel` /
    `deleteBookmark` wrappers (null/false on any failure — UI stays calm).
  - `client/src/scripts/bookmarks.ts` — all in-call UI state: button, popover
    with re-armable 3 s dismiss, side panel, inline edit; `setBookmarkSession`
    is the on/off switch wired from `room_joined` / `leaveCall` in `app.ts`.
  - `client/src/scripts/session-screen.ts` — `renderBookmarks` (pinned-moments
    block above the transcript); `client/src/pages/index.astro` — markup +
    styles (panel, popover, mobile bottom sheet); `client/src/scripts/icons.ts`
    — `bookmark`, `pencil`, `trash` SVGs.
- **Data model:** `transcript_bookmarks` (migration `005_features.sql`,
  shipped with the AI-bundle foundations `41e3bee`): `id` UUID PK,
  `session_id` UUID FK → `call_sessions` ON DELETE CASCADE, `user_id` UUID FK
  → `users` ON DELETE CASCADE (labels are PII-adjacent → GDPR account-deletion
  cascade; guest-only session purge from 0009 sweeps them too), `ts`
  TIMESTAMPTZ, `label` VARCHAR(200) NULL, `created_at`; index
  `(session_id, ts)`.
- **Protocol / API:** (all JWT-authed; 503 when transcripts are unconfigured)
  - `POST /api/sessions/{id}/bookmarks` `{ts?, label?}` → 201 `Bookmark` ·
    400 label too long · 401/403/404.
  - `GET /api/sessions/{id}/bookmarks` → 200 `Bookmark[]` chronological ·
    401/403/404.
  - `PATCH /api/sessions/{id}/bookmarks/{bid}` `{label}` (`null`/empty clears)
    → 204 · 400 · 403 not owner · 404 unknown id.
  - `DELETE /api/sessions/{id}/bookmarks/{bid}` → 204 · 403 · 404.
  - `GET /api/sessions/{id}/transcript.json` → document gains
    `bookmarks: [{ts, label, by}]`; `transcript.pdf` interleaves marker rows.
- **Sequence (happy path):** user taps 🔖 → `addBookmark` POSTs `{}` →
  participant gate → INSERT with `now()` → 201 echoed into local state →
  popover shows "Bookmark added" + label input (3 s) → Enter PATCHes the label
  → side panel on open re-fetches everyone's pins → after the call, the
  session screen and the JSON/PDF exports show the same moments.
- **Key decisions:**
  - *Pin first, label after (two requests)* → the timestamp captures the exact
    press, typing never delays it, and abandoning the popover still keeps the
    pin. Alternative (single labeled POST) rejected: label typing time would
    skew the moment or require client timestamps.
  - *Server stamps `ts` via `COALESCE($3, now())`* → immune to client clock
    skew; the explicit-`ts` escape hatch stays for tooling/tests.
  - *403-vs-404 via post-hoc EXISTS gate* → the happy path is one owner-scoped
    statement; only a 0-rows-affected outcome pays for the second query, and
    semantics stay honest (404 unknown, 403 not yours).
  - *Display name + viewer-relative `mine` flag, never user ids* → keeps the
    0009 privacy contract (user UUIDs never leave the server) while still
    letting the client gate edit/delete UI.
  - *Bookmarks cross into the PDF through the same `sys.inputs` JSON channel
    as events* → injection-safe by construction; no new escaping surface
    (pinned by a dedicated injection fixture, see §6).
  - *REST, not WebSocket* → bookmarks are session data, not call signaling;
    no protocol change, and the panel-open refresh is fresh enough. Rejected:
    broadcasting pins over the room WS (extra protocol surface for marginal
    value).
  - *List/create take the shared `session_gate`; mutations rely on the
    owner-scoped WHERE clause instead* — ownership is the stronger gate, so a
    non-participant can never read or alter anything (see §8 for the one
    cosmetic status-code nuance).

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | `transcript_bookmarks` table + index (shipped earlier with the AI-bundle foundations, `41e3bee`) | `server/migrations/005_features.sql` |
| S1 | Service CRUD + 403/404 gate + export embed | `server/src/transcripts.rs` |
| S2 | REST handlers, label hygiene, shared session gate, routes | `server/src/api.rs`, `server/src/lib.rs` |
| S3 | PDF timeline interleave + gold marker template | `server/src/pdf.rs`, `server/src/templates/transcript.typ` |
| S4 | Client types + REST wrappers | `client/src/scripts/api.ts` |
| S5 | In-call UI: 🔖 button, label popover, side panel, inline edit | `client/src/scripts/bookmarks.ts`, `app.ts`, `pages/index.astro`, `icons.ts` |
| S6 | Session-screen pinned moments + i18n (11 keys × 8 langs) | `client/src/scripts/session-screen.ts`, `i18n.ts` |

## 6. Testing & Verification

- **Integration (`server/tests/transcripts.rs::bookmarks_crud_gates_and_export`)**
  — the full matrix in one two-participant session: instant pin returns
  server-stamped `ts` + `mine: true` (R1); 201-char label → 400, PATCH trims
  whitespace, blank PATCH clears to null (R2); both viewers see both pins
  chronologically (explicit earlier `ts` sorts first) with viewer-relative
  `mine` (R3); cross-owner PATCH/DELETE → 403, unknown id → 404, stranger →
  403, no token → 401, unknown session → 404 (R3/R4); `transcript.json`
  embeds `{ts, label, by}` with **no** id fields and null for cleared labels
  (R5); owner delete → 204; deleting the session cascades the remaining rows.
- **Unit (`server/src/pdf.rs::bookmarks_interleave_as_marker_rows`)** — marker
  rows sort chronologically between events; a hostile fixture
  (`#eval`, `#pagebreak`, bracket-escape attempts in both `label` and `by`)
  renders literally on a single page (R5), alongside the pre-existing
  `user_text_never_executes_as_typst` test for event text.
- **Client:** no dedicated unit tests — `bookmarks.ts` is DOM-wiring around
  the (trivially thin) `api.ts` wrappers; the in-call flow is auth-gated so
  the guest-mode Playwright backend can't reach it and it was exercised
  manually. Coverage gates (server llvm-cov ≥85%, client vitest thresholds,
  `astro check`, e2e suite) stayed green at ship.

## 7. Deployment & Operations

- **No new env vars.** Feature rides the existing transcript stack: without
  `DATABASE_URL` the transcripts service is absent and every bookmark endpoint
  returns 503 (the client button never appears anyway because guests-only
  servers issue no `session_id`).
- **Migration:** `005_features.sql` is idempotent (`IF NOT EXISTS`) and runs
  at server startup; it shipped ahead of this feature with the AI-bundle
  foundations commit `41e3bee`.
- **GDPR:** no new runbook steps — bookmark rows cascade with account deletion
  (`user_id` FK) and with session purges (`session_id` FK), including the
  0009 guest-only session sweep.
- Rollout: server via `railway up` from `server/`; client autodeploys on push.

## 8. Risks / Open Items

- **No live sync:** another participant's new pin only appears when you
  (re)open the side panel or reload the session screen. Acceptable for v1;
  a WS broadcast would fix it if pins become collaborative.
- **Mutation endpoints skip the participant gate** (ownership filtering makes
  them safe), so a *stranger* probing PATCH/DELETE with a valid bookmark id
  gets 403 "not your bookmark" instead of a session-level 404 — a marginal
  existence oracle on unguessable UUIDs. Cosmetic; tighten if it ever matters.
- **SRT/VTT exports omit bookmarks** by design; revisit only if a captions
  use-case appears.
- **Popover dismiss is time-based (~3 s)** — slow typists are covered by the
  re-arm-on-input, but the label can still be added later from the panel.
- **Downstream consumers landed after `f6eb14a`** (current behavior, noted as
  post-ship evolution): the AI transcript condenser appends a
  `BOOKMARKS (moments participants flagged as important)` section so the
  report can ground a "Key moments" section (`server/src/ai/mod.rs`,
  `ai/report.rs`, spec 0014 commit `c2bc646`); the sentiment chart draws
  bookmark offsets as vertical markers (`client/src/scripts/sentiment.ts`,
  `sentiment-chart.ts`, spec 0015 commit `d5ce553`), fed by
  `session-screen.ts` as seconds-from-start.
- Spec backfill for the rest of the AI bundle (0011, 0012, 0014, 0015) is
  tracked in the README feature map.

## 9. References

- Commits: `f6eb14a` (feature), `41e3bee` (migration, AI-bundle foundations)
- Server: `server/src/transcripts.rs`, `server/src/api.rs`, `server/src/lib.rs`,
  `server/src/pdf.rs`, `server/src/templates/transcript.typ`,
  `server/migrations/005_features.sql`, `server/tests/transcripts.rs`
- Client: `client/src/scripts/bookmarks.ts`, `api.ts`, `app.ts`,
  `session-screen.ts`, `icons.ts`, `i18n.ts`, `client/src/pages/index.astro`
- Sibling specs: [0009 session transcripts](../0009-session-transcripts/spec.md),
  [0016 follow-up email](../0016-follow-up-email/spec.md)
- Typst injection-safety precedent: spec 0009 (`sys.inputs` JSON channel)
