# Architecture

A map of the crate for whoever changes it. It describes things that rarely change; API details are in the doc comments.

## Bird's-eye view

The spotiflux extension (JavaScript, inside Spotify) is a WebSocket **client**. This crate is the **server** side a native app embeds. It does three jobs:

1. **Types** for protocol v1 (`lib.rs`): every message as a serde type, plus `parse` and `encode`.
2. **Transport** (`server.rs`): a localhost WebSocket server that keeps one live connection and turns frames into `Event`s.
3. **Request/response** on top of a fire-and-forget protocol: `get` and `send_cmd` attach an id and wait for the frame carrying that id.

```
extension ──frame──▶ connection thread ──parse──▶ id waiting? ──yes──▶ waiter (get / send_cmd)
                                                         └──no───▶ Event channel ──▶ your app
your app ──send / get / send_cmd──▶ write queue ──▶ connection thread ──frame──▶ extension
```

## Code map

| File | Owns |
|---|---|
| `src/lib.rs` | Protocol constants (`PROTOCOL_VERSION`, `DEFAULT_PORT`), `Outgoing` (extension → app) and `Incoming` (app → extension) enums, the payload structs, `Cmd`, `parse`/`encode`, position and line helpers. No I/O. |
| `src/server.rs` | `Bridge` (cheap to clone, shared state behind `Arc`), the accept thread, one thread per connection, the Origin check, waiters by id, `Event`, `BridgeError`. |
| `tests/protocol.rs` | Every fixture parses and re-encodes; server tests with a fake extension client. |
| `fixtures/*.json` | One real frame per message type; `out_*` = from the extension, `in_*` = to it. Shared with docs and other-language clients. |
| `examples/listen.rs` | Console receiver for trying the bridge by hand. |

## Invariants

- **Localhost only.** The listener binds `127.0.0.1`, never `0.0.0.0`.
- **Origin.** A handshake with an `Origin` header is accepted only from `https://spotify.com` or `https://*.spotify.com`; no Origin (native client) is accepted. This stops browser pages from posing as the extension.
- **One connection.** A newer connection replaces the older one (Spotify reloads its page on restart). The generation counter makes sure an old thread can't clear the new connection.
- **Naming from the extension's side.** `Outgoing` = sent by the extension, `Incoming` = sent by the app. Don't flip it.
- **v1 only grows.** New optional fields may be added; nothing is removed or retyped. Unknown fields and unknown `type`s are ignored, a different `v` is rejected.
- **Frames are capped** at `MAX_FRAME_BYTES` (1 MiB) on the way in.
- **No async runtime and no extra dependencies** beyond serde, serde_json and tungstenite, so any app (Tauri, egui, CLI) can embed it.

## Boundaries (what it deliberately doesn't do)

- It doesn't decide whether control is allowed; the extension does, and answers `control off`.
- It doesn't apply the user's lyric sync offset; `Line` messages already carry it, `Lyrics::line_at` doesn't.
- It doesn't retry a taken port or pick another one; the app shows the error.
- It has no TypeScript or ts-rs types; apps mirror the types in their own protocol crate.
