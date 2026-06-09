-- Trust & safety + GDPR. Consent (age + ToS), bans, and abuse reports.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS age_confirmed  BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS consent_tos_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tos_version    TEXT,
    -- When set and in the future, the user is banned and can't join.
    ADD COLUMN IF NOT EXISTS banned_until   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS banned_reason  TEXT;

-- Abuse reports filed by one user against a peer in a room. The optional
-- transcript excerpt is the moderated text that triggered/accompanied the report.
CREATE TABLE IF NOT EXISTS reports (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room               TEXT NOT NULL,
    reported_peer_id   TEXT,
    reported_name      TEXT,
    reason             TEXT NOT NULL,
    transcript_excerpt TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
