//! VoxTranslate server library — Axum WebSocket relay.
//!
//! V2: video-meeting model. The server relays WebRTC signaling between peers
//! (pure passthrough), orchestrates per-speaker Deepgram STT with translation
//! fan-out subtitles, and relays auto-translated chat. Rooms are capped at 4.
//!
//! `app()` builds the router from an [`AppState`]; `serve()` is the binary entry.

pub mod admin;
pub mod api;
pub mod auth;
pub mod billing;
pub mod config;
pub mod content;
pub mod db;
pub mod deepgram;
pub mod groq;
pub mod middleware;
pub mod moderation;
pub mod pdf;
pub mod protocol;
pub mod rate_limit;
pub mod rooms;
pub mod safety;
pub mod stripe_handler;
pub mod subtitles;
pub mod transcripts;
pub mod translator;
pub mod usage;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::auth::{GoogleVerifier, TokenVerifier};
use crate::billing::{usd, BillingService};
use crate::config::Config;
use crate::db::Pool;
use crate::groq::Groq;
use crate::moderation::{Moderator, Severity};
use crate::protocol::{ClientMessage, RoomsResponse, ServerMessage, WsParams};
use crate::rate_limit::RateLimiter;
use crate::rooms::{Peer, RoomManager, Visibility};
use crate::safety::SafetyService;
use crate::transcripts::{EventKind, TranscriptEvent, TranscriptService};
use crate::translator::Translator;
use crate::usage::{run_guest_meter, run_usage_meter, MeterConfig};

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub rooms: Arc<RoomManager>,
    pub translator: Translator,
    /// Postgres pool — `Some` only when auth/billing is configured.
    pub pool: Option<Pool>,
    /// Credit ledger service — `Some` only when auth/billing is configured.
    pub billing: Option<BillingService>,
    /// Trust & safety + GDPR service — `Some` only when the database is configured.
    pub safety: Option<SafetyService>,
    /// Transcript persistence/export — `Some` only when the database is configured.
    pub transcripts: Option<TranscriptService>,
    /// Verifies Google credentials (swappable for tests).
    pub verifier: Arc<dyn TokenVerifier>,
    /// Shared HTTP client (Google tokeninfo, Stripe).
    pub http: reqwest::Client,
    /// Throttles auth + checkout endpoints.
    pub rate_limiter: Arc<RateLimiter>,
    /// Transcript/chat moderation (blocklist).
    pub moderator: Arc<Moderator>,
}

impl AppState {
    /// Build state from a [`Config`] **without** touching the database. The pool
    /// stays `None`; use [`AppState::init`] to connect + migrate when billing is
    /// configured.
    pub fn new(config: Config) -> Self {
        let translator = Translator::new(Groq::new(config.groq_key.clone()));
        let http = reqwest::Client::new();
        let client_id = config
            .billing
            .as_ref()
            .map(|b| b.google_client_id.clone())
            .unwrap_or_default();
        let verifier: Arc<dyn TokenVerifier> =
            Arc::new(GoogleVerifier::new(client_id, http.clone()));
        Self {
            config: Arc::new(config),
            rooms: Arc::new(RoomManager::new()),
            translator,
            pool: None,
            billing: None,
            safety: None,
            transcripts: None,
            verifier,
            http,
            rate_limiter: Arc::new(RateLimiter::new()),
            moderator: Arc::new(Moderator::from_env()),
        }
    }

    /// Build state and, when billing is configured, connect the database and run
    /// migrations. In guest-only mode this is just [`AppState::new`].
    pub async fn init(config: Config) -> Result<Self, String> {
        let mut state = Self::new(config);
        if let Some(billing) = state.config.billing.clone() {
            let pool = db::connect(&billing.database_url)
                .await
                .map_err(|e| format!("database connect failed: {e}"))?;
            db::migrate(&pool)
                .await
                .map_err(|e| format!("migrations failed: {e}"))?;
            let min_join = usd(billing.pricing.min_balance_to_join);
            state.billing = Some(BillingService::new(pool.clone(), min_join));
            state.safety = Some(SafetyService::new(pool.clone()));
            state.transcripts = Some(TranscriptService::new(pool.clone()));
            // Layer the DB-managed blocklist over the env baseline.
            let db_terms = content::load_blocklist_terms(&pool).await;
            state.moderator = Arc::new(Moderator::from_env().with_terms(db_terms));
            state.pool = Some(pool);
            tracing::info!(
                "auth/billing enabled — database connected, migrations applied, {} blocklist terms",
                state.moderator.len()
            );
        } else {
            tracing::info!("guest-only mode — no auth/billing configured");
        }
        Ok(state)
    }
}

/// Build the Axum router (routes + middleware) for the given state.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/rooms", get(rooms_handler))
        .route("/health", get(|| async { "ok" }))
        .route("/api/auth/config", get(auth::auth_config))
        .route("/api/auth/google", post(auth::auth_google))
        .route("/api/user/me", get(auth::user_me))
        .route("/api/billing/packages", get(api::billing_packages))
        .route("/api/billing/checkout", post(api::billing_checkout))
        .route("/api/billing/webhook", post(api::billing_webhook))
        .route("/api/billing/history", get(api::billing_history))
        .route("/api/billing/ai-pricing", get(api::ai_pricing))
        .route("/api/usage/sessions", get(api::usage_sessions))
        .route("/api/sessions", get(api::sessions_list))
        .route(
            "/api/sessions/{id}/transcript.json",
            get(api::transcript_json),
        )
        .route(
            "/api/sessions/{id}/transcript.pdf",
            get(api::transcript_pdf),
        )
        .route(
            "/api/sessions/{id}/transcript.srt",
            get(api::transcript_srt),
        )
        .route(
            "/api/sessions/{id}/transcript.vtt",
            get(api::transcript_vtt),
        )
        .route(
            "/api/sessions/{id}/bookmarks",
            get(api::bookmarks_list).post(api::bookmark_add),
        )
        .route(
            "/api/sessions/{id}/bookmarks/{bid}",
            axum::routing::patch(api::bookmark_update).delete(api::bookmark_delete),
        )
        .route("/api/report", post(api::report))
        .route("/api/user/consent", post(api::submit_consent))
        .route("/api/user/data", get(api::export_data))
        .route("/api/user", axum::routing::delete(api::delete_account))
        // Public, read-only managed content (client merges over its bundled copy).
        .route("/api/content/i18n", get(content::get_i18n))
        .route("/api/content/legal/{slug}", get(content::get_legal))
        // Backoffice admin actions (Directus → secret-guarded, server-to-server).
        .route("/api/admin/ban", post(admin::ban))
        .route("/api/admin/unban", post(admin::unban))
        .route("/api/admin/credit", post(admin::credit))
        .route("/api/admin/report/resolve", post(admin::resolve_report))
        .route("/api/admin/user/delete", post(admin::delete_user))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Binary entry point: load config, build state, bind, and serve.
pub async fn serve() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "voxtranslate_server=info,tower_http=warn".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("configuration error: {e}");
            std::process::exit(1);
        }
    };

    let port = config.port;
    // Resilient startup: if billing is configured but the database can't be
    // reached/migrated, log it and fall back to guest-only mode instead of
    // crashing — the core call/translation features stay up. (For Supabase,
    // DATABASE_URL must be the IPv4 *connection pooler*, not the direct host.)
    let state = match AppState::init(config.clone()).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                "billing/database init failed ({e}); falling back to GUEST-ONLY mode \
                 — check DATABASE_URL (Supabase: use the IPv4 connection pooler)"
            );
            let mut guest = config;
            guest.billing = None;
            AppState::new(guest)
        }
    };

    // Periodic cleanup of rooms whose peers have all disconnected; their call
    // sessions are finalized (flush + ended_at + guest-only purge).
    let rooms = state.rooms.clone();
    let transcripts = state.transcripts.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            for sid in rooms.prune() {
                if let Some(svc) = transcripts.as_ref() {
                    if let Err(e) = svc.finalize_session(sid).await {
                        tracing::error!("finalize pruned session {sid} failed: {e}");
                    }
                }
            }
        }
    });

    let addr = format!("0.0.0.0:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!("VoxTranslate server listening on {addr}");
    if let Err(e) = axum::serve(listener, app(state))
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

/// An authenticated, billable peer: their user id and Google avatar.
#[derive(Clone)]
struct AuthedPeer {
    user_id: Uuid,
    avatar_url: Option<String>,
}

/// Resolve the (optional) billed user for a WS connection from its token:
/// - `Ok(None)`       — guest (no token, or billing not configured here);
/// - `Ok(Some(peer))` — authenticated user with enough balance to join;
/// - `Err(msg)`       — reject the connection with this error frame.
async fn authorize(
    state: &AppState,
    token: Option<&str>,
) -> Result<Option<AuthedPeer>, ServerMessage> {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None); // no token -> guest
    };
    // A token was supplied but this server has no billing — treat as guest.
    let (Some(cfg), Some(svc)) = (state.config.billing.as_ref(), state.billing.as_ref()) else {
        return Ok(None);
    };

    let claims =
        crate::auth::verify_jwt(&cfg.jwt_secret, token).map_err(|_| ServerMessage::Error {
            message: "invalid or expired session".to_string(),
            code: Some("invalid_token".to_string()),
        })?;
    let uid = Uuid::parse_str(&claims.sub).map_err(|_| ServerMessage::Error {
        message: "invalid session".to_string(),
        code: Some("invalid_token".to_string()),
    })?;

    // Banned users can't join (regardless of balance).
    if let Some(safety) = state.safety.as_ref() {
        if let Ok(Some(reason)) = safety.is_banned(uid).await {
            return Err(ServerMessage::Error {
                message: format!("You are banned: {reason}"),
                code: Some("banned".to_string()),
            });
        }
    }

    match svc.can_join(uid).await {
        Ok(true) => {
            let avatar_url = svc.get_avatar(uid).await.unwrap_or_default();
            Ok(Some(AuthedPeer {
                user_id: uid,
                avatar_url,
            }))
        }
        Ok(false) => Err(ServerMessage::Error {
            message: "insufficient balance to join".to_string(),
            code: Some("insufficient_balance".to_string()),
        }),
        Err(e) => {
            tracing::error!("can_join check failed: {e}");
            Err(ServerMessage::Error {
                message: "billing service unavailable".to_string(),
                code: Some("billing_unavailable".to_string()),
            })
        }
    }
}

/// Spawn the usage meter for a just-started speaking session, returning its
/// cancel handle. Returns `None` when no metering applies (guest with no cap).
fn spawn_meter(
    state: &AppState,
    billed_user: Option<Uuid>,
    usage_session_id: Option<Uuid>,
    guest_cap_secs: Option<u64>,
    guest_spent: &Option<Arc<AtomicU64>>,
    out_tx: &UnboundedSender<String>,
    exhaust_tx: &UnboundedSender<()>,
) -> Option<oneshot::Sender<()>> {
    let billing_cfg = state.config.billing.as_ref()?;
    let interval = billing_cfg.pricing.usage_update_interval;

    // Billed user: charge credits per interval.
    if let (Some(uid), Some(sid), Some(svc)) =
        (billed_user, usage_session_id, state.billing.as_ref())
    {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let cfg = MeterConfig {
            interval_secs: interval,
            rate_per_second: billing_cfg.pricing.user_rate_per_second,
            low_balance_threshold: billing_cfg.pricing.low_balance_threshold,
        };
        tokio::spawn(run_usage_meter(
            svc.clone(),
            uid,
            sid,
            cfg,
            out_tx.clone(),
            exhaust_tx.clone(),
            cancel_rx,
        ));
        return Some(cancel_tx);
    }

    // Guest with a cumulative time cap.
    if let (Some(cap), Some(spent)) = (guest_cap_secs, guest_spent.as_ref()) {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        tokio::spawn(run_guest_meter(
            spent.clone(),
            cap,
            interval,
            out_tx.clone(),
            exhaust_tx.clone(),
            cancel_rx,
        ));
        return Some(cancel_tx);
    }

    None
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
        token,
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

    // Auth / billing gate: resolve the (optional) billed user before joining.
    let authed = match authorize(&state, token.as_deref()).await {
        Ok(u) => u,
        Err(err) => {
            let _ = ws_tx.send(Message::Text(err.to_json().into())).await;
            let _ = ws_tx.close().await;
            return;
        }
    };
    let billed_user = authed.as_ref().map(|a| a.user_id);
    let avatar_url = authed.and_then(|a| a.avatar_url);

    // Accountability: when accounts are live (the DB is connected, so users can
    // actually sign in), public rooms require a signed-in user. Guests can still
    // use private rooms via an invite link. We key off the live pool rather than
    // mere config so the degraded guest-only fallback (billing configured but DB
    // unreachable) doesn't lock everyone out of public rooms.
    if matches!(visibility, Visibility::Public) && billed_user.is_none() && state.pool.is_some() {
        let _ = ws_tx
            .send(Message::Text(
                ServerMessage::Error {
                    message: "sign in to use public rooms".to_string(),
                    code: Some("login_required".to_string()),
                }
                .to_json()
                .into(),
            ))
            .await;
        let _ = ws_tx.close().await;
        return;
    }

    // Outgoing channel: server -> this peer's WS (text frames).
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    let peer = Peer {
        id: id.clone(),
        name: name.clone(),
        lang: lang.clone(),
        avatar_url: avatar_url.clone(),
        tx: out_tx.clone(),
    };

    let joined = match state.rooms.join(&room, peer, visibility) {
        Ok(joined) => joined,
        Err(()) => {
            // Room full — tell the peer directly and close.
            let _ = ws_tx
                .send(Message::Text(ServerMessage::RoomFull.to_json().into()))
                .await;
            let _ = ws_tx.close().await;
            return;
        }
    };
    let session_id = joined.session_id;
    let existing = joined.existing;
    tracing::info!(%room, %name, %lang, peers = existing.len() + 1, "peer joined");

    // Transcript persistence: ensure the session row exists (first joiner wins)
    // and record this participant. `participant_row` is kept for `left_at`.
    let participant_row = match state.transcripts.as_ref() {
        Some(svc) => {
            if let Err(e) = svc.session_started(session_id, &room).await {
                tracing::error!("transcript session_started failed: {e}");
            }
            match svc
                .participant_joined(session_id, &id, billed_user, &name, &lang)
                .await
            {
                Ok(pid) => Some(pid),
                Err(e) => {
                    tracing::error!("transcript participant_joined failed: {e}");
                    None
                }
            }
        }
        None => None,
    };

    // Tell the new peer its id + the peers already present (it will connect to them).
    let _ = out_tx.send(
        ServerMessage::RoomJoined {
            peer_id: id.clone(),
            peers: existing,
            // Doubles as the client's "transcript recording on" signal.
            session_id: state.transcripts.as_ref().map(|_| session_id.to_string()),
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
            avatar_url: avatar_url.clone(),
        }
        .to_json(),
    );

    let send_task = tokio::spawn(pump_to_ws(out_rx, ws_tx));

    // One usage session per call for billed users (cost accrues while speaking).
    let usage_session_id = match (billed_user, state.billing.as_ref()) {
        (Some(uid), Some(svc)) => match svc.create_session(uid, &room).await {
            Ok(sid) => Some(sid),
            Err(e) => {
                tracing::error!("create usage session failed: {e}");
                None
            }
        },
        _ => None,
    };

    // Guest speaking-time cap (cumulative across bursts), if configured.
    let guest_cap_secs = if billed_user.is_none() {
        state
            .config
            .billing
            .as_ref()
            .and_then(|b| b.guest_max_minutes)
            .map(|m| m.saturating_mul(60))
    } else {
        None
    };
    let guest_spent = guest_cap_secs.map(|_| Arc::new(AtomicU64::new(0)));

    // Active speaking session (Some only while unmuted/talking).
    let mut audio_tx: Option<UnboundedSender<Vec<u8>>> = None;
    // Cancels the running usage/guest meter (on Stop / disconnect).
    let mut meter_cancel: Option<oneshot::Sender<()>> = None;
    // The meter signals here when credits/cap are exhausted -> stop audio.
    let (exhaust_tx, mut exhaust_rx) = mpsc::unbounded_channel::<()>();

    loop {
        tokio::select! {
            maybe_msg = ws_rx.next() => {
                let Some(Ok(msg)) = maybe_msg else { break };
                match msg {
                    Message::Binary(data) => {
                        if let Some(tx) = &audio_tx {
                            let _ = tx.send(data.to_vec());
                        }
                    }
                    Message::Text(t) => match serde_json::from_str::<ClientMessage>(t.as_str()) {
                        Ok(ClientMessage::Start) => {
                            if audio_tx.is_none() {
                                audio_tx = start_speaking_session(
                                    &state,
                                    deepgram::SpeakerCtx {
                                        room: room.clone(),
                                        speaker_id: id.clone(),
                                        speaker_name: name.clone(),
                                        speaker_lang: lang.clone(),
                                        session_id,
                                        speaker_user_id: billed_user,
                                    },
                                )
                                .await;
                                if audio_tx.is_some() {
                                    meter_cancel = spawn_meter(
                                        &state,
                                        billed_user,
                                        usage_session_id,
                                        guest_cap_secs,
                                        &guest_spent,
                                        &out_tx,
                                        &exhaust_tx,
                                    );
                                }
                            }
                        }
                        Ok(ClientMessage::Stop) => {
                            audio_tx = None; // flush + close Deepgram
                            if let Some(c) = meter_cancel.take() {
                                let _ = c.send(());
                            }
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
                                &ServerMessage::Ice { from: id.clone(), candidate }.to_json(),
                            );
                        }
                        Ok(ClientMessage::Chat { text }) => {
                            // Moderate chat too: block + warn the sender on a hit.
                            if state.moderator.severity(&text) == Severity::Severe {
                                let _ = out_tx.send(
                                    ServerMessage::ModerationWarning {
                                        message: "Your message was blocked by moderation."
                                            .to_string(),
                                    }
                                    .to_json(),
                                );
                            } else {
                                handle_chat(
                                    &state,
                                    deepgram::SpeakerCtx {
                                        room: room.clone(),
                                        speaker_id: id.clone(),
                                        speaker_name: name.clone(),
                                        speaker_lang: lang.clone(),
                                        session_id,
                                        speaker_user_id: billed_user,
                                    },
                                    &avatar_url,
                                    text,
                                );
                            }
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
                        Ok(ClientMessage::Emoji { emoji }) => {
                            state.rooms.broadcast(
                                &room,
                                &ServerMessage::EmojiReaction {
                                    peer_id: id.clone(),
                                    peer_name: name.clone(),
                                    emoji,
                                }
                                .to_json(),
                            );
                        }
                        Ok(ClientMessage::HandRaise { raised }) => {
                            state.rooms.broadcast_except(
                                &room,
                                &id,
                                &ServerMessage::HandRaised {
                                    peer_id: id.clone(),
                                    raised,
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
            _ = exhaust_rx.recv() => {
                // Credits/cap exhausted: stop audio -> STT, keep the call alive.
                audio_tx = None;
                meter_cancel = None;
            }
        }
    }

    tracing::info!(%room, %name, "peer left");
    drop(audio_tx); // flush any active speaking session
    if let Some(c) = meter_cancel.take() {
        let _ = c.send(());
    }
    if let (Some(sid), Some(svc)) = (usage_session_id, state.billing.as_ref()) {
        let _ = svc.finalize_session(sid).await;
    }
    if let (Some(pid), Some(svc)) = (participant_row, state.transcripts.as_ref()) {
        if let Err(e) = svc.participant_left(pid).await {
            tracing::error!("transcript participant_left failed: {e}");
        }
    }
    // The last leaver's removal ends the call session: flush + finalize it.
    if let Some(ended) = state.rooms.remove(&room, &id) {
        if let Some(svc) = state.transcripts.as_ref() {
            if let Err(e) = svc.finalize_session(ended).await {
                tracing::error!("finalize transcript session {ended} failed: {e}");
            }
        }
    }
    state
        .rooms
        .broadcast(&room, &ServerMessage::PeerLeft { peer_id: id }.to_json());
    send_task.abort();
}

/// Translate a chat message into every language in the room (parallel), persist
/// it to the transcript, and broadcast it to everyone, including the sender.
/// (Moderation-blocked messages never reach here, so they are never persisted.)
fn handle_chat(
    state: &AppState,
    ctx: deepgram::SpeakerCtx,
    avatar_url: &Option<String>,
    text: String,
) {
    let rooms = state.rooms.clone();
    let translator = state.translator.clone();
    let transcripts = state.transcripts.clone();
    let sender_avatar = avatar_url.clone();
    let timestamp = now_unix();
    let ts = chrono::Utc::now(); // capture send time before the translation await
    tokio::spawn(async move {
        let targets = rooms.get_room_languages(&ctx.room, &ctx.speaker_id);
        let translations = translator
            .translate_fanout(&text, &ctx.speaker_lang, &targets)
            .await;
        if let Some(svc) = transcripts.as_ref() {
            svc.record(TranscriptEvent {
                session_id: ctx.session_id,
                kind: EventKind::Chat,
                speaker_peer_id: ctx.speaker_id.clone(),
                speaker_user_id: ctx.speaker_user_id,
                speaker_name: ctx.speaker_name.clone(),
                original_text: text.clone(),
                original_lang: ctx.speaker_lang.clone(),
                translations: translations.clone(),
                ts,
            });
        }
        rooms.broadcast(
            &ctx.room,
            &ServerMessage::ChatMessage {
                sender_id: ctx.speaker_id,
                sender_name: ctx.speaker_name,
                sender_lang: ctx.speaker_lang,
                sender_avatar,
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
    ctx: deepgram::SpeakerCtx,
) -> Option<UnboundedSender<Vec<u8>>> {
    match deepgram::open_deepgram_ws(&ctx.speaker_lang, &state.config).await {
        Ok((dg_sink, dg_source)) => {
            let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            tokio::spawn(deepgram::forward_audio(audio_rx, dg_sink));
            tokio::spawn(deepgram::process_transcripts(
                dg_source,
                state.rooms.clone(),
                state.translator.clone(),
                state.moderator.clone(),
                ctx,
                state.transcripts.clone(),
            ));
            Some(audio_tx)
        }
        Err(e) => {
            tracing::error!("deepgram open failed: {e}");
            state.rooms.relay_to_peer(
                &ctx.room,
                &ctx.speaker_id,
                &ServerMessage::Error {
                    message: "speech service unavailable".to_string(),
                    code: None,
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
