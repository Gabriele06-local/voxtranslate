//! Persistent per-speaker Deepgram streaming WebSocket client.
//!
//! Each speaker gets one Deepgram connection for the whole session. Audio chunks
//! are forwarded as binary frames; transcripts come back as JSON text frames,
//! are broadcast to the room, and finals additionally trigger an async Groq
//! translation.

use std::sync::Arc;
use std::time::Duration;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::config::Config;
use crate::protocol::{DeepgramResponse, ServerMessage};
use crate::rooms::RoomManager;
use crate::translator::Translator;

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
#[allow(clippy::too_many_arguments)]
pub async fn process_transcripts(
    mut source: DgSource,
    rooms: Arc<RoomManager>,
    translator: Translator,
    room: String,
    speaker_id: String,
    speaker_name: String,
    speaker_lang: String,
) {
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

        // Fan out a translation per distinct language in the room, then broadcast
        // the final subtitle with the full map so every peer picks its language.
        let rooms = rooms.clone();
        let translator = translator.clone();
        let room = room.clone();
        let speaker_id = speaker_id.clone();
        let speaker_name = speaker_name.clone();
        let speaker_lang = speaker_lang.clone();
        tokio::spawn(async move {
            let target_langs = rooms.get_room_languages(&room, &speaker_id);
            let translations = translator
                .translate_fanout(&transcript, &speaker_lang, &target_langs)
                .await;
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
