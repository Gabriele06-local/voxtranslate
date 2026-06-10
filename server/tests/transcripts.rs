//! Transcript capture + export end-to-end over real HTTP/WebSocket: an authed
//! user chats in a call, the event is persisted, the session is listed, and the
//! JSON transcript downloads with the right auth gates (401/403/404).
//!
//! Every test is **DB-gated**: it no-ops when `DATABASE_URL` is unset. Locally,
//! run against the Docker Postgres:
//! `DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/vox_test cargo test --test transcripts`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use uuid::Uuid;
use voxtranslate_server::auth::{issue_jwt, upsert_google_user, FakeVerifier, GoogleIdentity};
use voxtranslate_server::billing::{usd, BillingService};
use voxtranslate_server::config::Config;
use voxtranslate_server::db::{self, Pool};
use voxtranslate_server::safety::SafetyService;
use voxtranslate_server::transcripts::{EventKind, TranscriptEvent, TranscriptService};
use voxtranslate_server::{app, AppState};

struct Server {
    addr: SocketAddr,
    pool: Pool,
    secret: String,
}

/// Spawn a billing-mode server with the transcript service wired (unlike
/// `tests/billing.rs`, which predates transcripts and leaves it `None`).
async fn setup() -> Option<Server> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = db::connect(&url).await.ok()?;
    db::migrate(&pool).await.ok()?;
    let secret = "transcripts-secret".to_string();
    let config = Config::test_with_billing(&url, &secret, 2.0);
    let min_join = usd(config.billing.as_ref().unwrap().pricing.min_balance_to_join);
    let mut state = AppState::new(config);
    state.billing = Some(BillingService::new(pool.clone(), min_join));
    state.safety = Some(SafetyService::new(pool.clone()));
    state.transcripts = Some(TranscriptService::new(pool.clone()));
    state.pool = Some(pool.clone());
    state.verifier = Arc::new(FakeVerifier);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app(state)).await;
    });
    Some(Server { addr, pool, secret })
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect and return the first JSON text frame (keeping the socket open).
async fn connect_first(addr: SocketAddr, params: &str) -> (serde_json::Value, Ws) {
    let url = format!("ws://{addr}/ws?{params}");
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let frame = loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => {
                break serde_json::from_str(t.as_str()).unwrap()
            }
            Ok(Some(Ok(_))) => continue,
            _ => panic!("no frame"),
        }
    };
    (frame, ws)
}

/// Wait until a frame of the given type arrives on the socket.
async fn wait_for(ws: &mut Ws, frame_type: &str) -> serde_json::Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                if v["type"] == frame_type {
                    return v;
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => panic!("no {frame_type} frame"),
        }
    }
}

async fn login(srv: &Server, name: &str) -> (Uuid, String) {
    let identity = GoogleIdentity {
        google_id: format!("g-{}", Uuid::new_v4()),
        email: format!("{}@x.com", Uuid::new_v4()),
        name: name.into(),
        avatar_url: None,
    };
    let user = upsert_google_user(&srv.pool, &identity, rust_decimal::Decimal::new(200, 2))
        .await
        .unwrap();
    let jwt = issue_jwt(&srv.secret, &user.id, &user.email, &user.name, 168).unwrap();
    (user.id, jwt)
}

#[tokio::test]
async fn chat_is_captured_listed_and_downloadable_with_auth_gates() {
    let Some(srv) = setup().await else {
        eprintln!("skipping — no DATABASE_URL");
        return;
    };
    let (_uid, jwt) = login(&srv, "Tess").await;
    let room = format!("tr-{}", Uuid::new_v4().simple());

    // Authed join: room_joined carries the session id (recording is on).
    // Single-peer room -> chat fan-out has zero target languages -> no Groq.
    let (frame, mut ws) = connect_first(
        srv.addr,
        &format!("room={room}&lang=it&id=tess-peer&token={jwt}"),
    )
    .await;
    assert_eq!(frame["type"], "room_joined");
    let session_id = frame["session_id"].as_str().expect("session_id present");
    Uuid::parse_str(session_id).expect("session_id is a UUID");

    // Chat; the broadcast echoes back to the sender once the event is queued
    // for persistence (record() happens before the broadcast).
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({ "type": "chat", "text": "ciao a tutti" }).to_string(),
    ))
    .await
    .unwrap();
    let chat = wait_for(&mut ws, "chat_message").await;
    assert_eq!(chat["original"], "ciao a tutti");
    drop(ws); // hang up -> participant_left + finalize_session

    let http = reqwest::Client::new();
    let base = format!("http://{}", srv.addr);

    // Poll the listing until the finalize + batch insert land. The listing's
    // own flush() can persist the event before the disconnect path stamps
    // `ended_at`, so wait for both.
    let mut listed = None;
    for _ in 0..30 {
        let rows: serde_json::Value = http
            .get(format!("{base}/api/sessions"))
            .bearer_auth(&jwt)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(row) = rows.as_array().unwrap().iter().find(|r| {
            r["id"] == session_id
                && r["event_count"].as_i64() >= Some(1)
                && r["ended_at"].is_string()
        }) {
            listed = Some(row.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let row = listed.expect("session listed, finalized, with the chat event");
    assert_eq!(row["room"], room.as_str());

    // Download the JSON transcript.
    let resp = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.json"))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json"
    );
    let cd = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .expect("content-disposition")
        .to_string();
    assert!(
        cd.starts_with("attachment; filename=\"voxtranslate-"),
        "{cd}"
    );
    assert!(cd.ends_with(".json\""), "{cd}");

    let body = resp.text().await.unwrap();
    assert!(body.contains("\n  "), "pretty-printed with 2-space indent");
    let doc: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(doc["session"]["id"], session_id);
    assert_eq!(doc["session"]["room_name"], room.as_str());
    assert!(doc["session"]["duration_seconds"].is_number());
    assert_eq!(doc["session"]["participants"][0]["id"], "tess-peer");
    assert_eq!(doc["session"]["participants"][0]["language"], "it");
    assert_eq!(doc["events"][0]["type"], "chat");
    assert_eq!(doc["events"][0]["original"], "ciao a tutti");
    assert_eq!(doc["events"][0]["lang"], "it");
    assert!(doc["events"][0]["translations"].is_object());
    assert!(doc["exported_at"].is_string());

    // Download the PDF transcript (timezone localized).
    let pdf = http
        .get(format!(
            "{base}/api/sessions/{session_id}/transcript.pdf?tz=Europe/Rome"
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(pdf.status(), 200);
    assert_eq!(
        pdf.headers().get("content-type").unwrap(),
        "application/pdf"
    );
    let cd = pdf
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();
    assert!(cd.ends_with(".pdf\""), "{cd}");
    let bytes = pdf.bytes().await.unwrap();
    assert!(bytes.starts_with(b"%PDF-"), "PDF magic bytes");

    // A bogus timezone falls back to UTC — still a 200.
    let bogus_tz = http
        .get(format!(
            "{base}/api/sessions/{session_id}/transcript.pdf?tz=Not/AZone"
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(bogus_tz.status(), 200);

    // Rendering is rate-limited per user: 5/min, and we've spent 2 already.
    let mut last = 0;
    for _ in 0..5 {
        last = http
            .get(format!("{base}/api/sessions/{session_id}/transcript.pdf"))
            .bearer_auth(&jwt)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();
        if last == 429 {
            break;
        }
    }
    assert_eq!(last, 429, "rapid PDF requests throttle");

    // Gates: a non-participant gets 403, unknown session 404, no token 401.
    let (_eve, eve_jwt) = login(&srv, "Eve").await;
    let forbidden = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.json"))
        .bearer_auth(&eve_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let missing = http
        .get(format!(
            "{base}/api/sessions/{}/transcript.json",
            Uuid::new_v4()
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);

    let unauth = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.json"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);
    let unauth_list = http
        .get(format!("{base}/api/sessions"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_list.status(), 401);

    // Eve never sees Tess's session in her own listing.
    let eve_rows: serde_json::Value = http
        .get(format!("{base}/api/sessions"))
        .bearer_auth(&eve_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(eve_rows
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["id"] != session_id));
}

/// SRT/VTT subtitle exports (spec 0012): seeded speech events come back as
/// timed cues in the requested language mode, chat is skipped, and the same
/// auth gates as the JSON export apply.
#[tokio::test]
async fn subtitles_download_as_srt_and_vtt() {
    let Some(srv) = setup().await else {
        eprintln!("skipping — no DATABASE_URL");
        return;
    };
    let (uid, jwt) = login(&srv, "Tess").await;
    let room = format!("st-{}", Uuid::new_v4().simple());
    let session_id = Uuid::new_v4();

    // Seed a session directly through the service (shares the server's pool).
    let svc = TranscriptService::new(srv.pool.clone());
    svc.session_started(session_id, &room).await.unwrap();
    svc.participant_joined(session_id, "tess-peer", Some(uid), "Tess", "it")
        .await
        .unwrap();
    svc.record(TranscriptEvent {
        session_id,
        kind: EventKind::Speech,
        speaker_peer_id: "tess-peer".into(),
        speaker_user_id: Some(uid),
        speaker_name: "Tess".into(),
        original_text: "Hello world.".into(),
        original_lang: "en".into(),
        translations: HashMap::from([("it".to_string(), "Ciao mondo.".to_string())]),
        ts: chrono::Utc::now(),
    });
    svc.record(TranscriptEvent {
        session_id,
        kind: EventKind::Chat,
        speaker_peer_id: "tess-peer".into(),
        speaker_user_id: Some(uid),
        speaker_name: "Tess".into(),
        original_text: "off the record".into(),
        original_lang: "en".into(),
        translations: HashMap::new(),
        ts: chrono::Utc::now() + chrono::Duration::seconds(5),
    });
    svc.flush().await;

    let http = reqwest::Client::new();
    let base = format!("http://{}", srv.addr);

    // Default mode = translated, default target = requester's lang ("it").
    let srt = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.srt"))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(srt.status(), 200);
    assert_eq!(
        srt.headers().get("content-type").unwrap(),
        "application/x-subrip"
    );
    let cd = srt
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();
    assert!(cd.ends_with(".srt\""), "{cd}");
    let body = srt.text().await.unwrap();
    assert!(body.starts_with("1\n"), "{body}");
    assert!(body.contains("Tess: Ciao mondo."), "{body}");
    assert!(body.contains(" --> "), "{body}");
    assert!(!body.contains("off the record"), "chat must be skipped: {body}");

    // VTT, original mode: voice tag + original text.
    let vtt = http
        .get(format!(
            "{base}/api/sessions/{session_id}/transcript.vtt?lang=original"
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(vtt.status(), 200);
    assert_eq!(vtt.headers().get("content-type").unwrap(), "text/vtt");
    let body = vtt.text().await.unwrap();
    assert!(body.starts_with("WEBVTT\n\n"), "{body}");
    assert!(body.contains("<v Tess>Hello world."), "{body}");

    // Both mode pairs original + translation.
    let both = http
        .get(format!(
            "{base}/api/sessions/{session_id}/transcript.srt?lang=both&target=it"
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(both.contains("Tess: Hello world.\nCiao mondo."), "{both}");

    // Gates: bad mode 400, stranger 403, no token 401.
    let bad = http
        .get(format!(
            "{base}/api/sessions/{session_id}/transcript.srt?lang=klingon"
        ))
        .bearer_auth(&jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    let (_eve, eve_jwt) = login(&srv, "Eve").await;
    let forbidden = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.vtt"))
        .bearer_auth(&eve_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);
    let unauth = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.srt"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);
}

/// Bookmark CRUD (spec 0013): instant pin + later relabel, owner-only
/// mutations, shared visibility across participants, export integration, and
/// the FK cascade when the session goes away.
#[tokio::test]
async fn bookmarks_crud_gates_and_export() {
    let Some(srv) = setup().await else {
        eprintln!("skipping — no DATABASE_URL");
        return;
    };
    let (tess, tess_jwt) = login(&srv, "Tess").await;
    let (bob, bob_jwt) = login(&srv, "Bob").await;
    let room = format!("bm-{}", Uuid::new_v4().simple());
    let session_id = Uuid::new_v4();

    // Seed a two-participant session directly through the service.
    let svc = TranscriptService::new(srv.pool.clone());
    svc.session_started(session_id, &room).await.unwrap();
    svc.participant_joined(session_id, "tess-peer", Some(tess), "Tess", "it")
        .await
        .unwrap();
    svc.participant_joined(session_id, "bob-peer", Some(bob), "Bob", "en")
        .await
        .unwrap();

    let http = reqwest::Client::new();
    let base = format!("http://{}", srv.addr);
    let bookmarks_url = format!("{base}/api/sessions/{session_id}/bookmarks");

    // Instant pin: empty body -> server stamps "now", no label yet.
    let created = http
        .post(&bookmarks_url)
        .bearer_auth(&tess_jwt)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let bm: serde_json::Value = created.json().await.unwrap();
    let bid = bm["id"].as_str().expect("bookmark id").to_string();
    assert_eq!(bm["by"], "Tess");
    assert_eq!(bm["mine"], true);
    assert!(bm["label"].is_null());
    assert!(bm["ts"].is_string());

    // Labels are capped at 200 chars.
    let too_long = http
        .post(&bookmarks_url)
        .bearer_auth(&tess_jwt)
        .json(&serde_json::json!({ "label": "x".repeat(201) }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_long.status(), 400);

    // Relabel afterwards (the in-call input PATCHes) — whitespace trimmed.
    let tess_bm_url = format!("{bookmarks_url}/{bid}");
    let patched = http
        .patch(&tess_bm_url)
        .bearer_auth(&tess_jwt)
        .json(&serde_json::json!({ "label": "  decision made  " }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 204);

    // Bob pins with an explicit (earlier) ts + label of his own.
    let earlier = chrono::Utc::now() - chrono::Duration::seconds(60);
    let bob_created = http
        .post(&bookmarks_url)
        .bearer_auth(&bob_jwt)
        .json(&serde_json::json!({ "ts": earlier, "label": "Bob's moment" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_created.status(), 201);
    let bob_bm: serde_json::Value = bob_created.json().await.unwrap();
    let bob_bid = bob_bm["id"].as_str().unwrap().to_string();

    // Both participants see both pins, chronological, with viewer-relative `mine`.
    let rows: serde_json::Value = http
        .get(&bookmarks_url)
        .bearer_auth(&bob_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["by"], "Bob", "explicit earlier ts sorts first");
    assert_eq!(rows[0]["mine"], true);
    assert_eq!(rows[1]["by"], "Tess");
    assert_eq!(rows[1]["mine"], false);
    assert_eq!(rows[1]["label"], "decision made");

    // Blank label PATCH clears it.
    let cleared = http
        .patch(format!("{bookmarks_url}/{bob_bid}"))
        .bearer_auth(&bob_jwt)
        .json(&serde_json::json!({ "label": "   " }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), 204);

    // Owner-only mutations: Bob can't touch Tess's pin; unknown id is 404.
    let hijack = http
        .patch(&tess_bm_url)
        .bearer_auth(&bob_jwt)
        .json(&serde_json::json!({ "label": "hijack" }))
        .send()
        .await
        .unwrap();
    assert_eq!(hijack.status(), 403);
    let steal = http
        .delete(&tess_bm_url)
        .bearer_auth(&bob_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(steal.status(), 403);
    let missing = http
        .delete(format!("{bookmarks_url}/{}", Uuid::new_v4()))
        .bearer_auth(&tess_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);

    // Gates: stranger 403, no token 401, unknown session 404.
    let (_eve, eve_jwt) = login(&srv, "Eve").await;
    let forbidden = http
        .get(&bookmarks_url)
        .bearer_auth(&eve_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);
    let forbidden_post = http
        .post(&bookmarks_url)
        .bearer_auth(&eve_jwt)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden_post.status(), 403);
    let unauth = http.get(&bookmarks_url).send().await.unwrap();
    assert_eq!(unauth.status(), 401);
    let unknown = http
        .get(format!("{base}/api/sessions/{}/bookmarks", Uuid::new_v4()))
        .bearer_auth(&tess_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);

    // The JSON transcript embeds the bookmarks chronologically (names only —
    // user ids never leave the server).
    let doc: serde_json::Value = http
        .get(format!("{base}/api/sessions/{session_id}/transcript.json"))
        .bearer_auth(&tess_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let exported = doc["bookmarks"].as_array().expect("bookmarks array");
    assert_eq!(exported.len(), 2);
    assert_eq!(exported[0]["by"], "Bob");
    assert!(exported[0]["label"].is_null(), "cleared label exports null");
    assert_eq!(exported[1]["label"], "decision made");
    assert!(exported[0].get("id").is_none(), "export carries no ids");

    // Owner delete works...
    let deleted = http
        .delete(&tess_bm_url)
        .bearer_auth(&tess_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);
    // ...and the FK cascade clears the rest when the session is purged.
    sqlx::query("DELETE FROM call_sessions WHERE id = $1")
        .bind(session_id)
        .execute(&srv.pool)
        .await
        .unwrap();
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM transcript_bookmarks WHERE session_id = $1")
            .bind(session_id)
            .fetch_one(&srv.pool)
            .await
            .unwrap();
    assert_eq!(left, 0, "bookmarks cascade with the session");
}

#[tokio::test]
async fn guest_only_session_is_purged_on_end() {
    let Some(srv) = setup().await else {
        eprintln!("skipping — no DATABASE_URL");
        return;
    };
    let room = format!("gr-{}", Uuid::new_v4().simple());

    // A guest in a private room still gets a session id (recording is on)...
    let (frame, mut ws) = connect_first(srv.addr, &format!("room={room}&lang=en&id=g1")).await;
    assert_eq!(frame["type"], "room_joined");
    let session_id = Uuid::parse_str(frame["session_id"].as_str().unwrap()).unwrap();

    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({ "type": "chat", "text": "off the record" }).to_string(),
    ))
    .await
    .unwrap();
    wait_for(&mut ws, "chat_message").await;
    drop(ws); // last leave -> finalize -> guest-only purge

    // ...but the whole session (and its events) is purged on end.
    let mut sessions = -1i64;
    for _ in 0..30 {
        sessions = sqlx::query_scalar("SELECT count(*) FROM call_sessions WHERE id = $1")
            .bind(session_id)
            .fetch_one(&srv.pool)
            .await
            .unwrap();
        if sessions == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(sessions, 0, "guest-only session purged");
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM transcript_events WHERE session_id = $1")
            .bind(session_id)
            .fetch_one(&srv.pool)
            .await
            .unwrap();
    assert_eq!(events, 0, "no orphaned guest events");
}
