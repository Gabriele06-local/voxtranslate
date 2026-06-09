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
