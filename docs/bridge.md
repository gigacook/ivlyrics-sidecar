# spotiflux bridge: protocol v1

The spotiflux extension runs inside the Spotify desktop app and sends what Spotify plays, the lyrics with timing and translations, and the current lyric line to a program on the same computer. That program can also send commands, if the user allows it. This page describes the protocol for any programming language. Rust programs can use the [`bridge/`](../bridge) crate, which implements all of it.

- [How the connection works](#how-the-connection-works)
- [Frames](#frames)
- [From spotiflux to your app](#from-spotiflux-to-your-app)
- [From your app to spotiflux](#from-your-app-to-spotiflux)
- [Example session](#example-session)
- [Security model](#security-model)
- [Using it from GIGAPLAY](#using-it-from-gigaplay)
- [Using it from C# or WinUI](#using-it-from-c-or-winui)

## How the connection works

1. **Your app is the server.** It listens for WebSocket connections on `127.0.0.1`, port **47474** by default. The user can change the port in spotiflux's settings; your app should let the user change it too.
2. **spotiflux is the client.** While its bridge is on (the default), it connects to `ws://127.0.0.1:<port>`: when Spotify starts, then after 2, 5 and 15 seconds, then once a minute, until a connection succeeds. After a disconnect that came more than 10 seconds after connecting, it starts over with the same delays; after a shorter connection it keeps backing off. Start order doesn't matter.
3. **One connection at a time.** Spotify reloads its page when it restarts, so a new connection from spotiflux replaces the old one. The Rust server does this for you.
4. **Origin.** Because spotiflux runs in Spotify's page, its handshake carries an `Origin` header from Spotify's own page, `https://spotify.com` or `https://<something>.spotify.com`. Refuse handshakes with any other Origin: they come from web pages in a browser, which can open WebSockets to localhost too. Native clients send no Origin.

On connect, spotiflux sends `hello`, then `state`, then `lyrics` (when the song's lyrics have finished loading). No `line` follows on connect: the first one comes when the current line next changes, so until then find the line yourself (`Lyrics::line_at` in the crate). Send your own `hello` so the user sees your app's name in spotiflux's settings.

## Frames

Every message is one WebSocket **text** frame holding one JSON object:

```json
{ "v": 1, "type": "line", "uri": "spotify:track:0VjIjW4GlUZAMYd2vXMi3b", "index": 1, "start_ms": 12340 }
```

- `v` is the protocol version, always `1`. Reject frames with any other `v`.
- `type` says which message it is. Ignore types you don't know.
- Units are in the field names: `_ms` is milliseconds, `_epoch_ms` is milliseconds since 1970-01-01 UTC (the Unix epoch).
- Ignore fields you don't know: later versions of v1 may add fields, never remove or change them.
- spotiflux ignores frames from your app that are longer than 65,536 characters, aren't JSON, have another `v`, or have an unknown `type`. The limit counts JavaScript characters (UTF-16 units), not bytes. An unknown `cmd` is not ignored: it gets an `ack` with an error.

## From spotiflux to your app

### `hello`

Sent on connect, and again whenever the user switches "allow control".

| Field | Type | Meaning |
|---|---|---|
| `app` | string | Always `"spotiflux"`. |
| `version` | string | spotiflux's version, for example `"2.0.0"`. |
| `spotify_version` | string | Spotify's version, for example `"1.3.4.258"`. |
| `control_allowed` | bool | Whether commands are obeyed. |

### `state`

Sent on connect, on song change, on play or pause, after a seek (the position moved more than 1.5 s from where it should be), on a change of volume, shuffle, repeat or song length, and every 5 seconds as a heartbeat. Also the answer to `get` with `what: "state"`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string, only in answers | The `id` of the `get` this answers. |
| `playing` | bool | Playing (true) or paused (false). |
| `uri` | string | `spotify:track:…`, `spotify:episode:…`, `spotify:local:…`, or `""` when nothing is loaded. |
| `title` | string | Song title. |
| `artists` | array of strings | Artist names, main artist first. |
| `album` | string | Album name. |
| `album_uri` | string | `spotify:album:…`, or `""`. |
| `cover_url` | string | `https://i.scdn.co/image/…` of the largest cover, or `""`. |
| `duration_ms` | number | Length of the song. |
| `position_ms` | number | Position at the moment `at_epoch_ms`. |
| `at_epoch_ms` | number | When the message was made, on the computer's clock. |
| `volume` | number | 0.0 to 1.0. |
| `shuffle` | bool | Shuffle on. |
| `repeat` | string | `"off"`, `"context"` (repeat the playlist or album) or `"track"`. |
| `context_uri` | string | What it plays from (`spotify:playlist:…`, `spotify:album:…`), or `""`. |
| `context_name` | string | Name of that playlist or album, or `""`. |

**Interpolate the position yourself** between messages: while `playing`, the position now is `position_ms + (now_epoch_ms - at_epoch_ms)`, at most `duration_ms`. While paused, it's `position_ms`. Both ends run on the same computer, so their clocks agree.

### `lyrics`

Sent when a song's lyrics have loaded (also when there are none), again when translations arrive, and as the answer to `get` with `what: "lyrics"`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string, only in answers | The `id` of the `get` this answers. |
| `uri` | string | The song these lyrics belong to. |
| `source` | string | `"spotify"` (Spotify's own lyrics), `"lrclib"` (lrclib.net) or `"none"`. |
| `synced` | bool | Whether the lines have start times. When false, every `start_ms` is 0 and the only `line` message for the song has `index` -1. |
| `language` | string | Language code from Spotify (`"en"`, `"ja"`, …), or `""` when unknown. |
| `lines` | array | One object per line, in order: |
| `lines[].start_ms` | number | When the line starts, in song time. |
| `lines[].text` | string | The line. `""` marks an instrumental gap. |
| `lines[].translation` | string, optional | Present once Gemini translated the song. Only songs that aren't in English are translated, and only when the user set a Gemini key. |
| `lines[].pronunciation` | string, optional | The line in Latin letters, for lines not written in Latin script. |

### `line`

Sent whenever the current line changes, checked four times a second, and once more (same index) after every `lyrics` message. The user's per-song sync offset is already applied, so prefer this over your own clock.

| Field | Type | Meaning |
|---|---|---|
| `uri` | string | The song. |
| `index` | number | Index into the last `lyrics.lines` for this `uri`. `-1` means before the first line, or no timed lyrics. |
| `start_ms` | number | That line's `start_ms` (0 when `index` is -1). |

### `queue`

Only as the answer to `get` with `what: "queue"`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The `id` of the `get`. |
| `current` | object or null | The playing track: `uri`, `title`, `artists`, `provider`. |
| `next` | array | Up to 80 upcoming tracks, same fields. |

`provider` is `"queue"` (queued by the user), `"context"` (the rest of the playlist or album) or `"autoplay"` (Spotify's recommendations).

### `ack`

The answer to every `cmd`, and to a `get` with an unknown `what`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The `id` of the request, always as a string. |
| `ok` | bool | Whether it worked. |
| `error` | string, only when `ok` is false | Why not (see the table under `cmd`). |

## From your app to spotiflux

### `hello`

| Field | Type | Meaning |
|---|---|---|
| `app` | string | Your app's name, shown in spotiflux's settings as `bridge: connected to <app> <version>`. ASCII letters and digits, spaces and `. : + ( ) - _` are kept (other characters are dropped), up to 64 characters. An empty name shows as "an app". |
| `version` | string | Your app's version, cut to 24 characters. |

### `get`

Always allowed, even with control off.

| Field | Type | Meaning |
|---|---|---|
| `id` | string or number | Your request id, echoed back as a string (at most 64 characters). The Rust crate always sends strings. |
| `what` | string | `"state"`, `"lyrics"` or `"queue"`. |

The answer is a `state`, `lyrics` or `queue` message carrying the same `id`.

### `cmd`

Only obeyed while the user has "allow control" switched on. Otherwise the answer is `ack` with `ok: false` and `error: "control off"`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string or number | Your request id, echoed in the `ack` as a string. |
| `cmd` | string | One of the commands below, with its fields next to `cmd`. |

| `cmd` | Fields | What it does |
|---|---|---|
| `play` | | Resume. |
| `pause` | | Pause. |
| `toggle` | | Play if paused, pause if playing. |
| `next` | | Next track. |
| `prev` | | Previous track (or the start of this one, as Spotify's button does). |
| `seek` | `position_ms` (number of milliseconds, 0 or more) | Jump to that position, clamped to the song's length. 0 goes to 2 ms (Spotify reads 0 to 1 as a fraction). |
| `volume` | `value` (number, 0 to 1) | Set the volume, clamped to 0 to 1. |
| `queue_next` | `uri` (`spotify:track:…` or `spotify:episode:…`) | Put the track first in the queue, without interrupting the song. |
| `add_to_playlist` | `playlist_uri` (`spotify:playlist:…`), optional | Add the playing song to that playlist. Without `playlist_uri`, to the playlist the user pinned in this Spotify session (the picker opens with Ctrl+Shift+A, or Ctrl+Shift+S when nothing is pinned). |

| `error` | Meaning |
|---|---|
| `control off` | The user hasn't allowed control. |
| `unknown cmd` | `cmd` isn't in the table. |
| `bad position_ms`, `bad value` | Not a number. |
| `bad uri`, `bad playlist_uri` | Not a URI of the right kind (22-character Spotify id). |
| `queue refused`, `add failed` | Spotify refused the request. |
| `no pinned playlist` | `add_to_playlist` without `playlist_uri`, and nothing is pinned. |
| `not an editable playlist` | The user can't add to that playlist. |
| `unknown what` | A `get` with a `what` not in the list. |

Any other text is an error message from Spotify itself, cut to 200 characters. A request without a valid `id` gets its `ack` with `id: ""`.

## Example session

`→` is your app receiving, `←` your app sending.

```
→ {"v":1,"type":"hello","app":"spotiflux","version":"2.0.0","spotify_version":"1.3.4.258","control_allowed":false}
← {"v":1,"type":"hello","app":"GIGAPLAY","version":"0.1.0"}
→ {"v":1,"type":"state","playing":true,"uri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b","title":"夜に駆ける","artists":["YOASOBI"],"album":"THE BOOK","album_uri":"spotify:album:…","cover_url":"https://i.scdn.co/image/…","duration_ms":261013,"position_ms":11870,"at_epoch_ms":1791570202949,"volume":0.64,"shuffle":false,"repeat":"off","context_uri":"spotify:playlist:…","context_name":"j-pop"}
→ {"v":1,"type":"lyrics","uri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b","source":"spotify","synced":true,"language":"ja","lines":[{"start_ms":0,"text":""},{"start_ms":12340,"text":"沈むように溶けてゆくように"}]}
→ {"v":1,"type":"line","uri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b","index":1,"start_ms":12340}
→ {"v":1,"type":"lyrics", … the same lines, now with "translation" and "pronunciation" …}
← {"v":1,"type":"cmd","id":"r1","cmd":"toggle"}
→ {"v":1,"type":"ack","id":"r1","ok":false,"error":"control off"}
← {"v":1,"type":"get","id":"r2","what":"queue"}
→ {"v":1,"type":"queue","id":"r2","current":{…},"next":[…]}
```

`bridge/fixtures/` has one complete example of every message.

## Security model

- **Localhost only.** spotiflux only ever connects to `127.0.0.1`. Your server should bind `127.0.0.1`, never `0.0.0.0`, so nothing on the network can reach it.
- **Read-only by default.** Commands are refused with `control off` until the user ticks "allow control" in spotiflux's settings. The `hello` message's `control_allowed` tells your app which state it's in.
- **No secrets.** Nothing from spotiflux's settings is sent, above all not the user's Gemini key.
- **Any local program can listen.** spotiflux can't tell your app from another program that took the port first, so what plays is readable by any program the user runs. That's why control stays off by default and why the user can switch the bridge off.
- **Refuse web pages.** Check the `Origin` header as described above, so a web page in a browser can't pose as spotiflux and feed your app false data.

## Using it from GIGAPLAY

GIGAPLAY (Tauri, Rust) can take the crate as a git dependency. In `src-tauri/Cargo.toml`:

```toml
[dependencies]
spotiflux-bridge = { git = "https://github.com/gigacook/spotiflux", package = "spotiflux-bridge" }
```

In the Tauri `setup` hook, start the server and forward events to the frontend, one Tauri event per message type, in gp-protocol's style (`gp://` names, units in field names, serde types shared with the frontend). Name them `spotiflux_*`, not `spotify_*`, so they don't mix with GIGAPLAY's own Spotify provider, and add the names to gp-protocol's event and command lists so its contract test still passes.

```rust
use spotiflux_bridge::{Bridge, Event, Outgoing, DEFAULT_PORT};
use tauri::{Emitter, Manager};

.setup(|app| {
    let handle = app.handle().clone();
    // A taken port must not stop GIGAPLAY from starting: report it and carry on.
    match Bridge::listen(DEFAULT_PORT, "GIGAPLAY", env!("CARGO_PKG_VERSION")) {
        Ok((bridge, events)) => {
            app.manage(bridge); // commands use it: bridge.send_cmd(Cmd::Toggle, Duration::from_secs(2))
            std::thread::spawn(move || {
                for event in events {
                    let _ = match event {
                        Event::Message(Outgoing::State(s)) => handle.emit("gp://spotiflux_state", s),
                        Event::Message(Outgoing::Lyrics(l)) => handle.emit("gp://spotiflux_lyrics", l),
                        Event::Message(Outgoing::Line(l)) => handle.emit("gp://spotiflux_line", l),
                        Event::Message(Outgoing::Hello(h)) => handle.emit("gp://spotiflux_status", Some(h)),
                        Event::Disconnected => handle.emit("gp://spotiflux_status", None::<()>),
                        _ => Ok(()),
                    };
                }
            });
        }
        Err(e) => { let _ = handle.emit("gp://spotiflux_status_error", e.to_string()); }
    }
    Ok(())
})
```

`Bridge::listen` fails if another program already uses the port; show that to the user rather than retrying silently. `State::position_ms_at(now_epoch_ms)` gives the interpolated position for a visualiser or lyric overlay, and `Lyrics::line_at(position_ms)` finds a line without waiting for `line` messages (without the user's sync offset). The protocol types need `ts-rs` derives on GIGAPLAY's side if its frontend wants generated TypeScript types; mirror them in gp-protocol rather than adding ts-rs to this crate.

## Using it from C# or WinUI

.NET needs no extra packages. Run an `HttpListener` on `http://localhost:47474/` (it answers on 127.0.0.1), accept the WebSocket, and parse each text frame with `System.Text.Json`:

```csharp
var http = new HttpListener();
http.Prefixes.Add("http://localhost:47474/");
http.Start();
while (true) {
    var ctx = await http.GetContextAsync();
    var origin = ctx.Request.Headers["Origin"];
    if (!ctx.Request.IsWebSocketRequest || (origin != null && !(origin == "https://spotify.com" || (origin.StartsWith("https://") && origin.EndsWith(".spotify.com"))))) {
        ctx.Response.StatusCode = 403; ctx.Response.Close(); continue;
    }
    var ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket;
    await ws.SendAsync(Encoding.UTF8.GetBytes("{\"v\":1,\"type\":\"hello\",\"app\":\"MyWidget\",\"version\":\"1.0\"}"),
        WebSocketMessageType.Text, true, default);
    var buf = new byte[1 << 20];
    while (ws.State == WebSocketState.Open) {
        var r = await ws.ReceiveAsync(buf, default);   // frames from spotiflux are small; loop on EndOfMessage for safety
        using var doc = JsonDocument.Parse(buf.AsMemory(0, r.Count));
        if (doc.RootElement.GetProperty("v").GetInt32() != 1) continue;
        switch (doc.RootElement.GetProperty("type").GetString()) {
            case "state": /* title, position_ms, at_epoch_ms … */ break;
            case "line":  /* index */ break;
        }
    }
}
```

Use the `localhost` prefix: Windows lets normal users listen on it, while other prefixes need a URL reservation (`netsh http add urlacl`) or administrator rights. The same JSON works with `ClientWebSocket` in tests that pretend to be spotiflux.
