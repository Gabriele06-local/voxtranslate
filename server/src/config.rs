//! Environment configuration, loaded from `.env` via dotenvy.
//!
//! Auth/billing is **optional**: it activates only when `DATABASE_URL`,
//! `GOOGLE_CLIENT_ID` and `JWT_SECRET` are all set. Otherwise the server runs in
//! guest-only mode (no accounts, no metering) — the original behavior.

use std::env;

use serde::{Deserialize, Serialize};

/// Runtime configuration for the server.
#[derive(Debug, Clone)]
pub struct Config {
    pub deepgram_key: String,
    pub groq_key: String,
    pub port: u16,
    /// Allowed CORS origins; empty means permissive (dev).
    pub allowed_origins: Vec<String>,
    /// Present only when auth/billing is configured.
    pub billing: Option<BillingConfig>,
}

/// Everything needed for accounts, credits, and payments.
#[derive(Debug, Clone)]
pub struct BillingConfig {
    pub database_url: String,
    pub google_client_id: String,
    pub jwt_secret: String,
    pub jwt_expiry_hours: i64,
    pub stripe_secret_key: String,
    pub stripe_webhook_secret: String,
    pub stripe_success_url: String,
    pub stripe_cancel_url: String,
    /// Optional cap on guest (un-authenticated) session length.
    pub guest_max_minutes: Option<u64>,
    /// Shared secret the Directus backoffice presents to the `/api/admin/*`
    /// endpoints (server-to-server). When absent, admin endpoints are disabled.
    pub admin_api_secret: Option<String>,
    pub pricing: PricingConfig,
}

/// Pricing — all values from env. The user-facing rate (cost × markup) and the
/// raw cost are NEVER serialized to clients.
#[derive(Debug, Clone)]
pub struct PricingConfig {
    pub cost_per_minute: f64,
    pub markup_percentage: f64,
    pub user_rate_per_minute: f64,
    pub user_rate_per_second: f64,
    pub free_credits: f64,
    pub low_balance_threshold: f64,
    pub min_balance_to_join: f64,
    pub usage_update_interval: u64,
    pub packages: Vec<CreditPackage>,
}

/// A purchasable credit package. `stripe_price_id` is read from env but never
/// sent to the client (`skip_serializing`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditPackage {
    pub id: String,
    pub name: String,
    pub price_usd: f64,
    pub credits_usd: f64,
    #[serde(skip_serializing)]
    pub stripe_price_id: String,
}

impl Config {
    /// Load configuration from the process environment.
    pub fn from_env() -> Result<Self, String> {
        let deepgram_key = require("DEEPGRAM_API_KEY")?;
        let groq_key = require("GROQ_API_KEY")?;
        let port = parse_or("PORT", 3001u16);
        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|o| o.trim().to_string())
                    .filter(|o| !o.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // Billing activates only when the three core values are present.
        let billing =
            if present("DATABASE_URL") && present("GOOGLE_CLIENT_ID") && present("JWT_SECRET") {
                Some(BillingConfig::from_env())
            } else {
                None
            };

        Ok(Self {
            deepgram_key,
            groq_key,
            port,
            allowed_origins,
            billing,
        })
    }

    pub fn billing_enabled(&self) -> bool {
        self.billing.is_some()
    }
}

impl BillingConfig {
    fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").unwrap_or_default(),
            google_client_id: env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            jwt_secret: env::var("JWT_SECRET").unwrap_or_default(),
            jwt_expiry_hours: parse_or("JWT_EXPIRY_HOURS", 168i64),
            stripe_secret_key: env::var("STRIPE_SECRET_KEY").unwrap_or_default(),
            stripe_webhook_secret: env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_default(),
            stripe_success_url: env::var("STRIPE_SUCCESS_URL").unwrap_or_default(),
            stripe_cancel_url: env::var("STRIPE_CANCEL_URL").unwrap_or_default(),
            guest_max_minutes: env::var("GUEST_MAX_MINUTES")
                .ok()
                .and_then(|s| s.parse().ok()),
            admin_api_secret: env::var("ADMIN_API_SECRET")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            pricing: PricingConfig::from_env(),
        }
    }
}

impl PricingConfig {
    fn from_env() -> Self {
        let cost_per_minute = parse_or("COST_PER_MINUTE", 0.008f64);
        let markup_percentage = parse_or("MARKUP_PERCENTAGE", 0.25f64);
        let (user_rate_per_minute, user_rate_per_second) =
            compute_rate(cost_per_minute, markup_percentage);
        let packages = env::var("CREDIT_PACKAGES")
            .ok()
            .map(|s| parse_packages(&s))
            .unwrap_or_default();
        Self {
            cost_per_minute,
            markup_percentage,
            user_rate_per_minute,
            user_rate_per_second,
            free_credits: parse_or("FREE_CREDITS", 2.0f64),
            low_balance_threshold: parse_or("LOW_BALANCE_THRESHOLD", 0.5f64),
            min_balance_to_join: parse_or("MIN_BALANCE_TO_JOIN", 0.05f64),
            usage_update_interval: parse_or("USAGE_UPDATE_INTERVAL", 5u64),
            packages,
        }
    }
}

/// Computed user rate: cost × (1 + markup), per minute and per second.
fn compute_rate(cost_per_minute: f64, markup: f64) -> (f64, f64) {
    let per_minute = cost_per_minute * (1.0 + markup);
    (per_minute, per_minute / 60.0)
}

/// Parse the `CREDIT_PACKAGES` JSON array; returns empty on malformed input.
fn parse_packages(json: &str) -> Vec<CreditPackage> {
    serde_json::from_str(json).unwrap_or_default()
}

fn present(name: &str) -> bool {
    env::var(name)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

fn parse_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn require(name: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!(
            "missing required environment variable `{name}` (set it in server/.env)"
        )),
    }
}

impl Config {
    /// Build a billing-enabled config for tests — defaults for everything except
    /// the database URL, JWT secret, and free-credit grant. Exposed (doc-hidden)
    /// so the integration-test crate can construct billing state.
    #[doc(hidden)]
    pub fn test_with_billing(database_url: &str, jwt_secret: &str, free_credits: f64) -> Self {
        let (user_rate_per_minute, user_rate_per_second) = compute_rate(0.008, 0.25);
        Self {
            deepgram_key: "dummy".into(),
            groq_key: "dummy".into(),
            port: 0,
            allowed_origins: vec![],
            billing: Some(BillingConfig {
                database_url: database_url.into(),
                google_client_id: "test-client".into(),
                jwt_secret: jwt_secret.into(),
                jwt_expiry_hours: 168,
                stripe_secret_key: String::new(),
                stripe_webhook_secret: String::new(),
                stripe_success_url: String::new(),
                stripe_cancel_url: String::new(),
                guest_max_minutes: None,
                admin_api_secret: Some("test-admin-secret".into()),
                pricing: PricingConfig {
                    cost_per_minute: 0.008,
                    markup_percentage: 0.25,
                    user_rate_per_minute,
                    user_rate_per_second,
                    free_credits,
                    low_balance_threshold: 0.5,
                    min_balance_to_join: 0.05,
                    usage_update_interval: 5,
                    packages: vec![],
                },
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_math() {
        let (per_min, per_sec) = compute_rate(0.008, 0.25);
        assert!((per_min - 0.01).abs() < 1e-9);
        assert!((per_sec - 0.01 / 60.0).abs() < 1e-12);
    }

    #[test]
    fn packages_parse() {
        let json = r#"[{"id":"plus","name":"Plus","price_usd":15.0,"credits_usd":17.0,"stripe_price_id":"price_x"}]"#;
        let pkgs = parse_packages(json);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].id, "plus");
        assert_eq!(pkgs[0].stripe_price_id, "price_x");
        // stripe_price_id is never serialized to the client.
        let out = serde_json::to_string(&pkgs[0]).unwrap();
        assert!(!out.contains("stripe_price_id") && !out.contains("price_x"));
        assert!(parse_packages("not json").is_empty());
    }

    // NOTE: `Config::from_env()` reads process-global env, so its guest-vs-billing
    // detection is tested in a *separate* binary (`tests/config_env.rs`) — mutating
    // `DATABASE_URL` here would race the DB-gated tests in this binary.
}
