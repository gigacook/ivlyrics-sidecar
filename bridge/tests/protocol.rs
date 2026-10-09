use serde_json::Value;
use spotiflux_bridge::*;
use std::time::Duration;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// parse -> encode gives back the same JSON (field names, types, optional fields).
fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(name: &str) -> T {
    let text = fixture(name);
    let msg: T = parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
    let original: Value = serde_json::from_str(&text).unwrap();
    let again: Value = serde_json::from_str(&encode(&msg)).unwrap();
    assert_eq!(original, again, "{name} changed in a round trip");
    msg
}

#[test]
fn every_outgoing_fixture_round_trips() {
    assert!(matches!(round_trip::<Outgoing>("out_hello.json"), Outgoing::Hello(h) if h.app == "spotiflux" && !h.control_allowed));
    assert!(matches!(round_trip::<Outgoing>("out_state.json"), Outgoing::State(s) if s.repeat == Repeat::Context && s.id.is_none()));
    let Outgoing::Lyrics(l) = round_trip::<Outgoing>("out_lyrics.json") else { panic!() };
    assert_eq!(l.source, LyricsSource::Spotify);
    assert_eq!(l.lines[1].pronunciation.as_deref(), Some("yoru ni kakeru"));
    assert_eq!(l.lines[2].pronunciation, None);
    assert!(matches!(round_trip::<Outgoing>("out_line.json"), Outgoing::Line(x) if x.index == 1));
    assert!(matches!(round_trip::<Outgoing>("out_ack.json"), Outgoing::Ack(a) if !a.ok && a.error.as_deref() == Some("control off")));
    assert!(matches!(round_trip::<Outgoing>("out_queue.json"), Outgoing::Queue(q) if q.next.len() == 1 && q.id.as_deref() == Some("r3")));
}

#[test]
fn every_incoming_fixture_round_trips() {
    assert!(matches!(round_trip::<Incoming>("in_hello.json"), Incoming::Hello(h) if h.app == "GIGAPLAY"));
    assert!(matches!(round_trip::<Incoming>("in_get.json"), Incoming::Get(g) if g.what == What::Lyrics));
    let cmd = |name| match round_trip::<Incoming>(name) {
        Incoming::Cmd(c) => c.cmd,
        other => panic!("{other:?}"),
    };
    assert_eq!(cmd("in_cmd_toggle.json"), Cmd::Toggle);
    assert_eq!(cmd("in_cmd_seek.json"), Cmd::Seek { position_ms: 60000 });
    assert_eq!(cmd("in_cmd_volume.json"), Cmd::Volume { value: 0.5 });
    assert!(matches!(cmd("in_cmd_queue_next.json"), Cmd::QueueNext { .. }));
    assert!(matches!(cmd("in_cmd_add.json"), Cmd::AddToPlaylist { playlist_uri: Some(_) }));
    assert_eq!(cmd("in_cmd_add_pinned.json"), Cmd::AddToPlaylist { playlist_uri: None });
}

#[test]
fn rejects_unknown_versions_and_types() {
    assert!(matches!(parse::<Outgoing>(r#"{"v":2,"type":"line","uri":"","index":0,"start_ms":0}"#), Err(Error::Version(Some(2)))));
    assert!(matches!(parse::<Outgoing>(r#"{"type":"line"}"#), Err(Error::Version(None))));
    assert!(matches!(parse::<Outgoing>(r#"{"v":1,"type":"video"}"#), Err(Error::Message(_))));
    assert!(matches!(parse::<Incoming>(r#"{"v":1,"type":"cmd","id":"x","cmd":"format_disk"}"#), Err(Error::Message(_))));
    assert!(matches!(parse::<Outgoing>("not json"), Err(Error::Json(_))));
    // Unknown extra fields are fine (forward compatible).
    assert!(parse::<Outgoing>(r#"{"v":1,"type":"line","uri":"u","index":0,"start_ms":5,"new_field":1}"#).is_ok());
}

#[test]
fn position_interpolates_only_while_playing() {
    let mut s = State { playing: true, position_ms: 10_000, at_epoch_ms: 1_000_000, duration_ms: 200_000, ..Default::default() };
    assert_eq!(s.position_ms_at(1_002_500), 12_500);
    assert_eq!(s.position_ms_at(999_000), 10_000); // clock behind the message: no going back
    assert_eq!(s.position_ms_at(9_000_000), 200_000); // clamped to the duration
    s.playing = false;
    assert_eq!(s.position_ms_at(1_002_500), 10_000);
}

#[test]
fn line_at_finds_the_current_line() {
    let Outgoing::Lyrics(l) = parse(&fixture("out_lyrics.json")).unwrap() else { panic!() };
    assert_eq!(l.line_at(0), Some(0));
    assert_eq!(l.line_at(12_339), Some(0));
    assert_eq!(l.line_at(12_340), Some(1));
    assert_eq!(l.line_at(99_999), Some(2));
    let unsynced = Lyrics { synced: false, ..l };
    assert_eq!(unsynced.line_at(20_000), None);
}

/// The server end to end, with a fake extension on a real socket.
#[test]
fn server_routes_events_and_answers() {
    use tungstenite::Message;
    let (bridge, events) = Bridge::listen(0, "test", "1").unwrap();
    let url = format!("ws://{}", bridge.local_addr());
    let (mut ext, _) = tungstenite::connect(url).unwrap();
    assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), Event::Connected);
    // Our hello reaches the extension first.
    let Message::Text(t) = ext.read().unwrap() else { panic!() };
    assert!(matches!(parse::<Incoming>(t.as_str()).unwrap(), Incoming::Hello(h) if h.app == "test"));

    ext.send(Message::text(fixture("out_line.json"))).unwrap();
    assert!(matches!(events.recv_timeout(Duration::from_secs(5)).unwrap(), Event::Message(Outgoing::Line(_))));

    // A command: the fake extension reads it and answers with an ack.
    let b = bridge.clone();
    let waiter = std::thread::spawn(move || b.send_cmd(Cmd::Toggle, Duration::from_secs(5)));
    let Message::Text(t) = ext.read().unwrap() else { panic!() };
    let Incoming::Cmd(c) = parse::<Incoming>(t.as_str()).unwrap() else { panic!() };
    assert_eq!(c.cmd, Cmd::Toggle);
    let ack = Outgoing::Ack(Ack { id: c.id, ok: false, error: Some("control off".into()) });
    ext.send(Message::text(encode(&ack))).unwrap();
    let got = waiter.join().unwrap().unwrap();
    assert_eq!(got.error.as_deref(), Some("control off"));

    drop(ext);
    assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), Event::Disconnected);
    assert_eq!(bridge.send_cmd(Cmd::Next, Duration::from_millis(100)), Err(BridgeError::NotConnected));
}

#[test]
fn server_refuses_foreign_web_pages() {
    use tungstenite::client::IntoClientRequest;
    let (bridge, events) = Bridge::listen(0, "test", "1").unwrap();
    let mut req = format!("ws://{}", bridge.local_addr()).into_client_request().unwrap();
    req.headers_mut().insert("Origin", "https://evil.example".parse().unwrap());
    assert!(tungstenite::connect(req).is_err());
    assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), Event::Rejected { origin: "https://evil.example".into() });
}
