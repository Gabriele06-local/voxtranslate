//! Shared message types for client <-> server communication and for parsing
//! Deepgram streaming responses.

use serde::{Deserialize, Serialize};

/// Messages the server pushes to participants as JSON over WebSocket text frames.
///
/// Serialized with an internal `type` tag, lowercased to match the client's
/// `switch (data.type)`. Every speech message carries `from` (display name) and
/// `from_id` (stable participant id) so the UI can attribute it ("Tu" for self).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMessage {
    /// Partial transcript, sent only back to the speaker as live self-feedback.
    Interim {
        from: String,
        from_id: String,
        text: String,
        lang: String,
    },
    /// Finalized transcript in the speaker's language, sent to everyone who
    /// shares that language (including the speaker).
    Transcript {
        from: String,
        from_id: String,
        text: String,
        lang: String,
    },
    /// Translated text in a recipient language, sent to participants of that
    /// language. One per distinct other-language in the room.
    Translation {
        from: String,
        from_id: String,
        original: String,
        translated: String,
        source_lang: String,
        target_lang: String,
    },
    /// Non-fatal error surfaced to a participant.
    Error { message: String },
}

impl ServerMessage {
    /// Serialize to a JSON string for sending over a text frame.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"type":"error","message":"serialization failed"}"#.to_string()
        })
    }
}

/// Query parameters for the `/ws` upgrade route:
/// `/ws?room=..&lang=..&name=..&id=..&public=..`
///
/// Every participant is symmetric (speaks and listens), so there is no role.
/// `lang` is the single language the participant speaks and receives in.
/// `public` sets the room's visibility when it is first created (otherwise the
/// existing room's visibility is kept). Absent/false → private.
#[derive(Debug, Clone, Deserialize)]
pub struct WsParams {
    pub room: String,
    pub lang: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub public: Option<bool>,
}

// --- Lobby (GET /rooms) ----------------------------------------------------

/// One online participant as shown in the public lobby.
#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub name: String,
    pub lang: String,
}

/// A public room with its currently online members.
#[derive(Debug, Clone, Serialize)]
pub struct PublicRoom {
    pub room: String,
    pub count: usize,
    pub participants: Vec<Member>,
}

/// Response body for `GET /rooms`.
#[derive(Debug, Clone, Serialize)]
pub struct RoomsResponse {
    pub rooms: Vec<PublicRoom>,
}

/// Control frames a participant sends as JSON text to bracket a speaking session.
/// `start` opens a fresh Deepgram connection, `stop` flushes and closes it.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientControl {
    Start,
    Stop,
}

// --- Deepgram streaming response parsing -----------------------------------

/// A Deepgram streaming message. We only model the fields we use; everything
/// else (Metadata, UtteranceEnd, SpeechStarted, ...) deserializes with defaults.
#[derive(Debug, Deserialize)]
pub struct DeepgramResponse {
    #[serde(rename = "type", default)]
    pub msg_type: String,
    #[serde(default)]
    pub is_final: bool,
    #[serde(default)]
    pub channel: Option<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramChannel {
    #[serde(default)]
    pub alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
pub struct DeepgramAlternative {
    #[serde(default)]
    pub transcript: String,
    #[serde(default)]
    pub confidence: f32,
}

impl DeepgramResponse {
    /// Returns the best (first) alternative's transcript + confidence if this is
    /// a non-empty `Results` message, else `None`.
    pub fn best_alternative(&self) -> Option<(&str, f32)> {
        if self.msg_type != "Results" {
            return None;
        }
        let alt = self.channel.as_ref()?.alternatives.first()?;
        let text = alt.transcript.trim();
        if text.is_empty() {
            return None;
        }
        Some((text, alt.confidence))
    }
}
