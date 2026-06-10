-- Advanced features (specs 0011+): room glossaries, transcript bookmarks,
-- AI reports / sentiment / follow-up emails, and richer ledger detail for
-- credit-charged AI features.

-- Per-feature ledger detail. All nullable: additive, backwards-compatible with
-- the existing 'free_credit' / 'purchase' / 'usage' rows.
ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS feature    TEXT,
    ADD COLUMN IF NOT EXISTS session_id UUID,
    ADD COLUMN IF NOT EXISTS metadata   JSONB;
CREATE INDEX IF NOT EXISTS idx_ct_session
    ON credit_transactions (session_id) WHERE session_id IS NOT NULL;

-- Glossary header: one per room code. Rooms are ephemeral TEXT codes (no rooms
-- table), so the glossary persists across calls that reuse the same code.
CREATE TABLE IF NOT EXISTS room_glossaries (
    room       TEXT PRIMARY KEY,
    name       TEXT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Glossary term pairs. Injected into the translation prompt only when the
-- speaker's language matches `source_lang`.
CREATE TABLE IF NOT EXISTS glossary_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room        TEXT NOT NULL REFERENCES room_glossaries(room) ON DELETE CASCADE,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    source_term VARCHAR(200) NOT NULL,
    target_term VARCHAR(200) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (room, source_lang, target_lang, source_term)
);
CREATE INDEX IF NOT EXISTS idx_glossary_room_lang
    ON glossary_entries (room, source_lang);

-- Moments pinned during a call. Auth-only (guests have no user row); labels
-- are PII-adjacent so the row cascades with the account (GDPR).
CREATE TABLE IF NOT EXISTS transcript_bookmarks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts         TIMESTAMPTZ NOT NULL,
    label      VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_session
    ON transcript_bookmarks (session_id, ts);

-- AI-generated meeting reports. Multiple per session: regenerating with new
-- guidelines keeps history (newest is served).
CREATE TABLE IF NOT EXISTS session_reports (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guidelines TEXT,
    format     TEXT NOT NULL CHECK (format IN ('structured', 'freeform')),
    lang       TEXT NOT NULL,
    markdown   TEXT NOT NULL,
    model      TEXT NOT NULL,
    cost       DECIMAL(10, 6) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_session
    ON session_reports (session_id, created_at DESC);

-- Sentiment analysis result. UNIQUE(session_id) is the cache contract: one
-- result per session, returned without re-running (or re-charging).
CREATE TABLE IF NOT EXISTS session_sentiments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL UNIQUE REFERENCES call_sessions(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    result_json JSONB NOT NULL,
    model       TEXT NOT NULL,
    cost        DECIMAL(10, 6) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Follow-up email drafts and sends. `recipients` is a JSONB array of
-- {"kind":"participant","user_id":...} | {"kind":"email","email":...} — the
-- participant form is resolved to an address server-side at send time so other
-- users' emails are never exposed to the requester.
CREATE TABLE IF NOT EXISTS session_emails (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'failed')),
    subject    TEXT NOT NULL,
    body_html  TEXT NOT NULL,
    body_text  TEXT NOT NULL,
    recipients JSONB NOT NULL,
    tone       TEXT,
    guidelines TEXT,
    lang       TEXT,
    resend_id  TEXT,
    sent_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emails_session
    ON session_emails (session_id);
