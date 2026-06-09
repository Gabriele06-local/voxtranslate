-- VoxTranslate auth + billing schema.
-- `gen_random_uuid()` is built into Postgres 13+ (pgcrypto is bundled); no
-- extension needed. Money is DECIMAL(10,6) — six fractional digits cover
-- sub-cent per-second rates without float drift.

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_id   TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    avatar_url  TEXT,
    balance     DECIMAL(10, 6) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit ledger. Every balance change writes one row here. `kind` is
-- one of: free_credit, purchase, usage. `amount` is signed (+credit, -usage).
CREATE TABLE IF NOT EXISTS credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          DECIMAL(10, 6) NOT NULL,
    kind            TEXT NOT NULL,
    balance_after   DECIMAL(10, 6) NOT NULL,
    description     TEXT,
    stripe_event_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user_created
    ON credit_transactions (user_id, created_at DESC);

-- One row per call a user joins. `speaking_seconds` accumulates across speaking
-- bursts; `cost` is the credits deducted for that session so far.
CREATE TABLE IF NOT EXISTS usage_sessions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room             TEXT NOT NULL,
    speaking_seconds INTEGER NOT NULL DEFAULT 0,
    cost             DECIMAL(10, 6) NOT NULL DEFAULT 0,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_usage_user_started
    ON usage_sessions (user_id, started_at DESC);

-- Stripe webhook idempotency: the event id is the primary key, so a replayed
-- webhook hits a duplicate-key violation and credits are never doubled.
CREATE TABLE IF NOT EXISTS stripe_events (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
