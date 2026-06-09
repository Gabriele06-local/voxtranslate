//! Request extractors for authentication.
//!
//! [`AuthUser`] pulls a Bearer token from the `Authorization` header, verifies
//! the JWT against the configured secret, and yields the user id. Any failure
//! (no billing configured, missing/garbled header, bad/expired token) rejects
//! with `401 Unauthorized`.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::auth::verify_jwt;
use crate::AppState;

/// An authenticated user, extracted from a valid `Bearer` JWT.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub email: String,
    pub name: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let billing = state.config.billing.as_ref().ok_or_else(unauthorized)?;
        let token = bearer_token(parts).ok_or_else(unauthorized)?;
        let claims = verify_jwt(&billing.jwt_secret, &token).map_err(|_| unauthorized())?;
        let user_id = Uuid::parse_str(&claims.sub).map_err(|_| unauthorized())?;
        Ok(AuthUser {
            user_id,
            email: claims.email,
            name: claims.name,
        })
    }
}

/// Extract the raw token from an `Authorization: Bearer <token>` header.
fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value.strip_prefix("Bearer ").map(str::to_string)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}
