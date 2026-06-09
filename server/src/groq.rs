//! Groq chat-completion client used to translate a finalized transcript.
//! Non-streaming: a single sentence is fast enough (~120ms) and simpler.

use serde::Deserialize;
use std::time::Duration;

const GROQ_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
/// Spec model id. Centralized here so a Groq rename is a one-line change.
const MODEL: &str = "llama-3.1-8b-instant";

/// Cloneable translation client. Wraps a pooled `reqwest::Client` (keep-alive)
/// and the API key.
#[derive(Clone)]
pub struct Groq {
    http: reqwest::Client,
    api_key: String,
}

impl Groq {
    pub fn new(api_key: String) -> Self {
        let http = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build reqwest client");
        Self { http, api_key }
    }

    /// Translate `text` from `source` to `target` (language codes like "it", "en").
    /// Returns the translation only (no quotes/preamble). Retries once on HTTP 429.
    pub async fn translate(
        &self,
        text: &str,
        source: &str,
        target: &str,
    ) -> Result<String, String> {
        let system = format!(
            "You are a real-time speech translator. Translate from {src} to {tgt}. \
             Output ONLY the translation. No quotes, no explanation, no preamble. \
             Preserve tone, register, and speech patterns. Handle informal/spoken \
             language naturally. If text is already in target language, return it unchanged.",
            src = lang_name(source),
            tgt = lang_name(target),
        );

        let body = serde_json::json!({
            "model": MODEL,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": text },
            ],
            "temperature": 0.2,
            "max_tokens": 256,
        });

        // One retry on rate limit with a short backoff.
        for attempt in 0..2 {
            let resp = self
                .http
                .post(GROQ_URL)
                .bearer_auth(&self.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("groq request failed: {e}"))?;

            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            }

            if !resp.status().is_success() {
                let status = resp.status();
                let detail = resp.text().await.unwrap_or_default();
                return Err(format!("groq returned {status}: {detail}"));
            }

            let parsed: ChatResponse = resp
                .json()
                .await
                .map_err(|e| format!("groq response parse failed: {e}"))?;

            let translated = parsed
                .choices
                .into_iter()
                .next()
                .map(|c| c.message.content.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "groq returned empty translation".to_string())?;

            return Ok(translated);
        }

        Err("groq rate limited after retry".to_string())
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

/// Map a short language code to a human-readable name for the prompt. Unknown
/// codes pass through unchanged so the model still gets a usable hint.
fn lang_name(code: &str) -> &str {
    match code {
        "it" => "Italian",
        "en" => "English",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "pt" => "Portuguese",
        "ja" => "Japanese",
        "zh" => "Chinese",
        other => other,
    }
}
