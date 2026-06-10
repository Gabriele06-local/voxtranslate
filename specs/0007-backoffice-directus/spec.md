# 0007 — Backoffice: admin actions + managed content + Directus studio

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-10 |
| **Shipped** | 2026-06-10 |
| **Version** | post-v1.0.0 |
| **Commits** | `ce06868`, `c0a80af`, `41305ec`, `b00679e`, `a439a4b` |
| **Depends on** | [0005](../0005-accounts-credits-billing/spec.md), [0006](../0006-trust-safety-gdpr/spec.md) |

## 1. Context & Problem

Operators need to **moderate users and manage content** without shipping code:
ban/unban, adjust credits, resolve reports, GDPR-delete, and edit UI strings / legal
pages / blocklist terms — ideally in a real admin UI. The constraint: **money and ban
logic must stay behind the Rust server**, never exposed to a CMS with direct DB write
access. The solution: **Directus 11** reads the existing Supabase Postgres and edits
*content* directly, while *privileged* actions run through Directus **Flows** that POST
to secret-guarded `/api/admin/*` endpoints on the server.

## 2. Goals / Non-Goals

**Goals**
- A secret-guarded admin API (`/api/admin/*`) for ban/unban/credit/resolve-report/delete-user, each audited.
- DB-overridable **managed content**: i18n strings, legal pages, blocklist terms.
- Stand up **Directus** on the same Postgres, register the app tables, and wire 5 Flows for privileged actions.
- Architecture rule: **Directus edits content directly; privileged writes go via the server.**

**Non-Goals**
- Giving Directus write access to money/ban tables (forbidden — those go through the server).
- A bespoke admin frontend (Directus is the studio).
- Choosing PocketBase (rejected — see decision below).

## 3. Requirements

- **R1 — Guarded admin actions.** *Given* `X-Admin-Secret: ADMIN_API_SECRET`, *when* it matches
  (constant-time), *then* `/api/admin/{ban,unban,credit,report/resolve,user/delete}` runs; *else* **403**.
  Each action writes an `admin_audit` row. Secret is checked **before body parsing** via an
  `AdminAuth` `FromRequestParts` extractor (a malformed unauth body returns 403, not 422).
- **R2 — Managed i18n.** `GET /api/content/i18n` returns a merged map; the client overlays DB
  strings over its bundled baseline at boot (fail-safe to bundled).
- **R3 — Managed legal.** `GET /api/content/legal/{slug}?lang=` returns a page in the requested
  language, falling back EN → bundled.
- **R4 — DB blocklist.** The `Moderator` loads `blocklist_terms` from the DB at init, over the env baseline.
- **R5 — Content is override-only.** *Given* empty content tables, *when* the app boots, *then* it
  works entirely from the bundled baseline (DB holds overrides, never the whole truth).
- **R6 — Directus studio.** Operators see the 11 app tables with data and have 5 confirmation-gated Flows.

## 4. Design & Architecture

**Data (`migrations/003_backoffice.sql`, idempotent)** — `languages`, `i18n_strings` +
`i18n_translations`, `legal_pages` + `legal_translations`, `blocklist_terms`, `reports`
lifecycle cols (`status`/`resolved_at`/`resolved_by`/`action_note`), `admin_audit`.

**Server**
- `admin.rs` — ban/unban/credit/resolve_report/delete_user; each writes `admin_audit`;
  `AdminAuth` extractor does a **constant-time** secret check **before** body parsing.
- `content.rs` — `GET /api/content/i18n` (merged map), `GET /api/content/legal/{slug}?lang=`,
  with a **short-TTL cache** (see [0008](../0008-managed-content-i18n/spec.md)).
- `moderation.rs` — loads `blocklist_terms` over the env baseline at init.
- `config.admin_api_secret`; `uuid` gained the `serde` feature.

**Client**
- `content.ts` — `loadRemoteI18n` merges DB strings over bundled `I18N` at boot;
  `fetchLegal` + `renderMarkdown`; **all fail-safe to bundled**.
- `Legal.astro` overlays managed content onto the bundled page.

**Directus topology (the boundary)**
- Directus 11 reads the Supabase Postgres and edits content tables directly.
- **Privileged actions are NOT direct DB writes** — they are Directus **Flows** (manual trigger,
  confirmation-gated) that issue a `request` op:
  `POST {{$env.VOX_API_URL}}/api/admin/*` with header `X-Admin-Secret: {{$env.ADMIN_API_SECRET}}`,
  body `{{$trigger.keys[0]}}` (row id) + confirmation fields, actor `{{$accountability.user}}`.
- 5 Flows: **Ban / Unban / Adjust-credits / GDPR-delete** on `users`, **Resolve-report** on `reports`.

**Key decisions**
- **Directus over PocketBase** — PocketBase ships its own SQLite and can't sit on the existing
  Supabase Postgres; Directus introspects the existing DB and has a native Translations UI.
- **Money/ban logic stays behind the server** — Directus never writes those tables; Flows call the guarded API.
- **Content is override-only** — the client bundles the full baseline, so empty tables ⇒ working app.
- **Secret check before body parse** — `FromRequestParts` extractor ⇒ consistent 403 for unauth (`b00679e`).

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Schema (idempotent) | `migrations/003_backoffice.sql` |
| S1 | Admin actions + audit + guard | `server/src/admin.rs`, `config.rs` |
| S2 | Managed content endpoints | `server/src/content.rs` |
| S3 | DB blocklist load | `server/src/moderation.rs` |
| S4 | Client runtime content (i18n merge + legal) | `client/src/scripts/content.ts`, `Legal.astro` |
| S5 | Directus service + seeds + setup guide | `directus/{docker-compose.yml,README.md,gen-*-seed.mjs,seed-*.sql}` |
| S6 | Flow walkthrough screenshots | `directus/screenshots/`, `a439a4b` |

## 6. Testing & Verification

- Server coverage **86.56%**; client `content.ts` **100%**.
- Verified in prod: `/api/content/legal/terms?lang=it` = "Termini di servizio"; `fr` falls back to EN.
- `admin.rs`: well-formed unauth = 403; (pre-`b00679e`) malformed unauth body returned 422 — hardened to 403 via the extractor.

## 7. Deployment & Operations (runbook → `directus/README.md`)

- **Server + client + content endpoints DEPLOYED (2026-06-10):** `ADMIN_API_SECRET` set on the
  Railway server; `railway up` (migration 003 + endpoints live); frontend pushed.
- **Prod content tables SEEDED** directly via the `vox-pg` container's psql against prod Supabase
  (idempotent, content-only): 8 languages, 86 i18n keys ×8, legal EN/IT/ES ×3. Seed-without-exposing-secret:
  `cd server; URL=$(railway variables --kv | sed -n 's/^DATABASE_URL=//p'); docker exec -i -e PGURL="$URL" vox-pg sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1' < directus/seed-*.sql`.
- **Directus DEPLOYED** to Railway (image `directus/directus:11`) on the single live project
  `voxtranslate-server`; domain `…/admin`. Env: `DB_CLIENT=pg` + `DB_CONNECTION_STRING` (not DATABASE_URL),
  `DB_SSL__REJECT_UNAUTHORIZED=false`, `PORT=8055`, `PUBLIC_URL`, `VOX_API_URL`,
  `FLOWS_ENV_ALLOW_LIST=ADMIN_API_SECRET,VOX_API_URL`, generated `KEY`/`SECRET`.
- **Studio configured programmatically:** the 11 app tables registered by inserting into
  `directus_collections` (Directus 11 refuses `POST /collections` for existing tables) + cache clear;
  5 Flows created via `POST /flows` + `/operations` + `PATCH`. Flows **not executed against prod**
  (would ban/delete real users) — operator must test per README §8 with a throwaway account.
- Generators run via **`node`** (Node 24 strips TS types importing `i18n.ts`; do **not** set
  `globalThis.navigator` — read-only getter).

## 8. Risks / Open Items (optional, not automated — risky via raw SQL)

- Native Translations interface wiring (README §5: O2M alias + relations) — data is editable as flat rows without it.
- Read-only permission scoping for a separate editor role (README §6) — moot while logged in as admin.
- **Secret hygiene:** `ADMIN_API_SECRET` shared env on both Railway services; value only in the Railway dashboard. Never print/commit it.

## 9. References

- Commits: `ce06868`, `c0a80af`, `41305ec`, `b00679e`, `a439a4b`
- Files: `server/src/{admin,content,moderation,config}.rs`, `migrations/003_backoffice.sql`, `client/src/scripts/content.ts`, `directus/*`
- Memory: [[auth-billing-feature]]
