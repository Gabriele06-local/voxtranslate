//! Database layer: Postgres connection pool, migrations, and row types.
//!
//! We use **runtime** SQLx (`sqlx::query`/`query_as`) rather than the
//! compile-time `query!` macros, so the crate builds with no live database and
//! CI stays simple. Migrations in `migrations/` are embedded at compile time and
//! run on startup via [`migrate`].

use std::time::Duration;

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::FromRow;
use uuid::Uuid;

pub type Pool = sqlx::PgPool;

/// A row from `users`. `balance` is in USD credits (DECIMAL(10,6)).
#[derive(Debug, Clone, FromRow)]
pub struct User {
    pub id: Uuid,
    pub google_id: String,
    pub email: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub balance: Decimal,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Trust & safety / GDPR consent (added in migration 002).
    pub age_confirmed: bool,
    pub consent_tos_at: Option<DateTime<Utc>>,
    pub tos_version: Option<String>,
    pub banned_until: Option<DateTime<Utc>>,
    pub banned_reason: Option<String>,
}

/// Open a connection pool to the given Postgres URL.
pub async fn connect(url: &str) -> Result<Pool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url)
        .await
}

/// Run all pending migrations (idempotent — already-applied ones are skipped).
pub async fn migrate(pool: &Pool) -> Result<(), sqlx::Error> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Migrate a real test DB and round-trip a user. Skipped when `DATABASE_URL`
    /// is unset (e.g. CI without a Postgres service); run locally against the
    /// Docker Postgres: `DATABASE_URL=postgres://postgres:postgres@localhost:5433/voxtest`.
    #[tokio::test]
    async fn migrate_and_round_trip_user() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping db test — no DATABASE_URL");
            return;
        };

        let pool = connect(&url).await.expect("connect");
        migrate(&pool).await.expect("migrate");

        // Unique identifiers so repeated runs don't collide on the UNIQUE cols.
        let gid = format!("g-{}", Uuid::new_v4());
        let email = format!("{}@example.com", Uuid::new_v4());

        let inserted: User = sqlx::query_as(
            "INSERT INTO users (google_id, email, name, avatar_url)
             VALUES ($1, $2, $3, $4) RETURNING *",
        )
        .bind(&gid)
        .bind(&email)
        .bind("Tester")
        .bind(Option::<String>::None)
        .fetch_one(&pool)
        .await
        .expect("insert user");

        assert_eq!(inserted.google_id, gid);
        assert_eq!(inserted.email, email);
        // New users start at exactly zero credits.
        assert_eq!(inserted.balance, Decimal::ZERO);

        let fetched: User = sqlx::query_as("SELECT * FROM users WHERE id = $1")
            .bind(inserted.id)
            .fetch_one(&pool)
            .await
            .expect("fetch user");
        assert_eq!(fetched.id, inserted.id);
        assert_eq!(fetched.email, email);
    }
}
