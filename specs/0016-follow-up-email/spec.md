# 0016 — Follow-up email (AI draft + Resend delivery)

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-11 |
| **Shipped** | 2026-06-11 |
| **Version** | post-v1.0.0 AI bundle |
| **Commits** | (this PR) |
| **Depends on** | [0005](../0005-accounts-credits-billing/spec.md) (credits), [0009](../0009-session-transcripts/spec.md) (transcripts), AI report (spec 0014, commit `c2bc646`) |

## 1. Context & Problem

After a translated meeting ends, someone still has to write the recap email:
what was discussed, what was decided, who owns what. The transcript (spec 0009)
and the AI session report (spec 0014) already contain that information — but
getting it into an email means copy-pasting and rewriting, in whatever language
the recipients share.

This spec closes the loop: generate an editable follow-up email from the call
transcript (optionally led by the stored report's executive summary), let the
requester address it to session participants and/or typed addresses, edit it,
and send it through a transactional-email provider — without ever revealing
other participants' email addresses to the requester.

## 2. Goals / Non-Goals

**Goals**
- One-click recap email drafted by Groq from the session transcript, in a
  chosen tone and language, billed a flat credit price per draft.
- Recipients addressable two ways: session participants (by name — resolved to
  their account email server-side) and raw typed addresses (To or CC).
- Draft is editable (subject + body) before sending; sending is free.
- **Privacy contract:** another participant's email address NEVER reaches the
  requester — not in API responses, not in stored-draft echoes.
- Feature is optional: without `RESEND_*` env vars every email endpoint 503s
  and the client hides the composer entirely.

**Non-Goals**
- No scheduling, threading, reply-tracking, or attachments.
- No emails to guests (no account → no address on file; the API explains why).
- No per-recipient personalization — one email, addressed collectively.
- No Resend webhook ingestion (delivery status beyond the accepted message id).

## 3. Requirements

- **R1 — Draft from transcript.** As a logged-in participant of a session with
  transcript events, I want an AI-drafted recap email, so I don't write it by hand.
  - *Given* a session I took part in, *when* I POST `/api/sessions/{id}/email-draft`
    with ≥1 recipient, *then* I get a 201 with subject/body and am charged the
    flat `CREDITS_EMAIL_DRAFT` price (default $0.02).
  - *Given* the Groq call fails, *then* I get 502 "you were not charged" and no
    ledger row is written.
  - *Given* my balance is below the price, *then* I get the standard 402
    `insufficient_credits` body (feature `ai_email`).
- **R2 — Recipient resolution & privacy.** As a requester, I address
  participants by name; the server maps them to addresses.
  - *Given* a participant ref, *then* the stored draft keeps `user_id` + display
    name, and every API response strips `user_id` (and never adds an address).
  - *Given* a guest participant ref, *then* 400 "joined as a guest and has no
    account email".
  - *Given* duplicate refs (same account twice, same address cased differently),
    *then* they collapse to one recipient.
  - *Given* only CC recipients, *then* 400 — at least one To is required.
    Max 10 recipients total.
- **R3 — Edit & send.** As the draft owner, I can edit and send it once.
  - *Given* my draft, *when* I POST `email-send` with edited subject/body,
    *then* edits persist BEFORE the send attempt (a failed send keeps them),
    `body_html` is rebuilt from the edited text, and on success the draft flips
    to `sent` with Resend's message id.
  - *Given* someone else's draft, *then* 403; already sent, *then* 409; the
    send itself is free.
- **R4 — Grounding on the report.** *Given* a stored AI report (spec 0014) and
  `include_summary: true` (default), *then* the draft prompt leads with the
  report's `## Executive Summary` section — no extra model call.
- **R5 — Composer UI.** As a user on the session detail screen, I get an
  "✉️ Follow-up email" section (slot `#ai-email-slot`) with participant To-chips,
  typed To/CC addresses, tone, language, summary toggle, guidelines, a cost
  preview, then an editable subject/body with Send — localized in all 8 UI
  languages, hidden when the backend reports `email_enabled: false`.

## 4. Design & Architecture

- **Components / files:**
  - `server/src/email.rs` — `Resend` client (raw reqwest against
    `api.resend.com/emails`, mirrors the `Groq` client shape) + `OutboundEmail`.
  - `server/src/ai/email_draft.rs` — recipient resolution/sanitization, prompt
    builder, `generate_draft` (primary→fallback model dance shared with the
    report), `session_emails` persistence.
  - `server/src/api.rs` — `email_draft_generate`, `email_send`, `email_latest`
    handlers (billing gates, ownership, recipient→address resolution at send).
  - `client/src/scripts/email-utils.ts` — pure helpers (address check, chip
    state → `RecipientRef[]`), vitest-covered.
  - `client/src/scripts/email.ts` — composer rendered into `#ai-email-slot`;
    `client/src/scripts/api.ts` — REST wrappers; `session-screen.ts` wires
    `initEmailSlot` + `updateEmailContext(roster)`.
- **Data model:** `session_emails` (migration `005_features.sql`): id, session_id,
  user_id (owner), status `draft|sent|failed`, subject, body_html, body_text,
  recipients JSONB (`{kind:"participant",user_id,name,cc}` | `{kind:"email",email,cc}`),
  tone, guidelines, lang, resend_id, sent_at, created_at. Multiple rows per
  session — regenerate appends history.
- **Protocol / API:**
  - `POST /api/sessions/{id}/email-draft` `{recipients, tone?, guidelines?, lang?,
    include_summary?}` → 201 draft (+`cost`, `balance`) · 400 validation · 402
    insufficient · 422 empty transcript · 502 model failure · 503 not configured.
  - `POST /api/sessions/{id}/email-send` `{email_id, subject?, body_text?}` →
    200 `{status:"sent", resend_id, sent_at}` · 403/404/409 · 502 send failure.
  - `GET /api/sessions/{id}/email` → owner's latest draft/sent email (owner-scoped:
    drafts can hold raw addresses the requester typed).
  - `GET /api/billing/ai-pricing` gains `"email": {"draft": …}` and
    `"email_enabled": bool`.
- **Sequence (happy path):** composer collects refs → draft endpoint flushes
  transcripts, gates session access, resolves refs against
  `session_participants`, condenses transcript (map-reduce from the AI bundle),
  prepends report summary, Groq JSON-mode draft → atomic credit deduction →
  insert row → client shows editable draft → send endpoint persists edits,
  resolves participant user_ids → addresses (server-side only), Resend send →
  `mark_sent`.
- **Key decisions:**
  - *Recipients stored as refs, resolved at send time* → privacy (no address in
    any response) and correctness if a user changes their account email between
    draft and send. Alternative (resolve at draft time) rejected: leaks + staleness.
  - *Same user-favorable billing policy as the report* (no charge on model
    failure; withhold output on genuine InsufficientFunds at the gate; deliver
    free if OUR deduct/persist fails after generation) — consistency across AI
    features.
  - *Send persists edits before attempting delivery* → a Resend outage never
    eats the user's edits; a failed status flip after delivery logs loudly but
    never errors the user into double-sending.
  - *`body_html` rebuilt from edited text* (`text_to_html`, escaped) → the two
    MIME parts cannot drift; the model's richer HTML is kept only when untouched.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Config + migration (committed with the AI-bundle foundations) | `config.rs` (`ResendConfig`, `CREDITS_EMAIL_DRAFT`), `migrations/005_features.sql` |
| S1 | Resend client | `server/src/email.rs` |
| S2 | Draft engine: refs, prompt, generation, persistence | `server/src/ai/email_draft.rs` |
| S3 | REST endpoints + routes + state | `server/src/api.rs`, `server/src/lib.rs` |
| S4 | Client API wrappers + pure helpers | `client/src/scripts/api.ts`, `email-utils.ts` |
| S5 | Composer UI + wiring + styles + i18n (8 langs) | `client/src/scripts/email.ts`, `session-screen.ts`, `pages/index.astro`, `i18n.ts` |

## 6. Testing & Verification

- **Unit (server):** `email.rs` body shaping (from-format, cc omitted when
  empty); `email_draft.rs` — flat cost, address validation, resolution
  happy/dedup/reject paths (R2), sanitization strips `user_id`, exec-summary
  extraction, text→HTML escaping, prompt assembly (tone/lang/summary/guidelines).
- **Integration (`tests/transcripts.rs::email_draft_send_gates_and_billing`):**
  503 feature gate, 401/403/404 access gates, validation 400s, 422 empty
  session, 402 pre-check, Groq-failure → 502 + untouched balance + zero ledger
  rows (R1), stored-draft GET sanitization + owner-scoping, send 404/403/409,
  failed send keeps edited draft + status stays `draft` (R3).
- **Unit (client):** `email-utils.test.ts` — address check parity with the
  server, chip-state mapping + dedup.
- **Gates:** server `cargo llvm-cov` ≥85% lines (85.57% at ship), client vitest
  thresholds ≥85 (95.5% lines), `astro check` 0 errors, full Playwright e2e
  suite green (12) — the composer itself is auth+billing-gated and exercised
  manually (guest e2e backend can't reach it).

## 7. Deployment & Operations

- **Env (server):** `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME` —
  all-or-nothing, like billing; absent → endpoints 503, pricing reports
  `email_enabled: false`, client hides the section. `CREDITS_EMAIL_DRAFT`
  (default `0.02`).
- **Migration:** `005_features.sql` (`session_emails`) runs at startup; already
  shipped with the AI-bundle foundations.
- **Resend:** the `from` domain must be verified in the Resend dashboard before
  production sends; the API key lives only in Railway env.
- Rollout: server via `railway up` from `server/`; client autodeploys on push.

## 8. Risks / Open Items

- `status: 'failed'` exists in the schema CHECK but is never written yet — a
  failed send currently keeps `draft` (deliberate: retryable). Revisit if
  delivery analytics are ever needed.
- No Resend webhook → "sent" means *accepted by Resend*, not *delivered*.
- Spec docs for the rest of the AI bundle (glossary `18d20f8`, auto-detect
  `a594e94`, bookmarks `f6eb14a`, report `c2bc646`, sentiment `d5ce553`) were
  never written; their commit messages reused numbers 0011–0015 inconsistently.
  Backfill pending — see the README feature map.

## 9. References

- `server/src/email.rs`, `server/src/ai/email_draft.rs`, `server/src/api.rs`
- `client/src/scripts/email.ts`, `email-utils.ts`, `session-screen.ts`
- Resend API: https://resend.com/docs/api-reference/emails/send-email
- Billing policy precedent: AI session report (commit `c2bc646`)
