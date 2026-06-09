//! VoxTranslate server — Axum WebSocket relay.
//!
//! V2: video-meeting model. The server relays WebRTC signaling between peers
//! (pure passthrough), orchestrates per-speaker Deepgram STT with translation
//! fan-out subtitles, and relays auto-translated chat. Rooms are capped at 4.

mod config;
mod deepgram;
mod groq;
mod protocol;
mod rooms;
mod translator;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::config::Config;
use crate::groq::Groq;
use crate::protocol::{ClientMessage, RoomsResponse, ServerMessage, WsParams};
use crate::rooms::{Peer, RoomManager, Visibility};
use crate::translator::Translator;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    rooms: Arc<RoomManager>,
    translator: Translator,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "voxtranslate_server=info,tower_http=warn".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::error!("configuration error: {e}");
            std::process::exit(1);
        }
    };

    let translator = Translator::new(Groq::new(config.groq_key.clone()));
    let rooms = Arc::new(RoomManager::new());
    let port = config.port;

    let state = AppState {
        config,
        rooms: rooms.clone(),
        translator,
    };

    // Periodic cleanup of rooms whose peers have all disconnected.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            rooms.prune();
        }
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/rooms", get(rooms_handler))
        .route("/health", get(|| async { "ok" }))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!("VoxTranslate server listening on {addr}");
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!("server error: {e}");
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> Response {
    if params.room.trim().is_empty() || params.lang.trim().is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, "missing room or lang").into_response();
    }
    ws.on_upgrade(move |socket| handle_peer(socket, params, state))
}

/// Lobby: list public rooms with their currently online participants.
async fn rooms_handler(State(state): State<AppState>) -> Json<RoomsResponse> {
    Json(RoomsResponse {
        rooms: state.rooms.public_rooms(),
    })
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A peer's WebSocket: receives audio (binary) + control/signaling/chat (text),
/// and is sent room lifecycle, relayed signaling, subtitles, chat, and peer state.
async fn handle_peer(socket: WebSocket, params: WsParams, state: AppState) {
    let WsParams {
        room,
        lang,
        name,
        id,
        public,
    } = params;
    let id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Guest".to_string());
    let visibility = if public.unwrap_or(false) {
        Visibility::Public
    } else {
        Visibility::Private
    };

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Outgoing channel: server -> this peer's WS (text frames).
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    let peer = Peer {
        id: id.clone(),
        name: name.clone(),
        lang: lang.clone(),
        tx: out_tx.clone(),
    };

    let existing = match state.rooms.join(&room, peer, visibility) {
        Ok(existing) => existing,
        Err(()) => {
            // Room full — tell the peer directly and close.
            let _ = ws_tx
                .send(Message::Text(ServerMessage::RoomFull.to_json().into()))
                .await;
            let _ = ws_tx.close().await;
            return;
        }
    };
    tracing::info!(%room, %name, %lang, peers = existing.len() + 1, "peer joined");

    // Tell the new peer its id + the peers already present (it will connect to them).
    let _ = out_tx.send(
        ServerMessage::RoomJoined {
            peer_id: id.clone(),
            peers: existing,
        }
        .to_json(),
    );
    // Tell the others a new peer arrived (they initiate the WebRTC offer).
    state.rooms.broadcast_except(
        &room,
        &id,
        &ServerMessage::PeerJoined {
            peer_id: id.clone(),
            user_name: name.clone(),
            lang: lang.clone(),
        }
        .to_json(),
    );

    let send_task = tokio::spawn(pump_to_ws(out_rx, ws_tx));

    // Active speaking session (Some only while unmuted/talking).
    let mut audio_tx: Option<UnboundedSender<Vec<u8>>> = None;

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(data) => {
                if let Some(tx) = &audio_tx {
                    let _ = tx.send(data.to_vec());
                }
            }
            Message::Text(t) => match serde_json::from_str::<ClientMessage>(t.as_str()) {
                Ok(ClientMessage::Start) => {
                    if audio_tx.is_none() {
                        audio_tx = start_speaking_session(&state, &room, &id, &name, &lang).await;
                    }
                }
                Ok(ClientMessage::Stop) => {
                    audio_tx = None; // flush + close Deepgram
                }
                Ok(ClientMessage::Offer { to, sdp }) => {
                    state.rooms.relay_to_peer(
                        &room,
                        &to,
                        &ServerMessage::Offer { from: id.clone(), sdp }.to_json(),
                    );
                }
                Ok(ClientMessage::Answer { to, sdp }) => {
                    state.rooms.relay_to_peer(
                        &room,
                        &to,
                        &ServerMessage::Answer { from: id.clone(), sdp }.to_json(),
                    );
                }
                Ok(ClientMessage::Ice { to, candidate }) => {
                    state.rooms.relay_to_peer(
                        &room,
                        &to,
                        &ServerMessage::Ice {
                            from: id.clone(),
                            candidate,
                        }
                        .to_json(),
                    );
                }
                Ok(ClientMessage::Chat { text }) => {
                    handle_chat(&state, &room, &id, &name, &lang, text);
                }
                Ok(ClientMessage::MuteAudio { muted }) => {
                    state.rooms.broadcast_except(
                        &room,
                        &id,
                        &ServerMessage::PeerMuted {
                            peer_id: id.clone(),
                            kind: "audio".to_string(),
                            muted,
                        }
                        .to_json(),
                    );
                }
                Ok(ClientMessage::MuteVideo { muted }) => {
                    state.rooms.broadcast_except(
                        &room,
                        &id,
                        &ServerMessage::PeerMuted {
                            peer_id: id.clone(),
                            kind: "video".to_string(),
                            muted,
                        }
                        .to_json(),
                    );
                }
                Err(_) => {} // unknown / malformed control frame
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    tracing::info!(%room, %name, "peer left");
    drop(audio_tx); // flush any active speaking session
    state.rooms.remove(&room, &id);
    state
        .rooms
        .broadcast(&room, &ServerMessage::PeerLeft { peer_id: id }.to_json());
    send_task.abort();
}

/// Translate a chat message into every language in the room (parallel) and
/// broadcast it to everyone, including the sender.
fn handle_chat(state: &AppState, room: &str, id: &str, name: &str, lang: &str, text: String) {
    let rooms = state.rooms.clone();
    let translator = state.translator.clone();
    let room = room.to_string();
    let sender_id = id.to_string();
    let sender_name = name.to_string();
    let sender_lang = lang.to_string();
    let timestamp = now_unix();
    tokio::spawn(async move {
        let targets = rooms.get_room_languages(&room, &sender_id);
        let translations = translator
            .translate_fanout(&text, &sender_lang, &targets)
            .await;
        rooms.broadcast(
            &room,
            &ServerMessage::ChatMessage {
                sender_id,
                sender_name,
                sender_lang,
                original: text,
                translations,
                timestamp,
            }
            .to_json(),
        );
    });
}

/// Open a fresh Deepgram connection for one speaking session and spawn the audio
/// forwarder + subtitle router. Returns the audio sender, or `None` on failure.
async fn start_speaking_session(
    state: &AppState,
    room: &str,
    id: &str,
    name: &str,
    lang: &str,
) -> Option<UnboundedSender<Vec<u8>>> {
    match deepgram::open_deepgram_ws(lang, &state.config).await {
        Ok((dg_sink, dg_source)) => {
            let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            tokio::spawn(deepgram::forward_audio(audio_rx, dg_sink));
            tokio::spawn(deepgram::process_transcripts(
                dg_source,
                state.rooms.clone(),
                state.translator.clone(),
                room.to_string(),
                id.to_string(),
                name.to_string(),
                lang.to_string(),
            ));
            Some(audio_tx)
        }
        Err(e) => {
            tracing::error!("deepgram open failed: {e}");
            state.rooms.relay_to_peer(
                room,
                id,
                &ServerMessage::Error {
                    message: "speech service unavailable".to_string(),
                }
                .to_json(),
            );
            None
        }
    }
}

/// Forward queued JSON strings to a WebSocket as text frames until the channel
/// closes or the socket errors.
async fn pump_to_ws(mut rx: UnboundedReceiver<String>, mut ws_tx: SplitSink<WebSocket, Message>) {
    while let Some(msg) = rx.recv().await {
        if ws_tx.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
}

/// Resolve on Ctrl-C or SIGTERM for graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
