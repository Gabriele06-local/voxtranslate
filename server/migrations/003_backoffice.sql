-- Backoffice: multilingual content (UI strings + legal pages), moderation
-- blocklist, report lifecycle, and an admin audit trail.
--
-- Content tables follow Directus's translations pattern (a base row + one
-- translation row per language) so the Directus Data Studio edits them with its
-- native Translations interface. The Rust server reads these to serve the client
-- at runtime (with the bundled strings as the offline fallback).

-- Supported UI languages — also the Directus translations "languages" collection.
CREATE TABLE IF NOT EXISTS languages (
    code      TEXT PRIMARY KEY,                 -- 'it','en',…
    name      TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'ltr',
    sort      INTEGER NOT NULL DEFAULT 0
);

-- UI strings: one base row per key, one translation row per (key, language).
CREATE TABLE IF NOT EXISTS i18n_strings (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key        TEXT NOT NULL UNIQUE,
    notes      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS i18n_translations (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    string_id UUID NOT NULL REFERENCES i18n_strings(id) ON DELETE CASCADE,
    language  TEXT NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
    value     TEXT NOT NULL,
    UNIQUE (string_id, language)
);

-- Legal pages (terms / privacy / acceptable-use): base row + per-language body.
CREATE TABLE IF NOT EXISTS legal_pages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       TEXT NOT NULL UNIQUE,            -- 'terms','privacy','acceptable-use'
    version    TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legal_translations (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id  UUID NOT NULL REFERENCES legal_pages(id) ON DELETE CASCADE,
    language TEXT NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
    title    TEXT NOT NULL,
    body     TEXT NOT NULL,                     -- markdown
    UNIQUE (page_id, language)
);

-- Moderation blocklist: severe terms, optionally scoped to a language
-- (NULL = applies to every language). Loaded by the Moderator at startup
-- alongside the env baseline.
CREATE TABLE IF NOT EXISTS blocklist_terms (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    term       TEXT NOT NULL,
    language   TEXT REFERENCES languages(code) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One row per term per language scope (a NULL scope is the global entry).
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocklist_term_lang
    ON blocklist_terms (term, COALESCE(language, '*'));

-- Report lifecycle for the moderation queue.
ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'open', -- open|resolved|dismissed
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_by TEXT,
    ADD COLUMN IF NOT EXISTS action_note TEXT;

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);

-- Admin audit trail: every privileged backoffice action, for safety + GDPR
-- accountability.
CREATE TABLE IF NOT EXISTS admin_audit (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor      TEXT NOT NULL,                   -- Directus user email / 'system'
    action     TEXT NOT NULL,                   -- ban|unban|credit|resolve_report|delete_user
    target     TEXT,                            -- user id / report id
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);
