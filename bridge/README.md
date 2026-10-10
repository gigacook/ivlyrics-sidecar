# spotiflux-bridge

Rust receiver for the [spotiflux](../README.md) bridge: get what Spotify plays, its timed lyrics and the current line in your native app, and (if the user allows it) control playback.

```
Spotify ─ spotiflux extension ──ws://127.0.0.1:47474──▶ your app (Bridge::listen)
```

## Install

```toml
[dependencies]
spotiflux-bridge = { git = "https://github.com/gigacook/spotiflux", package = "spotiflux-bridge" }
```

Blocking std threads, no async runtime. Dependencies: `serde`, `serde_json`, `tungstenite`.

## Use

```rust
use spotiflux_bridge::{Bridge, Cmd, Event, Outgoing, DEFAULT_PORT};
use std::time::Duration;

let (bridge, events) = Bridge::listen(DEFAULT_PORT, "MyApp", "1.0")?;
for event in events {
    match event {
        Event::Message(Outgoing::State(s)) => println!("{} at {} ms", s.title, s.position_ms_now()),
        Event::Message(Outgoing::Line(l)) => println!("line {}", l.index),
        _ => {}
    }
}
// elsewhere, with a clone of `bridge`:
let ack = bridge.send_cmd(Cmd::Toggle, Duration::from_secs(2))?; // ok=false, "control off" unless allowed
```

Run the bundled listener against your Spotify: `cargo run --example listen` (type `toggle`, `get queue`, `quit`).

## What you get

| API | Does |
|---|---|
| `Bridge::listen(port, app, version)` | Binds `127.0.0.1:port`, returns the handle and an `Event` receiver. Fails if the port is taken. |
| `Event` | `Connected`, `Message(Outgoing)`, `Disconnected`, `Rejected { origin }` |
| `Outgoing` | `Hello`, `State`, `Lyrics`, `Line`, `Queue`, `Ack` |
| `bridge.get(What, timeout)` | Ask for `State`, `Lyrics` or `Queue`; always allowed. |
| `bridge.send_cmd(Cmd, timeout)` | `Play`, `Pause`, `Toggle`, `Next`, `Prev`, `Seek`, `Volume`, `QueueNext`, `AddToPlaylist`; obeyed only with "allow control" on. |
| `State::position_ms_now()` / `position_ms_at(t)` | Interpolated playback position. |
| `Lyrics::line_at(position_ms)` | Current line without waiting for `Line` (no user sync offset). |
| `parse` / `encode` | Raw protocol frames, for tests or other transports. |

Protocol (every message and field): [`docs/bridge.md`](../docs/bridge.md). Internals: [`ARCHITECTURE.md`](ARCHITECTURE.md). Example frames: [`fixtures/`](fixtures).

## Test

```
cargo test
```

Licence: MIT.
