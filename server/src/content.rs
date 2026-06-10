//! Public, read-only content endpoints backed by the Directus-managed tables:
//! UI strings (`i18n_*`) and legal pages (`legal_*`). The client fetches these at
//! runtime and layers them over its bundled defaults, so editors can change copy
//! and translations without a redeploy. Also loads the moderation blocklist from
//! the database at startup.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header::CACHE_CONTROL, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::db::Pool;
use crate::AppState;

/// Managed content changes rarely and is edited in the backoffice, so a short
/// cache window (browser + any CDN) avoids refetching the full string map on
/// every page load while staying fresh within a minute (plus background
/// revalidation). Applied to successful responses only.
fn with_cache(mut resp: Response) -> Response {
    resp.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60, stale-while-revalidate=300"),
    );
    resp
}

/// `GET /api/content/i18n` — every DB-managed string override, grouped by
/// language: `{ "en": { "key": "value", … }, "it": { … } }`. Empty when nothing
/// is managed yet (the client then keeps its bundled strings).
pub async fn get_i18n(State(state): State<AppState>) -> Response {
    let Some(pool) = state.pool.as_ref() else {
        return Json(serde_json::json!({})).into_response();
    };
    let rows: Vec<(String, String, String)> = match sqlx::query_as(
        "SELECT t.language, s.key, t.value
           FROM i18n_translations t
           JOIN i18n_strings s ON s.id = t.string_id",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("i18n load failed: {e}");
            return Json(serde_json::json!({})).into_response();
        }
    };
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (lang, key, value) in rows {
        out.entry(lang).or_default().insert(key, value);
    }
    with_cache(Json(out).into_response())
}

#[derive(Deserialize)]
pub struct LegalQuery {
    #[serde(default)]
    pub lang: Option<String>,
}

/// `GET /api/content/legal/{slug}?lang=xx` — a legal page in the requested
/// language, falling back to English, then to whatever exists. 404 when the page
/// isn't managed (the client then renders its bundled copy).
pub async fn get_legal(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(q): Query<LegalQuery>,
) -> Response {
    let Some(pool) = state.pool.as_ref() else {
        return (StatusCode::NOT_FOUND, "no managed content").into_response();
    };
    let lang = q.lang.unwrap_or_else(|| "en".into());
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT p.slug, p.version, tr.title, tr.body
           FROM legal_pages p
           JOIN legal_translations tr ON tr.page_id = p.id
          WHERE p.slug = $1
          ORDER BY (tr.language = $2) DESC, (tr.language = 'en') DESC
          LIMIT 1",
    )
    .bind(&slug)
    .bind(&lang)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    match row {
        Some((slug, version, title, body)) => with_cache(
            Json(serde_json::json!({
                "slug": slug,
                "version": version,
                "title": title,
                "body": body,
            }))
            .into_response(),
        ),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Load every blocklist term (all language scopes) for the [`Moderator`] at
/// startup. Errors degrade to an empty list (the env baseline still applies).
///
/// [`Moderator`]: crate::moderation::Moderator
pub async fn load_blocklist_terms(pool: &Pool) -> Vec<String> {
    sqlx::query_scalar::<_, String>("SELECT term FROM blocklist_terms")
        .fetch_all(pool)
        .await
        .unwrap_or_default()
}
