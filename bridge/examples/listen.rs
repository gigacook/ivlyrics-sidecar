//! Try the bridge: `cargo run --example listen [port]` in `bridge/`.
//!
//! Prints every event from spotiflux on one line, and reads commands from stdin:
//!   toggle | play | pause | next | prev | seek <ms> | volume <0..1>
//!   queue <spotify:track:…> | add [spotify:playlist:…] | get state|lyrics|queue | quit
//! Commands only work when "allow control" is on in spotiflux's settings;
//! otherwise the answer is `ack ok=false error=control off`.

use spotiflux_bridge::*;
use std::io::BufRead;
use std::time::Duration;

fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
}

fn main() -> std::io::Result<()> {
    let port = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let (bridge, events) = Bridge::listen(port, "spotiflux-listen", env!("CARGO_PKG_VERSION"))?;
    println!("listening on ws://{}  (type a command, or quit)", bridge.local_addr());

    let b = bridge.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let mut words = line.split_whitespace();
            let (Some(word), arg) = (words.next(), words.next()) else { continue };
            let wait = Duration::from_secs(5);
            let cmd = match (word, arg) {
                ("quit", _) => std::process::exit(0),
                ("get", Some(what)) => {
                    let what = match what {
                        "state" => What::State,
                        "lyrics" => What::Lyrics,
                        "queue" => What::Queue,
                        _ => { println!("get state|lyrics|queue"); continue; }
                    };
                    match b.get(what, wait) {
                        Ok(reply) => println!("reply  {}", encode(&reply)),
                        Err(e) => println!("error  {e}"),
                    }
                    continue;
                }
                ("toggle", _) => Cmd::Toggle,
                ("play", _) => Cmd::Play,
                ("pause", _) => Cmd::Pause,
                ("next", _) => Cmd::Next,
                ("prev", _) => Cmd::Prev,
                ("seek", Some(ms)) if ms.parse::<u64>().is_ok() => Cmd::Seek { position_ms: ms.parse().unwrap() },
                ("volume", Some(v)) if v.parse::<f64>().is_ok() => Cmd::Volume { value: v.parse().unwrap() },
                ("queue", Some(uri)) => Cmd::QueueNext { uri: uri.into() },
                ("add", uri) => Cmd::AddToPlaylist { playlist_uri: uri.map(Into::into) },
                _ => { println!("? toggle play pause next prev | seek <ms> | volume <0..1> | queue <uri> | add [playlist uri] | get state|lyrics|queue | quit"); continue; }
            };
            match b.send_cmd(cmd, wait) {
                Ok(ack) => println!("ack    ok={} {}", ack.ok, ack.error.map(|e| format!("error={e}")).unwrap_or_default()),
                Err(e) => println!("error  {e}"),
            }
        }
    });

    let mut lyrics: Option<Lyrics> = None;
    for event in events {
        match event {
            Event::Connected => println!("connected"),
            Event::Disconnected => println!("disconnected"),
            Event::Rejected { origin } => println!("refused a web page from {origin}"),
            Event::Message(Outgoing::Hello(h)) => {
                println!("hello  {} {} on Spotify {}  control {}", h.app, h.version, h.spotify_version, if h.control_allowed { "allowed" } else { "off" })
            }
            Event::Message(Outgoing::State(s)) => println!(
                "state  {} {} - {}  {}/{}  vol {:.0}%",
                if s.playing { "▶" } else { "❚❚" },
                s.artists.join(", "),
                s.title,
                clock(s.position_ms_now()),
                clock(s.duration_ms),
                s.volume * 100.0
            ),
            Event::Message(Outgoing::Lyrics(l)) => {
                let translated = l.lines.iter().filter(|x| x.translation.is_some()).count();
                println!("lyrics {:?} synced={} lang={} {} lines, {} translated", l.source, l.synced, l.language, l.lines.len(), translated);
                lyrics = Some(l);
            }
            Event::Message(Outgoing::Line(x)) => {
                let line = lyrics.as_ref().filter(|l| l.uri == x.uri).and_then(|l| usize::try_from(x.index).ok().and_then(|i| l.lines.get(i)));
                match line {
                    Some(l) => println!("line   {:>3} [{}] {}{}", x.index, clock(x.start_ms), l.text, l.translation.as_ref().map(|t| format!("  /  {t}")).unwrap_or_default()),
                    None => println!("line   {:>3}", x.index),
                }
            }
            Event::Message(other) => println!("other  {}", encode(&other)),
        }
    }
    Ok(())
}
