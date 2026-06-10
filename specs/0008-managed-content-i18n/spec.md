# 0008 — Managed content & i18n: DB-overridable strings, legal pages, 404

| | |
|---|---|
| **Status** | ✅ Shipped |
| **Owner** | micio86dev |
| **Created** | 2026-06-10 |
| **Shipped** | 2026-06-10 |
| **Version** | post-v1.0.0 |
| **Commits** | `151980c`, `90492d1`, `c10a2df` |
| **Depends on** | [0006](../0006-trust-safety-gdpr/spec.md), [0007](../0007-backoffice-directus/spec.md) |

## 1. Context & Problem

With managed content plumbed in ([0007](../0007-backoffice-directus/spec.md)), the app
needs the **content itself**: a complete, localized i18n set; localized legal pages
seeded into the DB; a styled, localized **404**; and a sane caching story so the boot
fetch of ~hundreds of strings doesn't hammer the server. This spec covers the content
layer and its delivery — including the per-language legal-page generation pipeline and
its expansion from EN/IT/ES to **8 languages**.

## 2. Goals / Non-Goals

**Goals**
- **Per-language legal seed generation**: bodies read from `directus/legal/<slug>.<lang>.md`;
  the generator emits an idempotent `seed-content.sql`, skipping languages without a file.
- **Localized legal pages** seeded into the DB; client renders requested lang → EN → bundled.
- **Styled localized 404** page (8 languages inline, brand gradient).
- **Short-TTL cache** for the managed-content endpoints so the per-boot fetch is cheap.
- Expand legal coverage to **fr, de, ja, pt, zh** on top of EN/IT/ES.

**Non-Goals**
- Machine-translating content at runtime (content is authored/seeded, not translated on the fly).
- Replacing the bundled baseline (DB stays override-only — see [0007](../0007-backoffice-directus/spec.md) R5).

## 3. Requirements

- **R1 — Per-language seed gen.** *Given* `directus/legal/<slug>.<lang>.md` files, *when* I run
  `node directus/gen-content-seed.mjs > directus/seed-content.sql`, *then* it emits idempotent
  `INSERT … ON CONFLICT DO UPDATE` rows and **skips** languages without a markdown file.
- **R2 — Legal fallback chain.** *Given* a requested language, *when* the page is rendered, *then*
  the client shows requested → English → bundled copy.
- **R3 — Styled 404.** *Given* an unknown route, *when* it 404s, *then* `client/src/pages/404.astro`
  renders a branded, localized page (8 languages inline, brand gradient).
- **R4 — Cheap content delivery.** *Given* the client fetches `/api/content/*` every boot, *when*
  requests arrive, *then* a **short-TTL cache** serves them (the boot i18n fetch is ~hundreds of strings).
- **R5 — 8-language legal coverage.** *Given* the three legal pages, *when* seeded, *then* EN/IT/ES
  **plus fr/de/ja/pt/zh** are present; remaining unmanaged languages fall back EN → bundled.

## 4. Design & Architecture

**Content pipeline (`directus/`)**
- `legal/<slug>.<lang>.md` — authored sources for `terms` / `privacy` / `acceptable-use` in
  en, it, es, fr, de, ja, pt, zh.
- `gen-content-seed.mjs` — reads bodies from `legal/<slug>.<lang>.md`, emits idempotent
  `seed-content.sql`; languages without a file are skipped (client falls back). Run **before** `seed-i18n.sql`.
- `gen-i18n-seed.mjs` — emits `seed-i18n.sql` for UI strings (run via `node`; Node 24 strips TS
  types when importing `i18n.ts`; do **not** set `globalThis.navigator`).
- Seeds are **idempotent** and **content-only**.

**Delivery**
- Server `content.rs` (`GET /api/content/i18n`, `GET /api/content/legal/{slug}?lang=`) gets a
  **short-TTL cache** (`90492d1`) so repeated boot fetches don't recompute the merged map.
- Client `content.ts` fetches `/api/content/i18n` with `cache:'no-store'` each boot (~688 strings)
  and overlays DB strings over the bundled baseline; legal via `fetchLegal` + `renderMarkdown`.

**404**
- `client/src/pages/404.astro` — 8 languages inline, brand gradient, fully static.

**Key decisions**
- **Markdown-per-language sources** → legal copy is reviewable/diffable as plain files; the SQL seed is generated, never hand-edited.
- **Skip-missing-language** in the generator → adding a language = adding a file; no schema or generator change.
- **Short-TTL server cache** instead of client caching → keeps `no-store` client correctness while removing server load.

## 5. Implementation

| Slice | What | Key files |
|-------|------|-----------|
| S0 | Styled localized 404 | `client/src/pages/404.astro` |
| S1 | EN/IT/ES legal seed + per-language generator | `directus/gen-content-seed.mjs`, `directus/legal/*.{en,it,es}.md`, `directus/seed-content.sql` |
| S2 | Short-TTL cache for content endpoints | `server/src/content.rs` |
| S3 | +5 languages (fr, de, ja, pt, zh) | `directus/legal/*.{fr,de,ja,pt,zh}.md`, regenerated `directus/seed-content.sql` |

## 6. Testing & Verification

- Client `content.ts` coverage **100%** ([0007](../0007-backoffice-directus/spec.md)).
- Generator output verified idempotent (`ON CONFLICT DO UPDATE`); prod verified:
  `/api/content/legal/terms?lang=it` = "Termini di servizio"; unmanaged langs fall back to EN.
- After S3, fr/de/ja/pt/zh bodies are present in `seed-content.sql`.

## 7. Deployment & Operations

- Regenerate after editing/adding a legal file:
  `node directus/gen-content-seed.mjs > directus/seed-content.sql` (run **before** `seed-i18n.sql`).
- Apply to prod without exposing secrets (see [0007](../0007-backoffice-directus/spec.md) §7 runbook): seed via the `vox-pg` container's psql against prod Supabase.
- **Note:** the client boot fetch of `/api/content/i18n` is `cache:'no-store'`; the **server-side**
  short-TTL cache is what keeps it cheap.

## 8. Risks / Open Items

- Adding a language requires authoring 3 markdown files + re-running the generator + re-seeding prod.
- i18n strings beyond the legal pages (the 86 keys ×8) are seeded but expand manually.

## 9. References

- Commits: `151980c` (404 + EN/IT/ES legal + per-language gen), `90492d1` (short-TTL cache), `c10a2df` (+fr/de/ja/pt/zh)
- Files: `directus/{gen-content-seed.mjs,seed-content.sql,legal/*}`, `server/src/content.rs`, `client/src/pages/404.astro`, `client/src/scripts/content.ts`
- Memory: [[auth-billing-feature]]
