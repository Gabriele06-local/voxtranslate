//! Persistent per-speaker Deepgram streaming WebSocket client.
//!
//! Each speaker gets one Deepgram connection for the whole session. Audio chunks
//! are forwarded as binary frames; transcripts come back as JSON text frames,
//! are broadcast to the room, and finals additionally trigger an async Groq
//! translation.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use crate::config::Config;
use crate::moderation::{Moderator, Severity};
use crate::protocol::{DeepgramResponse, ServerMessage};
use crate::rooms::RoomManager;
use crate::transcripts::{EventKind, TranscriptEvent, TranscriptService};
use crate::translator::Translator;

/// Identity + context of the speaker behind one speaking session: who they are,
/// where they are, and which call session their words belong to.
pub struct SpeakerCtx {
    pub room: String,
    pub speaker_id: String,
    pub speaker_name: String,
    pub speaker_lang: String,
    /// The room's call-session id (transcript persistence).
    pub session_id: Uuid,
    /// `None` for guests.
    pub speaker_user_id: Option<Uuid>,
}

type DgStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type DgSink = SplitSink<DgStream, Message>;
type DgSource = SplitStream<DgStream>;

/// Open a persistent Deepgram streaming connection for `source_lang` and split
/// it into a sink (send audio) and a stream (receive transcripts).
pub async fn open_deepgram_ws(
    source_lang: &str,
    config: &Config,
) -> Result<(DgSink, DgSource), String> {
    // `container=webm` lets Deepgram auto-detect the Opus encoding, sample rate,
    // and channels from the WebM header — which is what the browser's
    // MediaRecorder actually produces (Opus is internally 48kHz, not 16k). Passing
    // explicit `encoding`/`sample_rate`/`channels` here breaks container demuxing
    // (Deepgram then decodes only ~0.1s of audio), so we deliberately omit them.
    let url = format!(
        "wss://api.deepgram.com/v1/listen\
         ?container=webm&model=nova-2&language={source_lang}\
         &punctuate=true&interim_results=true&utterance_end_ms=1000\
         &vad_events=true&smart_format=true"
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("invalid deepgram url: {e}"))?;

    let auth = HeaderValue::from_str(&format!("Token {}", config.deepgram_key))
        .map_err(|e| format!("invalid deepgram key header: {e}"))?;
    request.headers_mut().insert(AUTHORIZATION, auth);

    let (ws, _resp) = connect_async(request)
        .await
        .map_err(|e| format!("deepgram connect failed: {e}"))?;

    Ok(ws.split())
}

/// Forward audio chunks from the channel to Deepgram, keeping the connection
/// alive during silence and flushing on close.
///
/// Runs until the audio channel is dropped (speaker disconnected) or the sink
/// errors. Sends `{"type":"KeepAlive"}` every 8s of inactivity and a final
/// `{"type":"CloseStream"}` to flush pending transcripts before closing.
pub async fn forward_audio(mut audio_rx: UnboundedReceiver<Vec<u8>>, mut sink: DgSink) {
    let mut keepalive = tokio::time::interval(Duration::from_secs(8));
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            maybe_chunk = audio_rx.recv() => {
                match maybe_chunk {
                    Some(chunk) => {
                        if sink.send(Message::binary(chunk)).await.is_err() {
                            break;
                        }
                        // Reset the keepalive window now that audio is flowing.
                        keepalive.reset();
                    }
                    None => {
                        // Speaker disconnected: flush finals, then close cleanly.
                        let _ = sink.send(Message::text(r#"{"type":"CloseStream"}"#)).await;
                        let _ = sink.close().await;
                        break;
                    }
                }
            }
            _ = keepalive.tick() => {
                if sink.send(Message::text(r#"{"type":"KeepAlive"}"#)).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Read Deepgram transcripts for one speaking session and broadcast subtitles to
/// the whole room so each peer can render them on the speaker's video cell:
/// - interim → `subtitle_interim` (original language, live),
/// - final → translated into every language present (fan-out), broadcast as
///   `subtitle_final` with a `{ lang: text }` map; each client picks its own.
pub async fn process_transcripts(
    mut source: DgSource,
    rooms: Arc<RoomManager>,
    translator: Translator,
    moderator: Arc<Moderator>,
    ctx: SpeakerCtx,
    transcripts: Option<TranscriptService>,
) {
    let SpeakerCtx {
        room,
        speaker_id,
        speaker_name,
        speaker_lang,
        session_id,
        speaker_user_id,
    } = ctx;
    while let Some(msg) = source.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue, // ping/pong/binary — ignore
            Err(e) => {
                tracing::warn!("deepgram stream error: {e}");
                break;
            }
        };

        let parsed: DeepgramResponse = match serde_json::from_str(text.as_str()) {
            Ok(p) => p,
            Err(_) => continue, // non-Results frame we don't model
        };

        let Some((transcript, confidence)) = parsed.best_alternative() else {
            continue;
        };
        if confidence < 0.4 {
            continue;
        }

        if !parsed.is_final {
            // Live partial subtitle, shown (untranslated) on the speaker's cell.
            rooms.broadcast(
                &room,
                &ServerMessage::SubtitleInterim {
                    speaker_id: speaker_id.clone(),
                    speaker_name: speaker_name.clone(),
                    text: transcript.to_string(),
                    lang: speaker_lang.clone(),
                }
                .to_json(),
            );
            continue;
        }

        let transcript = transcript.to_string();

        // Moderation: drop a flagged final (don't translate/broadcast it) and warn
        // only the speaker, so abusive speech isn't shown/translated to the room.
        if moderator.severity(&transcript) == Severity::Severe {
            tracing::info!(%room, speaker = %speaker_id, "moderation: dropped flagged transcript");
            rooms.relay_to_peer(
                &room,
                &speaker_id,
                &ServerMessage::ModerationWarning {
                    message: "Your message was blocked by moderation.".to_string(),
                }
                .to_json(),
            );
            continue;
        }

        // Fan out a translation per distinct language in the room, then broadcast
        // the final subtitle with the full map so every peer picks its language.
        // `ts` is captured *now* (when the words were spoken), not after the
        // translation round-trip, so transcript ordering matches reality.
        let rooms = rooms.clone();
        let translator = translator.clone();
        let transcripts = transcripts.clone();
        let room = room.clone();
        let speaker_id = speaker_id.clone();
        let speaker_name = speaker_name.clone();
        let speaker_lang = speaker_lang.clone();
        let ts = Utc::now();
        tokio::spawn(async move {
            let target_langs = rooms.get_room_languages(&room, &speaker_id);
            let translations = translator
                .translate_fanout(&transcript, &speaker_lang, &target_langs)
                .await;
            if let Some(svc) = transcripts.as_ref() {
                svc.record(TranscriptEvent {
                    session_id,
                    kind: EventKind::Speech,
                    speaker_peer_id: speaker_id.clone(),
                    speaker_user_id,
                    speaker_name: speaker_name.clone(),
                    original_text: transcript.clone(),
                    original_lang: speaker_lang.clone(),
                    translations: translations.clone(),
                    ts,
                });
            }
            rooms.broadcast(
                &room,
                &ServerMessage::SubtitleFinal {
                    speaker_id,
                    speaker_name,
                    original: transcript,
                    lang: speaker_lang,
                    translations,
                }
                .to_json(),
            );
        });
    }
}
