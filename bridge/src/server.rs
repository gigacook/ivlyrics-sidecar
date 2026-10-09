//! The WebSocket server a native app runs; the spotiflux extension connects to it.
//!
//! Blocking std threads, no async runtime: one accept thread, one thread per
//! connection. Only one extension connection is live at a time; a newer one
//! replaces the older one (Spotify reloads its page on restart and reconnects).
//!
//! Security: binds 127.0.0.1 only. Browsers send an `Origin` header with every
//! WebSocket handshake, so a web page trying to pose as the extension is refused
//! unless it comes from Spotify's own page; native clients send no Origin and are
//! accepted. Any local program can still connect, which is why the extension keeps
//! control off until the user allows it.

use crate::{AppHello, Ack, Cmd, CmdMsg, Get, Incoming, Outgoing, What, encode, parse};
use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

/// Largest frame accepted from the extension (lyrics with translations stay far below).
pub const MAX_FRAME_BYTES: usize = 1 << 20;
/// How long a connection thread blocks in a read before it checks for writes.
const POLL: Duration = Duration::from_millis(25);
/// Longest wait for a handshake or for a write to go through.
const STALL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The extension connected. Its `hello` follows as a [`Event::Message`].
    Connected,
    /// Any message that isn't the answer to a [`Bridge::get`] / [`Bridge::send_cmd`].
    Message(Outgoing),
    /// The extension went away (Spotify closed or reloaded, bridge switched off).
    Disconnected,
    /// A handshake was refused because its Origin isn't Spotify's page.
    Rejected { origin: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeError {
    /// No extension is connected right now.
    NotConnected,
    /// No answer within the timeout.
    Timeout,
    /// The connection dropped while waiting.
    Disconnected,
    /// The extension answered with something else (for `get`: an `ack` with ok false).
    Unexpected(Box<Outgoing>),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::NotConnected => write!(f, "spotiflux is not connected"),
            BridgeError::Timeout => write!(f, "no answer from spotiflux"),
            BridgeError::Disconnected => write!(f, "spotiflux disconnected"),
            BridgeError::Unexpected(m) => write!(f, "unexpected answer: {m:?}"),
        }
    }
}

impl std::error::Error for BridgeError {}

struct Shared {
    hello: AppHello,
    /// The live connection: its generation and its write queue.
    conn: Mutex<Option<(u64, Sender<String>)>>,
    /// Requests waiting for an answer, by id.
    waiters: Mutex<HashMap<String, Sender<Outgoing>>>,
    next_id: AtomicU64,
    next_gen: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Handle to a running bridge server. Cheap to clone; all clones share the connection.
#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
    addr: SocketAddr,
}

impl Bridge {
    /// Bind `127.0.0.1:port` (0 = any free port) and start accepting. `app` and
    /// `version` are sent in our `hello` and show in spotiflux's settings.
    /// Events arrive on the returned channel.
    pub fn listen(port: u16, app: &str, version: &str) -> io::Result<(Bridge, Receiver<Event>)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            hello: AppHello { app: app.into(), version: version.into() },
            conn: Mutex::new(None),
            waiters: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            next_gen: AtomicU64::new(1),
        });
        let (events, rx) = mpsc::channel();
        let accept_shared = shared.clone();
        thread::Builder::new().name("spotiflux-bridge-accept".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let (shared, events) = (accept_shared.clone(), events.clone());
                let _ = thread::Builder::new()
                    .name("spotiflux-bridge-conn".into())
                    .spawn(move || serve(stream, shared, events));
            }
        })?;
        Ok((Bridge { shared, addr }, rx))
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn is_connected(&self) -> bool {
        lock(&self.shared.conn).is_some()
    }

    /// Send any message to the extension without waiting for an answer.
    pub fn send(&self, msg: &Incoming) -> Result<(), BridgeError> {
        match &*lock(&self.shared.conn) {
            Some((_, out)) => out.send(encode(msg)).map_err(|_| BridgeError::NotConnected),
            None => Err(BridgeError::NotConnected),
        }
    }

    /// Run a command and wait for its `ack`. `ack.ok == false` with `error ==
    /// "control off"` means the user hasn't allowed control in spotiflux's settings.
    pub fn send_cmd(&self, cmd: Cmd, timeout: Duration) -> Result<Ack, BridgeError> {
        let id = self.new_id();
        match self.request(&Incoming::Cmd(CmdMsg { id: id.clone(), cmd }), id, timeout)? {
            Outgoing::Ack(ack) => Ok(ack),
            other => Err(BridgeError::Unexpected(Box::new(other))),
        }
    }

    /// Ask for the current state, lyrics or queue. Answers with `Outgoing::State`,
    /// `Outgoing::Lyrics` or `Outgoing::Queue`.
    pub fn get(&self, what: What, timeout: Duration) -> Result<Outgoing, BridgeError> {
        let id = self.new_id();
        match self.request(&Incoming::Get(Get { id: id.clone(), what }), id, timeout)? {
            ack @ Outgoing::Ack(_) => Err(BridgeError::Unexpected(Box::new(ack))),
            reply => Ok(reply),
        }
    }

    fn new_id(&self) -> String {
        format!("r{}", self.shared.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn request(&self, msg: &Incoming, id: String, timeout: Duration) -> Result<Outgoing, BridgeError> {
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.waiters).insert(id.clone(), tx);
        let res = self.send(msg).and_then(|()| {
            rx.recv_timeout(timeout).map_err(|e| match e {
                RecvTimeoutError::Timeout => BridgeError::Timeout,
                RecvTimeoutError::Disconnected => BridgeError::Disconnected,
            })
        });
        lock(&self.shared.waiters).remove(&id);
        res
    }
}

/// Spotify's desktop page, or no Origin at all (native clients).
fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => o.starts_with("https://") && (o.ends_with(".spotify.com") || o == "https://spotify.com"),
    }
}

fn serve(stream: TcpStream, shared: Arc<Shared>, events: Sender<Event>) {
    let _ = stream.set_nodelay(true);
    // A client that never finishes the handshake, or stops reading, can't hold this thread forever.
    let _ = stream.set_read_timeout(Some(STALL));
    let _ = stream.set_write_timeout(Some(STALL));
    let mut refused = None;
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").map(|o| o.to_str().unwrap_or("?").to_string());
        if origin_allowed(origin.as_deref()) {
            return Ok(resp);
        }
        refused = origin;
        let mut err = ErrorResponse::new(Some("origin not allowed".into()));
        *err.status_mut() = StatusCode::FORBIDDEN;
        Err(err)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let ws = tungstenite::accept_hdr_with_config(stream, check, Some(config));
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(_) => {
            if let Some(origin) = refused {
                let _ = events.send(Event::Rejected { origin });
            }
            return;
        }
    };
    let _ = ws.get_ref().set_read_timeout(Some(POLL));

    // Newest connection wins: replacing the write queue ends the older thread.
    let generation = shared.next_gen.fetch_add(1, Ordering::Relaxed);
    let (out_tx, out_rx) = mpsc::channel::<String>();
    lock(&shared.waiters).clear(); // first, so a request on the new connection keeps its waiter
    *lock(&shared.conn) = Some((generation, out_tx));
    let _ = events.send(Event::Connected);
    if ws.send(Message::text(encode(&Incoming::Hello(shared.hello.clone())))).is_ok() {
        run(&mut ws, &out_rx, &shared, &events);
    }

    let mut conn = lock(&shared.conn);
    if conn.as_ref().map(|c| c.0) == Some(generation) {
        *conn = None;
        drop(conn);
        lock(&shared.waiters).clear(); // pending requests fail with Disconnected
        let _ = events.send(Event::Disconnected);
    }
}

fn run(ws: &mut WebSocket<TcpStream>, out_rx: &Receiver<String>, shared: &Shared, events: &Sender<Event>) {
    loop {
        loop {
            match out_rx.try_recv() {
                Ok(text) => {
                    if ws.send(Message::text(text)).is_err() {
                        return;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return, // replaced by a newer connection
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => route(text.as_str(), shared, events),
            Ok(_) => {} // pings are answered by tungstenite; binary frames aren't part of v1
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                let _ = ws.flush(); // pending pongs
            }
            Err(_) => return,
        }
    }
}

/// Answers go to the waiting request; everything else becomes an event.
/// Frames that don't parse are ignored, as the protocol asks.
fn route(text: &str, shared: &Shared, events: &Sender<Event>) {
    let Ok(msg) = parse::<Outgoing>(text) else { return };
    let id = match &msg {
        Outgoing::Ack(a) => Some(a.id.clone()),
        Outgoing::State(s) => s.id.clone(),
        Outgoing::Lyrics(l) => l.id.clone(),
        Outgoing::Queue(q) => q.id.clone(),
        Outgoing::Hello(_) | Outgoing::Line(_) => None,
    };
    if let Some(id) = id {
        if let Some(waiter) = lock(&shared.waiters).remove(&id) {
            let _ = waiter.send(msg);
            return;
        }
        if matches!(msg, Outgoing::Ack(_)) {
            return; // answer to a request that already timed out
        }
    }
    let _ = events.send(Event::Message(msg));
}

#[cfg(test)]
mod tests {
    use super::origin_allowed;

    #[test]
    fn origins() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("https://xpui.app.spotify.com")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("https://spotify.com.evil.example")));
        assert!(!origin_allowed(Some("http://xpui.app.spotify.com")));
        assert!(!origin_allowed(Some("null")));
    }
}
