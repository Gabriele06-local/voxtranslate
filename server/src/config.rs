//! Environment configuration, loaded from `.env` via dotenvy.

use std::env;

/// Runtime configuration for the server.
#[derive(Debug, Clone)]
pub struct Config {
    pub deepgram_key: String,
    pub groq_key: String,
    pub port: u16,
}

impl Config {
    /// Load configuration from the process environment.
    ///
    /// `dotenvy` is expected to have already populated env vars from `.env`.
    /// Fails fast with a descriptive error if a required key is missing.
    pub fn from_env() -> Result<Self, String> {
        let deepgram_key = require("DEEPGRAM_API_KEY")?;
        let groq_key = require("GROQ_API_KEY")?;
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3001);

        Ok(Self {
            deepgram_key,
            groq_key,
            port,
        })
    }
}

fn require(name: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!(
            "missing required environment variable `{name}` (set it in server/.env)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serialized: these mutate process-global env. Keep them in one test.
    #[test]
    fn from_env_requires_keys_and_defaults_port() {
        std::env::set_var("DEEPGRAM_API_KEY", "dk");
        std::env::set_var("GROQ_API_KEY", "gk");
        std::env::remove_var("PORT");
        let c = Config::from_env().unwrap();
        assert_eq!(c.deepgram_key, "dk");
        assert_eq!(c.groq_key, "gk");
        assert_eq!(c.port, 3001);

        std::env::set_var("PORT", "9090");
        assert_eq!(Config::from_env().unwrap().port, 9090);

        std::env::set_var("PORT", "not-a-number");
        assert_eq!(Config::from_env().unwrap().port, 3001); // falls back to default

        std::env::set_var("DEEPGRAM_API_KEY", "   ");
        assert!(Config::from_env().is_err()); // blank is rejected

        std::env::remove_var("DEEPGRAM_API_KEY");
        std::env::remove_var("GROQ_API_KEY");
        std::env::remove_var("PORT");
    }
}
