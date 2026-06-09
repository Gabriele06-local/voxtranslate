//! Ephemeral room registry. Each room holds its participants and a visibility
//! (public rooms are listed in the lobby). Every participant can both speak and
//! listen, so messages are routed by language:
//! - a speaker's transcript goes to everyone sharing the speaker's language,
//! - a translation goes to everyone whose language is the (distinct) target.

use dashmap::DashMap;
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::{Member, PublicRoom};

/// Room visibility. Public rooms are advertised in the lobby (`GET /rooms`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
}

/// A connected participant: identity, the language they speak/receive in, and a
/// channel to push JSON text frames to their WebSocket.
#[derive(Clone)]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub tx: UnboundedSender<String>,
}

/// A room and its current members.
struct Room {
    visibility: Visibility,
    participants: Vec<Participant>,
}

/// Manages ephemeral rooms. No persistence — everything lives in memory and is
/// cleaned up as participants disconnect.
#[derive(Default)]
pub struct RoomManager {
    rooms: DashMap<String, Room>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a participant to a room, creating it with `visibility` if new (an
    /// existing room keeps its original visibility).
    pub fn join(&self, room_id: &str, participant: Participant, visibility: Visibility) {
        let mut room = self.rooms.entry(room_id.to_string()).or_insert_with(|| Room {
            visibility,
            participants: Vec::new(),
        });
        room.participants.push(participant);
    }

    /// Remove a participant by id, dropping the room once empty.
    pub fn remove(&self, room_id: &str, id: &str) {
        if let Some(mut room) = self.rooms.get_mut(room_id) {
            room.participants.retain(|p| p.id != id);
        }
        self.rooms
            .remove_if(room_id, |_, room| room.participants.is_empty());
    }

    /// Send to every participant in the room, pruning dead channels.
    /// Reserved for room-wide notices (kept for future use).
    #[allow(dead_code)]
    pub fn broadcast(&self, room_id: &str, message: &str) {
        if let Some(mut room) = self.rooms.get_mut(room_id) {
            room.participants
                .retain(|p| p.tx.send(message.to_string()).is_ok());
        }
    }

    /// Send to a single participant by id (used for interim self-feedback).
    pub fn send_to_id(&self, room_id: &str, id: &str, message: &str) {
        if let Some(room) = self.rooms.get(room_id) {
            if let Some(p) = room.participants.iter().find(|p| p.id == id) {
                let _ = p.tx.send(message.to_string());
            }
        }
    }

    /// Send to every participant whose language is `lang`.
    pub fn send_to_lang(&self, room_id: &str, lang: &str, message: &str) {
        if let Some(room) = self.rooms.get(room_id) {
            for p in room.participants.iter().filter(|p| p.lang == lang) {
                let _ = p.tx.send(message.to_string());
            }
        }
    }

    /// Distinct languages present in the room that differ from `speaker_lang` —
    /// i.e. the set of target languages a speaker's utterance must be translated
    /// into. Each is translated independently (in parallel) by the caller.
    pub fn other_langs(&self, room_id: &str, speaker_lang: &str) -> Vec<String> {
        let mut langs: Vec<String> = Vec::new();
        if let Some(room) = self.rooms.get(room_id) {
            for p in room.participants.iter() {
                if p.lang != speaker_lang && !langs.contains(&p.lang) {
                    langs.push(p.lang.clone());
                }
            }
        }
        langs
    }

    /// Snapshot of all public rooms with their online members, for the lobby.
    pub fn public_rooms(&self) -> Vec<PublicRoom> {
        let mut out: Vec<PublicRoom> = self
            .rooms
            .iter()
            .filter(|r| {
                r.value().visibility == Visibility::Public && !r.value().participants.is_empty()
            })
            .map(|r| PublicRoom {
                room: r.key().clone(),
                count: r.value().participants.len(),
                participants: r
                    .value()
                    .participants
                    .iter()
                    .map(|p| Member {
                        name: p.name.clone(),
                        lang: p.lang.clone(),
                    })
                    .collect(),
            })
            .collect();
        // Stable, friendly ordering: busiest rooms first, then by code.
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.room.cmp(&b.room)));
        out
    }

    /// Drop participants whose receiver has been dropped, and remove empty rooms.
    pub fn prune(&self) {
        self.rooms.retain(|_, room| {
            room.participants.retain(|p| !p.tx.is_closed());
            !room.participants.is_empty()
        });
    }
}
