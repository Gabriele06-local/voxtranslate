//! REST API handlers for billing + usage: package catalog, Stripe checkout,
//! Stripe webhook, credit history, and usage history.
//!
//! All money internals (cost, markup, rate, `stripe_price_id`) stay server-side
//! — only `balance`, package prices/credits, and deltas reach the client.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;

use crate::billing::usd;
use crate::middleware::AuthUser;
use crate::stripe_handler;
use crate::transcripts::SessionAccess;
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

/// Shared 402 responder for credit-charged AI features. The pre-check is
/// advisory (the atomic `deduct_feature` is the real gate) but lets the client
/// show "need X, have Y" before any AI work runs.
pub fn insufficient_credits(feature: &str, required: Decimal, available: Decimal) -> Response {
    (
        StatusCode::PAYMENT_REQUIRED,
        Json(serde_json::json!({
            "error": "insufficient_credits",
            "required": required.to_f64().unwrap_or(0.0),
            "available": available.to_f64().unwrap_or(0.0),
            "feature": feature,
        })),
    )
        .into_response()
}

/// `GET /api/billing/ai-pricing` — per-feature user rates for client cost
/// previews. These are the env-configured user-facing prices; raw cost/markup
/// internals are never exposed.
pub async fn ai_pricing(State(state): State<AppState>) -> Response {
    let Some(cfg) = state.config.billing.as_ref() else {
        return service_unavailable();
    };
    let ai = &cfg.ai;
    Json(serde_json::json!({
        "report": { "base": ai.report_base, "per_minute": ai.report_per_minute },
        "sentiment": {
            "base": ai.sentiment_base,
            "per_participant": ai.sentiment_per_participant,
            "per_minute": ai.sentiment_per_minute,
        },
        "email": { "draft": ai.email_draft },
        "suggestions": {
            "per_minute": ai.suggestions_per_minute,
            "interval_seconds": ai.suggestions_interval_secs,
        },
        "email_enabled": state.config.resend.is_some(),
    }))
    .into_response()
}

/// `GET /api/sessions` — call sessions the user took part in, newest first.
pub async fn sessions_list(State(state): State<AppState>, user: AuthUser) -> Response {
    let Some(svc) = state.transcripts.as_ref() else {
        return service_unavailable();
    };
    // Barrier so just-finished calls show their final event counts.
    svc.flush().await;
    match svc.list_sessions(user.user_id, 50).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::error!("sessions query failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response()
        }
    }
}

/// `GET /api/sessions/{id}/transcript.json` — download the transcript as
/// pretty-printed JSON. Participants only (404 unknown / 403 stranger).
pub async fn transcript_json(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session_id): Path<Uuid>,
) -> Response {
    let Some(svc) = state.transcripts.as_ref() else {
        return service_unavailable();
    };
    // Barrier kills the leave-then-download race and enables live mid-call export.
    svc.flush().await;

    match svc.access(session_id, user.user_id).await {
        Ok(SessionAccess::Ok) => {}
        Ok(SessionAccess::NotFound) => {
            return (StatusCode::NOT_FOUND, "no such session").into_response()
        }
        Ok(SessionAccess::Forbidden) => {
            return (StatusCode::FORBIDDEN, "not a participant").into_response()
        }
        Err(e) => {
            tracing::error!("transcript access check failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    }

    let export = match svc.export(session_id).await {
        Ok(Some(doc)) => doc,
        // Purged between the access check and here (guest-only finalize race).
        Ok(None) => return (StatusCode::NOT_FOUND, "no such session").into_response(),
        Err(e) => {
            tracing::error!("transcript export failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    let body = match serde_json::to_string_pretty(&export) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("transcript serialization failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "export failed").into_response();
        }
    };
    let filename = transcript_filename(&export.session.room_name, session_id, "json");
    (
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize, Default)]
pub struct TranscriptPdfQuery {
    /// IANA timezone for displayed times (e.g. `Europe/Rome`); bogus → UTC.
    pub tz: Option<String>,
    /// Translation language to show per event; default = the requester's own
    /// participant language for that session, fallback `en`.
    pub lang: Option<String>,
}

/// `GET /api/sessions/{id}/transcript.pdf?tz=Europe/Rome&lang=it` — download
/// the transcript as a typst-rendered PDF. Same auth gates as the JSON export,
/// plus a per-user rate limit (PDF compilation is CPU-bound).
pub async fn transcript_pdf(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session_id): Path<Uuid>,
    Query(q): Query<TranscriptPdfQuery>,
) -> Response {
    let Some(svc) = state.transcripts.as_ref() else {
        return service_unavailable();
    };

    // Throttle before any work — rendering costs real CPU (5 / minute).
    if !state
        .rate_limiter
        .allow(&format!("pdf:{}", user.user_id), 5, Duration::from_secs(60))
    {
        return (StatusCode::TOO_MANY_REQUESTS, "too many requests").into_response();
    }

    // Barrier kills the leave-then-download race and enables live mid-call export.
    svc.flush().await;

    match svc.access(session_id, user.user_id).await {
        Ok(SessionAccess::Ok) => {}
        Ok(SessionAccess::NotFound) => {
            return (StatusCode::NOT_FOUND, "no such session").into_response()
        }
        Ok(SessionAccess::Forbidden) => {
            return (StatusCode::FORBIDDEN, "not a participant").into_response()
        }
        Err(e) => {
            tracing::error!("transcript access check failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    }

    let export = match svc.export(session_id).await {
        Ok(Some(doc)) => doc,
        // Purged between the access check and here (guest-only finalize race).
        Ok(None) => return (StatusCode::NOT_FOUND, "no such session").into_response(),
        Err(e) => {
            tracing::error!("transcript export failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    let tz =
        q.tz.as_deref()
            .and_then(|s| s.parse::<chrono_tz::Tz>().ok())
            .unwrap_or(chrono_tz::UTC);
    let lang = match q.lang {
        Some(l) => l,
        None => svc
            .participant_lang(session_id, user.user_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "en".to_string()),
    };

    let doc_json = match serde_json::to_string(&crate::pdf::build_pdf_doc(&export, tz, &lang)) {
        Ok(j) => j,
        Err(e) => {
            tracing::error!("pdf doc serialization failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "export failed").into_response();
        }
    };
    // typst compilation is CPU-bound — keep it off the async runtime.
    let rendered =
        tokio::task::spawn_blocking(move || crate::pdf::render_transcript_pdf(&doc_json)).await;
    let pdf = match rendered {
        Ok(Ok(pdf)) => pdf,
        Ok(Err(e)) => {
            tracing::error!("transcript pdf render failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "pdf render failed").into_response();
        }
        Err(e) => {
            tracing::error!("transcript pdf task panicked: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "pdf render failed").into_response();
        }
    };

    let filename = transcript_filename(&export.session.room_name, session_id, "pdf");
    (
        [
            (header::CONTENT_TYPE, "application/pdf".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        pdf.bytes,
    )
        .into_response()
}

#[derive(Deserialize, Default)]
pub struct SubtitleQuery {
    /// `original` | `translated` (default) | `both`.
    pub lang: Option<String>,
    /// Translation language for `translated`/`both`; default = the requester's
    /// own participant language for that session, fallback `en`.
    pub target: Option<String>,
}

/// `GET /api/sessions/{id}/transcript.srt?lang=both&target=it` — SubRip
/// subtitles. Same auth gates as the JSON export.
pub async fn transcript_srt(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session_id): Path<Uuid>,
    Query(q): Query<SubtitleQuery>,
) -> Response {
    subtitles_response(state, user, session_id, q, SubtitleFormat::Srt).await
}

/// `GET /api/sessions/{id}/transcript.vtt?lang=both&target=it` — WebVTT
/// subtitles with `<v Speaker>` voice tags. Same auth gates as the JSON export.
pub async fn transcript_vtt(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session_id): Path<Uuid>,
    Query(q): Query<SubtitleQuery>,
) -> Response {
    subtitles_response(state, user, session_id, q, SubtitleFormat::Vtt).await
}

enum SubtitleFormat {
    Srt,
    Vtt,
}

async fn subtitles_response(
    state: AppState,
    user: AuthUser,
    session_id: Uuid,
    q: SubtitleQuery,
    format: SubtitleFormat,
) -> Response {
    let Some(svc) = state.transcripts.as_ref() else {
        return service_unavailable();
    };
    let mode = match q.lang.as_deref() {
        None => crate::subtitles::LangMode::Translated,
        Some(s) => match crate::subtitles::LangMode::parse(s) {
            Some(m) => m,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    "lang must be original, translated or both",
                )
                    .into_response()
            }
        },
    };

    // Barrier kills the leave-then-download race and enables live mid-call export.
    svc.flush().await;

    match svc.access(session_id, user.user_id).await {
        Ok(SessionAccess::Ok) => {}
        Ok(SessionAccess::NotFound) => {
            return (StatusCode::NOT_FOUND, "no such session").into_response()
        }
        Ok(SessionAccess::Forbidden) => {
            return (StatusCode::FORBIDDEN, "not a participant").into_response()
        }
        Err(e) => {
            tracing::error!("transcript access check failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    }

    let export = match svc.export(session_id).await {
        Ok(Some(doc)) => doc,
        // Purged between the access check and here (guest-only finalize race).
        Ok(None) => return (StatusCode::NOT_FOUND, "no such session").into_response(),
        Err(e) => {
            tracing::error!("transcript export failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "db error").into_response();
        }
    };

    let target = match q.target {
        Some(t) => t,
        None => svc
            .participant_lang(session_id, user.user_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "en".to_string()),
    };

    let cues = crate::subtitles::compute_cues(
        &export.events,
        export.session.started_at,
        mode,
        &target,
    );
    let (body, content_type, ext) = match format {
        SubtitleFormat::Srt => (
            crate::subtitles::build_srt(&cues),
            "application/x-subrip",
            "srt",
        ),
        SubtitleFormat::Vtt => (crate::subtitles::build_vtt(&cues), "text/vtt", "vtt"),
    };
    let filename = transcript_filename(&export.session.room_name, session_id, ext);
    (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    )
        .into_response()
}

/// `voxtranslate-{room_slug}-{id8}.{ext}` — the room slug is filtered to
/// `[A-Za-z0-9_-]` so user-chosen room names can't inject header syntax.
fn transcript_filename(room: &str, session_id: Uuid, ext: &str) -> String {
    let slug: String = room
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect();
    let slug = if slug.is_empty() { "room".into() } else { slug };
    let id = session_id.to_string();
    let id8 = &id[..8];
    format!("voxtranslate-{slug}-{id8}.{ext}")
}

/// The ToS/Privacy version a consent is recorded against.
pub const CURRENT_TOS_VERSION: &str = "2026-06-10";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_filename_sanitizes_room_names() {
        let sid = Uuid::parse_str("a1b2c3d4-0000-0000-0000-000000000000").unwrap();
        assert_eq!(
            transcript_filename("my-room_1", sid, "json"),
            "voxtranslate-my-room_1-a1b2c3d4.json"
        );
        // Header-injection / quote-breaking characters are stripped.
        assert_eq!(
            transcript_filename("evil\"; rm -rf /\r\nX: y", sid, "pdf"),
            "voxtranslate-evilrm-rfXy-a1b2c3d4.pdf"
        );
        // Nothing survivable -> generic slug; long names truncated to 40 chars.
        assert_eq!(
            transcript_filename("🎉🎉🎉", sid, "json"),
            "voxtranslate-room-a1b2c3d4.json"
        );
        let long = "x".repeat(80);
        assert_eq!(
            transcript_filename(&long, sid, "json"),
            format!("voxtranslate-{}-a1b2c3d4.json", "x".repeat(40))
        );
    }
}

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
