//! REST API handlers for billing + usage: package catalog, Stripe checkout,
//! Stripe webhook, credit history, and usage history.
//!
//! All money internals (cost, markup, rate, `stripe_price_id`) stay server-side
//! — only `balance`, package prices/credits, and deltas reach the client.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::billing::usd;
use crate::middleware::AuthUser;
use crate::stripe_handler;
use crate::AppState;

/// `GET /api/billing/packages` — the credit catalog (without `stripe_price_id`).
pub async fn billing_packages(State(state): State<AppState>) -> Response {
    match state.config.billing.as_ref() {
        Some(cfg) => Json(&cfg.pricing.packages).into_response(),
        None => service_unavailable(),
    }
}

#[derive(Deserialize)]
pub struct CheckoutRequest {
    pub package_id: String,
}

/// `POST /api/billing/checkout` — start a Stripe Checkout Session for a package.
/// Rate-limited per user. Returns `{ "url": "https://checkout.stripe.com/..." }`.
pub async fn billing_checkout(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CheckoutRequest>,
) -> Response {
    let Some(cfg) = state.config.billing.as_ref() else {
        return service_unavailable();
    };

    // Throttle checkout creation per user (10 / minute).
    if !state.rate_limiter.allow(
        &format!("checkout:{}", user.user_id),
        10,
        Duration::from_secs(60),
    ) {
        return (StatusCode::TOO_MANY_REQUESTS, "too many requests").into_response();
    }

    let Some(pkg) = cfg
        .pricing
        .packages
        .iter()
        .find(|p| p.id == body.package_id)
    else {
        return (StatusCode::BAD_REQUEST, "unknown package").into_response();
    };
    if cfg.stripe_secret_key.trim().is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, "payments not configured").into_response();
    }

    match stripe_handler::create_checkout_session(&state.http, cfg, pkg, &user.user_id).await {
        Ok(url) => Json(serde_json::json!({ "url": url })).into_response(),
        Err(e) => {
            tracing::error!("stripe checkout failed: {e}");
            (StatusCode::BAD_GATEWAY, "checkout failed").into_response()
        }
    }
}

/// `POST /api/billing/webhook` — verify the Stripe signature, then on
/// `checkout.session.completed` credit the user idempotently.
pub async fn billing_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (Some(cfg), Some(billing)) = (state.config.billing.as_ref(), state.billing.as_ref()) else {
        return service_unavailable();
    };

    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !stripe_handler::verify_stripe_signature(&cfg.stripe_webhook_secret, &body, sig) {
        return (StatusCode::BAD_REQUEST, "invalid signature").into_response();
    }

    let event: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid payload").into_response(),
    };
    let event_id = event["id"].as_str().unwrap_or_default();
    let event_type = event["type"].as_str().unwrap_or_default();
    if event_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing event id").into_response();
    }

    if event_type == "checkout.session.completed" {
        let meta = &event["data"]["object"]["metadata"];
        let user_id = meta["user_id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok());
        // Stripe metadata values are strings; accept a number too, defensively.
        let credits = meta["credits_usd"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| meta["credits_usd"].as_f64());
        let package = meta["package_id"].as_str().unwrap_or("credits");

        match (user_id, credits) {
            (Some(uid), Some(cr)) if cr > 0.0 => {
                match billing
                    .credit_from_stripe_event(
                        event_id,
                        event_type,
                        uid,
                        usd(cr),
                        &format!("Purchase: {package}"),
                    )
                    .await
                {
                    Ok(true) => tracing::info!(%uid, credits = cr, %event_id, "credited purchase"),
                    Ok(false) => tracing::info!(%event_id, "duplicate webhook ignored"),
                    Err(e) => {
                        tracing::error!("crediting failed: {e}");
                        return (StatusCode::INTERNAL_SERVER_ERROR, "credit failed")
                            .into_response();
                    }
                }
            }
            _ => tracing::warn!(%event_id, "checkout.session.completed missing metadata"),
        }
    }

    (StatusCode::OK, "ok").into_response()
}

/// `GET /api/billing/history` — the authenticated user's recent ledger entries.
pub async fn billing_history(State(state): State<AppState>, user: AuthUser) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return service_unavailable();
    };
    match billing.get_history(user.user_id, 50).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::error!("history query failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

/// `GET /api/usage/sessions` — the authenticated user's recent usage sessions.
pub async fn usage_sessions(State(state): State<AppState>, user: AuthUser) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return service_unavailable();
    };
    match billing.get_sessions(user.user_id, 50).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::error!("usage query failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

fn service_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "auth/billing not configured",
    )
        .into_response()
}

/// The ToS/Privacy version a consent is recorded against.
pub const CURRENT_TOS_VERSION: &str = "2026-06-10";

#[derive(Deserialize)]
pub struct ReportRequest {
    pub room: String,
    #[serde(default)]
    pub reported_peer_id: Option<String>,
    #[serde(default)]
    pub reported_name: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub transcript_excerpt: Option<String>,
}

/// `POST /api/report` — file an abuse report against a peer.
pub async fn report(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<ReportRequest>,
) -> Response {
    let Some(safety) = state.safety.as_ref() else {
        return service_unavailable();
    };
    if body.reason.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing reason").into_response();
    }
    // Truncate the excerpt defensively.
    let excerpt = body
        .transcript_excerpt
        .as_deref()
        .map(|s| s.chars().take(500).collect::<String>());
    match safety
        .record_report(
            user.user_id,
            &body.room,
            body.reported_peer_id.as_deref(),
            body.reported_name.as_deref(),
            &body.reason,
            excerpt.as_deref(),
        )
        .await
    {
        Ok(()) => (StatusCode::CREATED, "reported").into_response(),
        Err(e) => {
            tracing::error!("report failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "report failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct ConsentRequest {
    pub age_confirmed: bool,
}

/// `POST /api/user/consent` — record the user is 18+ and accepts the ToS/Privacy.
pub async fn submit_consent(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<ConsentRequest>,
) -> Response {
    let Some(safety) = state.safety.as_ref() else {
        return service_unavailable();
    };
    if !body.age_confirmed {
        return (StatusCode::FORBIDDEN, "must be 18+ to use this service").into_response();
    }
    match safety.set_consent(user.user_id, CURRENT_TOS_VERSION).await {
        Ok(()) => Json(serde_json::json!({ "consent_given": true })).into_response(),
        Err(e) => {
            tracing::error!("consent failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "consent failed").into_response()
        }
    }
}

/// `GET /api/user/data` — export everything we hold on the user (GDPR).
pub async fn export_data(State(state): State<AppState>, user: AuthUser) -> Response {
    let Some(safety) = state.safety.as_ref() else {
        return service_unavailable();
    };
    match safety.export_user_data(user.user_id).await {
        Ok(data) => Json(data).into_response(),
        Err(e) => {
            tracing::error!("export failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "export failed").into_response()
        }
    }
}

/// `DELETE /api/user` — erase the account and all linked data (GDPR).
pub async fn delete_account(State(state): State<AppState>, user: AuthUser) -> Response {
    let Some(safety) = state.safety.as_ref() else {
        return service_unavailable();
    };
    match safety.delete_user(user.user_id).await {
        Ok(()) => (StatusCode::OK, "deleted").into_response(),
        Err(e) => {
            tracing::error!("delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "delete failed").into_response()
        }
    }
}
