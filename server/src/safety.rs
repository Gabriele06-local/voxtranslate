//! Trust & safety + GDPR data operations: abuse reports, consent (age + ToS),
//! bans, and the user's right to export / delete their data.

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::db::Pool;

/// One JSON document with everything we hold on a user (GDPR data portability).
/// Built entirely in Postgres (`json_build_object`) and returned as text so we
/// don't need sqlx's json feature.
const EXPORT_SQL: &str = "
SELECT json_build_object(
  'profile', (SELECT row_to_json(u) FROM (
      SELECT id, email, name, avatar_url, balance, created_at,
             age_confirmed, consent_tos_at, tos_version
      FROM users WHERE id = $1) u),
  'credit_transactions', (SELECT coalesce(json_agg(t), '[]') FROM (
      SELECT amount, kind, balance_after, description, created_at
      FROM credit_transactions WHERE user_id = $1 ORDER BY created_at) t),
  'usage_sessions', (SELECT coalesce(json_agg(s), '[]') FROM (
      SELECT room, speaking_seconds, cost, started_at, ended_at
      FROM usage_sessions WHERE user_id = $1 ORDER BY started_at) s),
  'reports_filed', (SELECT coalesce(json_agg(r), '[]') FROM (
      SELECT room, reason, created_at
      FROM reports WHERE reporter_user_id = $1 ORDER BY created_at) r)
)::text";

/// Database operations for moderation + GDPR. Cheap to clone.
#[derive(Clone)]
pub struct SafetyService {
    pool: Pool,
}

impl SafetyService {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    /// File an abuse report against a peer in a room.
    pub async fn record_report(
        &self,
        reporter: Uuid,
        room: &str,
        reported_peer_id: Option<&str>,
        reported_name: Option<&str>,
        reason: &str,
        transcript_excerpt: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO reports
                 (reporter_user_id, room, reported_peer_id, reported_name, reason, transcript_excerpt)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(reporter)
        .bind(room)
        .bind(reported_peer_id)
        .bind(reported_name)
        .bind(reason)
        .bind(transcript_excerpt)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record that the user confirmed they're of age and accepted the given
    /// ToS/Privacy version.
    pub async fn set_consent(&self, user_id: Uuid, tos_version: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE users
             SET age_confirmed = TRUE, consent_tos_at = now(), tos_version = $2, updated_at = now()
             WHERE id = $1",
        )
        .bind(user_id)
        .bind(tos_version)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// `Some(reason)` if the user is currently banned, else `None`.
    pub async fn is_banned(&self, user_id: Uuid) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(Option<DateTime<Utc>>, Option<String>)> =
            sqlx::query_as("SELECT banned_until, banned_reason FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(match row {
            Some((Some(until), reason)) if until > Utc::now() => {
                Some(reason.unwrap_or_else(|| "banned".to_string()))
            }
            _ => None,
        })
    }

    /// Ban a user. `days = None` is effectively permanent.
    pub async fn ban_user(
        &self,
        user_id: Uuid,
        reason: &str,
        days: Option<i64>,
    ) -> Result<(), sqlx::Error> {
        let until = Utc::now() + Duration::days(days.unwrap_or(365_000));
        sqlx::query("UPDATE users SET banned_until = $2, banned_reason = $3 WHERE id = $1")
            .bind(user_id)
            .bind(until)
            .bind(reason)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Lift a ban (clear `banned_until`/`banned_reason`).
    pub async fn unban_user(&self, user_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE users SET banned_until = NULL, banned_reason = NULL WHERE id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// All data held on the user, as one JSON document (GDPR portability).
    pub async fn export_user_data(&self, user_id: Uuid) -> Result<serde_json::Value, sqlx::Error> {
        let json: String = sqlx::query_scalar(EXPORT_SQL)
            .bind(user_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(serde_json::from_str(&json).unwrap_or(serde_json::Value::Null))
    }

    /// Erase the user and all linked rows (FKs cascade). GDPR right to erasure.
    pub async fn delete_user(&self, user_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn service() -> Option<SafetyService> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let pool = crate::db::connect(&url).await.ok()?;
        crate::db::migrate(&pool).await.ok()?;
        Some(SafetyService::new(pool))
    }

    async fn make_user(svc: &SafetyService) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO users (google_id, email, name, balance)
             VALUES ($1, $2, 'T', 1.0) RETURNING id",
        )
        .bind(format!("g-{}", Uuid::new_v4()))
        .bind(format!("{}@x.com", Uuid::new_v4()))
        .fetch_one(&svc.pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn consent_ban_report_export_delete() {
        let Some(svc) = service().await else {
            eprintln!("skipping — no DATABASE_URL");
            return;
        };
        let uid = make_user(&svc).await;

        // Consent.
        svc.set_consent(uid, "v1").await.unwrap();
        let (age, at): (bool, Option<DateTime<Utc>>) =
            sqlx::query_as("SELECT age_confirmed, consent_tos_at FROM users WHERE id = $1")
                .bind(uid)
                .fetch_one(&svc.pool)
                .await
                .unwrap();
        assert!(age && at.is_some());

        // Not banned, then banned, then expired ban.
        assert!(svc.is_banned(uid).await.unwrap().is_none());
        svc.ban_user(uid, "abuse", Some(7)).await.unwrap();
        assert_eq!(svc.is_banned(uid).await.unwrap().as_deref(), Some("abuse"));
        svc.ban_user(uid, "old", Some(-1)).await.unwrap(); // already expired
        assert!(svc.is_banned(uid).await.unwrap().is_none());

        // Report + export sees it.
        svc.record_report(
            uid,
            "room1",
            Some("peer9"),
            Some("Bob"),
            "harassment",
            Some("bad text"),
        )
        .await
        .unwrap();
        let export = svc.export_user_data(uid).await.unwrap();
        assert!(export["profile"]["email"].is_string());
        assert_eq!(export["reports_filed"][0]["reason"], "harassment");

        // Delete cascades.
        svc.delete_user(uid).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
            .bind(uid)
            .fetch_one(&svc.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let reports: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reports WHERE reporter_user_id = $1")
                .bind(uid)
                .fetch_one(&svc.pool)
                .await
                .unwrap();
        assert_eq!(reports, 0, "reports cascade-deleted");
    }
}
