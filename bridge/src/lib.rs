//! spotiflux-bridge: the receiver side of the spotiflux bridge.
//!
//! The spotiflux Spicetify extension connects as a WebSocket *client* to
//! `ws://127.0.0.1:<port>` (default [`DEFAULT_PORT`]) and sends what Spotify plays,
//! the lyrics with timing and translations, and the current line. A native app runs
//! the server ([`server::Bridge`]) and can read all of it; it can also send commands,
//! which the extension only obeys when the user switched "allow control" on.
//!
//! Wire format: protocol "spotiflux-bridge v1", one JSON object per text frame,
//! `{ "v": 1, "type": "...", ... }`. Units are explicit in field names (`_ms` =
//! milliseconds, `_epoch_ms` = milliseconds since the Unix epoch). The full table is
//! in `docs/bridge.md`.
//!
//! Naming is from the extension's point of view: [`Outgoing`] = extension -> app,
//! [`Incoming`] = app -> extension.

pub mod server;

pub use server::{Bridge, BridgeError, Event};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;

/// The only protocol version this crate speaks. Frames with another `v` are rejected.
pub const PROTOCOL_VERSION: u64 = 1;
/// Port the extension connects to unless the user changed it in its settings.
pub const DEFAULT_PORT: u16 = 47474;

// ---------------------------------------------------------------------------------------
// extension -> app
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Outgoing {
    /// Sent once on connect, and again when "allow control" changes.
    Hello(ExtHello),
    /// Playback state. On connect, song change, play/pause, seek, volume, shuffle or
    /// repeat change, and every 5 s as a heartbeat. Also the answer to `get state`.
    State(State),
    /// All lyric lines of the current song. When lyrics load, again when translations
    /// arrive, and as the answer to `get lyrics`.
    Lyrics(Lyrics),
    /// The current lyric line changed.
    Line(Line),
    /// Answer to a [`Cmd`] (and to a `get` with an unknown `what`).
    Ack(Ack),
    /// Answer to `get queue`.
    Queue(Queue),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtHello {
    /// Always "spotiflux".
    pub app: String,
    /// Extension version.
    pub version: String,
    /// Spotify client version, as Spicetify reports it.
    pub spotify_version: String,
    /// Whether commands are obeyed (the user's "allow control" switch).
    pub control_allowed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Repeat {
    #[default]
    Off,
    Context,
    Track,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// Set only when this answers a `get`: the request's id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub playing: bool,
    /// `spotify:track:…`, `spotify:episode:…`, `spotify:local:…`, or "" when nothing is loaded.
    pub uri: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_uri: String,
    /// https URL of the largest cover Spotify offers, or "".
    pub cover_url: String,
    pub duration_ms: u64,
    /// Position when the message was made, at `at_epoch_ms`.
    pub position_ms: u64,
    pub at_epoch_ms: u64,
    /// 0.0 to 1.0.
    pub volume: f64,
    pub shuffle: bool,
    pub repeat: Repeat,
    /// What's playing from (playlist, album, …), or "".
    pub context_uri: String,
    pub context_name: String,
}

impl State {
    /// Playback position at `now_epoch_ms`, interpolated from `position_ms` and
    /// `at_epoch_ms` while playing, clamped to the duration. Paused: `position_ms`.
    pub fn position_ms_at(&self, now_epoch_ms: u64) -> u64 {
        if !self.playing {
            return self.position_ms;
        }
        let pos = self.position_ms + now_epoch_ms.saturating_sub(self.at_epoch_ms);
        if self.duration_ms > 0 { pos.min(self.duration_ms) } else { pos }
    }

    /// [`State::position_ms_at`] for the current system time.
    pub fn position_ms_now(&self) -> u64 {
        self.position_ms_at(now_epoch_ms())
    }
}

/// Milliseconds since the Unix epoch, the clock `at_epoch_ms` uses.
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricsSource {
    Spotify,
    Lrclib,
    #[default]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Lyrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub uri: String,
    pub source: LyricsSource,
    /// false: the lines have no timing (`start_ms` is 0) and no `line` messages follow.
    pub synced: bool,
    /// Language tag when Spotify gives one (for example "en", "ja"), else "".
    pub language: String,
    pub lines: Vec<LyricLine>,
}

impl Lyrics {
    /// Index of the line playing at `position_ms` (the last line that started at or
    /// before it), if any. For receivers that keep their own clock instead of `line`.
    /// Doesn't know the user's per-song sync offset; `line` messages include it.
    pub fn line_at(&self, position_ms: u64) -> Option<usize> {
        if !self.synced {
            return None;
        }
        self.lines.partition_point(|l| l.start_ms <= position_ms).checked_sub(1)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LyricLine {
    pub start_ms: u64,
    /// "" for instrumental gaps.
    pub text: String,
    /// Present once Gemini translated the song (only for songs that aren't English).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    /// Romanised pronunciation, for lines not written in Latin script.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronunciation: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Line {
    pub uri: String,
    /// Index into the last `lyrics.lines`; -1 = before the first line.
    pub index: i64,
    pub start_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Ack {
    pub id: String,
    pub ok: bool,
    /// Why it failed, for example "control off", "bad uri", "no pinned playlist".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Queue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub current: Option<QueueTrack>,
    pub next: Vec<QueueTrack>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct QueueTrack {
    pub uri: String,
    pub title: String,
    pub artists: Vec<String>,
    /// "queue" (queued by the user), "context" (rest of the playlist), "autoplay".
    pub provider: String,
}

// ---------------------------------------------------------------------------------------
// app -> extension
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Incoming {
    /// The app introduces itself; shown in the extension's settings status line.
    Hello(AppHello),
    /// Always allowed. Answered with `state`, `lyrics` or `queue` carrying the same id.
    Get(Get),
    /// Only obeyed with "allow control" on; always answered with an `ack`.
    Cmd(CmdMsg),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppHello {
    pub app: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum What {
    State,
    Lyrics,
    Queue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Get {
    pub id: String,
    pub what: What,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CmdMsg {
    pub id: String,
    #[serde(flatten)]
    pub cmd: Cmd,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Play,
    Pause,
    Toggle,
    Next,
    Prev,
    Seek { position_ms: u64 },
    /// 0.0 to 1.0.
    Volume { value: f64 },
    /// Put a track first in the queue. `spotify:track:…` or `spotify:episode:…`.
    QueueNext { uri: String },
    /// Add the playing song to a playlist; without a uri, to the pinned one (Ctrl+Shift+S).
    AddToPlaylist {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        playlist_uri: Option<String>,
    },
}

// ---------------------------------------------------------------------------------------
// parse / encode
// ---------------------------------------------------------------------------------------

#[derive(Debug)]
pub enum Error {
    /// Not JSON, or not an object.
    Json(serde_json::Error),
    /// `v` missing or not [`PROTOCOL_VERSION`].
    Version(Option<u64>),
    /// Known version, but an unknown `type` / `cmd` or a field of the wrong shape.
    Message(serde_json::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Json(e) => write!(f, "not a JSON object: {e}"),
            Error::Version(Some(v)) => write!(f, "unsupported protocol version {v}"),
            Error::Version(None) => write!(f, "missing protocol version"),
            Error::Message(e) => write!(f, "unknown or malformed message: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// Parse one frame. `T` is [`Outgoing`] in a receiver (or [`Incoming`] to test one).
/// Rejects any `v` but 1; unknown fields are ignored so later minor additions don't break you.
pub fn parse<T: DeserializeOwned>(text: &str) -> Result<T, Error> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(Error::Json)?;
    let v = value.get("v").and_then(|v| v.as_u64());
    if v != Some(PROTOCOL_VERSION) {
        return Err(Error::Version(v));
    }
    serde_json::from_value(value).map_err(Error::Message)
}

/// Encode one frame, with `"v": 1` added.
pub fn encode<T: Serialize>(msg: &T) -> String {
    let mut value = serde_json::to_value(msg).expect("protocol types always serialize");
    if let Some(obj) = value.as_object_mut() {
        obj.insert("v".into(), PROTOCOL_VERSION.into());
    }
    value.to_string()
}
