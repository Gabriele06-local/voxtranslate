//! `Config::from_env` guest-vs-billing detection. This test mutates
//! process-global env (`DATABASE_URL`, etc.), so it lives in its own integration
//! binary — running it inside the lib unit-test binary would race the DB-gated
//! tests that read `DATABASE_URL`.

use voxtranslate_server::config::Config;

#[test]
fn from_env_detects_guest_and_billing_modes() {
    std::env::set_var("DEEPGRAM_API_KEY", "dk");
    std::env::set_var("GROQ_API_KEY", "gk");
    for k in ["DATABASE_URL", "GOOGLE_CLIENT_ID", "JWT_SECRET", "PORT"] {
        std::env::remove_var(k);
    }

    // Guest-only mode (no billing env).
    let c = Config::from_env().unwrap();
    assert_eq!(c.port, 3001);
    assert!(!c.billing_enabled());

    // Billing mode activates when the three core values are present.
    std::env::set_var("DATABASE_URL", "postgres://x");
    std::env::set_var("GOOGLE_CLIENT_ID", "gid");
    std::env::set_var("JWT_SECRET", "secret");
    std::env::set_var("COST_PER_MINUTE", "0.01");
    std::env::set_var("MARKUP_PERCENTAGE", "0.5");
    let c = Config::from_env().unwrap();
    let b = c.billing.as_ref().expect("billing enabled");
    assert!((b.pricing.user_rate_per_minute - 0.015).abs() < 1e-9);
    assert_eq!(b.jwt_expiry_hours, 168);

    // A missing required key still fails.
    std::env::set_var("DEEPGRAM_API_KEY", "  ");
    assert!(Config::from_env().is_err());

    for k in [
        "DEEPGRAM_API_KEY",
        "GROQ_API_KEY",
        "DATABASE_URL",
        "GOOGLE_CLIENT_ID",
        "JWT_SECRET",
        "COST_PER_MINUTE",
        "MARKUP_PERCENTAGE",
    ] {
        std::env::remove_var(k);
    }
}
