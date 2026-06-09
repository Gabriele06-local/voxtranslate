//! VoxTranslate server — Axum WebSocket relay orchestrating Deepgram STT and
//! Groq translation. Every participant is symmetric: they speak and listen, and
//! the server translates each utterance into every other participant's language.

mod config;
mod deepgram;
mod groq;
mod protocol;
mod rooms;

use std::sync::Arc;
use std::time::Duration;

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
use crate::protocol::{ClientControl, RoomsResponse, ServerMessage, WsParams};
use crate::rooms::{Participant, RoomManager, Visibility};

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    rooms: Arc<RoomManager>,
    groq: Groq,
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

    let groq = Groq::new(config.groq_key.clone());
    let rooms = Arc::new(RoomManager::new());
    let port = config.port;

    let state = AppState {
        config,
        rooms: rooms.clone(),
        groq,
    };

    // Periodic cleanup of rooms whose participants have all disconnected.
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
        return (
            axum::http::StatusCode::BAD_REQUEST,
            "missing room or lang",
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_participant(socket, params, state))
}

/// Lobby: list public rooms with their currently online participants.
async fn rooms_handler(State(state): State<AppState>) -> Json<RoomsResponse> {
    Json(RoomsResponse {
        rooms: state.rooms.public_rooms(),
    })
}

/// A participant both speaks and listens over one WebSocket:
/// - binary frames are audio for the current speaking session,
/// - `{"type":"start"}` / `{"type":"stop"}` text frames bracket a session,
///   opening/closing a fresh per-session Deepgram connection,
/// - the participant's own channel (registered in the room) receives the
///   transcripts/translations routed to its language.
async fn handle_participant(socket: WebSocket, params: WsParams, state: AppState) {
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

    tracing::info!(%room, %name, %lang, ?visibility, "participant joined");

    let (ws_tx, mut ws_rx) = socket.split();

    // Outgoing channel: server -> this participant's WS (text frames).
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    state.rooms.join(
        &room,
        Participant {
            id: id.clone(),
            name: name.clone(),
            lang: lang.clone(),
            tx: out_tx,
        },
        visibility,
    );
    let send_task = tokio::spawn(pump_to_ws(out_rx, ws_tx));

    // Active speaking session: present (Some) only while the participant talks.
    // Dropping the sender flushes (CloseStream) and ends the Deepgram session.
    let mut audio_tx: Option<UnboundedSender<Vec<u8>>> = None;

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(data) => {
                if let Some(tx) = &audio_tx {
                    let _ = tx.send(data.to_vec());
                }
            }
            Message::Text(t) => match serde_json::from_str::<ClientControl>(t.as_str()) {
                Ok(ClientControl::Start) => {
                    if audio_tx.is_none() {
                        audio_tx =
                            start_speaking_session(&state, &room, &id, &name, &lang).await;
                    }
                }
                Ok(ClientControl::Stop) => {
                    // Drop the sender to flush finals and close Deepgram.
                    audio_tx = None;
                }
                Err(_) => {} // unknown control frame — ignore
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    tracing::info!(%room, %name, "participant left");
    drop(audio_tx); // flush any active speaking session
    state.rooms.remove(&room, &id);
    send_task.abort();
}

/// Open a fresh Deepgram connection for one speaking session and spawn the audio
/// forwarder + transcript router. Returns the audio sender, or `None` on failure
/// (after notifying the participant).
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
                state.groq.clone(),
                room.to_string(),
                id.to_string(),
                name.to_string(),
                lang.to_string(),
            ));
            Some(audio_tx)
        }
        Err(e) => {
            tracing::error!("deepgram open failed: {e}");
            state.rooms.send_to_id(
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
