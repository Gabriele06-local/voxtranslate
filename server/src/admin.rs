//! Backoffice admin API. The Directus Data Studio triggers privileged actions —
//! ban, credit adjust, GDPR delete, resolve report — here via Flows, guarded by
//! the shared `ADMIN_API_SECRET` (server-to-server), NOT a user JWT. This keeps
//! money + ban logic behind the server while Directus stays a thin admin UI over
//! the data. Every action writes an `admin_audit` row.

use axum::extract::State;
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::billing::usd;
use crate::db::Pool;
use crate::AppState;

/// Whether the request carries the configured admin secret. Accepts either
/// `Authorization: Bearer <secret>` or `X-Admin-Secret: <secret>`. Returns false
/// when no secret is configured (admin endpoints are then effectively disabled).
fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(secret) = state
        .config
        .billing
        .as_ref()
        .and_then(|b| b.admin_api_secret.as_deref())
    else {
        return false;
    };
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let xhdr = headers.get("x-admin-secret").and_then(|v| v.to_str().ok());
    constant_eq(bearer, secret) || constant_eq(xhdr, secret)
}

/// Length-checked, branch-light comparison so a wrong secret doesn't leak its
/// length via timing. Good enough for a server-to-server shared secret.
fn constant_eq(given: Option<&str>, secret: &str) -> bool {
    let Some(given) = given else { return false };
    if given.len() != secret.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in given.bytes().zip(secret.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Append one audit row. Failures are logged, never fatal to the action.
async fn audit(
    pool: &Pool,
    actor: &str,
    action: &str,
    target: Option<&str>,
    detail: serde_json::Value,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO admin_audit (actor, action, target, detail) VALUES ($1, $2, $3, $4::jsonb)",
    )
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(detail.to_string())
    .execute(pool)
    .await
    {
        tracing::error!("audit write failed: {e}");
    }
}

fn actor(a: &Option<String>) -> &str {
    a.as_deref().filter(|s| !s.is_empty()).unwrap_or("admin")
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "invalid admin secret").into_response()
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, "admin not configured").into_response()
}

fn ok() -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct BanRequest {
    pub user_id: Uuid,
    #[serde(default)]
    pub days: Option<i64>,
    pub reason: String,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /api/admin/ban` — ban a user for `days` (omit for permanent).
pub async fn ban(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BanRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return forbidden();
    }
    let (Some(safety), Some(pool)) = (state.safety.as_ref(), state.pool.as_ref()) else {
        return unavailable();
    };
    match safety.ban_user(body.user_id, &body.reason, body.days).await {
        Ok(()) => {
            audit(
                pool,
                actor(&body.actor),
                "ban",
                Some(&body.user_id.to_string()),
                serde_json::json!({ "reason": body.reason, "days": body.days }),
            )
            .await;
            ok()
        }
        Err(e) => {
            tracing::error!("ban failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "ban failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct UnbanRequest {
    pub user_id: Uuid,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /api/admin/unban` — lift a user's ban.
pub async fn unban(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UnbanRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return forbidden();
    }
    let (Some(safety), Some(pool)) = (state.safety.as_ref(), state.pool.as_ref()) else {
        return unavailable();
    };
    match safety.unban_user(body.user_id).await {
        Ok(()) => {
            audit(
                pool,
                actor(&body.actor),
                "unban",
                Some(&body.user_id.to_string()),
                serde_json::json!({}),
            )
            .await;
            ok()
        }
        Err(e) => {
            tracing::error!("unban failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "unban failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct CreditRequest {
    pub user_id: Uuid,
    /// Signed: positive grants credits, negative deducts (manual adjustment).
    pub amount: f64,
    pub reason: String,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /api/admin/credit` — manually adjust a user's balance (grant/refund).
pub async fn credit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreditRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return forbidden();
    }
    let (Some(billing), Some(pool)) = (state.billing.as_ref(), state.pool.as_ref()) else {
        return unavailable();
    };
    match billing
        .add_credits(
            body.user_id,
            usd(body.amount),
            "admin_adjust",
            Some(&body.reason),
            None,
        )
        .await
    {
        Ok(new_balance) => {
            audit(
                pool,
                actor(&body.actor),
                "credit",
                Some(&body.user_id.to_string()),
                serde_json::json!({ "amount": body.amount, "reason": body.reason }),
            )
            .await;
            Json(serde_json::json!({ "ok": true, "balance": new_balance.to_string() }))
                .into_response()
        }
        Err(e) => {
            tracing::error!("credit failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "credit failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub report_id: Uuid,
    /// `resolved` or `dismissed`.
    pub action: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /api/admin/report/resolve` — close a report (resolved or dismissed).
pub async fn resolve_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResolveRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return forbidden();
    }
    let Some(pool) = state.pool.as_ref() else {
        return unavailable();
    };
    let status = match body.action.as_str() {
        "resolved" | "dismissed" => body.action.as_str(),
        _ => return (StatusCode::BAD_REQUEST, "action must be resolved|dismissed").into_response(),
    };
    let who = actor(&body.actor);
    match sqlx::query(
        "UPDATE reports SET status = $2, resolved_at = now(), resolved_by = $3, action_note = $4
         WHERE id = $1",
    )
    .bind(body.report_id)
    .bind(status)
    .bind(who)
    .bind(body.note.as_deref())
    .execute(pool)
    .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND, "no such report").into_response()
        }
        Ok(_) => {
            audit(
                pool,
                who,
                "resolve_report",
                Some(&body.report_id.to_string()),
                serde_json::json!({ "action": status, "note": body.note }),
            )
            .await;
            ok()
        }
        Err(e) => {
            tracing::error!("resolve failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "resolve failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct DeleteRequest {
    pub user_id: Uuid,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /api/admin/user/delete` — erase a user and all linked data (GDPR).
pub async fn delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DeleteRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return forbidden();
    }
    let (Some(safety), Some(pool)) = (state.safety.as_ref(), state.pool.as_ref()) else {
        return unavailable();
    };
    // Audit BEFORE the delete — the cascade would otherwise erase nothing of the
    // audit (it's a free-standing table), but recording first is the safe order.
    audit(
        pool,
        actor(&body.actor),
        "delete_user",
        Some(&body.user_id.to_string()),
        serde_json::json!({}),
    )
    .await;
    match safety.delete_user(body.user_id).await {
        Ok(()) => ok(),
        Err(e) => {
            tracing::error!("admin delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "delete failed").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::constant_eq;

    #[test]
    fn constant_eq_matches_only_exact() {
        assert!(constant_eq(Some("s3cret"), "s3cret"));
        assert!(!constant_eq(Some("s3cret"), "s3creT"));
        assert!(!constant_eq(Some("short"), "longer-secret"));
        assert!(!constant_eq(None, "s3cret"));
    }
}
