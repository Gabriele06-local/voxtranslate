//! Ephemeral room registry. Each room holds its peers and a visibility (public
//! rooms are listed in the lobby). Every peer can speak, listen, connect P2P via
//! WebRTC, and chat. Rooms are capped at `MAX_PEERS`.

use dashmap::DashMap;
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::{Member, PeerInfo, PublicRoom};

/// Maximum peers per room (WebRTC full mesh stays cheap up to this).
pub const MAX_PEERS: usize = 4;

/// Room visibility. Public rooms are advertised in the lobby (`GET /rooms`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
}

/// A connected peer: identity, the language they speak/receive in, and a channel
/// to push JSON text frames to their WebSocket.
#[derive(Clone)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub tx: UnboundedSender<String>,
}

/// A room and its current peers.
struct Room {
    visibility: Visibility,
    peers: Vec<Peer>,
}

/// Manages ephemeral rooms. No persistence — everything lives in memory and is
/// cleaned up as peers disconnect.
#[derive(Default)]
pub struct RoomManager {
    rooms: DashMap<String, Room>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a peer to a room (creating it with `visibility` if new). Returns the
    /// list of peers that were already present, or `Err(())` if the room is full.
    pub fn join(
        &self,
        room_id: &str,
        peer: Peer,
        visibility: Visibility,
    ) -> Result<Vec<PeerInfo>, ()> {
        let mut room = self.rooms.entry(room_id.to_string()).or_insert_with(|| Room {
            visibility,
            peers: Vec::new(),
        });
        if room.peers.len() >= MAX_PEERS {
            return Err(());
        }
        let existing: Vec<PeerInfo> = room
            .peers
            .iter()
            .map(|p| PeerInfo {
                id: p.id.clone(),
                user_name: p.name.clone(),
                lang: p.lang.clone(),
            })
            .collect();
        room.peers.push(peer);
        Ok(existing)
    }

    /// Remove a peer by id, dropping the room once empty.
    pub fn remove(&self, room_id: &str, id: &str) {
        if let Some(mut room) = self.rooms.get_mut(room_id) {
            room.peers.retain(|p| p.id != id);
        }
        self.rooms.remove_if(room_id, |_, room| room.peers.is_empty());
    }

    /// Send to every peer in the room, pruning dead channels.
    pub fn broadcast(&self, room_id: &str, message: &str) {
        if let Some(mut room) = self.rooms.get_mut(room_id) {
            room.peers.retain(|p| p.tx.send(message.to_string()).is_ok());
        }
    }

    /// Send to every peer in the room except `except_id`.
    pub fn broadcast_except(&self, room_id: &str, except_id: &str, message: &str) {
        if let Some(room) = self.rooms.get(room_id) {
            for p in room.peers.iter().filter(|p| p.id != except_id) {
                let _ = p.tx.send(message.to_string());
            }
        }
    }

    /// Send to a single peer by id. Used for signaling relay and self-feedback.
    pub fn relay_to_peer(&self, room_id: &str, target_id: &str, message: &str) -> bool {
        if let Some(room) = self.rooms.get(room_id) {
            if let Some(p) = room.peers.iter().find(|p| p.id == target_id) {
                return p.tx.send(message.to_string()).is_ok();
            }
        }
        false
    }

    /// Distinct languages present in the room, excluding `exclude_id`. Used by the
    /// translation fan-out to know which languages to translate into.
    pub fn get_room_languages(&self, room_id: &str, exclude_id: &str) -> Vec<String> {
        let mut langs: Vec<String> = Vec::new();
        if let Some(room) = self.rooms.get(room_id) {
            for p in room.peers.iter() {
                if p.id != exclude_id && !langs.contains(&p.lang) {
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
            .filter(|r| r.value().visibility == Visibility::Public && !r.value().peers.is_empty())
            .map(|r| PublicRoom {
                room: r.key().clone(),
                count: r.value().peers.len(),
                participants: r
                    .value()
                    .peers
                    .iter()
                    .map(|p| Member {
                        name: p.name.clone(),
                        lang: p.lang.clone(),
                    })
                    .collect(),
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.room.cmp(&b.room)));
        out
    }

    /// Drop peers whose receiver has been dropped, and remove empty rooms.
    pub fn prune(&self) {
        self.rooms.retain(|_, room| {
            room.peers.retain(|p| !p.tx.is_closed());
            !room.peers.is_empty()
        });
    }
}
