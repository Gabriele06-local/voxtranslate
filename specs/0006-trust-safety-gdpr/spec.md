# 0006 — Trust & safety + GDPR

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-10 |
| **Shipped** | 2026-06-10 |
| **Version** | post-v1.0.0 |
| **Commits** | `4b84f87` (server), `b166d9b` (client), `bb52a63` (e2e fix) |
| **Depends on** | [0005](../0005-accounts-credits-billing/spec.md) |

## 1. Context & Problem

A public, real-time A/V product with accounts and payments needs a **trust & safety**
and **GDPR** layer before it can responsibly take users: age/consent gating, content
moderation on speech and chat, per-peer reporting and local blocking, account bans,
and data-subject rights (export + erasure). This spec adds that layer end-to-end.

## 2. Goals / Non-Goals

**Goals**
- **Consent gate**: confirm age (18+) and accept the current ToS version before use.
- **Moderation**: deterministic whole-word blocklist on chat + finalized transcripts; warn the sender.
- **Report & block**: report a peer to the server; locally block (mute + hide) a peer.
- **Bans**: server can ban a user (until a time); banned users can't connect.
- **GDPR rights**: export all of my data; delete my account (cascade erasure).
- **Legal pages**: `/terms`, `/privacy`, `/acceptable-use` (8 languages), listing processors + retention + rights.
- Public-room access requires login **only when a live DB is present** (don't lock public rooms in the degraded guest-only fallback).

**Non-Goals**
- ML/contextual moderation (deterministic blocklist only at this stage).
- Human moderation queue UI (server records reports; admin tooling is [0007](../0007-backoffice-directus/spec.md)).

## 3. Requirements

- **R1 — Age + consent.** *Given* a new/again-prompted user, *when* they enter, *then* a consent/age
  modal blocks use until accepted; `POST /api/user/consent` returns **403 if age not confirmed**;
  `CURRENT_TOS_VERSION = "2026-06-10"`. Existing users get `age_confirmed=false` → must re-consent (intended GDPR re-consent).
- **R2 — Moderate content.** *Given* a chat message or finalized transcript, *when* it contains a
  blocklisted whole word above the severity gate, *then* it's blocked and the sender gets `moderation_warning`.
  The `Moderator` loads default slurs + optional `MODERATION_BLOCKLIST`, later overlaid by DB `blocklist_terms` ([0007](../0007-backoffice-directus/spec.md)).
- **R3 — Report a peer.** *Given* another participant, *when* I report them, *then* `POST /api/report`
  records a `reports` row (lifecycle: open → resolved).
- **R4 — Block a peer locally.** *Given* a peer I don't want to see/hear, *when* I block them, *then*
  the client mutes + hides them locally (no server round-trip needed).
- **R5 — Ban enforcement.** *Given* a banned user, *when* they open a WS, *then* `authorize()` rejects
  the connection (`is_banned` / `banned_until`).
- **R6 — Data export.** `GET /api/user/data` returns all my data (Postgres `json_build_object`::text).
- **R7 — Erasure.** `DELETE /api/user` deletes my account and cascades (FK `ON DELETE CASCADE`).
- **R8 — Legal pages.** `/terms`, `/privacy`, `/acceptable-use` render in 8 languages, flagged
  **DRAFT — needs lawyer review**, listing processors (Google, Deepgram, Groq, Stripe, Supabase, Vercel, Railway) + retention + GDPR rights.

## 4. Design & Architecture

**Data (`migrations/002_safety.sql`, idempotent, auto-run at startup)**
- `users` += `age_confirmed`, `consent_tos_at`, `tos_version`, `banned_until`, `banned_reason`.
- `reports` table (FK `ON DELETE CASCADE` for erasure).

**Server modules**
- `moderation.rs` — `Moderator::from_env()`: default slurs + optional `MODERATION_BLOCKLIST`;
  deterministic **whole-word** match; severity gate on chat + final transcripts.
- `safety.rs` — `SafetyService`: `report` / `consent` / `ban` / `is_banned` / GDPR `export` (`json_build_object`) / `delete_user` (cascade).
- `lib.rs` WS gates: ban check in `authorize()`; **public-room login requirement keys off
  `state.pool.is_some()` (live DB), not config** — this avoids locking public rooms in the
  degraded guest-only fallback (it was a test-breaking bug: integration `make_state` enables
  billing config when `DATABASE_URL` is set).
- Endpoints: `POST /api/report`, `POST /api/user/consent` (403 if !age), `GET /api/user/data`, `DELETE /api/user`.
- `protocol.rs`: `moderation_warning { message }`.

**Client (`client/src/scripts/`, `client/src/pages/`)**
- Consent/age modal (gate), per-peer **report** + local **block** (mute + hide), GDPR export/delete panel, cookie banner.
- Legal pages `terms.astro` / `privacy.astro` / `acceptable-use.astro`; i18n ×8.

**Key decisions**
- **Deterministic whole-word blocklist** (not ML) → predictable, auditable, cheap; DB-overridable later.
- **Login-for-public-rooms gates on live DB, not config** → degraded mode never accidentally locks public rooms.
- **Erasure via FK cascade** → one `DELETE` removes all dependent rows; reports/usage cascade.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Schema + auto-migrate | `migrations/002_safety.sql`, `db.rs` |
| S1 | Moderation engine | `moderation.rs` |
| S2 | Safety service + endpoints | `safety.rs`, `api.rs`, `lib.rs` |
| S3 | Consent gate + report/block UI | `client/src/scripts/app.ts` |
| S4 | GDPR panel + cookie banner | `client/src/scripts/app.ts` |
| S5 | Legal pages ×8 langs | `client/src/pages/{terms,privacy,acceptable-use}.astro` |

## 6. Testing & Verification

- Server integration tests cover moderation gating, consent 403, ban rejection, export/erasure.
- e2e fix `bb52a63`: billing fixtures marked **consented** so the consent gate doesn't block them.
- No new Railway env vars required. See [[auth-billing-feature]].

## 7. Deployment & Operations

- Migration `002_safety.sql` runs automatically at startup via `db::migrate`.
- **DEPLOYED to prod (2026-06-10).** Existing logged-in users re-consent on next visit.
- The blocklist baseline can be extended via `MODERATION_BLOCKLIST` and (later) DB `blocklist_terms`.
- Legal copy is DRAFT — flagged needs-lawyer-review.

## 8. Risks / Open Items

- Moderation is keyword-only → misses obfuscation/context; mitigated by report+block + admin bans.
- Legal pages are templates, not legal advice — must be reviewed by counsel before relied upon.

## 9. References

- Commits: `4b84f87`, `b166d9b`, `bb52a63`
- Files: `server/src/{moderation,safety,lib,api,protocol}.rs`, `migrations/002_safety.sql`, `client/src/pages/{terms,privacy,acceptable-use}.astro`
- Memory: [[auth-billing-feature]]
