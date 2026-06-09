//! Shared message types for client <-> server communication and for parsing
//! Deepgram streaming responses.
//!
//! V2: video-meeting model. Every peer speaks, listens, and connects P2P via
//! WebRTC; the server relays signaling, fans out translations, and relays chat.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// --- Client -> Server ------------------------------------------------------

/// Messages a peer sends as JSON text frames. (Audio is sent as binary frames.)
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Begin a speaking session (opens a fresh Deepgram connection).
    Start,
    /// End the speaking session (flush + close Deepgram).
    Stop,
    /// WebRTC signaling, relayed verbatim to peer `to` (server adds `from`).
    Offer { to: String, sdp: String },
    Answer { to: String, sdp: String },
    Ice {
        to: String,
        candidate: serde_json::Value,
    },
    /// A chat message to be translated and broadcast to the room.
    Chat { text: String },
    /// Local mute state, broadcast to peers for UI indicators.
    MuteAudio { muted: bool },
    MuteVideo { muted: bool },
}

// --- Server -> Client ------------------------------------------------------

/// Lightweight peer descriptor sent in `room_joined`.
#[derive(Debug, Clone, Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub user_name: String,
    pub lang: String,
}

/// Messages the server pushes to peers as JSON text frames.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent to a peer right after joining: its own id + the existing peers.
    RoomJoined {
        peer_id: String,
        peers: Vec<PeerInfo>,
    },
    /// A new peer joined (sent to the others).
    PeerJoined {
        peer_id: String,
        user_name: String,
        lang: String,
    },
    /// A peer left.
    PeerLeft { peer_id: String },
    /// The room already has the maximum number of peers; the join is rejected.
    RoomFull,

    /// WebRTC signaling relayed from peer `from`.
    Offer { from: String, sdp: String },
    Answer { from: String, sdp: String },
    Ice {
        from: String,
        candidate: serde_json::Value,
    },

    /// A translated chat message (broadcast to everyone, including the sender).
    ChatMessage {
        sender_id: String,
        sender_name: String,
        sender_lang: String,
        original: String,
        translations: HashMap<String, String>,
        timestamp: u64,
    },

    /// A peer toggled audio/video; `kind` is "audio" or "video".
    PeerMuted {
        peer_id: String,
        kind: String,
        muted: bool,
    },

    /// Live partial transcript for a speaker (original language), broadcast so
    /// everyone can show it on the speaker's video cell.
    SubtitleInterim {
        speaker_id: String,
        speaker_name: String,
        text: String,
        lang: String,
    },
    /// Finalized transcript + translations into every language in the room.
    /// Each client renders `translations[my_lang]` (falling back to `original`).
    SubtitleFinal {
        speaker_id: String,
        speaker_name: String,
        original: String,
        lang: String,
        translations: HashMap<String, String>,
    },

    /// Non-fatal error surfaced to a peer.
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
/// Every peer is symmetric (speaks and listens). `lang` is the single language
/// the peer speaks and receives in. `public` sets visibility on room creation.
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
