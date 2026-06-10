# 0005 — Optional accounts, credits, Stripe billing + usage metering

| | |
|---|---|
| **Status** | ✅ Shipped (v1.0.0) |
| **Owner** | micio86dev |
| **Created** | 2026-06-09 |
| **Shipped** | 2026-06-09 |
| **Version** | **v1.0.0** (`24f04b2`) |
| **Commits** | `4c4ca33`, `30a7863`, `14dfbbb`, `2d278ae`, `7881496`, `922fe2a`, `43b3b9d`, `8b9aafb`, `cfb7997`, `536e277`, `24f04b2` |
| **Depends on** | [0002](../0002-video-calls-translated-chat/spec.md), [0004](../0004-quality-testing-ci/spec.md) |

## 1. Context & Problem

VoxTranslate burns real money per second of speech (Deepgram + Groq). To be a
product it needs **optional accounts**, a **credit balance**, **Stripe checkout** to
top up, and **usage metering** that deducts credits as users speak — while keeping a
**guest mode** so anyone can try it. Built via SDD + TDD across **9 vertical slices
(S0–S8)**. This is the v1.0.0 release.

## 2. Goals / Non-Goals

**Goals**
- **Optional** login with Google (GSI); a valid session JWT marks a peer as billed.
- **Guest mode preserved**: no token → guest, capped at `GUEST_MAX_MINUTES` (prod 10).
- **Credit ledger** with atomic, idempotent accounting (no double-spend, no double-credit).
- **Stripe checkout** to buy credit packages; **webhook** credits the ledger idempotently.
- **Usage metering**: speaking time (transcribed+translated) deducts credits live; the speaker
  gets `balance_update`, a one-time `low_balance` warning, and `balance_exhausted` when out.
- **Billing auto-detects**: enabled only when `DATABASE_URL` + `GOOGLE_CLIENT_ID` + `JWT_SECRET`
  are set; otherwise the server runs **guest-only**.

**Non-Goals**
- Subscriptions/recurring billing (one-off credit packs only).
- Exposing pricing internals (cost, markup, rates, price IDs) to the client.

## 3. Requirements

- **R1 — Optional Google login.** *Given* GSI, *when* I sign in, *then* the client POSTs the
  Google credential to `/api/auth/google`, the server verifies it and returns a session JWT
  (HS256); `/api/user/me` returns my profile; `/api/auth/config` serves the GSI client id.
- **R2 — Guest cap.** *Given* no token, *when* I speak, *then* I'm a guest and metered against
  `GUEST_MAX_MINUTES`; when the trial ends the client prompts **sign-in** (not buy-credits).
- **R3 — Atomic ledger.** *Given* concurrent deductions, *when* credits change, *then* the balance
  update is atomic (`SELECT … FOR UPDATE`) and never goes inconsistent.
- **R4 — Idempotent crediting.** *Given* Stripe may retry a webhook, *when* the same event
  arrives twice, *then* `credit_from_stripe_event` credits **once** (event id deduped in `stripe_events`).
- **R5 — Buy credits.** *Given* I'm logged in, *when* I open the buy-credits modal and pick a pack,
  *then* `/api/billing/checkout` creates a Stripe Checkout Session and redirects me; on success my balance rises.
- **R6 — Live metering.** *Given* I'm speaking as a billed user, *when* usage accrues, *then* I get
  `balance_update`; below `LOW_BALANCE_THRESHOLD` I get one `low_balance`; at zero I get
  `balance_exhausted` — STT stops but the **WebRTC call stays up** so I can buy and resume.
- **R7 — No price leakage.** Cost-per-minute, markup, user rate, and `stripe_price_id` are **never**
  serialized to the client. `MARKUP_PERCENTAGE` ensures no package loses money (prod 0.50).
- **R8 — Resilience.** *Given* the DB is unreachable at startup, *when* the server boots, *then* it
  **degrades to guest-only** instead of crashing.

## 4. Design & Architecture

**Config (`config.rs`)** — auto-detects billing; knobs: `GUEST_MAX_MINUTES`,
`MARKUP_PERCENTAGE` (default 0.25, prod 0.50), `CREDIT_PACKAGES` (JSON), `LOW_BALANCE_THRESHOLD`
(0.5), Stripe `*_URL`/keys, `GOOGLE_CLIENT_ID`, `JWT_SECRET`, `DATABASE_URL`.

**Data (`migrations/001_init.sql`)** — `users`, `credit_transactions` (the ledger),
`usage_sessions`, `stripe_events` (webhook idempotency).

**Server modules**
- `auth.rs` — `TokenVerifier` trait with **Google** and **Fake** (test) impls; JWT HS256;
  routes `/api/auth/google`, `/api/user/me`, `/api/auth/config`.
- `middleware.rs` — extracts/validates the session.
- `billing.rs` — atomic ledger (`SELECT … FOR UPDATE`), idempotent `credit_from_stripe_event`.
- `usage.rs` — per-speaking-session meter + guest cap; emits balance messages.
- `stripe_handler.rs` — Stripe via **raw reqwest** + **HMAC** webhook verification.
- `api.rs` — `/api/billing/{packages,checkout,webhook,history}`, `/api/usage/sessions`.
- `rate_limit.rs` — request rate limiting.
- WS: `token` query param (optional) decides guest vs billed.

**Money invariants (load-bearing)**
- Money is `rust_decimal::Decimal` **end-to-end**; `f64` only at the JSON edge.
- Never serialize `cost_per_minute` / `markup` / `user_rate` / `stripe_price_id` to the client.
- Guest mode kept: WS token is optional.

**Client (`client/src/scripts/`)**
- `auth.ts` (+15 vitest tests) — GSI flow, session storage, `me`.
- Billing UI in `app.ts`: login gate, account bar, buy-credits modal, balance display,
  low-balance banner, exhausted modal; i18n across 8 languages.
- Avatars: `Peer.avatar_url` flows through `peer_joined`/`chat_message` → tiles/chat/account
  (Google photo also used in the pre-join camera-off preview).

**Sequence (top-up + speak)**
1. Sign in with Google → JWT stored client-side.
2. Open buy-credits modal → `/api/billing/checkout` → Stripe Checkout → return to success URL.
3. Stripe → `/api/billing/webhook` (HMAC-verified) → `credit_from_stripe_event` (idempotent) → balance up.
4. Join a room with `token` → billed peer; speaking deducts credits → `balance_update` →
   `low_balance` → `balance_exhausted` (STT stops, call persists).

## 5. Implementation (9 slices)

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Config auto-detect (billing vs guest-only) | `config.rs` |
| S1 | DB schema + access | `db.rs`, `migrations/001_init.sql` |
| S2 | Auth (TokenVerifier+Google+Fake, JWT) + middleware | `auth.rs`, `middleware.rs` |
| S3 | Billing ledger (atomic, idempotent) | `billing.rs` |
| S4 | WS auth + usage meter + guest cap | `usage.rs`, `lib.rs` |
| S5 | Stripe handler + billing API + rate limit | `stripe_handler.rs`, `api.rs`, `rate_limit.rs` |
| S6 | Client auth + billing UI + i18n (8 langs) | `client/src/scripts/auth.ts`, `app.ts` |
| S7 | Avatars end-to-end | `protocol.rs` (`avatar_url`), `app.ts` |
| S8 | CI Postgres service + coverage gate | `.github/workflows/*` |

## 6. Testing & Verification

- **Server llvm-cov 86.26%** lines; integration in `server/tests/billing.rs` (8 tests, own binary);
  env-mutating config test in `server/tests/config_env.rs`.
- **Client vitest 95.7%** (gate ≥85%); `auth.ts` +15 tests.
- **9 Playwright e2e** (`client/e2e/billing.spec.ts`) use `page.route('**/api/**')` +
  `page.routeWebSocket` to simulate billing against the guest backend; e2e context sets
  `serviceWorkers: 'block'` (the PWA SW otherwise intercepts `/api`).
- Plan: `~/.claude/plans/clever-stargazing-ripple.md`. See [[auth-billing-feature]].

## 7. Deployment & Operations

- **v1.0.0 SHIPPED TO PROD.** Frontend: **Vercel** `https://voxtranslate.vercel.app` (autodeploy on push to `main`).
  Backend: **Railway** `https://voxtranslate-server-production.up.railway.app` via `railway up --detach` from `server/` (not GitHub-connected).
- DB: **Supabase**; use the IPv4 **Session pooler** host (direct host is IPv6-only).
- Prod knobs: `GUEST_MAX_MINUTES=10`, `MARKUP_PERCENTAGE=0.50`. Stripe products/prices created via `922fe2a` helper script.
- Docker: `migrations/` copied into the build so `sqlx::migrate!` compiles (`2d278ae`).
- **Security constraint (persist):** never accept a live Stripe `sk_live_` secret in chat (price IDs `price_` are safe); never print/commit real `.env` secrets.

## 8. Risks / Open Items

- Single-currency, one-off packs only; no proration/refund automation.
- Guest cap is time-based and per-connection (not per-identity) — acceptable for a free trial.

## 9. References

- Commits: `4c4ca33` (feat) … `24f04b2` (release v1.0.0); fixes `14dfbbb`, `2d278ae`, `7881496`, `922fe2a`, `43b3b9d`, `8b9aafb`, `536e277`
- Files: `server/src/{config,db,auth,middleware,billing,usage,stripe_handler,api,rate_limit,protocol}.rs`, `migrations/001_init.sql`, `client/src/scripts/{auth,app}.ts`, `client/e2e/billing.spec.ts`
- Memory: [[auth-billing-feature]], [[server-coverage-gotchas]]
