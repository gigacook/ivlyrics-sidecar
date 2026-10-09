// spotiflux — Spicetify extension: a fullscreen deck inside Spotify, and a
// local WebSocket bridge that sends Spotify out to native apps.
//
// Layout: library pane | player | queue pane over our own deck
// (#spotiflux-deck, body.ivlib-fs). Both panes take the same slice of the
// window so the centred player is never covered. The current lyric line shows
// in a box above the player (own lyrics: Spotify's, else LRCLIB; translation
// and pronunciation from Gemini with the user's key).
//
// Bridge: client to ws://127.0.0.1:<port> (default 47474), protocol
// spotiflux-bridge v1 (docs/bridge.md). Read-only unless "allow control" is on.
//
// Keys (one dispatcher, onKey): Space play/pause and , / . 10 s back / forward
// anywhere (not mid-text in a text box); Esc back to just
// the player; F12 is swallowed; Ctrl+Backspace leaves fullscreen (also the
// "ctrl+⌫ exit" label at the bottom middle);
// Ctrl+A snaps to the library (queue closed), Ctrl+E to the queue (library
// closed); already there = no change;
// ← / → move focus between library, middle and queue: entering a side opens
// it, leaving it back to the middle closes it; ↑ / ↓ move the selection in
// the focused pane; Enter goes one level in or plays; Backspace goes one level
// back (closing the pane at the top). Clicks only select; double-click = Enter.
// C in the queue pane clears what you queued yourself.
// Mouse wheel over the player = volume, 10 per notch in steps of 2 (100 at Spotify start).
// Shift+, / Shift+. volume up / down anywhere (6 at once, holding ramps 2 → 6).
// Ctrl+Shift (fullscreen): S adds the song to the pinned playlist (asks first;
// no pin yet = picker), A picks / changes the pinned playlist, H help with
// command search, L lyric box on/off, T translation on/off, P pronunciation on/off.
// None of these reuse an existing key, ours or Spotify's (Ctrl+S is its shuffle).
//
// Library: playlists open in place, newest tracks first; after a minute away
// it reopens on the playing playlist; q queues a track next;
// "back.." jumps to what's playing; search widens on Y / Enter / Tab from this
// view to all playlists to Spotify. Queue: up next, plus album / artist views
// from the title, album and artist links and the cover's right-click menu.
// Also: per-track sync offset dialog (gear by the lyric box), hidden window
// buttons until hovered, and window.ivlib.launch() for playlist-home.
//
// Storage keys and CSS ids keep their old ivlyrics-sidecar prefixes (ivlib:,
// ivlyr:, ivsync:, ivhint:, #iv…) so existing users keep their state; new
// keys use the spotiflux: prefix.
(function spotiflux() {
  if (!window.Spicetify?.Platform?.LibraryAPI || !Spicetify.Player || !document.body) {
    setTimeout(spotiflux, 300);
    return;
  }

  const VERSION = "2.0.0";
  const STORE_OPEN = "ivlib:open";
  const PANEL_W = 300;
  const TYPE_LABEL = { playlist: "Playlist", album: "Album", artist: "Artist", show: "Podcast", folder: "Folder", collection: "Liked", track: "Song" };

  const state = {
    open: localStorage.getItem(STORE_OPEN) === "1",
    stack: [],             // [{ kind: "folder"|"tracks", uri, name, type }] drill-down path
    items: [],
    sel: -1,          // selected (clicked) row in the library list
    focusNow: false,  // after "back..": scroll to the playing track
    hiddenAt: 0,      // when the library was last closed or left with fullscreen
  };

  // ---------- styles ----------
  const style = document.createElement("style");
  style.id = "ivlib-style";
  style.textContent = `
    /* Shared pane backdrop: the average of the old library (.55, 24px) and queue (none) looks. */
    :root { --ivpane-bg: rgba(10,10,12,.28); --ivpane-blur: blur(12px) saturate(1.1); }
    :root { --ivlib-w: ${PANEL_W}px; --ivmono: "JetBrains Mono", "JetBrainsMono Nerd Font", Consolas, monospace; }
    :is(#ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg, #ivlib-tab) { font-family: var(--ivmono) !important; }
    :is(#ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg) :is(input, button) { font-family: inherit; }
    #ivlib-root { display: none; }
    body.ivlib-fs #ivlib-root { display: block; }
    /* Steel grips on both edges: brushed steel, rivets, grip ridges, so it's
       obvious the panes slide out. They ride on the pane edge when open. */
    .ivgrip {
      position: fixed; top: 50%; transform: translateY(-50%); z-index: 2147483647;
      width: 14px; height: 88px; border: 0; padding: 0; cursor: pointer; opacity: .55;
      background:
        radial-gradient(circle at 50% 9px, #e9edf1 0 1.6px, #50555c 2.2px, transparent 2.8px),
        radial-gradient(circle at 50% calc(100% - 9px), #e9edf1 0 1.6px, #50555c 2.2px, transparent 2.8px),
        repeating-linear-gradient(180deg, transparent 0 5px, rgba(0,0,0,.35) 5px 6px, rgba(255,255,255,.18) 6px 7px) 0 22px / 100% calc(100% - 44px) no-repeat,
        linear-gradient(90deg, #3a3e44, #9aa1a9 30%, #d5dadf 50%, #8a9097 70%, #33373c);
      box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 2px 10px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.12);
      transition: left .22s ease, right .22s ease, opacity .15s ease;
    }
    .ivgrip:hover { opacity: 1; }
    #ivlib-tab { left: 0; border-radius: 0 6px 6px 0; }
    #ivnext-tab { right: 0; border-radius: 6px 0 0 6px; }
    body.ivlib-open #ivlib-tab { left: var(--ivlib-w); }
    body.ivnext-open #ivnext-tab { right: var(--ivnext-w); }
    #ivlib-panel {
      position: fixed; left: 0; top: 0; bottom: 0; width: var(--ivlib-w);
      z-index: 2147483646; box-sizing: border-box; padding: 48px 8px 10px;
      display: flex; flex-direction: column; gap: 8px;
      background: var(--ivpane-bg); backdrop-filter: var(--ivpane-blur);
      border-right: 1px solid rgba(255,255,255,.06);
      transform: translateX(-100%); transition: transform .22s ease;
      font-family: var(--ivmono); color: #fff;
    }
    body.ivlib-open #ivlib-panel { transform: none; }
    /* Ctrl+A / Ctrl+E snap: panes and grips jump almost instantly. */
    body.ivsnap :is(#ivlib-panel, #ivnext-panel, .ivgrip, .ivedge) { transition-duration: .04s !important; }
    .ivlib-head { display: flex; align-items: center; gap: 6px; padding: 0 4px; }
    .ivlib-head[hidden] { display: none; }
    .ivlib-title { font-size: 13px; font-weight: 700; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ivlib-btn {
      border: 0; background: rgba(255,255,255,.08); color: #fff; border-radius: 6px;
      font-size: 11px; padding: 3px 8px; cursor: pointer;
    }
    .ivlib-btn:hover { background: rgba(255,255,255,.18); }
    .ivlib-searchwrap { position: relative; }
    #ivlib-search {
      width: 100%; box-sizing: border-box; border: 0; outline: 0; border-radius: 8px;
      padding: 7px 10px; font-size: 12px; color: #fff; background: rgba(255,255,255,.1);
    }
    #ivlib-search:focus { background: rgba(255,255,255,.16); }
    .ivlib-row.ivlib-widen { min-height: 0; padding: 8px; font-size: 12px; opacity: .8; display: block; }
    .ivlib-key { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.14); margin-left: 4px; }
    .ivlib-section { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; opacity: .5; padding: 6px 6px 2px; }
    .ivlib-list { flex: 1; overflow-y: auto; scrollbar-width: thin; }
    .ivlib-row {
      display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px;
      cursor: pointer; min-height: 36px;
    }
    /* Playing = neon signal yellow; selection = violet. */
    :root { --ivplay: #eaff3d; --ivplay-glow: rgba(234,255,61,.45); --ivsel: rgba(80,45,128,.22); --ivsel-edge: rgba(150,100,220,.7); }
    .ivlib-row:hover { background: rgba(255,255,255,.08); }
    .ivlib-row.active { background: var(--ivsel); box-shadow: inset 2px 0 0 var(--ivsel-edge); }
    .ivlib-row.playing .ivlib-name { color: var(--ivplay); text-shadow: 0 0 8px var(--ivplay-glow); }
    /* Browsing: selected row, and a hover chip that queues the track next. */
    #ivlib-list .ivlib-row.sel { background: var(--ivsel); box-shadow: inset 2px 0 0 var(--ivsel-edge); }
    .ivlib-q {
      display: none; flex: none; font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 4px;
      color: #ffd666; background: rgba(255,214,102,.14); cursor: pointer;
    }
    .ivlib-q:hover { background: rgba(255,214,102,.3); }
    #ivlib-list .ivlib-trow:hover .ivlib-q { display: inline-block; }
    #ivlib-list .ivlib-trow:hover .ivlib-date { display: none; }
    #ivlib-list .ivlib-row.queued .ivlib-q { display: inline-block; background: rgba(255,214,102,.35); }
    #ivlib-now { font-size: 11px !important; letter-spacing: .02em; }
    /* User-queued songs in the right pane: "u" marker, faint yellow glow. */
    #ivnext-list .ivlib-row.userq .ivlib-name { color: #ffe9a8; text-shadow: 0 0 6px rgba(255,214,102,.35); }
    .ivlib-u { display: inline-block; width: 1.4em; color: #ffd666; font-weight: 700; text-shadow: 0 0 6px rgba(255,214,102,.6); }
    .ivlib-img {
      width: 32px; height: 32px; border-radius: 4px; flex: none; object-fit: cover;
      background: rgba(255,255,255,.08); display: grid; place-items: center; font-size: 14px;
    }
    .ivlib-img.round { border-radius: 50%; }
    .ivlib-txt { min-width: 0; flex: 1; }
    .ivlib-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ivlib-sub { font-size: 10.5px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ivlib-empty { font-size: 12px; opacity: .5; padding: 10px 6px; }
    .ivlib-row.ivlib-trow { min-height: 0; padding: 4px 8px; gap: 10px; }
    .ivlib-trow .ivlib-name { flex: 1; min-width: 0; font-weight: 500; }
    .ivlib-date { flex: none; max-width: 40%; font-size: 10.5px; opacity: .5; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Stray corner chrome found at runtime (see hideCornerChrome). */
    body.ivlib-fs .ivlib-corner-hide { visibility: hidden !important; }

    /* ---- right pane: tracks around the current one ---- */
    /* The list fills the shared band (--ivnext-top/bottom, set by layout()):
       at least 33%–66% of the height, stretched to the album column if taller. */
    /* Slides in from the right, mirroring the library pane. */
    #ivnext-panel {
      position: fixed; right: 0; top: 0; bottom: 0; width: var(--ivnext-w, 50vw);
      z-index: 2147483645; color: #fff; pointer-events: none;
      font-family: var(--ivmono);
      background: var(--ivpane-bg); backdrop-filter: var(--ivpane-blur);
      border-left: 1px solid rgba(255,255,255,.06);
      transform: translateX(100%); transition: transform .22s ease;
    }
    body.ivnext-open #ivnext-panel { transform: none; }
    body:not(.ivnext-open) #ivnext-list { pointer-events: none !important; }
    #ivnext-list {
      position: absolute; left: 28px; right: 24px; padding: 6px 0; pointer-events: auto;
      top: var(--ivnext-top, 33vh); bottom: var(--ivnext-bottom, 34vh);
      overflow-y: auto; scrollbar-width: none;
      mask-image: linear-gradient(transparent, #000 6%, #000 94%, transparent);
    }
    /* Column divider: zipper teeth, a small cog in the gap, faded like smoke. */
    #ivnext-divider {
      position: fixed; left: calc(100vw - var(--ivnext-w, 50vw)); width: 12px; transform: translateX(-50%);
      z-index: 2147483644;
      top: calc(var(--ivnext-top, 33vh) - 48px); bottom: calc(var(--ivnext-bottom, 34vh) - 48px);
      opacity: .11; filter: blur(.25px); pointer-events: none;
    }
    #ivnext-divider .zip {
      position: absolute; inset: 0;
      background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8'><rect x='1.5' y='.5' width='4.5' height='3' rx='1' fill='white'/><rect x='6' y='4.5' width='4.5' height='3' rx='1' fill='white'/><line x1='6' y1='0' x2='6' y2='8' stroke='white' stroke-width='.4'/></svg>") center top / 12px 8px repeat-y;
      mask-image: linear-gradient(transparent, #000 22%, #000 calc(50% - 16px), transparent calc(50% - 16px),
        transparent calc(50% + 16px), #000 calc(50% + 16px), #000 78%, transparent);
    }
    /* Divider marks the queue pane's inner edge, so only while it's open. */
    #ivnext-divider { display: none; }
    body.ivlib-fs.ivnext-open #ivnext-divider { display: block; }
    #ivnext-divider .cog { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; transform: translate(-50%, -50%); }
    #ivnext-list .ivlib-row { opacity: .6; }
    #ivnext-list .ivlib-row:hover { opacity: 1; }
    #ivnext-list .ivlib-row.current { opacity: 1; background: rgba(255,255,255,.1); }
    #ivnext-list .ivlib-row.current .ivlib-name { color: var(--ivplay); text-shadow: 0 0 8px var(--ivplay-glow); }
    #ivnext-list .ivlib-name { font-size: 13px; }
    /* Album-cover right-click menu. */
    #ivlib-ctx {
      position: fixed; z-index: 2147483647; min-width: 200px; max-width: 280px; padding: 4px;
      border-radius: 8px; background: rgba(24,24,28,.97); box-shadow: 0 10px 30px rgba(0,0,0,.5);
      color: #fff; font-size: 12.5px; font-family: var(--ivmono);
    }
    #ivlib-ctx[hidden] { display: none; }
    .ivlib-ctx-item { padding: 7px 10px; border-radius: 5px; cursor: pointer; display: flex; justify-content: space-between; gap: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ivlib-ctx-item:hover, .ivlib-ctx-item.active { background: rgba(255,255,255,.1); }
    .ivlib-ctx-item.disabled { opacity: .4; pointer-events: none; }
    .ivlib-ctx-list { max-height: 45vh; overflow-y: auto; scrollbar-width: thin; }
    #ivlib-ctx input {
      width: 100%; box-sizing: border-box; border: 0; outline: 0; border-radius: 6px; padding: 6px 8px;
      margin-bottom: 4px; font-size: 12px; color: #fff; background: rgba(255,255,255,.1);
    }

    /* Right pane breadcrumb + album view. */
    #ivnext-crumb, #ivnext-hint {
      position: absolute; left: 36px; right: 24px; font-size: 11px; letter-spacing: .06em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff;
    }
    #ivnext-crumb { top: calc(var(--ivnext-top, 33vh) - 30px); text-transform: lowercase; opacity: .5; }
    #ivnext-hint { bottom: calc(var(--ivnext-bottom, 34vh) - 28px); opacity: .3; }

    /* Library header: path like /all/techno/dj between big back / play buttons. */
    #ivlib-title {
      font-size: 12px; font-weight: 700; letter-spacing: .03em; color: #fff; white-space: nowrap; overflow: hidden;
      text-shadow: 0 0 1px #fff, 0 0 6px rgba(255,255,255,.55), 0 0 14px rgba(255,255,255,.25);
    }
    #ivlib-head .ivlib-btn { font-size: 15px; line-height: 1; min-width: 30px; height: 28px; padding: 0 8px; border-radius: 7px; }
    #ivlib-head :is(.ivlib-btn, .ivlib-hk)[hidden] { display: none; }
    /* Key hints, no box: "← ⌫" goes up, "→ ent" goes in. Clickable too. */
    .ivlib-hk {
      flex: none; border: 0; background: none; color: #fff; padding: 0 2px; cursor: pointer;
      display: inline-flex; align-items: baseline; gap: 3px; opacity: .55; font-family: inherit;
    }
    .ivlib-hk b { font-size: 15px; font-weight: 800; text-shadow: 0 0 6px rgba(255,255,255,.45); }
    .ivlib-hk span { font-size: 9.5px; letter-spacing: .04em; opacity: .8; }
    .ivlib-hk:hover { opacity: 1; }
    .ivnext-album-head { display: flex; gap: 12px; align-items: center; padding: 4px 8px 10px; }
    .ivnext-album-head img { width: 64px; height: 64px; border-radius: 4px; object-fit: cover; flex: none; }
    .ivnext-album-title { font-size: 14px; font-weight: 700; }
    .ivnext-album-sub { font-size: 11px; opacity: .55; margin-top: 2px; }
    .ivlib-num { flex: none; width: 18px; text-align: right; font-size: 11px; opacity: .45; font-variant-numeric: tabular-nums; }
    /* Sync gear: right of the lyric box, invisible until the pointer is near it. */
    #ivsync-gear {
      position: fixed; z-index: 2147483646; width: 18px; height: 18px; padding: 3px; margin: -9px 0 0 0;
      border: 0; border-radius: 50%; background: transparent; color: #fff; cursor: pointer;
      opacity: 0; pointer-events: none; transition: opacity .25s ease, background .15s;
    }
    body.ivlib-fs.ivsync-hot #ivsync-gear { opacity: .22; pointer-events: auto; }
    body.ivlib-fs #ivsync-gear:hover, body.ivsync-open #ivsync-gear { opacity: .85; pointer-events: auto; background: rgba(255,255,255,.08); }
    body.ivlib-fs.ivlib-nolyrics #ivsync-gear { display: none; }
    #ivsync-gear svg { width: 100%; height: 100%; display: block; }

    /* Sync dialog, opening below the gear. */
    #ivsync-dlg {
      position: fixed; z-index: 2147483647; width: 236px; padding: 12px; box-sizing: border-box;
      left: var(--ivsync-x, 50vw); top: var(--ivsync-y, 30vh);
      border-radius: 10px; background: rgba(20,20,24,.96); box-shadow: 0 14px 40px rgba(0,0,0,.55);
      color: #fff; font-family: var(--ivmono); font-size: 12px;
      display: none;
    }
    body.ivlib-fs.ivsync-open #ivsync-dlg { display: block; }
    .ivsync-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .5; display: flex; justify-content: space-between; gap: 8px; }
    .ivsync-title span { text-transform: none; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
    .ivsync-readout { font-size: 26px; font-weight: 700; text-align: center; margin: 10px 0 2px; font-variant-numeric: tabular-nums; }
    .ivsync-tell { text-align: center; font-size: 11px; opacity: .7; }
    #ivsync-dlg[data-dir="earlier"] :is(.ivsync-readout, .ivsync-tell) { color: #7fd8ff; }
    #ivsync-dlg[data-dir="later"] :is(.ivsync-readout, .ivsync-tell) { color: #ffc46b; }
    .ivsync-meter { position: relative; height: 4px; margin: 10px 0 12px; border-radius: 2px; background: rgba(255,255,255,.1); }
    .ivsync-meter i { position: absolute; top: 0; bottom: 0; border-radius: 2px; transition: width .15s ease; }
    #ivsync-dlg[data-dir="earlier"] .ivsync-meter i { background: #7fd8ff; }
    #ivsync-dlg[data-dir="later"] .ivsync-meter i { background: #ffc46b; }
    .ivsync-meter b { position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: rgba(255,255,255,.5); }
    .ivsync-row { display: flex; gap: 8px; }
    .ivsync-btn {
      flex: 1; border: 0; border-radius: 8px; padding: 8px 0 6px; cursor: pointer; color: #fff;
      background: rgba(255,255,255,.09); font-size: 16px; font-weight: 700; display: flex; flex-direction: column; align-items: center;
    }
    .ivsync-btn small { font-size: 10px; font-weight: 400; opacity: .6; }
    .ivsync-btn:hover { background: rgba(255,255,255,.17); }
    .ivsync-steps { display: flex; gap: 4px; margin-top: 8px; }
    .ivsync-step { flex: 1; border: 0; border-radius: 5px; padding: 4px 0; cursor: pointer; font-size: 10.5px; color: #fff; background: rgba(255,255,255,.06); }
    .ivsync-step.on { background: rgba(255,255,255,.28); font-weight: 700; }
    .ivsync-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 10.5px; opacity: .55; }
    .ivsync-reset { border: 0; background: none; color: inherit; cursor: pointer; text-decoration: underline; padding: 0; font-size: inherit; }
    @keyframes ivsync-kick-earlier { 0% { transform: translateX(0); } 35% { transform: translateX(-10px); } 100% { transform: translateX(0); } }
    @keyframes ivsync-kick-later { 0% { transform: translateX(0); } 35% { transform: translateX(10px); } 100% { transform: translateX(0); } }
    .ivsync-readout.kick-earlier { animation: ivsync-kick-earlier .18s ease-out; }
    .ivsync-readout.kick-later { animation: ivsync-kick-later .18s ease-out; }
    /* Lyric box: the current line only, between the panes, above the player.
       English: the line alone. Other languages: tiny original + translation,
       packed with no gap. */
    #ivlyr-box {
      position: fixed; z-index: 2147483640; left: 50vw; transform: translateX(-50%);
      width: var(--ivlyr-w, 40vw); top: 40px; bottom: var(--ivlyr-bottom, 70vh);
      display: none; flex-direction: column; justify-content: center; align-items: center;
      text-align: center; overflow: hidden; pointer-events: none; color: #fff; font-family: var(--ivmono);
      text-shadow: 0 0 2px rgba(0,0,0,.8), 0 0 12px rgba(0,0,0,.55);
    }
    body.ivlib-fs #ivlyr-box { display: flex; }
    #ivlyr-box > div { margin: 0; overflow-wrap: anywhere; }
    #ivlyr-box .o { font-size: 19px; font-weight: 700; line-height: 1.3; }
    #ivlyr-box.dual .o { font-size: 10.5px; font-weight: 500; line-height: 1.15; opacity: .75; letter-spacing: -.01em; }
    #ivlyr-box.dual .t { font-size: 14px; font-weight: 700; line-height: 1.15; letter-spacing: -.01em; }
    #ivlyr-box .p { font-size: 10.5px; font-style: italic; line-height: 1.2; opacity: .7; }
    body.ivlyr-off :is(#ivlyr-box, #ivsync-gear) { display: none !important; }
    /* Bottom middle, over the exit label: lyric box state + help, both clickable. */
    #ivstate { bottom: 32px; left: 50vw; transform: translateX(-50%); pointer-events: auto; white-space: nowrap; -webkit-app-region: no-drag; }
    #ivstate span { cursor: pointer; }
    #ivstate span:hover { opacity: .8; }
    #ivstate #ivlyr-tog::before { content: "● "; color: var(--ivplay); }
    body.ivlyr-off #ivstate #ivlyr-tog::before { content: "○ "; color: inherit; }

    /* Add-to-playlist confirm: a terminal-style row with a blinking block cursor. */
    .ivconfirm { padding: 8px 10px; font-size: 13px; }
    .ivconfirm b { color: var(--ivplay); font-weight: 700; }
    .ivconfirm small { display: block; font-size: 10.5px; opacity: .5; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ivcur { display: inline-block; width: .6em; height: 1.05em; margin-left: 4px; vertical-align: -2px; background: #fff; animation: ivcur 1.06s steps(1, end) infinite; }
    @keyframes ivcur { 50% { opacity: 0; } }
    .ivlib-ctx-hint { font-size: 10px; opacity: .45; padding: 5px 10px 3px; white-space: nowrap; }

    /* Help (Ctrl+Shift+H): command search over a keyboard whose keys light up. */
    #ivhelp { position: fixed; inset: 0; z-index: 2147483647; display: none; place-items: center; background: rgba(0,0,0,.55); backdrop-filter: blur(6px); }
    body.ivhelp-open #ivhelp { display: grid; }
    .ivhelp-box {
      width: min(780px, 92vw); max-height: 88vh; display: flex; flex-direction: column; gap: 10px; padding: 16px; box-sizing: border-box;
      border-radius: 12px; background: rgba(20,20,24,.97); box-shadow: 0 20px 60px rgba(0,0,0,.6); color: #fff; font-family: var(--ivmono);
    }
    .ivhelp-box input {
      border: 0; outline: 0; border-radius: 8px; padding: 9px 12px; font: 13px var(--ivmono); color: #fff; background: rgba(255,255,255,.1);
    }
    .ivkb { display: flex; flex-direction: column; gap: 4px; align-items: center; user-select: none; }
    .ivkb div { display: flex; gap: 4px; }
    .ivkb b {
      min-width: 26px; height: 24px; padding: 0 5px; box-sizing: border-box; display: grid; place-items: center; border-radius: 5px;
      font-size: 10px; font-weight: 600; color: rgba(255,255,255,.45); background: rgba(255,255,255,.05); box-shadow: inset 0 -2px 0 rgba(0,0,0,.4);
      transition: background .12s, color .12s, box-shadow .12s;
    }
    .ivkb b.hit { color: #fff; background: rgba(150,100,220,.35); }
    .ivkb b.on { color: #111; background: var(--ivplay); box-shadow: 0 0 12px var(--ivplay-glow); }
    .ivhelp-list { overflow-y: auto; scrollbar-width: thin; min-height: 120px; }
    .ivhelp-row { display: grid; grid-template-columns: 150px 1fr auto; gap: 12px; padding: 5px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .ivhelp-row:hover { background: rgba(255,255,255,.06); }
    .ivhelp-row.active { background: var(--ivsel); box-shadow: inset 2px 0 0 var(--ivsel-edge); }
    .ivhelp-row kbd { font: 700 11px var(--ivmono); color: #ffd666; }
    .ivhelp-row i { font-style: normal; font-size: 10.5px; opacity: .45; white-space: nowrap; }
    .ivhelp-row em { font-style: normal; font-size: 10px; color: var(--ivplay); opacity: .8; }
    .ivhelp-foot { font-size: 10px; opacity: .4; text-align: center; }
    #ivlyr-box.in > div { animation: ivlyr-in .14s ease-out; }
    @keyframes ivlyr-in { from { opacity: 0; transform: translateY(3px); } }

    /* Focus: the focused pane gets a soft glowing line on its inner edge; the
       other pane's selection dims. The middle shows the caret instead. */
    #ivlib-panel::after, #ivnext-panel::after {
      content: ""; position: absolute; top: 0; bottom: 0; width: 2px; opacity: 0; pointer-events: none;
      background: linear-gradient(transparent, rgba(255,255,255,.55) 25%, rgba(255,255,255,.55) 75%, transparent);
      box-shadow: 0 0 8px rgba(255,255,255,.35); transition: opacity .15s ease;
    }
    #ivlib-panel::after { right: -1px; }
    #ivnext-panel::after { left: 0; }
    body.ivfocus-left #ivlib-panel::after, body.ivfocus-right #ivnext-panel::after { opacity: 1; }
    #ivnext-list .ivlib-row.active { background: var(--ivsel); box-shadow: inset 2px 0 0 var(--ivsel-edge); opacity: 1; }
    body:not(.ivfocus-left) #ivlib-list .ivlib-row.sel,
    body:not(.ivfocus-right) #ivnext-list .ivlib-row.active { background: rgba(80,45,128,.1); box-shadow: inset 2px 0 0 rgba(150,100,220,.3); }

    /* Corner guides, all four the same size and contrast: names on top,
       snap keys at the bottom. Each pair hides while its pane is open. */
    .ivedge {
      position: fixed; z-index: 2147483639; font: 600 10.5px var(--ivmono); letter-spacing: .06em;
      color: #fff; opacity: .28; pointer-events: none; transition: opacity .2s ease;
    }
    #ivedge-l, #ivedge-r { top: 14px; }
    #ivexit { bottom: 14px; }
    /* Bottom middle, between the ctrl+a and ctrl+e labels: leaves fullscreen. */
    #ivexit { left: 50vw; transform: translateX(-50%); pointer-events: auto; cursor: pointer; -webkit-app-region: no-drag; }
    #ivexit:hover { opacity: .8; }
    #ivkey-l, #ivkey-r { bottom: 14px; }
    #ivedge-l, #ivkey-l { left: 22px; }
    #ivedge-r, #ivkey-r { right: 22px; }
    body.ivlib-open :is(#ivedge-l, #ivkey-l), body.ivnext-open :is(#ivedge-r, #ivkey-r) { opacity: 0; }

    /* Arrow guide: "lib ◀ ● ▶ que" on one symmetric row at the top middle,
       between the library and queue corner labels, in yellow to stand apart.
       The dot toggles the guide (filled = shown, hollow = hidden) and is the
       middle cursor: while the middle has the focus it blinks white / violet. */
    #ivhint {
      position: fixed; z-index: 2147483641; left: 50vw; top: 11px; width: 240px; height: 20px;
      transform: translateX(-50%); pointer-events: none; display: none;
      font: 700 10.5px var(--ivmono); letter-spacing: .05em; color: #ffd666;
    }
    body.ivlib-fs #ivhint { display: block; }
    #ivhint span {
      position: absolute; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 6px;
      opacity: .85; transition: opacity .2s ease; text-shadow: 0 0 6px rgba(255,214,102,.45);
    }
    #ivhint .lf { right: calc(50% + 12px); }
    #ivhint .rt { left: calc(50% + 12px); }
    #ivhint svg { width: 15px; height: 11px; color: #ffd666; filter: drop-shadow(0 0 3px rgba(255,214,102,.55)); }
    body.ivhint-off #ivhint span { opacity: 0; }
    #ivhint-dot {
      position: absolute; left: 50%; top: 50%; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; padding: 0;
      border-radius: 50%; border: 1.5px solid #fff; background: #fff; box-sizing: border-box;
      cursor: pointer; pointer-events: auto; box-shadow: 0 0 6px rgba(255,255,255,.55); -webkit-app-region: no-drag;
    }
    body.ivhint-off #ivhint-dot { background: transparent; opacity: .4; box-shadow: none; }
    body.ivfocus-mid #ivhint-dot { animation: ivdot 1.06s steps(1, end) infinite; opacity: 1; }
    @keyframes ivdot {
      0% { background: #fff; border-color: #fff; box-shadow: 0 0 6px rgba(255,255,255,.6); }
      50% { background: #a36bff; border-color: #a36bff; box-shadow: 0 0 8px rgba(163,107,255,.75); }
    }

    /* Feedback line at the top of the queue pane: small, selectable. */
    #ivnext-feedback {
      position: absolute; left: 36px; right: 24px; top: calc(var(--ivnext-top, 33vh) - 54px);
      font-size: 10px; letter-spacing: .03em; opacity: .28; color: #fff; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; user-select: text; cursor: text; pointer-events: auto;
    }
    #ivnext-feedback:hover { opacity: .55; }

    /* Volume readout while scrolling. */
    #ivvol {
      position: fixed; z-index: 2147483641; left: 50vw; bottom: 18px; transform: translateX(-50%);
      font: 700 11px var(--ivmono); letter-spacing: .06em; color: #fff; opacity: 0; pointer-events: none;
      text-shadow: 0 0 6px rgba(255,255,255,.4); transition: opacity .35s ease;
    }
    #ivvol.on { opacity: .75; transition: opacity .05s linear; }
    #ivlib-root:has(#ivvol.on) #ivexit { opacity: 0; } /* same spot: the readout wins */

    #ivlyr-box .ld { font-size: 10px; letter-spacing: .06em; opacity: .45; }

    /* The deck: our own fullscreen over the whole window. Blurred, darkened
       cover behind; the player block is placed by layout() (--sfx-top). */
    #spotiflux-deck { position: fixed; inset: 0; z-index: 2147483600; overflow: hidden; background: #000; color: #fff; font-family: var(--ivmono); }
    .sfx-bg { position: absolute; inset: -80px; background: center / cover no-repeat; filter: blur(56px) brightness(.36) saturate(1.25); transition: background-image .4s; }
    #sfx-player {
      position: absolute; left: 50vw; top: var(--sfx-top, 28vh); transform: translateX(-50%); width: var(--sfx-cover, 300px);
      display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
    }
    #sfx-cover { width: var(--sfx-cover, 300px); height: var(--sfx-cover, 300px); border-radius: 6px; object-fit: cover; background: rgba(255,255,255,.06); box-shadow: 0 18px 50px rgba(0,0,0,.55); margin-bottom: 8px; }
    #sfx-cover:not([src]) { visibility: hidden; }
    #sfx-title { font-size: 16px; font-weight: 700; line-height: 1.25; }
    #sfx-artist { font-size: 12.5px; opacity: .8; }
    #sfx-album { font-size: 11px; opacity: .5; }
    .sfx-link { cursor: pointer; max-width: 100%; overflow-wrap: anywhere; }
    .sfx-link:hover { text-decoration: underline; text-underline-offset: 3px; }
    .sfx-prog { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 6px; font-size: 10.5px; opacity: .75; font-variant-numeric: tabular-nums; }
    .sfx-bar { flex: 1; height: 14px; display: flex; align-items: center; cursor: pointer; }
    .sfx-bar::before { content: ""; flex: 1; height: 3px; border-radius: 2px; background: linear-gradient(90deg, #fff var(--sfx-p, 0%), rgba(255,255,255,.2) var(--sfx-p, 0%)); }
    .sfx-bar:hover::before { height: 5px; }
    .sfx-ctl { display: flex; align-items: center; justify-content: center; gap: 14px; }
    .sfx-ctl button { border: 0; background: none; color: #fff; cursor: pointer; padding: 4px; opacity: .7; display: grid; place-items: center; position: relative; }
    .sfx-ctl button:hover { opacity: 1; }
    .sfx-ctl svg { width: 18px; height: 18px; }
    .sfx-ctl #sfx-play { opacity: 1; width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #000; }
    .sfx-ctl #sfx-play svg { width: 16px; height: 16px; }
    .sfx-ctl button.on { color: var(--ivplay); opacity: 1; filter: drop-shadow(0 0 4px var(--ivplay-glow)); }
    .sfx-ctl button[data-one]::after { content: "1"; position: absolute; right: -2px; top: -1px; font-size: 8px; font-weight: 800; }
    .sfx-vol { display: flex; align-items: center; gap: 8px; width: 70%; font-size: 10.5px; opacity: .55; }
    .sfx-vol:hover { opacity: .9; }
    .sfx-vol input { flex: 1; accent-color: #fff; height: 3px; cursor: pointer; }
    .sfx-vol span { width: 3.2em; text-align: right; font-variant-numeric: tabular-nums; }

    /* Settings dialog (profile menu): sync-dialog look, centred over anything. */
    #sfx-settings { position: fixed; inset: 0; z-index: 2147483647; display: none; place-items: center; background: rgba(0,0,0,.5); font-family: var(--ivmono); }
    body.sfx-settings-open #sfx-settings { display: grid; }
    .sfx-set-box { width: min(440px, 92vw); padding: 14px 16px; box-sizing: border-box; border-radius: 10px; background: rgba(20,20,24,.97); box-shadow: 0 14px 40px rgba(0,0,0,.55); color: #fff; font-size: 12px; }
    .sfx-set-box h3 { margin: 12px 0 6px; font-size: 11px; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; opacity: .5; }
    .sfx-set-box h3:first-of-type { margin-top: 2px; }
    .sfx-set-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .sfx-set-row label { flex: none; width: 92px; opacity: .75; }
    .sfx-set-row input[type=text], .sfx-set-row input[type=password], .sfx-set-row input[type=number] {
      flex: 1; min-width: 0; border: 0; outline: 0; border-radius: 6px; padding: 6px 8px; font: 12px var(--ivmono); color: #fff; background: rgba(255,255,255,.1);
    }
    .sfx-set-row input:focus { background: rgba(255,255,255,.16); }
    .sfx-set-row .ivlib-btn, .sfx-set-foot .ivlib-btn { font-family: inherit; }
    .sfx-set-check { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
    .sfx-set-check input { accent-color: var(--ivplay); }
    .sfx-set-note { font-size: 10.5px; opacity: .5; margin: 2px 0 0; line-height: 1.4; }
    #sfx-bridge-status { font-size: 11px; margin: 6px 0 0; color: var(--ivplay); opacity: .85; }
    .sfx-set-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; font-size: 10.5px; opacity: .8; }
    /* Short windows: names only, no artwork or meta line. */
    @media (max-height: 720px) {
      .ivlib-img, .ivlib-sub { display: none; }
      .ivlib-row { min-height: 0; padding: 4px 8px; }
      .ivlib-name { font-weight: 500; }
    }
  `;
  document.head.appendChild(style);

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.id = "ivlib-root";
  // Player-button icons (16 x 16).
  const ICON = {
    shuffle: "M11 2l3 2.5L11 7V5.3H9.6L7.9 7.4 6.8 6l1.5-1.8.4-.5h2.3zM1 4.2h2.6l6 7.1H11V9.7L14 12l-3 2.5v-1.7H9l-6-7.1H1zm0 7.1h2.1l1.7-2 1 1.3-2 2.2H1z",
    prev: "M3 2h2v12H3zm3 6 8-6v12z", next: "M11 2h2v12h-2zM10 8 2 14V2z",
    play: "M4 2l10 6-10 6z", pause: "M3 2h4v12H3zm6 0h4v12H9z",
    repeat: "M3 5h8V3l3 3-3 3V7H5v2.5H3zm10 6H5v2l-3-3 3-3v2h6V6.5h2z",
  };
  const icon = (d) => `<svg viewBox="0 0 16 16" fill="currentColor"><path d="${d}"/></svg>`;
  root.innerHTML = `
    <div id="spotiflux-deck">
      <div class="sfx-bg" id="sfx-bg"></div>
      <div id="sfx-player">
        <img id="sfx-cover" alt="" title="Right-click: show album, show artist, add to playlist">
        <div id="sfx-title" class="sfx-link" title="Open the album"></div>
        <div id="sfx-artist" class="sfx-link" title="Open the artist"></div>
        <div id="sfx-album" class="sfx-link" title="Open the album"></div>
        <div class="sfx-prog"><span id="sfx-pos">0:00</span><div class="sfx-bar" id="sfx-bar"></div><span id="sfx-dur">0:00</span></div>
        <div class="sfx-ctl">
          <button id="sfx-shuffle" title="Shuffle">${icon(ICON.shuffle)}</button>
          <button id="sfx-prev" title="Previous">${icon(ICON.prev)}</button>
          <button id="sfx-play" title="Play / pause (Space)">${icon(ICON.play)}</button>
          <button id="sfx-next" title="Next">${icon(ICON.next)}</button>
          <button id="sfx-repeat" title="Repeat">${icon(ICON.repeat)}</button>
        </div>
        <div class="sfx-vol"><span>vol</span><input id="sfx-vol" type="range" min="0" max="100" step="2" title="Volume (wheel, Shift+, / Shift+.)"><span id="sfx-volv"></span></div>
      </div>
    </div>
    <button id="ivlib-tab" class="ivgrip" title="Library (Ctrl+A)"></button>
    <button id="ivnext-tab" class="ivgrip" title="Queue (Ctrl+E)"></button>
    <div class="ivedge" id="ivedge-l">◂ library</div>
    <div class="ivedge" id="ivedge-r">queue ▸</div>
    <div class="ivedge" id="ivkey-l">ctrl+a</div>
    <div class="ivedge" id="ivkey-r">ctrl+e</div>
    <div class="ivedge" id="ivexit" title="Leave fullscreen (Ctrl+Backspace)">ctrl+⌫ exit</div>
    <div class="ivedge" id="ivstate"><span id="ivlyr-tog" title="Lyric box on / off (Ctrl+Shift+L)"></span> · <span id="ivhelp-tag" title="Keys and commands (Ctrl+Shift+H)">ctrl+⇧+h help</span></div>
    <div id="ivhelp"><div class="ivhelp-box">
      <input id="ivhelp-q" type="text" placeholder="Search keys and commands… e.g. add to playlist" autocomplete="off" spellcheck="false">
      <div class="ivkb" id="ivhelp-kb"></div>
      <div class="ivhelp-list" id="ivhelp-list"></div>
      <div class="ivhelp-foot">↑ ↓ choose · ↵ run it · esc close</div>
    </div></div>
    <div id="ivhint"><span class="lf">lib <svg viewBox="0 0 16 12"><path d="M0 6 7 0v3.6h9v4.8H7V12z" fill="currentColor"/></svg></span><button id="ivhint-dot" title="Show / hide the arrow guide"></button><span class="rt"><svg viewBox="0 0 16 12"><path d="M16 6 9 0v3.6H0v4.8h9V12z" fill="currentColor"/></svg> que</span></div>
    <div id="ivvol"></div>
    <div id="ivnext-divider"><div class="zip"></div><svg class="cog" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.3"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="white" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></div>
    <div id="ivlib-ctx" hidden></div>
    <div id="ivlyr-box"></div>
    <button id="ivsync-gear" title="Lyrics sync offset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="currentColor" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></button>
    <div id="ivsync-dlg"></div>
    <aside id="ivnext-panel">
      <div id="ivnext-feedback">feedback · github.com/gigacook/spotiflux/issues</div>
      <div id="ivnext-crumb"></div>
      <div id="ivnext-hint"></div>
      <div class="ivlib-list" id="ivnext-list"></div>
    </aside>
    <aside id="ivlib-panel">
      <div class="ivlib-head" id="ivlib-head">
        <button class="ivlib-hk" id="ivlib-back" title="Up one level (Backspace)"><b>←</b><span>⌫</span></button>
        <div class="ivlib-title" id="ivlib-title"></div>
        <button class="ivlib-hk" id="ivlib-ent" title="Go in (Enter)"><b>→</b><span>ent</span></button>
        <button class="ivlib-btn" id="ivlib-now" title="Back to what's playing">back..</button>
      </div>
      <div class="ivlib-searchwrap">
        <input id="ivlib-search" type="text" placeholder="Search playlists…" autocomplete="off" spellcheck="false">
      </div>
      <div class="ivlib-list" id="ivlib-list"></div>
    </aside>`;
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const tab = $("ivlib-tab"), list = $("ivlib-list");
  const input = $("ivlib-search"), back = $("ivlib-back"), title = $("ivlib-title"), head = $("ivlib-head"), nowBtn = $("ivlib-now"), entBtn = $("ivlib-ent");

  // ---------- data ----------
  const here = () => state.stack.at(-1);

  async function loadLibrary() {
    const at = here();
    try {
      if (at?.kind === "tracks") {
        state.items = await loadTracks(at);
      } else {
        const res = await Spicetify.Platform.LibraryAPI.getContents({
          offset: 0, limit: 9999, ...(at ? { folderUri: at.uri } : {}),
        });
        state.items = res?.items ?? [];
      }
    } catch (e) {
      console.error("[spotiflux] load failed", e);
      state.items = [];
    }
    if (at === here()) renderList(); // ignore if the user navigated meanwhile
  }

  // addedAt comes back as Date, ms, ISO string or { timestamp } depending on API.
  const toMs = (a) => a instanceof Date ? a.getTime()
    : typeof a === "number" ? a
    : typeof a === "string" ? Date.parse(a) || 0
    : Number(a?.timestamp ?? 0) || Date.parse(a?.isoString ?? "") || 0;

  async function loadTracks(at) {
    const res = at.type === "collection"
      ? await Spicetify.Platform.LibraryAPI.getTracks({ offset: 0, limit: 9999 })
      : await Spicetify.Platform.PlaylistAPI.getContents(at.uri, { offset: 0, limit: 9999 });
    return (res?.items ?? [])
      .filter((t) => t?.uri)
      .map((t) => ({
        type: "track", uri: t.uri, uid: t.uid, ctxUri: at.uri, ctxName: at.name,
        name: [(t.artists ?? []).map((a) => a.name).join(", "), t.name].filter(Boolean).join(" – "),
        added: toMs(t.addedAt),
      }))
      .sort((a, b) => b.added - a.added);
  }

  const thisYear = new Date().getFullYear();
  const fmtDate = (ms) => {
    if (!ms) return "";
    const d = new Date(ms);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== thisYear ? { year: "2-digit" } : {}) });
  };

  // Flattened library incl. folder contents, for search.
  let flatCache = null;
  async function flatLibrary() {
    if (flatCache) return flatCache;
    const out = [];
    const walk = async (folderUri) => {
      const res = await Spicetify.Platform.LibraryAPI.getContents({
        offset: 0, limit: 9999, ...(folderUri ? { folderUri } : {}),
      });
      for (const it of res?.items ?? []) {
        if (it.type === "folder") await walk(it.uri);
        else out.push(it);
      }
    };
    try { await walk(null); } catch (e) { console.error("[spotiflux] flatten failed", e); }
    return (flatCache = out);
  }

  // Every track of every playlist (+ Liked Songs), built once on first wide
  // search and reused until the library changes. Loads 4 playlists at a time.
  let trackIndex = null; // { tracks: [], done: n, total: n, ready: bool }
  function ensureTrackIndex(onProgress) {
    if (trackIndex) return trackIndex;
    const idx = (trackIndex = { tracks: [], done: 0, total: 0, ready: false });
    (async () => {
      const lists = (await flatLibrary()).filter((it) => it.type === "playlist" || it.type === "collection");
      idx.total = lists.length;
      let i = 0;
      const worker = async () => {
        while (i < lists.length && trackIndex === idx) {
          const pl = lists[i++];
          try { idx.tracks.push(...await loadTracks({ uri: pl.uri, name: pl.name, type: pl.type })); }
          catch (e) { console.warn("[spotiflux] index skip", pl.name, e); }
          idx.done++;
          onProgress();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      idx.ready = true;
      onProgress();
    })();
    return idx;
  }

  // Spotify-wide song search via the client's own GraphQL. The search query
  // definitions live in a chunk that only loads once the Search page has been
  // opened, so build them ourselves: hash from Spicetify if known, else read it
  // out of xpui-routes-search.js, else the hash seen in client 1.3.3.
  const GQL_HASHES = {
    searchTracks: "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
    searchDesktop: "1148393611bbc58e84e47aed35ecc731275df9f9eb660956962e352dd3631d89",
    getAlbum: "6a74b456cd1735c9193d9e8ec8cc5184cad7ce13572210315229db3975964361",
    queryArtistDiscographyAll: "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599",
  };
  // Lazy route chunks that define these queries (only loaded once the page was visited).
  const GQL_CHUNKS = { search: "/xpui-routes-search.js", queryArtist: "/xpui-routes-artist.js" };
  const gqlDefs = {}, chunkText = {};
  async function gqlDef(name) {
    if (gqlDefs[name]) return gqlDefs[name];
    let def = Spicetify.GraphQL?.Definitions?.[name];
    if (!def) {
      let hash = GQL_HASHES[name];
      const chunk = Object.entries(GQL_CHUNKS).find(([prefix]) => name.startsWith(prefix))?.[1];
      if (chunk) {
        try {
          chunkText[chunk] ??= await fetch(chunk).then((r) => r.text());
          hash = chunkText[chunk].match(new RegExp(`"${name}","query","([a-f0-9]{64})"`))?.[1] ?? hash;
        } catch (e) { console.warn(`[spotiflux] ${chunk} not readable, using built-in hash`, e); }
      }
      def = { name, operation: "query", sha256Hash: hash, value: null };
    }
    return (gqlDefs[name] = def);
  }

  async function searchSpotify(q) {
    const toView = (uri, name, artists) => ({ type: "track", uri, name: [artists, name].filter(Boolean).join(" – ") });
    const vars = {
      searchTerm: q, offset: 0, limit: 30, numberOfTopResults: 5,
      includeAudiobooks: false, includePreReleases: false, includeAlbumPreReleases: false,
      includeArtistHasConcertsField: false, includeLocalConcertsField: false,
      includeAuthors: false, includeEpisodeContentRatingsV2: false,
    };
    for (const name of ["searchTracks", "searchDesktop"]) {
      try {
        const res = await Spicetify.GraphQL.Request(await gqlDef(name), vars);
        const items = res?.data?.searchV2?.tracksV2?.items;
        if (!items) { console.warn(`[spotiflux] ${name}: no tracks`, res?.errors ?? res); continue; }
        return items.map((it) => {
          const d = it?.item?.data ?? it?.data ?? {};
          return toView(d.uri, d.name, (d.artists?.items ?? []).map((a) => a.profile?.name).join(", "));
        }).filter((t) => t.uri);
      } catch (e) { console.warn(`[spotiflux] ${name} failed`, e); }
    }
    try {
      const res = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/search?type=track&limit=30&q=${encodeURIComponent(q)}`);
      return (res?.tracks?.items ?? []).map((t) => toView(t.uri, t.name, t.artists.map((a) => a.name).join(", ")));
    } catch (e) {
      console.warn("[spotiflux] web api search failed", e);
      return [];
    }
  }

  // ---------- render ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function view(it) {
    if (it.type === "track") return it; // already normalised
    const sub = it.type === "playlist" ? it.owner?.name
      : it.type === "album" ? (it.artists ?? []).map((a) => a.name).join(", ")
      : it.type === "show" ? it.publisher : "";
    return {
      type: it.type, uri: it.uri, name: it.name,
      sub: [TYPE_LABEL[it.type] ?? it.type, sub].filter(Boolean).join(" · "),
      img: it.images?.[0]?.url,
    };
  }

  // ---- mac-style middle truncation, sized for JetBrains Mono ----
  let monoCanvas = null;
  // How many monospace characters fit in el's width at this size/weight.
  function charsFit(el, px, weight = 600) {
    monoCanvas ??= document.createElement("canvas").getContext("2d");
    monoCanvas.font = `${weight} ${px}px "JetBrains Mono", Consolas, monospace`;
    const cw = monoCanvas.measureText("M").width || px * 0.6;
    const w = el.clientWidth || (PANEL_W - 110);
    return Math.max(8, Math.floor(w / cw));
  }
  // "techno-hardgroove" -> "techn…groove": keep both ends, cut the middle.
  // Name column width in characters (artwork hidden in short windows).
  const rowChars = () => charsFit(list, 12, 600) - (window.innerHeight > 720 ? 6 : 2);
  function midTrunc(str, max) {
    const t = String(str ?? "");
    if (t.length <= max) return t;
    const keep = Math.max(2, max - 1);
    return t.slice(0, Math.ceil(keep / 2)) + "…" + t.slice(t.length - Math.floor(keep / 2));
  }
  // Path segments: squeeze parents (drop vowels: techno -> tchn), fold the
  // oldest parents into "…", then cut the last segment in the middle.
  const squeeze = (x) => (x.length > 4 ? x[0] + x.slice(1).replace(/[aeiouyåäö]/gi, "") : x);
  function fitPath(segs, max) {
    const join = (a) => "/" + a.join("/");
    let a = [...segs];
    if (join(a).length <= max) return join(a);
    a = a.map((x, i) => (i > 0 && i < a.length - 1 ? squeeze(x) : x));
    while (join(a).length > max && a.length > 3) a.splice(1, a[1] === "…" ? 2 : 1, "…");
    if (join(a).length > max && a.length === 3 && a[1] !== "…") a[1] = "…";
    const last = a.length - 1;
    if (join(a).length > max) a[last] = midTrunc(a[last], Math.max(4, a[last].length - (join(a).length - max)));
    return join(a);
  }

  function rowHtml(v, i) {
    const playing = Spicetify.Player.data?.context?.uri === v.uri;
    const icon = v.type === "folder" ? "📁" : v.type === "collection" ? "♥" : "♪";
    const img = v.img
      ? `<img class="ivlib-img${v.type === "artist" ? " round" : ""}" src="${esc(v.img)}" loading="lazy">`
      : `<div class="ivlib-img">${icon}</div>`;
    return `<div class="ivlib-row${playing ? " playing" : ""}" data-i="${i}">${img}
      <div class="ivlib-txt"><div class="ivlib-name">${esc(v.name)}</div><div class="ivlib-sub">${esc(v.sub)}</div></div></div>`;
  }

  // Right-hand meta: date added in a playlist, the playlist name in wide results.
  function trackRowHtml(v, i, meta = fmtDate(v.added)) {
    const playing = Spicetify.Player.data?.item?.uri === v.uri;
    return `<div class="ivlib-row ivlib-trow${playing ? " playing" : ""}${i === state.sel ? " sel" : ""}" data-i="${i}">
      <div class="ivlib-name">${esc(v.name)}</div><div class="ivlib-date">${esc(meta)}</div><span class="ivlib-q" title="Play next (Q)">q</span></div>`;
  }

  const anyRow = (v, i, meta) => (v.type === "track" ? trackRowHtml(v, i, meta) : rowHtml(v, i));

  let listViews = [];
  function renderList() {
    const at = here();
    // Header row: back (when nested), glowing path, play (inside a playlist).
    back.hidden = !at;
    const ctxUri = playingListUri();
    // Top level shows just the path. "→ ent" where Enter goes deeper (not in a
    // track list, where it plays); "back.." only in a playlist that isn't playing.
    nowBtn.hidden = !at || !ctxUri || at.uri === ctxUri || at.kind !== "tracks";
    entBtn.hidden = at?.kind === "tracks";
    const segs = ["all", ...state.stack.map((n) => (n.name ?? "").toLowerCase())];
    title.textContent = fitPath(segs, charsFit(title, 12, 700));
    title.title = "/" + segs.join("/");
    input.placeholder = at ? `Search in ${at.name}…` : "Search playlists…";
    if (search.q) return renderSearch();
    const items = (state.items ?? []).map(view);
    listViews = items;
    list.innerHTML = items.length
      ? items.map((v, i) => anyRow(v.type === "track" ? v : { ...v, name: midTrunc(v.name, rowChars()) }, i)).join("")
      : `<div class="ivlib-empty">${state.items === null ? "Loading…" : "Nothing here."}</div>`;
    if (state.sel >= 0) markSel();
    // After "back..": highlight and centre the playing track once it's loaded.
    if (state.focusNow && state.items) {
      state.focusNow = false;
      const i = listViews.findIndex((v) => v.uri === Spicetify.Player.data?.item?.uri);
      if (i >= 0) { state.sel = i; markSel(); list.querySelector(".ivlib-row.sel")?.scrollIntoView({ block: "center" }); }
    }
  }

  function markSel() {
    list.querySelectorAll(".ivlib-row").forEach((el) => el.classList.toggle("sel", +el.dataset.i === state.sel));
  }

  // The playing context, if it's something the library pane can open.
  function playingListUri() {
    const uri = Spicetify.Player.data?.context?.uri;
    return uri && (uri.startsWith("spotify:playlist:") || uri.includes(":collection")) ? uri : null;
  }

  // "back..": open the playing playlist with the current track in view.
  async function goToNow() {
    const uri = playingListUri();
    if (!uri) return;
    const lib = (await flatLibrary()).find((it) => it.uri === uri);
    clearSearch();
    state.stack = [{
      kind: "tracks", uri, type: uri.includes(":collection") ? "collection" : "playlist",
      name: lib?.name ?? Spicetify.Player.data?.context?.metadata?.context_description ?? "playing",
    }];
    state.items = null;
    state.sel = -1;
    state.focusNow = true;
    renderList();
    loadLibrary();
  }

  // Put a track first in the queue without touching what's playing. (Spotify's
  // PlayerAPI.playAsNextInQueue jumps straight to the track, so not that.)
  // Inserted before the first upcoming track; an empty queue just appends.
  async function queueNext(v, rowEl) {
    if (!v?.uri) return;
    const P = Spicetify.Platform.PlayerAPI;
    try {
      let first = null;
      try { first = P?.getInternalQueue?.()?.nextTracks?.[0]?.contextTrack ?? null; } catch {}
      if (first?.uri && typeof P?.insertIntoQueue === "function") {
        await P.insertIntoQueue([{ uri: v.uri }], { before: { uri: first.uri, uid: first.uid } });
      } else if (typeof P?.addToQueue === "function") await P.addToQueue([{ uri: v.uri }]);
      else await Spicetify.addToQueue([{ uri: v.uri }]);
      rowEl?.classList.add("queued");
      if (document.body.classList.contains("ivnext-open")) setTimeout(renderNext, 300);
      return true;
    } catch (e) {
      console.warn("[spotiflux] queue next failed", e);
      Spicetify.showNotification?.(`Couldn't queue ${v.name}`, true);
      return false;
    }
  }

  // Empty the "Queue" section (tracks you queued yourself). The playlist's own
  // upcoming tracks and autoplay stay, like Spotify's "Clear queue".
  async function clearQueue() {
    const P = Spicetify.Platform.PlayerAPI;
    let queued = null;
    try { queued = P?.getQueue?.()?.queued; } catch {}
    if (Array.isArray(queued) && !queued.length) { Spicetify.showNotification?.("Nothing queued"); return; }
    try {
      await P.clearQueue();
      list.querySelectorAll(".ivlib-row.queued").forEach((r) => r.classList.remove("queued"));
      Spicetify.showNotification?.("Queue cleared");
      if (document.body.classList.contains("ivnext-open")) setTimeout(renderNext, 300);
    } catch (e) {
      console.warn("[spotiflux] clear queue failed", e);
      Spicetify.showNotification?.("Couldn't clear the queue", true);
    }
  }

  function goTo(entry) {
    clearSearch();
    state.sel = -1;
    state.stack.push(entry);
    state.items = null;
    renderList();
    list.scrollTop = 0;
    loadLibrary();
  }

  // One level up; at the top, close the pane.
  function goUp() {
    clearSearch();
    state.sel = -1;
    if (state.stack.length) {
      state.stack.pop();
      state.items = null;
      renderList();
      list.scrollTop = 0;
      loadLibrary();
    } else {
      setOpen(false);
      setFocus("mid");
    }
  }

  // ---------- scoped search ----------
  // Starts in the current view (this playlist / folder); widens on request to
  // all playlists, then to Spotify. At the top level it starts at "all playlists".
  const SCOPES = ["here", "library", "spotify"];
  const search = { q: "", scope: 0, active: -1, spotify: null, seq: 0 };
  const baseScope = () => (state.stack.length ? 0 : 1);
  const scopeLabel = (s) => (s === 0 ? here()?.name ?? "this view" : s === 1 ? "all playlists" : "Spotify");

  function clearSearch() {
    input.value = "";
    search.q = "";
    search.scope = baseScope();
    search.active = -1;
    search.spotify = null;
  }

  function widen() {
    if (search.scope >= SCOPES.length - 1) return;
    search.scope++;
    search.active = -1;
    runSearch();
  }

  // Returns [{ label, rows: [view], meta?: fn }]
  function searchSections() {
    const needle = search.q.toLowerCase();
    const hit = (s) => s?.toLowerCase().includes(needle);
    const scope = SCOPES[search.scope];
    if (scope === "here") {
      return [{ label: null, rows: (state.items ?? []).map(view).filter((v) => hit(v.name)) }];
    }
    if (scope === "library") {
      const lists = (flatCache ?? []).filter((it) => hit(it.name)).map(view);
      const idx = trackIndex;
      const tracks = (idx?.tracks ?? []).filter((t) => hit(t.name)).slice(0, 300);
      return [
        { label: "Playlists", rows: lists },
        { label: "Songs in your playlists", rows: tracks, meta: (v) => v.ctxName },
      ];
    }
    return [{ label: "Spotify", rows: search.spotify ?? [] }];
  }

  function renderSearch() {
    const sections = searchSections();
    const scope = SCOPES[search.scope];
    const views = [];
    let html = "";
    for (const sec of sections) {
      if (!sec.rows.length) continue;
      if (sec.label) html += `<div class="ivlib-section">${esc(sec.label)}</div>`;
      for (const v of sec.rows) { html += anyRow(v, views.length, sec.meta?.(v)); views.push(v); }
    }
    const total = views.length;
    const idx = trackIndex;
    const loading = (scope === "library" && !(idx?.ready)) || (scope === "spotify" && search.spotify === null);
    if (loading) {
      const prog = scope === "library" && idx?.total ? ` ${idx.done}/${idx.total}` : "";
      html += `<div class="ivlib-empty">Searching ${esc(scopeLabel(search.scope))}${prog}…</div>`;
    }
    if (!loading && search.scope < SCOPES.length - 1) {
      // The only way out of a scope: explicit widen row (Y / Enter when empty, Tab always).
      const nextLabel = scopeLabel(search.scope + 1);
      const prompt = total
        ? `Search ${esc(nextLabel)} <span class="ivlib-key">Tab</span>`
        : `No matches in ${esc(scopeLabel(search.scope))}. Search ${esc(nextLabel)}? <span class="ivlib-key">Y</span> <span class="ivlib-key">↵</span>`;
      html += `<div class="ivlib-row ivlib-widen" data-i="${views.length}">${prompt}</div>`;
      views.push({ type: "widen" });
    } else if (!loading && !total) {
      html += `<div class="ivlib-empty">No matches anywhere.</div>`;
    }
    listViews = views;
    list.innerHTML = html;
    list.querySelectorAll(".ivlib-row").forEach((el) => el.classList.toggle("active", +el.dataset.i === search.active));
    list.querySelector(".ivlib-row.active")?.scrollIntoView({ block: "nearest" });
  }

  const resultCount = () => listViews.filter((v) => v.type !== "widen").length;

  let searchTimer, renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; if (search.q) renderSearch(); }, 250);
  };

  function runSearch() {
    const scope = SCOPES[search.scope];
    if (scope === "library") {
      flatLibrary().then(queueRender);
      ensureTrackIndex(queueRender);
    }
    if (scope === "spotify") {
      const seq = ++search.seq, q = search.q;
      search.spotify = null;
      searchSpotify(q).then((r) => { if (seq === search.seq) { search.spotify = r; renderSearch(); } });
    }
    renderSearch();
  }

  function onQuery() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = input.value.trim();
      if (!q) { clearSearch(); renderList(); return; }
      if (!search.q) search.scope = baseScope(); // fresh query starts in the current view
      search.q = q;
      search.active = -1;
      list.scrollTop = 0;
      runSearch();
    }, 120);
  }

  // ---------- actions ----------
  async function activate(v) {
    if (!v) return;
    if (v.type === "widen") return widen();
    if (v.type === "folder") return goTo({ kind: "folder", uri: v.uri, name: v.name });
    if (v.type === "playlist" || v.type === "collection") {
      return goTo({ kind: "tracks", uri: v.uri, name: v.name, type: v.type });
    }
    if (v.ctxUri) {
      // Track from a playlist: play that playlist from this track.
      try { await Spicetify.Platform.PlayerAPI.play({ uri: v.ctxUri }, {}, { skipTo: { uid: v.uid, uri: v.uri } }); }
      catch (e) { console.warn("[spotiflux] context play failed", e); Spicetify.Player.playUri(v.uri); }
      return;
    }
    try { await Spicetify.Player.playUri(v.uri); }
    catch (e) { Spicetify.showNotification?.(`Can't play ${v.name}`); console.error(e); }
  }

  function setOpen(open) {
    const was = state.open;
    state.open = open;
    localStorage.setItem(STORE_OPEN, open ? "1" : "0");
    document.body.classList.toggle("ivlib-open", open);
    if (!open && was) state.hiddenAt = Date.now();
    if (open && !was && autoNow()) return;
    if (open && !state.items?.length) loadLibrary();
  }

  // Coming back to the library after more than a minute away (or for the
  // first time) opens the playlist that's playing, instead of wherever you
  // left off. Returns true when it did.
  const AUTO_NOW_MS = 60000;
  function autoNow() {
    if (Date.now() - state.hiddenAt <= AUTO_NOW_MS || !playingListUri()) return false;
    state.hiddenAt = Date.now();
    goToNow();
    return true;
  }

  // ---------- library pointer events ----------
  tab.addEventListener("click", () => {
    if (!state.open) return focusZone("left");
    setOpen(false);
    if (focus.zone === "left") setFocus(null);
  });
  $("ivnext-tab").addEventListener("click", () => {
    if (!isOpen("right")) return focusZone("right");
    setNext(false);
    if (focus.zone === "right") setFocus(null);
  });
  back.addEventListener("click", goUp);
  nowBtn.addEventListener("click", goToNow);
  entBtn.addEventListener("click", () => {
    const i = search.q ? search.active : state.sel;
    if (i >= 0) activate(listViews[i]);
  });
  // A click only selects; Enter or a double-click goes in / plays.
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".ivlib-row");
    if (!row) return;
    const i = +row.dataset.i, v = listViews[i];
    if (e.target.closest(".ivlib-q")) return queueNext(v, row);
    if (v?.type === "widen") return widen();
    if (search.q) { search.active = i; renderSearch(); } else { state.sel = i; markSel(); }
  });
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".ivlib-row");
    const v = row && listViews[+row.dataset.i];
    if (v && v.type !== "widen" && !e.target.closest(".ivlib-q")) activate(v);
  });
  input.addEventListener("input", onQuery);
  // Keys are handled by onKey (window, capture). Stop them here so Spotify's
  // own shortcuts never see typing in the search box.
  ["keydown", "keyup", "keypress"].forEach((t) => input.addEventListener(t, (e) => e.stopPropagation()));

  // Library changed elsewhere → refresh.
  try {
    Spicetify.Platform.LibraryAPI.getEvents()._emitter.addListener("update", () => {
      flatCache = null;
      trackIndex = null;
      ctx.editable = null;
      if (state.open) loadLibrary();
    }, {});
  } catch {}
  Spicetify.Player.addEventListener("songchange", () => { if (state.open && state.items) renderList(); });

  // ---------- window buttons ----------
  // Spotify's native minimise/maximise/close sit over the UI. Keep them hidden
  // and reveal only after the pointer rests in the top-right corner, so a
  // passing click can't close the app.
  const setWinButtons = (() => {
    try {
      // Lives in Spotify's service registry, not on Platform itself.
      const reg = Spicetify.Platform.Registry ?? Spicetify.Platform.getRegistry?.();
      const native = reg?.resolve?.(Symbol.for("NativeAPI"));
      if (typeof native?.setWindowButtonsVisibility === "function") return (v) => native.setWindowButtonsVisibility(v);
      for (const k of Object.keys(Spicetify.Platform)) {
        const api = Spicetify.Platform[k];
        if (typeof api?.setWindowButtonsVisibility === "function") return (v) => api.setWindowButtonsVisibility(v);
      }
      const client = Spicetify.Platform.ControlMessageAPI?._updateUiClient;
      if (typeof client?.setButtonsVisibility === "function") return (v) => client.setButtonsVisibility({ showButtons: v });
    } catch (e) { console.warn("[spotiflux] window buttons API not found", e); }
    return null;
  })();
  if (setWinButtons) {
    const CORNER_W = 150, CORNER_H = 56, DWELL_MS = 500;
    let shown = null, dwell = null;
    const show = (v) => { if (shown !== v) { shown = v; Promise.resolve().then(() => setWinButtons(v)).catch(() => {}); } };
    show(false);
    window.addEventListener("mousemove", (e) => {
      const inCorner = e.clientX > window.innerWidth - CORNER_W && e.clientY < CORNER_H;
      if (!inCorner) { clearTimeout(dwell); dwell = null; show(false); }
      else if (!shown && !dwell) dwell = setTimeout(() => { dwell = null; show(true); }, DWELL_MS);
    }, { passive: true });
    // Pointer left the window (e.g. over the native buttons themselves): keep state.
  }

  // ---------- corner chrome ----------
  // Small buttons/boxes left in the window corners over fullscreen (the "..."
  // menu, the window-controls backdrop). Found by hit-testing, so it adapts to
  // whatever Spotify/theme puts there; only small elements are touched.
  function hideCornerChrome() {
    document.querySelectorAll(".ivlib-corner-hide").forEach((el) => el.classList.remove("ivlib-corner-hide"));
    const small = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.width < 220 && r.height < 110; };
    for (const [x, y] of [[36, 30], [window.innerWidth - 50, 30]]) {
      let el = document.elementsFromPoint(x, y).find((e) => !root.contains(e) && e !== document.body && e !== document.documentElement);
      if (!el || !small(el)) continue;
      while (el.parentElement && el.parentElement !== document.body && small(el.parentElement)) el = el.parentElement;
      el.classList.add("ivlib-corner-hide");
    }
  }

  // ---------- right pane: tracks around the current one ----------
  const nextPanel = $("ivnext-panel"), nextList = $("ivnext-list"), crumb = $("ivnext-crumb"), hint = $("ivnext-hint");
  const next = { views: [], timer: null, stack: [], qActive: -1, rendered: null };
  // Top of the nest (null = queue). Assigning replaces the whole path.
  Object.defineProperty(next, "view", {
    get() { return this.stack.at(-1) ?? null; },
    set(v) { this.stack = v ? [v] : []; },
  });
  const imgUrl = (u) => (u?.startsWith("spotify:image:") ? `https://i.scdn.co/image/${u.slice(14)}` : u);

  function normTrack(t, section) {
    const ct = t?.contextTrack ?? t ?? {};
    const md = ct.metadata ?? t?.metadata ?? {};
    const uri = ct.uri ?? t?.uri;
    if (!uri || !/^spotify:(track|episode|local)/.test(uri)) return null;
    const title = md.title ?? t?.name ?? uri;
    const artists = md.artist_name ?? (t?.artists ?? []).map((a) => a.name).join(", ");
    return {
      type: "track", section, uri, uid: ct.uid ?? t?.uid, title,
      artists: md.artist_name ? [md.artist_name] : (t?.artists ?? []).map((a) => a.name),
      name: [artists, title].filter(Boolean).join(" – "),
      sub: "",
      img: imgUrl(md.image_url ?? md.image_small_url ?? t?.album?.images?.[0]?.url ?? t?.images?.[0]?.url),
      provider: t?.provider ?? ct.provider ?? "context",
    };
  }

  // Spotify's own state: player data has previousItems; PlayerAPI.getQueue()
  // gives { queued, nextUp } (nextUp runs into autoplay). Spicetify.Queue is a
  // last resort — it stays empty on current clients.
  function queueSnapshot() {
    const P = Spicetify.Platform.PlayerAPI;
    const pd = Spicetify.Player.data ?? P?._state ?? {};
    let q = null;
    try { q = P?.getQueue?.(); } catch {}
    const prevRaw = pd.previousItems?.length ? pd.previousItems : (Spicetify.Queue?.prevTracks ?? []);
    const nextRaw = q && (q.queued?.length || q.nextUp?.length)
      ? [...(q.queued ?? []), ...(q.nextUp ?? [])]
      : pd.nextItems?.length ? pd.nextItems : (Spicetify.Queue?.nextTracks ?? []);
    const prev = prevRaw.map((t) => normTrack(t, "prev")).filter(Boolean).slice(-15);
    const cur = pd.item ? normTrack(pd.item, "current") : null;
    const nxt = nextRaw.map((t) => normTrack(t, "next")).filter(Boolean).slice(0, 80);
    return { prev, cur, nxt };
  }

  const fmtDur = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}` : "");

  // ---------- right-pane nest: Queue > artist > album ----------
  // Only the top level is rendered; the path sits faintly above the list.
  // Arrows move a highlight, Enter opens/plays, Esc/Backspace go up a level.
  const RELEASE_LABEL = { ALBUM: "Album", SINGLE: "Single", EP: "EP", COMPILATION: "Compilation" };

  async function loadAlbum(uri) {
    const res = await Spicetify.GraphQL.Request(await gqlDef("getAlbum"), { uri, locale: "", offset: 0, limit: 300 });
    const a = res?.data?.albumUnion;
    if (!a?.name) throw new Error(JSON.stringify(res?.errors ?? res).slice(0, 300));
    const albumArtists = (a.artists?.items ?? []).map((x) => x.profile?.name).filter(Boolean).join(", ");
    const sources = a.coverArt?.sources ?? [];
    return {
      name: a.name,
      cover: (sources.find((c) => (c.width ?? 300) >= 128) ?? sources[0])?.url,
      sub: [albumArtists, a.date?.isoString?.slice(0, 4) ?? a.date?.year].filter(Boolean).join(" · "),
      rows: (a.tracksV2?.items ?? []).map((it) => it.track ?? it.item?.data ?? it).filter((t) => t?.uri).map((t, i) => {
        const artists = (t.artists?.items ?? []).map((x) => x.profile?.name).filter(Boolean).join(", ");
        return {
          type: "track", section: "album", uri: t.uri, ctxUri: uri, num: t.trackNumber ?? i + 1,
          name: artists && artists !== albumArtists ? `${artists} – ${t.name}` : t.name,
          ms: t.duration?.totalMilliseconds ?? 0,
        };
      }),
    };
  }

  async function loadArtist(uri) {
    const res = await Spicetify.GraphQL.Request(await gqlDef("queryArtistDiscographyAll"),
      { uri, offset: 0, limit: 100, order: "DATE_DESC" });
    const d = res?.data?.artistUnion;
    const all = d?.discography?.all;
    if (!all?.items) throw new Error(JSON.stringify(res?.errors ?? res).slice(0, 300));
    return {
      ...(d.profile?.name ? { name: d.profile.name } : {}),
      sub: `${all.totalCount ?? all.items.length} releases`,
      rows: all.items.map((it) => it.releases?.items?.[0] ?? it).filter((r) => r?.uri).map((r) => ({
        type: "release", uri: r.uri, name: r.name,
        meta: [r.date?.year, RELEASE_LABEL[r.type] ?? r.type?.toLowerCase()].filter(Boolean).join(" · "),
      })),
    };
  }

  async function openNest(entry, { push = false } = {}) {
    if (!entry?.uri) return;
    const node = { ...entry, loading: true, active: -1, rows: [] };
    next.stack = push ? [...next.stack, node] : [node];
    if (document.body.classList.contains("ivnext-open")) renderNext(); else setNext(true);
    setFocus("right");
    try { Object.assign(node, entry.kind === "artist" ? await loadArtist(entry.uri) : await loadAlbum(entry.uri)); }
    catch (e) { console.warn(`[spotiflux] ${entry.kind} load failed`, e); node.error = true; }
    node.loading = false;
    if (next.stack.includes(node)) renderNext();
  }
  const showAlbum = (uri, opts) => openNest({ kind: "album", uri }, opts);
  const showArtist = (uri, name) => openNest({ kind: "artist", uri, name });

  function popNest() {
    next.stack.pop();
    renderNext();
  }

  function renderNest() {
    const v = next.view;
    const playingUri = Spicetify.Player.data?.item?.uri;
    let html = "";
    if (v.name) {
      html += `<div class="ivnext-album-head">${v.cover ? `<img src="${esc(v.cover)}">` : ""}
        <div class="ivlib-txt"><div class="ivnext-album-title">${esc(v.name)}</div><div class="ivnext-album-sub">${esc(v.sub ?? "")}</div></div></div>`;
    }
    if (v.loading) html += `<div class="ivlib-empty">Loading…</div>`;
    if (v.error) html += `<div class="ivlib-empty">Couldn't load this ${v.kind}.</div>`;
    v.rows.forEach((r, i) => {
      html += r.type === "track"
        ? `<div class="ivlib-row ivlib-trow${r.uri === playingUri ? " current" : ""}" data-i="${i}">
            <span class="ivlib-num">${r.num}</span><div class="ivlib-name">${esc(r.name)}</div><div class="ivlib-date">${fmtDur(r.ms)}</div></div>`
        : `<div class="ivlib-row ivlib-trow" data-i="${i}">
            <div class="ivlib-name">${esc(r.name)}</div><div class="ivlib-date">${esc(r.meta)}</div></div>`;
    });
    const keep = nextList.scrollTop;
    next.views = v.rows;
    nextList.innerHTML = html;
    nextList.scrollTop = next.rendered === v ? keep : 0;
    next.rendered = v;
  }

  function renderNext() {
    crumb.textContent = "/" + ["queue", ...next.stack.map((n) => n.name ?? "…")].join("/");
    hint.textContent = next.stack.length ? "⌫ back · esc player" : "⌫ close · c clear · esc player";
    if (next.view) { renderNest(); markActive(); return; }
    next.rendered = null;
    const { cur, nxt } = queueSnapshot();
    const rows = [], views = [];
    const add = (v) => {
      let html = rowHtml(v, views.length);
      if (v.section === "current") html = html.replace('class="ivlib-row', 'class="ivlib-row current');
      else if (v.provider === "queue") {
        html = html.replace('class="ivlib-row', 'class="ivlib-row userq')
          .replace('<div class="ivlib-name">', '<div class="ivlib-name"><span class="ivlib-u">u</span>');
      }
      rows.push(html);
      views.push(v);
    };
    if (cur) add(cur);
    let lastLabel = null;
    for (const v of nxt) {
      const label = v.provider === "queue" ? "Queue" : v.provider === "autoplay" ? "Recommended" : null;
      if (label && label !== lastLabel) rows.push(`<div class="ivlib-section">${label}</div>`);
      lastLabel = label ?? lastLabel;
      add(v);
    }
    next.views = views;
    nextList.innerHTML = rows.join("") || `<div class="ivlib-empty">Nothing queued.</div>`;
    markActive();
    if (next.qActive < 0) nextList.scrollTop = 0;
  }

  // Keyboard highlight: per nest level, plus one for the queue.
  const getActive = () => (next.view ? next.view.active : next.qActive);
  const setActive = (i) => { if (next.view) next.view.active = i; else next.qActive = i; };
  function markActive(scroll = false) {
    const a = getActive();
    nextList.querySelectorAll(".ivlib-row").forEach((el) => el.classList.toggle("active", +el.dataset.i === a));
    if (scroll) nextList.querySelector(".ivlib-row.active")?.scrollIntoView({ block: "nearest" });
  }
  function moveActive(d) {
    const n = next.views.length;
    if (!n) return;
    let a = getActive();
    if (a < 0) {
      // Start from the playing row, like a cursor parked on it.
      const cur = nextList.querySelector(".ivlib-row.current");
      a = cur ? +cur.dataset.i : d > 0 ? -1 : n;
    }
    setActive(Math.max(0, Math.min(n - 1, a + d)));
    markActive(true);
  }

  function activateNext(v) {
    if (!v) return;
    if (v.type === "release") return openNest({ kind: "album", uri: v.uri, name: v.name }, { push: true });
    playFromNext(v);
  }

  async function playFromNext(v) {
    if (!v || v.section === "current") return;
    const P = Spicetify.Platform.PlayerAPI;
    const ctx = v.ctxUri ?? Spicetify.Player.data?.context?.uri;
    try {
      if (v.section === "next") await P.skipTo({ uid: v.uid, uri: v.uri });
      else if (ctx) await P.play({ uri: ctx }, {}, { skipTo: { uid: v.uid, uri: v.uri } });
      else throw new Error("no context");
    } catch (e) {
      console.warn("[spotiflux] skip failed, playing track alone", e);
      Spicetify.Player.playUri(v.uri);
    }
  }

  // ---------- layout ----------
  // Library | player | queue. Both panes are the same width (27.5% of the
  // window, 200-380px) so the centred player never sits under one. The cover
  // fits the space between the panes; the player block's top sits at 28% of
  // the height, leaving room above it for the lyric box. The queue list fills
  // the band from 33% to 66% of the height, or the player's full height if
  // that's taller. Runs on enter, resize and whenever the block's height
  // changes (ResizeObserver: long titles wrap).
  const paneWidth = () => Math.round(Math.min(380, Math.max(200, window.innerWidth * 0.275)));
  const player = $("sfx-player");

  function layout() {
    const css = document.documentElement.style;
    const W = window.innerWidth, H = window.innerHeight, pw = paneWidth();
    css.setProperty("--ivlib-w", `${pw}px`);
    css.setProperty("--ivnext-w", `${pw}px`);
    const mid = Math.max(160, Math.min(440, W - 2 * pw - 48));
    css.setProperty("--sfx-cover", `${Math.round(Math.max(140, Math.min(340, H * 0.36, mid * 0.85)))}px`);
    const h = player.offsetHeight;
    // Top at 28% (room for the lyric box) unless that pushes it off-screen.
    let pTop = Math.max(H * 0.28, (H - h) / 2);
    if (pTop + h > H - 12) pTop = Math.max(8, H - 12 - h);
    css.setProperty("--sfx-top", `${Math.round(pTop)}px`);
    css.setProperty("--ivnext-top", `${Math.max(8, Math.round(Math.min(H * 0.33, pTop)))}px`);
    css.setProperty("--ivnext-bottom", `${Math.max(8, Math.round(H - Math.max(H * 0.66, pTop + h)))}px`);
    css.setProperty("--ivlyr-w", `${mid}px`);
    // The lyric box runs from under the arrow guide (top row) to just above the cover.
    css.setProperty("--ivlyr-bottom", `${Math.round(H - pTop + 24)}px`);
    placeGear();
  }
  new ResizeObserver(() => { if (document.body.classList.contains("ivlib-fs")) layout(); }).observe(player);

  // ---------- the deck: cover, title, progress, buttons, volume ----------
  // Track fields, whichever shape Spicetify.Player.data.item has. Also used
  // by the bridge's state message.
  function trackInfo(item = Spicetify.Player.data?.item) {
    const md = item?.metadata ?? {};
    return {
      uri: item?.uri ?? "", title: item?.name ?? md.title ?? "",
      artists: item?.artists?.length ? item.artists.map((a) => a.name) : [md.artist_name].filter(Boolean),
      artist_uri: item?.artists?.[0]?.uri ?? md.artist_uri ?? "",
      album: item?.album?.name ?? md.album_title ?? "", album_uri: item?.album?.uri ?? md.album_uri ?? "",
      duration_ms: Number(item?.duration?.milliseconds ?? md.duration) || 0,
      cover_url: imgUrl(md.image_xlarge_url ?? md.image_large_url ?? md.image_url ?? item?.album?.images?.[0]?.url) ?? "",
    };
  }
  const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  const deck = { uri: null, key: "", bar: $("sfx-bar"), vol: $("sfx-vol"), cover: $("sfx-cover") };

  function renderDeck() {
    const t = trackInfo();
    deck.uri = t.uri;
    $("sfx-title").textContent = t.title;
    $("sfx-artist").textContent = t.artists.join(", ");
    $("sfx-album").textContent = t.album;
    if (t.cover_url) deck.cover.src = t.cover_url; else deck.cover.removeAttribute("src");
    $("sfx-bg").style.backgroundImage = t.cover_url ? `url("${t.cover_url}")` : "";
  }

  // Every 250 ms while the deck is open: progress, button states, volume.
  function tickDeck() {
    const P = Spicetify.Player;
    if ((P.data?.item?.uri ?? "") !== deck.uri) renderDeck();
    const pos = P.getProgress?.() ?? 0, dur = P.getDuration?.() ?? 0;
    $("sfx-pos").textContent = fmtTime(pos);
    $("sfx-dur").textContent = fmtTime(dur);
    deck.bar.style.setProperty("--sfx-p", `${dur ? Math.min(100, (100 * pos) / dur).toFixed(2) : 0}%`);
    const playing = !!P.isPlaying?.(), rep = P.getRepeat?.() ?? 0, vol = Math.round((P.getVolume?.() ?? 1) * 100);
    const key = `${playing}|${!!P.getShuffle?.()}|${rep}|${vol}`;
    if (key === deck.key) return;
    deck.key = key;
    $("sfx-play").innerHTML = icon(playing ? ICON.pause : ICON.play);
    $("sfx-shuffle").classList.toggle("on", !!P.getShuffle?.());
    $("sfx-repeat").classList.toggle("on", rep > 0);
    $("sfx-repeat").toggleAttribute("data-one", rep === 2);
    if (document.activeElement !== deck.vol) deck.vol.value = vol;
    $("sfx-volv").textContent = vol;
  }

  const playerDo = (fn) => () => { try { fn(Spicetify.Player); } catch (e) { console.warn("[spotiflux] player call failed", e); } };
  $("sfx-play").addEventListener("click", playerDo((P) => P.togglePlay()));
  $("sfx-prev").addEventListener("click", playerDo((P) => P.back()));
  $("sfx-next").addEventListener("click", playerDo((P) => P.next()));
  $("sfx-shuffle").addEventListener("click", playerDo((P) => P.toggleShuffle()));
  $("sfx-repeat").addEventListener("click", playerDo((P) => P.toggleRepeat()));
  deck.vol.addEventListener("input", playerDo((P) => P.setVolume(deck.vol.value / 100)));
  // Hand the keys back (Space, arrows) once the slider is let go.
  deck.vol.addEventListener("change", () => deck.vol.blur());
  deck.bar.addEventListener("click", (e) => {
    const r = deck.bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    playerDo((P) => P.seek(Math.round(frac * P.getDuration())))();
  });
  // Title or album opens the album, artist opens the artist, both in the
  // queue pane; right-click on the cover opens our menu.
  const openAlbumHere = () => showAlbum(trackInfo().album_uri);
  $("sfx-title").addEventListener("click", openAlbumHere);
  $("sfx-album").addEventListener("click", openAlbumHere);
  $("sfx-artist").addEventListener("click", () => { const t = trackInfo(); showArtist(t.artist_uri, t.artists[0]); });
  deck.cover.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY); });

  // ---------- queue pane open / close ----------
  // Folds like a book cover (CSS). The queue re-renders every 4s while open
  // because it has no reliable change event; album / artist views are static.
  function setNext(open) {
    document.body.classList.toggle("ivnext-open", open);
    clearInterval(next.timer);
    if (open) {
      layout();
      renderNext();
      next.timer = setInterval(() => { if (!next.view) renderNext(); }, 4000);
    } else {
      next.view = null;
    }
  }

  // ---------- focus: library | middle | queue ----------
  // One zone has the keyboard. The library zone keeps the typing cursor in
  // its search box; moving into a pane opens it.
  const ZONES = ["left", "mid", "right"];
  const focus = { zone: null };
  const isOpen = (zone) => (zone === "left" ? state.open : zone === "right" ? document.body.classList.contains("ivnext-open") : true);
  function setFocus(zone) {
    focus.zone = zone;
    for (const z of ZONES) document.body.classList.toggle(`ivfocus-${z}`, zone === z);
    if (zone === "left") setTimeout(() => input.focus({ preventScroll: true }), 0);
    else if (document.activeElement === input) input.blur();
  }
  function focusZone(zone) {
    if (zone === "left" && !state.open) setOpen(true);
    if (zone === "right" && !isOpen("right")) setNext(true);
    setFocus(zone);
  }
  // Esc: back to just the player.
  function resetView() {
    closeHelp();
    closeSync();
    closeCtx();
    if (search.q || input.value) { clearSearch(); renderList(); }
    if (state.open) setOpen(false);
    if (isOpen("right")) setNext(false);
    setFocus(null);
  }

  // ---------- keys: one dispatcher, in this order ----------
  // 1 Space  2 Esc  3 open dialogs  4 Ctrl+A / Ctrl+E  5 the focused zone.
  function onKey(e) {
    const fs = document.body.classList.contains("ivlib-fs");
    const mod = e.altKey || e.ctrlKey || e.metaKey;
    const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const field = e.target?.matches?.("input:not([type=range]), textarea, [contenteditable='true']") ? e.target : null;
    if (e.target === deck.vol) deck.vol.blur(); // the volume slider never keeps the keys
    // The settings dialog owns the keyboard while it's open; Esc closes it.
    if (settings.open) { if (e.key === "Escape") { consume(); closeSettings(); } return; }

    // 1. Space: play/pause anywhere in Spotify, except mid-text in a text box.
    if (e.code === "Space" && !mod && !(field && (field.value ?? field.textContent ?? "").length)) {
      consume();
      if (!e.repeat) Spicetify.Player.togglePlay();
      return;
    }
    // 1b. Shift+, / Shift+. : volume up / down, same text-box exception. Matched by
    // key position (e.code): Shift turns them into < > or ; : depending on layout.
    if ((e.code === "Comma" || e.code === "Period") && e.shiftKey && !mod && !(field && (field.value ?? field.textContent ?? "").length)) {
      consume();
      volumeKey(e.code === "Comma" ? 1 : -1, e.repeat);
      return;
    }
    // 1c. , and . : 10 s back / forward anywhere, with the same text-box exception.
    if ((e.key === "," || e.key === ".") && !mod && !(field && (field.value ?? field.textContent ?? "").length)) {
      consume();
      seekBy(e.key === "," ? -10000 : 10000);
      return;
    }
    if (!fs) return;
    // F12 does nothing in the deck (it used to leave fullscreen); Ctrl+Backspace leaves.
    if (e.key === "F12") { consume(); return; }
    // Ctrl+Shift commands: add to playlist, pick playlist, help, lyric box toggles.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && CMDS[e.code]) {
      consume();
      if (!e.repeat) CMDS[e.code]();
      return;
    }
    // Help owns the keyboard while it's open.
    if (help.open) { helpKey(e, consume); return; }
    // 2. Esc: everything closed, just the player.
    if (e.key === "Escape" && !mod) { consume(); resetView(); return; }
    // Ctrl+Backspace: leave fullscreen, except mid-text (there it deletes a word).
    if (e.key === "Backspace" && e.ctrlKey && !e.altKey && !e.metaKey && !(field && (field.value ?? field.textContent ?? "").length)) {
      consume();
      exitFullscreen();
      return;
    }
    // Text fields that aren't ours keep their keys.
    if (field && field !== input && field !== ctx.filterEl) return;
    // 3. Open dialogs.
    if (syncKeys(e)) return;
    if (ctx.state) {
      const inFilter = e.target === ctx.filterEl;
      const lists = ctx.state.mode === "playlists";
      if (e.key === "Backspace" && !(inFilter && ctx.filterEl.value)) { consume(); ctxBack(); return; }
      if (e.key === "Enter" && (inFilter || ctx.state.mode === "confirm")) { consume(); (ctx.views[ctx.active] ?? ctx.views[0])?.act(); return; }
      if (lists && (e.key === "ArrowDown" || e.key === "ArrowUp")) { consume(); moveCtx(e.key === "ArrowDown" ? 1 : -1); return; }
      if (lists && ctx.state.pick && e.key === "Tab") { consume(); pinPlaylist((ctx.views[ctx.active] ?? ctx.views[0])?.pl); return; }
      if (inFilter) return;
    }
    // 4. Snap: Ctrl+A library only, Ctrl+E queue only.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "KeyA" || e.code === "KeyE")) {
      consume();
      snapKeyAt = Date.now();
      snapTo(e.code === "KeyA" ? "left" : "right");
      return;
    }
    if (mod) return;
    // 5. The focused zone (a closed pane counts as the middle).
    const zone = focus.zone && isOpen(focus.zone) ? focus.zone : "mid";
    if (zone === "left") return libraryKey(e, consume);
    if (zone === "right") return queueKey(e, consume);
    if (e.key === "ArrowLeft") { consume(); focusZone("left"); }
    else if (e.key === "ArrowRight") { consume(); focusZone("right"); }
  }

  // Spotify's desktop shell owns Ctrl+A ("select all"): the page never sees
  // the keydown, only a "select_all" control message, sent at once. That
  // message is the snap; the key's release and the page-wide select-all it
  // can trigger are fallbacks. snapKeyAt stops double snaps.
  // With Shift held it's Ctrl+Shift+A (pick a playlist), never a snap.
  let snapKeyAt = 0, ctrlHeld = false, shiftHeld = false, pointerHeld = false;
  try {
    Spicetify.Platform.ControlMessageAPI.getEvents().addListener("message", ({ data } = {}) => {
      if (data?.type !== "select_all" || !document.body.classList.contains("ivlib-fs")) return;
      if (shiftHeld) { pickHotkey(); return; }
      const el = document.activeElement;
      if (el?.matches?.("input, textarea, [contenteditable='true']") && (el.value ?? el.textContent ?? "").length) return;
      if (Date.now() - snapKeyAt < 600) return;
      snapKeyAt = Date.now();
      snapTo("left");
    });
  } catch (e) { console.warn("[spotiflux] select_all hook unavailable, Ctrl+A snaps on release", e); }
  window.addEventListener("keydown", (e) => { if (e.key === "Control") ctrlHeld = true; else if (e.key === "Shift") shiftHeld = true; }, true);
  window.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
  window.addEventListener("pointerup", () => { pointerHeld = false; }, true);
  window.addEventListener("blur", () => { ctrlHeld = false; shiftHeld = false; pointerHeld = false; });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control") { ctrlHeld = false; return; }
    if (e.key === "Shift") { shiftHeld = false; return; }
    if (!document.body.classList.contains("ivlib-fs") || e.altKey || e.metaKey || e.shiftKey) return;
    if ((e.code !== "KeyA" && e.code !== "KeyE") || !(e.ctrlKey || ctrlHeld)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (Date.now() - snapKeyAt < 600) return;
    snapKeyAt = Date.now();
    snapTo(e.code === "KeyA" ? "left" : "right");
  }, true);
  document.addEventListener("selectstart", (e) => {
    if (!document.body.classList.contains("ivlib-fs") || pointerHeld || !ctrlHeld) return;
    const el = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
    if (el?.closest?.("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
    if (shiftHeld) return;
    if (Date.now() - snapKeyAt < 600) return;
    snapKeyAt = Date.now();
    snapTo("left");
  }, true);

  // Snap to one side: that pane open and focused, the other closed. Already
  // there = nothing moves. A fresh snap puts the cursor on the top row.
  let snapTimer = null;
  function snapTo(zone) {
    document.body.classList.add("ivsnap");
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => document.body.classList.remove("ivsnap"), 120);
    if (zone === "left" && isOpen("right")) setNext(false);
    if (zone === "right" && state.open) setOpen(false);
    if (focus.zone === zone && isOpen(zone)) return;
    focusZone(zone);
    if (zone === "left" && !search.q && state.sel < 0) { state.sel = 0; markSel(); }
    if (zone === "right" && getActive() < 0) { setActive(0); markActive(true); }
  }

  // Arrow guide on by default; the centre dot hides / shows it (remembered).
  const HINT_KEY = "ivhint:hidden";
  document.body.classList.toggle("ivhint-off", localStorage.getItem(HINT_KEY) === "1");
  $("ivhint-dot").addEventListener("click", () => {
    const off = !document.body.classList.contains("ivhint-off");
    document.body.classList.toggle("ivhint-off", off);
    localStorage.setItem(HINT_KEY, off ? "1" : "0");
  });

  function libraryKey(e, consume) {
    const k = e.key;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (k === "ArrowRight" && (e.target !== input || atEnd)) { consume(); setOpen(false); setFocus("mid"); return; }
    if (search.q) {
      // Search results.
      const n = listViews.length;
      if (k === "Tab") { consume(); widen(); return; }
      if (k === "ArrowDown" || k === "ArrowUp") {
        consume();
        if (n) { search.active = Math.max(0, Math.min(n - 1, (search.active < 0 ? -1 : search.active) + (k === "ArrowDown" ? 1 : -1))); renderSearch(); }
        return;
      }
      if (k === "Enter") {
        consume();
        if (search.active >= 0) activate(listViews[search.active]);
        else if (!resultCount()) widen();
        else activate(listViews[0]);
        return;
      }
      if ((k === "y" || k === "Y") && !resultCount() && listViews.some((v) => v.type === "widen")) { consume(); widen(); }
      return; // anything else types / edits
    }
    // Browsing.
    const n = listViews.length;
    if ((k === "ArrowDown" || k === "ArrowUp") && n) {
      consume();
      let i = state.sel;
      if (i < 0) {
        const playing = listViews.findIndex((v) => v.uri === Spicetify.Player.data?.item?.uri);
        i = playing >= 0 ? playing : k === "ArrowDown" ? -1 : n;
      }
      state.sel = Math.max(0, Math.min(n - 1, i + (k === "ArrowDown" ? 1 : -1)));
      markSel();
      list.querySelector(".ivlib-row.sel")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (k === "Enter") { consume(); if (state.sel >= 0) activate(listViews[state.sel]); return; }
    if (k === "Backspace" && !input.value) { consume(); goUp(); return; }
    if ((k === "q" || k === "Q") && !input.value && listViews[state.sel]?.type === "track") {
      consume();
      queueNext(listViews[state.sel], list.querySelector(".ivlib-row.sel"));
      return;
    }
    // Printable keys type into the search box even if it lost focus.
    if (k.length === 1 && e.target !== input) input.focus({ preventScroll: true });
  }

  function queueKey(e, consume) {
    const k = e.key;
    if (k === "ArrowLeft") { consume(); setNext(false); setFocus("mid"); return; }
    if (k === "ArrowDown" || k === "ArrowUp") { consume(); moveActive(k === "ArrowDown" ? 1 : -1); return; }
    if (k === "Enter") { consume(); if (getActive() >= 0) activateNext(next.views[getActive()]); return; }
    if (k === "c" || k === "C") { consume(); clearQueue(); return; }
    if (k === "Backspace") {
      consume();
      if (next.stack.length) popNest();
      else { setNext(false); setFocus("mid"); }
    }
  }

  // ---------- album-cover right-click menu ----------
  const ctx = { el: $("ivlib-ctx"), state: null, views: [], active: -1, filterEl: null, editable: null };

  // Playlists the current track can be added to: owned or collaborative.
  async function editablePlaylists() {
    if (ctx.editable) return ctx.editable;
    const all = (await flatLibrary()).filter((it) => it.type === "playlist");
    let me = null;
    try { me = (await Spicetify.Platform.UserAPI?.getUser?.())?.username; } catch {}
    const mine = all.filter((it) => it.isOwnedBySelf || it.canAdd || it.isCollaborative
      || (me && (it.owner?.uri === `spotify:user:${me}` || it.owner?.username === me)));
    return (ctx.editable = mine.length ? mine : all);
  }

  async function addToPlaylist(pl, trackUri) {
    closeCtx();
    if (!trackUri) { Spicetify.showNotification?.("Nothing is playing"); return false; }
    try {
      await Spicetify.Platform.PlaylistAPI.add(pl.uri, [trackUri], { after: "end" });
      Spicetify.showNotification?.(`Added to ${pl.name}`);
      return true;
    } catch (e) {
      console.error("[spotiflux] add to playlist failed", e);
      Spicetify.showNotification?.(`Couldn't add to ${pl.name}`, true);
      return false;
    }
  }

  function openCtx(x, y) {
    const item = Spicetify.Player.data?.item;
    ctx.state = {
      mode: "main", x, y, trackUri: item?.uri,
      albumUri: item?.album?.uri ?? item?.metadata?.album_uri,
      artistUri: item?.artists?.[0]?.uri ?? item?.metadata?.artist_uri,
      artistName: item?.artists?.[0]?.name ?? item?.metadata?.artist_name,
    };
    renderCtx();
  }

  function closeCtx() {
    ctx.state = null;
    ctx.el.hidden = true;
    ctx.el.innerHTML = "";
    ctx.filterEl = null;
    ctx.active = -1;
  }

  function ctxBack() {
    if (ctx.state?.mode === "playlists" && !ctx.state.pick) { ctx.state.mode = "main"; renderCtx(); }
    else closeCtx();
  }

  function moveCtx(d) {
    const n = ctx.views.length;
    if (!n) return;
    ctx.active = Math.max(0, Math.min(n - 1, (ctx.active < 0 ? -1 : ctx.active) + d));
    ctx.el.querySelectorAll(".ivlib-ctx-list .ivlib-ctx-item").forEach((el) => el.classList.toggle("active", +el.dataset.i === ctx.active));
    ctx.el.querySelector(".ivlib-ctx-item.active")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- add to playlist by key ----------
  // Ctrl+Shift+S adds the playing song to the pinned playlist after a one-key
  // confirm (Enter, or Ctrl+Shift+S again). Nothing pinned yet (every Spotify
  // start) opens the picker; Ctrl+Shift+A opens it any time to change the pin.
  // In the picker: ↑ ↓ choose, Enter = pin and add, Tab = pin only.
  let pinned = null; // { uri, name }, this session only
  const keyBoxXY = () => [Math.round(window.innerWidth / 2 - 150), 56];

  function openPicker() {
    const [x, y] = keyBoxXY();
    closeCtx();
    ctx.state = { mode: "playlists", pick: true, x, y, filter: "", trackUri: Spicetify.Player.data?.item?.uri };
    renderCtx();
  }

  let pickAt = 0;
  function pickHotkey() {
    if (Date.now() - pickAt < 600) return; // the keydown and Spotify's select_all message can both arrive
    pickAt = snapKeyAt = Date.now();
    openPicker();
  }

  async function addHotkey() {
    if (ctx.state?.mode === "confirm") return ctx.views[0]?.act(); // pressed twice = yes
    const item = Spicetify.Player.data?.item;
    if (!item?.uri) return;
    // A pin that's no longer an editable playlist (deleted, unfollowed) asks again.
    if (pinned && !(await editablePlaylists()).some((pl) => pl.uri === pinned.uri)) pinned = null;
    if (!pinned) return openPicker();
    const [x, y] = keyBoxXY();
    closeCtx();
    ctx.state = { mode: "confirm", x, y, trackUri: item.uri, song: item.name ?? "" };
    renderCtx();
  }

  function pinPlaylist(pl) {
    if (!pl) return;
    pinned = { uri: pl.uri, name: pl.name };
    closeCtx();
    flashReadout(`pinned ${pl.name}`);
  }

  async function renderCtx() {
    const st = ctx.state;
    if (!st) return;
    if (st.mode === "main") {
      ctx.views = [
        { label: "Show album", disabled: !st.albumUri, act: () => { closeCtx(); showAlbum(st.albumUri); } },
        { label: "Show artist", disabled: !st.artistUri, act: () => { closeCtx(); showArtist(st.artistUri, st.artistName); } },
        { label: "Add to playlist", arrow: "›", disabled: !st.trackUri, act: () => { st.mode = "playlists"; st.filter = ""; renderCtx(); } },
      ];
      ctx.el.innerHTML = ctx.views.map((v, i) =>
        `<div class="ivlib-ctx-item${v.disabled ? " disabled" : ""}" data-i="${i}"><span>${v.label}</span><span>${v.arrow ?? ""}</span></div>`).join("");
      ctx.filterEl = null;
    } else if (st.mode === "confirm") {
      ctx.views = [{ act: () => addToPlaylist(pinned, st.trackUri) }];
      ctx.el.innerHTML = `<div class="ivlib-ctx-item ivconfirm" data-i="0"><span><small>${esc(st.song)}</small>add to <b>${esc(pinned.name)}</b>?<i class="ivcur"></i></span></div>
        <div class="ivlib-ctx-hint">↵ add · ctrl+⇧+a change · esc</div>`;
      ctx.filterEl = null;
    } else {
      if (!ctx.filterEl) {
        const ph = st.pick ? "Pin a playlist for ctrl+⇧+s…" : "Add to playlist…";
        ctx.el.innerHTML = `<input type="text" placeholder="${ph}" spellcheck="false" autocomplete="off"><div class="ivlib-ctx-list"></div>`
          + `<div class="ivlib-ctx-hint">↑ ↓ choose · ↵ ${st.pick ? "add + pin · tab pin only" : "add"} · esc</div>`;
        ctx.filterEl = ctx.el.querySelector("input");
        ctx.filterEl.addEventListener("input", () => { st.filter = ctx.filterEl.value; ctx.active = -1; renderCtx(); });
        ["keydown", "keyup", "keypress"].forEach((t) => ctx.filterEl.addEventListener(t, (e) => e.stopPropagation()));
        setTimeout(() => ctx.filterEl?.focus(), 0);
      }
      const listEl = ctx.el.querySelector(".ivlib-ctx-list");
      if (!ctx.editable) listEl.innerHTML = `<div class="ivlib-empty">Loading playlists…</div>`;
      const lists = await editablePlaylists();
      if (ctx.state !== st || st.mode !== "playlists") return;
      const needle = (st.filter ?? "").toLowerCase();
      ctx.views = lists.filter((pl) => pl.name?.toLowerCase().includes(needle))
        .map((pl) => ({ label: pl.name, pl, act: () => { if (st.pick) pinned = { uri: pl.uri, name: pl.name }; addToPlaylist(pl, st.trackUri); } }));
      listEl.innerHTML = ctx.views.length
        ? ctx.views.map((v, i) => `<div class="ivlib-ctx-item${i === ctx.active ? " active" : ""}" data-i="${i}"><span>${esc(v.label)}</span>`
          + `<span>${v.pl.uri === pinned?.uri ? "pinned" : ""}</span></div>`).join("")
        : `<div class="ivlib-empty">No playlists match.</div>`;
    }
    // Place at the cursor, kept inside the window.
    ctx.el.hidden = false;
    const r = ctx.el.getBoundingClientRect();
    ctx.el.style.left = `${Math.min(st.x, window.innerWidth - r.width - 8)}px`;
    ctx.el.style.top = `${Math.min(st.y, window.innerHeight - r.height - 8)}px`;
  }

  ctx.el.addEventListener("click", (e) => {
    const item = e.target.closest(".ivlib-ctx-item");
    if (item) ctx.views[+item.dataset.i]?.act();
  });


  // Queue list: a click selects, Enter or a double-click plays / opens.
  const rowIndex = (e) => { const row = e.target.closest(".ivlib-row"); return row ? +row.dataset.i : -1; };
  nextList.addEventListener("click", (e) => {
    const i = rowIndex(e);
    if (i < 0) return;
    setActive(i);
    markActive();
  });
  nextList.addEventListener("dblclick", (e) => {
    const i = rowIndex(e);
    if (i >= 0) activateNext(next.views[i]);
  });
  window.addEventListener("resize", () => { if (document.body.classList.contains("ivlib-fs")) layout(); });
  Spicetify.Player.addEventListener("songchange", () => {
    if (document.body.classList.contains("ivnext-open")) setTimeout(renderNext, 300);
  });

  // ---------- lyrics sync offset: gear + dialog ----------
  // A faint gear right of the lyric box shows while the pointer is near the
  // box. It opens a dialog that nudges this track's lyrics earlier (+) or
  // later (-). Offsets live in localStorage ivsync:offsets, { uri: ms }.
  const SYNC_STEPS = [10, 50, 100, 250, 500, 1000];
  const SYNC_LIMIT = 10000; // +-10 s
  const sync = {
    gear: $("ivsync-gear"), dlg: $("ivsync-dlg"), open: false, offset: 0, uri: null,
    step: SYNC_STEPS.includes(+localStorage.getItem("ivsync:step")) ? +localStorage.getItem("ivsync:step") : 100,
  };
  const STORE_OFFSETS = "ivsync:offsets";
  const readOffsets = () => { try { return JSON.parse(localStorage.getItem(STORE_OFFSETS)) ?? {}; } catch { return {}; } };
  const offsets = readOffsets();
  const offsetOf = (uri) => Math.max(-SYNC_LIMIT, Math.min(SYNC_LIMIT, Number(offsets[uri]) || 0));
  function setOffset(uri, ms) {
    if (ms) offsets[uri] = ms; else delete offsets[uri];
    try { localStorage.setItem(STORE_OFFSETS, JSON.stringify(offsets)); }
    catch (e) { console.warn("[spotiflux] sync offset write failed", e); }
  }
  const fmtOffset = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;

  // Gear: just right of the lyric box, at its vertical middle; dialog below it.
  function placeGear() {
    const b = $("ivlyr-box").getBoundingClientRect();
    if (!b.height) return;
    const mid = Math.round(b.top + b.height / 2);
    sync.gear.style.left = `${Math.round(b.right + 4)}px`;
    sync.gear.style.top = `${mid}px`;
    const css = document.documentElement.style;
    css.setProperty("--ivsync-x", `${Math.round(Math.max(8, Math.min(b.right - 236, window.innerWidth - 244)))}px`);
    css.setProperty("--ivsync-y", `${mid + 14}px`);
  }

  function renderSync() {
    const o = sync.offset;
    const dir = o > 0 ? "earlier" : o < 0 ? "later" : "zero";
    const tell = o > 0 ? "◀ lyrics show earlier" : o < 0 ? "lyrics show later ▶" : "in sync with the song";
    // Bar from the centre: left = earlier, right = later; sqrt so small values still show.
    const frac = Math.min(1, Math.sqrt(Math.abs(o) / SYNC_LIMIT));
    sync.dlg.dataset.dir = dir;
    sync.dlg.innerHTML = `
      <div class="ivsync-title">Lyrics sync<span>${esc(Spicetify.Player.data?.item?.name ?? "")}</span></div>
      <div class="ivsync-readout">${fmtOffset(o)}</div>
      <div class="ivsync-tell">${tell}</div>
      <div class="ivsync-meter"><i style="${o > 0 ? "right:50%" : "left:50%"};width:${(frac * 50).toFixed(1)}%"></i><b></b></div>
      <div class="ivsync-row">
        <button class="ivsync-btn" data-act="plus" title="Earlier (+ or ←)">◀ +<small>earlier</small></button>
        <button class="ivsync-btn" data-act="minus" title="Later (− or →)">− ▶<small>later</small></button>
      </div>
      <div class="ivsync-steps">${SYNC_STEPS.map((s, i) =>
        `<button class="ivsync-step${s === sync.step ? " on" : ""}" data-step="${s}" title="Key ${i + 1}">${s >= 1000 ? `${s / 1000}s` : s}</button>`).join("")}</div>
      <div class="ivsync-foot"><button class="ivsync-reset" data-act="reset">reset</button><span>step ${sync.step} ms</span></div>`;
  }

  function openSync() {
    sync.uri = Spicetify.Player.data?.item?.uri ?? null;
    sync.offset = sync.uri ? offsetOf(sync.uri) : 0;
    sync.open = true;
    document.body.classList.add("ivsync-open");
    placeGear();
    renderSync();
  }

  function closeSync() {
    sync.open = false;
    document.body.classList.remove("ivsync-open");
  }

  function nudgeSync(delta) {
    if (!sync.uri) return;
    sync.offset = Math.max(-SYNC_LIMIT, Math.min(SYNC_LIMIT, sync.offset + delta));
    renderSync();
    // Direction flash: the readout kicks the way the lyrics moved.
    const ro = sync.dlg.querySelector(".ivsync-readout");
    ro.classList.add(delta > 0 ? "kick-earlier" : "kick-later");
    setOffset(sync.uri, sync.offset);
  }

  sync.gear.addEventListener("click", () => (sync.open ? closeSync() : openSync()));
  sync.dlg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.step) {
      sync.step = +b.dataset.step;
      localStorage.setItem("ivsync:step", String(sync.step));
      renderSync();
    } else if (b.dataset.act === "plus") nudgeSync(sync.step);
    else if (b.dataset.act === "minus") nudgeSync(-sync.step);
    else if (b.dataset.act === "reset") nudgeSync(-sync.offset);
  });
  // Pointer near the lyric box wakes the gear.
  window.addEventListener("mousemove", (e) => {
    if (!document.body.classList.contains("ivlib-fs")) return;
    const b = $("ivlyr-box").getBoundingClientRect();
    const near = e.clientX > b.left - 40 && e.clientX < b.right + 60 && e.clientY > b.top - 20 && e.clientY < b.bottom + 30;
    document.body.classList.toggle("ivsync-hot", near);
  }, { passive: true });
  Spicetify.Player.addEventListener("songchange", () => { if (sync.open) openSync(); });

  // Dialog keys; called first from the main keydown handler.
  function syncKeys(e) {
    if (!sync.open) return false;
    const k = e.key;
    if (k === "Escape" || k === "Backspace") closeSync();
    // Left is "earlier" everywhere: meter, button, arrow key, kick animation.
    else if (k === "+" || k === "=" || k === "ArrowLeft") nudgeSync(sync.step);
    else if (k === "-" || k === "_" || k === "ArrowRight") nudgeSync(-sync.step);
    else if (k === "0") nudgeSync(-sync.offset);
    else if (/^[1-6]$/.test(k)) { sync.step = SYNC_STEPS[+k - 1]; localStorage.setItem("ivsync:step", String(sync.step)); renderSync(); }
    else return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  }

  // ---------- lyrics: fetch, line clock, translation ----------
  // Spotify's own lyrics first (color-lyrics, through the client's session),
  // else LRCLIB (one request at a time). Found lyrics are cached per track
  // (memory + a small localStorage LRU). A 250 ms clock finds the current line
  // from the player position plus this song's sync offset. For songs that
  // aren't English, Gemini (the user's key) adds translation + pronunciation.
  const LRU_MAX = 40;
  function lru(store, max) {
    const mem = new Map();
    try { for (const [k, v] of JSON.parse(localStorage.getItem(store)) ?? []) mem.set(k, v); } catch {}
    return {
      get: (k) => mem.get(k),
      set(k, v) {
        mem.delete(k);
        mem.set(k, v);
        while (mem.size > max) mem.delete(mem.keys().next().value);
        try { localStorage.setItem(store, JSON.stringify([...mem])); } catch (e) { console.warn("[spotiflux] cache write failed", e); }
      },
    };
  }
  const lyrCache = lru("spotiflux:lyrics-cache", LRU_MAX), trCache = lru("spotiflux:tr-cache", LRU_MAX);
  const noLyrics = new Set(); // this session only: LRCLIB may get them later
  const lyrics = { uri: null, source: "none", synced: false, language: "", lines: [], loading: "", idx: -1, tr: null, english: null };
  const cleanLine = (t) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s === "♪" ? "" : s; };

  async function fromSpotify(uri) {
    const body = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/color-lyrics/v2/track/${uri.split(":")[2]}?format=json&vocalRemoval=false&market=from_token`);
    const l = body?.lyrics;
    if (!l?.lines?.length) return null;
    const synced = l.syncType === "LINE_SYNCED" || l.syncType === "SYLLABLE_SYNCED";
    return {
      source: "spotify", synced, language: l.language && l.language !== "und" ? l.language : "",
      lines: l.lines.map((x) => ({ start_ms: synced ? Number(x.startTimeMs) || 0 : 0, text: cleanLine(x.words) })),
    };
  }

  // "[01:02.34]text" lines, several stamps per line allowed.
  function parseLrc(lrc) {
    const out = [], stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    for (const raw of String(lrc).split(/\r?\n/)) {
      const text = cleanLine(raw.replace(stamp, ""));
      for (const m of raw.matchAll(stamp)) out.push({ start_ms: Math.round((+m[1] * 60 + +m[2]) * 1000), text });
    }
    return out.sort((a, b) => a.start_ms - b.start_ms);
  }

  // LRCLIB asks for one request at a time and a client name (browsers can't
  // set User-Agent, so its Lrclib-Client header).
  let lrcChain = Promise.resolve();
  const LRC_HEADERS = { "Lrclib-Client": `spotiflux ${VERSION} (https://github.com/gigacook/spotiflux)` };
  // A job whose song is no longer playing is skipped; a stalled request gives up after 8 s.
  const lrcGet = (path, wanted) => (lrcChain = lrcChain.catch(() => {}).then(async () => {
    if (!wanted()) throw new Error("song changed");
    const r = await fetch(`https://lrclib.net/api/${path}`, { headers: LRC_HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`lrclib ${r.status}`);
    return r.json();
  }));

  async function fromLrclib(t, wanted) {
    const q = (o) => new URLSearchParams(o).toString();
    const artist = t.artists[0] ?? "", secs = Math.round(t.duration_ms / 1000);
    let hit = await lrcGet(`get?${q({ track_name: t.title, artist_name: artist, album_name: t.album, duration: secs })}`, wanted);
    if (!hit?.syncedLyrics && !hit?.plainLyrics) {
      const found = await lrcGet(`search?${q({ track_name: t.title, artist_name: artist })}`, wanted);
      const all = Array.isArray(found) ? found : [];
      hit = all.find((h) => h.syncedLyrics && Math.abs(h.duration - secs) <= 3) ?? all.find((h) => h.syncedLyrics) ?? all.find((h) => h.plainLyrics);
    }
    if (hit?.syncedLyrics) return { source: "lrclib", synced: true, language: "", lines: parseLrc(hit.syncedLyrics) };
    if (hit?.plainLyrics) return { source: "lrclib", synced: false, language: "", lines: hit.plainLyrics.split(/\r?\n/).map((x) => ({ start_ms: 0, text: cleanLine(x) })) };
    return null;
  }

  async function loadLyrics() {
    const t = trackInfo(), uri = t.uri;
    Object.assign(lyrics, { uri, source: "none", synced: false, language: "", lines: [], loading: "", idx: -1, tr: null, english: null });
    let res = lyrCache.get(uri) ?? (noLyrics.has(uri) ? null : undefined);
    if (res === undefined && /^spotify:(track|local):/.test(uri)) {
      res = null;
      let failed = false;
      if (uri.startsWith("spotify:track:")) {
        lyrics.loading = "spotify";
        lyricsChanged();
        try { res = await fromSpotify(uri); } catch {} // 404 = Spotify has none
      }
      if (!res && t.title && lyrics.uri === uri) {
        lyrics.loading = "lrclib";
        lyricsChanged();
        try { res = await fromLrclib(t, () => lyrics.uri === uri); } catch (e) { failed = true; console.warn("[spotiflux] lrclib failed", e); }
      }
      if (res?.lines.length) lyrCache.set(uri, res);
      else {
        res = null;
        // Only a complete "nobody has them" counts; a skip or an error tries again next time.
        if (!failed && lyrics.uri === uri) noLyrics.add(uri);
      }
    }
    if (lyrics.uri !== uri) return; // the song changed meanwhile
    Object.assign(lyrics, res ?? {}, { loading: "" });
    lyrics.english = lyrics.language ? lyrics.language.startsWith("en")
      : lyrics.lines.length ? looksEnglish(lyrics.lines.slice(0, 60).map((l) => l.text).join(" ")) : null;
    lyricsChanged();
    translate();
  }

  // New lyrics, translations or loading state: box, gear, bridge.
  function lyricsChanged() {
    document.body.classList.toggle("ivlib-nolyrics", !lyrics.loading && !(lyrics.synced && lyrics.lines.length));
    lyrics.idx = -2; // forces a fresh line message
    lyr.key = "";
    if (!lyrics.loading) bridgeSend(lyricsMsg());
    lyricClock();
  }

  // Binary search: the last line that started at or before the position.
  function lyricClock() {
    let idx = -1;
    if (lyrics.synced) {
      const pos = (Spicetify.Player.getProgress?.() ?? 0) + offsetOf(lyrics.uri);
      let lo = 0, hi = lyrics.lines.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (lyrics.lines[m].start_ms <= pos) { idx = m; lo = m + 1; } else hi = m - 1;
      }
    }
    if (idx !== lyrics.idx) {
      lyrics.idx = idx;
      if (!lyrics.loading) bridgeSend({ type: "line", uri: lyrics.uri, index: idx, start_ms: lyrics.lines[idx]?.start_ms ?? 0 });
    }
    updateLyricBox();
  }

  // One Gemini call per song with all lines; answer [{t, p}] per line.
  async function gemini(texts, lang, key) {
    const prompt = `Translate these song lyric lines into the language with code "${lang}". For each line also give its pronunciation in Latin letters if the line is not written in Latin script, otherwise an empty string. Keep empty lines empty. Answer with only a JSON array of exactly ${texts.length} objects {"t": translation, "p": pronunciation}, one per line, in the same order.\n\n${JSON.stringify(texts)}`;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model())}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key }, // a header, so the key never sits in a URL
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      console.warn("[spotiflux] Gemini error", r.status, body?.error?.message ?? "");
      throw new Error(`Gemini ${r.status}`);
    }
    let arr = null;
    try { arr = JSON.parse((body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("")); } catch {}
    if (!Array.isArray(arr) || !arr.some((x) => String(x?.t ?? "").trim())) throw new Error("Gemini reply unreadable");
    return texts.map((_, i) => ({ t: String(arr[i]?.t ?? "").trim(), p: String(arr[i]?.p ?? "").trim() }));
  }

  async function translate() {
    const { uri, lines } = lyrics, key = cfg.key(), lang = cfg.lang();
    if (!key || lyrics.english !== false || !lines.some((l) => l.text)) return;
    let tr = trCache.get(`${uri}|${lang}`);
    if (tr?.length !== lines.length) { // none yet, or made for other lyrics of this song
      try {
        tr = await gemini(lines.map((l) => l.text), lang, key);
        trCache.set(`${uri}|${lang}`, tr);
      } catch (e) {
        console.warn(`[spotiflux] translation failed: ${e.message}`);
        if (lyrics.uri === uri) flashReadout(`translation failed: ${e.message}`, 3000);
        return;
      }
    }
    if (lyrics.uri !== uri || lyrics.lines !== lines || cfg.lang() !== lang) return;
    lyrics.tr = tr;
    lyricsChanged();
  }

  // ---------- lyric box: the current line above the player ----------
  // Per song, decides once whether the lyrics are English (Spotify's language
  // tag, else looksEnglish): then only the original shows; otherwise a tiny
  // original plus the translation.
  const lyr = { el: $("ivlyr-box"), key: "" };
  const EN_WORDS = /\b(the|you|i|i'm|me|my|and|to|in|it|is|of|on|your|we|be|so|not|love|no|all|just|that|what|never|can|don't|oh|this|with|for|like|know|it's|got|get|was|are|now|baby|yeah|when|she|he|they|our|up|down|out|go)\b/gi;
  function looksEnglish(text) {
    const letters = text.replace(/[^\p{L}]/gu, "");
    if (!letters.length) return true;
    const latin = letters.replace(/[^A-Za-z]/g, "").length / letters.length;
    const words = text.split(/\s+/).filter(Boolean).length || 1;
    return latin > 0.97 && (text.match(EN_WORDS) || []).length / words > 0.12;
  }
  function updateLyricBox() {
    if (!document.body.classList.contains("ivlib-fs")) return;
    const i = lyrics.idx, extra = lyrics.tr?.[i] ?? {};
    const orig = lyrics.lines[i]?.text ?? "";
    const tr = lyrOpt.tr && orig ? extra.t ?? "" : "";
    const ph = lyrOpt.ph && orig ? extra.p ?? "" : "";
    const showTr = !!tr && lyrics.english !== true;
    const dual = showTr || !!ph;
    const loading = lyrics.loading;
    const key = `${orig}\u0000${ph}\u0000${showTr ? tr : ""}\u0000${loading}`;
    if (key === lyr.key) return;
    lyr.key = key;
    lyr.el.classList.toggle("dual", dual);
    lyr.el.innerHTML = orig ? `<div class="o">${esc(orig)}</div>${ph ? `<div class="p">${esc(ph)}</div>` : ""}${showTr ? `<div class="t">${esc(tr)}</div>` : ""}`
      : loading ? `<div class="ld">loading ${esc(loading)}…</div>` : "";
    lyr.el.classList.remove("in");
    void lyr.el.offsetWidth; // restart the fade-in
    lyr.el.classList.add("in");
  }

  // Lyric box switches (remembered): the box itself, translation, pronunciation.
  // They only change what the box shows; translations are fetched either way.
  const LYR_OPTS = { on: ["ivlyr:on", "lyrics", true], tr: ["ivlyr:tr", "translation", true], ph: ["ivlyr:ph", "pronunciation", false] };
  const lyrOpt = Object.fromEntries(Object.entries(LYR_OPTS).map(([k, [store, , def]]) => {
    const v = localStorage.getItem(store);
    return [k, v === null ? def : v === "1"];
  }));
  function syncLyrUi() {
    document.body.classList.toggle("ivlyr-off", !lyrOpt.on);
    $("ivlyr-tog").textContent = `lyrics ${lyrOpt.on ? "on" : "off"}`;
  }
  function toggleLyr(k) {
    lyrOpt[k] = !lyrOpt[k];
    localStorage.setItem(LYR_OPTS[k][0], lyrOpt[k] ? "1" : "0");
    syncLyrUi();
    lyr.key = "";
    updateLyricBox();
    flashReadout(`${LYR_OPTS[k][1]} ${lyrOpt[k] ? "on" : "off"}`);
  }
  // Without a Gemini key there's nothing to show: say so on the first press.
  let keyHinted = false;
  function toggleTr() {
    toggleLyr("tr");
    if (!cfg.key() && !keyHinted) { keyHinted = true; flashReadout("translation needs a Gemini key (settings)", 3000); }
  }
  syncLyrUi();
  $("ivlyr-tog").addEventListener("click", () => toggleLyr("on"));
  $("ivhelp-tag").addEventListener("click", () => toggleHelp());

  // ---------- help: Ctrl+Shift+H ----------
  // The README's key table as a searchable list over a keyboard. Matching
  // commands light their keys faintly, the chosen one brightly; Enter runs it
  // when it's an action. Search matches every word anywhere in a row.
  // [keys, keyboard keys, what, where, run?, extra search words?]
  const HELP = [
    ["space", ["space"], "Play / pause", "anywhere"],
    [", / .", [",", "."], "Jump 10 s back / forward", "anywhere", null, "seek skip rewind"],
    ["⇧+, / ⇧+.", ["⇧", ",", "."], "Volume up / down, hold to speed up", "anywhere", null, "louder quieter sound"],
    ["wheel", [], "Volume up / down, 10 per notch", "over the player", null, "mouse scroll louder quieter sound"],
    ["ctrl+⇧+s", ["ctrl", "⇧", "s"], "Add the song to the pinned playlist (asks first)", "fullscreen", () => addHotkey(), "save"],
    ["ctrl+⇧+a", ["ctrl", "⇧", "a"], "Pick or change the pinned playlist", "fullscreen", () => openPicker(), "add to playlist choose"],
    ["ctrl+⇧+l", ["ctrl", "⇧", "l"], "Lyric box on / off", "fullscreen", () => toggleLyr("on"), "lyrics hide show"],
    ["ctrl+⇧+t", ["ctrl", "⇧", "t"], "Translation on / off", "fullscreen", () => toggleTr(), "lyrics translate gemini"],
    ["ctrl+⇧+p", ["ctrl", "⇧", "p"], "Pronunciation on / off", "fullscreen", () => toggleLyr("ph"), "lyrics romaji phonetic"],
    ["ctrl+⇧+h", ["ctrl", "⇧", "h"], "This help", "fullscreen", null, "keys shortcuts"],
    ["esc", ["esc"], "Close panes, dialogs and search: just the player", "fullscreen", () => resetView()],
    ["ctrl+⌫", ["ctrl", "⌫"], "Leave fullscreen", "fullscreen", () => exitFullscreen(), "exit quit"],
    ["ctrl+a", ["ctrl", "a"], "Library pane, queue closed", "fullscreen", () => snapTo("left"), "playlists"],
    ["ctrl+e", ["ctrl", "e"], "Queue pane, library closed", "fullscreen", () => snapTo("right"), "up next"],
    ["← / →", ["←", "→"], "Move between library, player and queue", "fullscreen", null, "focus pane"],
    ["↑ / ↓", ["↑", "↓"], "Move the selection", "panes and pickers"],
    ["↵", ["↵"], "Go in, or play the selected track", "panes", null, "enter open"],
    ["⌫", ["⌫"], "One level back, or close the pane", "panes", null, "backspace up"],
    ["q", ["q"], "Play the selected track next", "library, search box empty", null, "queue"],
    ["c", ["c"], "Clear the songs you queued", "queue pane", () => clearQueue()],
    ["y / ↵ / tab", ["y", "↵", "tab"], "Widen the search: this view, all playlists, Spotify", "library search", null, "find"],
    ["tab", ["tab"], "Pin the chosen playlist without adding", "playlist picker"],
    ["+ / −", ["=", "-"], "Lyrics earlier / later by one step", "sync dialog", null, "offset timing"],
    ["1 – 6", ["1", "2", "3", "4", "5", "6"], "Sync step: 10, 50, 100, 250, 500, 1000 ms", "sync dialog", null, "offset timing"],
    ["0", ["0"], "Reset the sync offset", "sync dialog", null, "timing"],
    ["f12", ["f12"], "Nothing: can't leave fullscreen by accident", "fullscreen"],
    ["right-click cover", [], "Show album, show artist, add to playlist", "player", null, "menu"],
    ["profile menu", [], "spotiflux settings: Gemini key, bridge, start", "anywhere", () => openSettings(), "settings options gemini key translation language autostart"],
    ["bridge", [], "Send Spotify to local apps (ws://127.0.0.1:47474), control off by default", "settings", () => openSettings(), "websocket gigaplay native app port allow control"],
    ["click title / artist", [], "Open the album or artist in the queue pane", "player"],
  ];
  // Ctrl+Shift + key, from onKey.
  const CMDS = {
    KeyS: () => addHotkey(), KeyA: () => pickHotkey(), KeyH: () => toggleHelp(),
    KeyL: () => toggleLyr("on"), KeyT: () => toggleTr(), KeyP: () => toggleLyr("ph"),
  };
  const KB = [
    ["esc", "f12"],
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "⌫"],
    ["tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "↵"],
    ["⇧", "z", "x", "c", "v", "b", "n", "m", ",", ".", "⇧"],
    ["ctrl", "space", "←", "↑", "↓", "→"],
  ];
  const help = { open: false, active: 0, rows: [] };
  const helpQ = $("ivhelp-q"), helpList = $("ivhelp-list"), helpKb = $("ivhelp-kb");
  helpKb.innerHTML = KB.map((row) => `<div>${row.map((k) =>
    `<b data-k="${esc(k)}" style="${k === "space" ? "min-width:170px" : k.length > 1 && k !== "f12" || "⇧⌫↵".includes(k) ? "min-width:44px" : ""}">${esc(k)}</b>`).join("")}</div>`).join("");

  function renderHelp() {
    const words = helpQ.value.toLowerCase().split(/\s+/).filter(Boolean);
    help.rows = HELP.filter((c) => {
      const hay = `${c[0]} ${c[2]} ${c[3]} ${c[5] ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    help.active = Math.max(0, Math.min(help.active, help.rows.length - 1));
    helpList.innerHTML = help.rows.map((c, i) => `<div class="ivhelp-row${i === help.active ? " active" : ""}" data-i="${i}">`
      + `<kbd>${esc(c[0])}</kbd><span>${esc(c[2])}${c[4] ? " <em>↵ run</em>" : ""}</span><i>${esc(c[3])}</i></div>`).join("")
      || `<div class="ivlib-empty">No command matches.</div>`;
    const hit = new Set(words.length ? help.rows.flatMap((c) => c[1]) : []);
    const on = new Set(help.rows[help.active]?.[1] ?? []);
    helpKb.querySelectorAll("b").forEach((b) => {
      b.classList.toggle("on", on.has(b.dataset.k));
      b.classList.toggle("hit", hit.has(b.dataset.k));
    });
    helpList.querySelector(".ivhelp-row.active")?.scrollIntoView({ block: "nearest" });
  }
  function openHelp() {
    help.open = true;
    help.active = 0;
    helpQ.value = "";
    document.body.classList.add("ivhelp-open");
    renderHelp();
    setTimeout(() => helpQ.focus({ preventScroll: true }), 0);
  }
  function closeHelp() {
    if (!help.open) return;
    help.open = false;
    document.body.classList.remove("ivhelp-open");
    if (document.activeElement === helpQ) helpQ.blur();
    if (focus.zone === "left") setFocus("left");
  }
  const toggleHelp = () => (help.open ? closeHelp() : openHelp());
  function runHelp(c) {
    if (!c?.[4]) return;
    closeHelp();
    c[4]();
  }
  function helpKey(e, consume) {
    const k = e.key;
    if (k === "Escape") { consume(); closeHelp(); }
    else if (k === "ArrowDown" || k === "ArrowUp") { consume(); help.active += k === "ArrowDown" ? 1 : -1; renderHelp(); }
    else if (k === "Enter") { consume(); runHelp(help.rows[help.active]); }
    else if (k.length === 1 && e.target !== helpQ) helpQ.focus({ preventScroll: true });
  }
  helpQ.addEventListener("input", () => { help.active = 0; renderHelp(); });
  ["keydown", "keyup", "keypress"].forEach((t) => helpQ.addEventListener(t, (e) => e.stopPropagation()));
  helpList.addEventListener("click", (e) => {
    const row = e.target.closest(".ivhelp-row");
    if (row) { help.active = +row.dataset.i; renderHelp(); }
  });
  helpList.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".ivhelp-row");
    if (row) runHelp(help.rows[+row.dataset.i]);
  });

  // ---------- pointer: one dispatcher ----------
  // Closes menus on outside clicks and moves focus to where you click. A click
  // on empty space in the deck also folds the queue away.
  const OWN_UI = "button, a, input, select, [role=button], [role=link], [role=slider], .sfx-bar, .sfx-link, #sfx-cover,"
    + " #ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg, #ivsync-gear, .ivgrip, #ivhint-dot, #ivexit, #ivstate, #ivhelp";
  window.addEventListener("pointerdown", (e) => {
    if (help.open && !e.target?.closest?.(".ivhelp-box, #ivhelp-tag")) closeHelp();
    if (ctx.state && !ctx.el.contains(e.target)) closeCtx();
    if (sync.open && !sync.dlg.contains(e.target) && !sync.gear.contains(e.target)) closeSync();
    if (e.button !== 0 || !document.body.classList.contains("ivlib-fs")) return;
    if (e.target?.closest?.("#ivlib-panel, #ivlib-tab, #ivnext-tab")) return;
    if (e.target?.closest?.("#ivlib-panel")) { setFocus("left"); return; }
    if (e.target?.closest?.("#ivnext-panel")) { setFocus("right"); return; }
    if (e.target?.closest?.(OWN_UI) || !e.target?.closest?.("#spotiflux-deck")) return;
    if (isOpen("right")) setNext(false);
    setFocus("mid");
  }, true);

  window.addEventListener("keydown", onKey, true);

  // ---------- volume ----------
  // Wheel anywhere over the deck except the panes (they scroll) changes
  // volume in steps of 2, snapped to even numbers: one wheel notch (100) is
  // five steps, 10 points. Trackpads accumulate.
  const vol = { acc: 0, timer: null, el: $("ivvol") };
  function flashReadout(text, ms = 700) {
    vol.el.textContent = text;
    vol.el.classList.add("on");
    clearTimeout(vol.timer);
    vol.timer = setTimeout(() => vol.el.classList.remove("on"), ms);
  }
  function seekBy(ms) {
    try {
      if (ms < 0) Spicetify.Player.skipBack(-ms); else Spicetify.Player.skipForward(ms);
      flashReadout(ms < 0 ? `◀ ${-ms / 1000}s` : `${ms / 1000}s ▶`);
    } catch (e) { console.warn("[spotiflux] seek failed", e); }
  }
  function stepVolume(d) {
    const cur = Math.round(((Spicetify.Player.getVolume?.() ?? 1) * 100) / 2) * 2;
    const v = Math.max(0, Math.min(100, cur + d));
    Spicetify.Player.setVolume(v / 100);
    flashReadout(`vol ${v}`);
  }
  // Shift+, / Shift+. : a press jumps 6; holding (key repeat, ~30/s) starts
  // fine at 2 and ramps to 4, then 6, every ~0.2 s. Even steps keep stepVolume's grid.
  let volRepeats = 0;
  function volumeKey(dir, repeat) {
    volRepeats = repeat ? volRepeats + 1 : 0;
    stepVolume(dir * (repeat ? Math.min(6, 2 + 2 * Math.floor(volRepeats / 6)) : 6));
  }
  window.addEventListener("wheel", (e) => {
    if (!document.body.classList.contains("ivlib-fs")) return;
    if (e.target?.closest?.("#ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg, #sfx-settings")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    vol.acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    while (Math.abs(vol.acc) >= 20) {
      stepVolume(vol.acc < 0 ? 2 : -2);
      vol.acc -= Math.sign(vol.acc) * 20;
    }
    if (Math.abs(e.deltaY) >= 100) vol.acc = 0;
  }, { capture: true, passive: false });
  // Each Spotify start begins at full volume; after that Spotify keeps whatever you set.
  try { Spicetify.Player.setVolume(1); } catch {}

  // ---------- settings (profile menu: "spotiflux settings…") ----------
  // Everything is stored in Spotify's localStorage only. The Gemini key is
  // never logged and never sent anywhere but Google's API.
  const STORE_AUTO = "ivlib:autostart";
  const CFG = {
    key: ["spotiflux:gemini-key", ""], model: ["spotiflux:gemini-model", "gemini-2.5-flash"], lang: ["spotiflux:lang", "en"],
    bridge: ["spotiflux:bridge", "1"], port: ["spotiflux:port", "47474"], control: ["spotiflux:control", "0"],
  };
  const cfg = Object.fromEntries(Object.entries(CFG).map(([k, [store, def]]) => [k, () => localStorage.getItem(store) || def]));
  const setCfg = (k, v) => localStorage.setItem(CFG[k][0], String(v));
  const bridgePort = () => { const p = parseInt(cfg.port(), 10); return p >= 1024 && p <= 65535 ? p : 47474; };
  const autoStart = () => localStorage.getItem(STORE_AUTO) !== "0";

  const setEl = document.createElement("div");
  setEl.id = "sfx-settings";
  setEl.innerHTML = `<div class="sfx-set-box" role="dialog" aria-label="spotiflux settings">
    <h3>Translation</h3>
    <div class="sfx-set-row"><label for="sfx-key">Gemini key</label><input id="sfx-key" type="password" autocomplete="off" spellcheck="false" placeholder="paste your API key">
      <button class="ivlib-btn" id="sfx-key-show">show</button><button class="ivlib-btn" id="sfx-key-clear">clear</button></div>
    <div class="sfx-set-row"><label for="sfx-model">model</label><input id="sfx-model" type="text" spellcheck="false"></div>
    <div class="sfx-set-row"><label for="sfx-lang">into</label><input id="sfx-lang" type="text" spellcheck="false" placeholder="en"></div>
    <p class="sfx-set-note">Get a key at aistudio.google.com/apikey. It stays in Spotify's local storage on this computer.</p>
    <h3>Bridge</h3>
    <label class="sfx-set-check"><input id="sfx-bridge" type="checkbox">send Spotify to local apps</label>
    <div class="sfx-set-row"><label for="sfx-port">port</label><input id="sfx-port" type="number" min="1024" max="65535"></div>
    <label class="sfx-set-check"><input id="sfx-control" type="checkbox">allow control (play, skip, seek, volume, queue, add to playlist)</label>
    <p id="sfx-bridge-status"></p>
    <h3>Start</h3>
    <label class="sfx-set-check"><input id="sfx-auto" type="checkbox">open the deck when Spotify starts</label>
    <div class="sfx-set-foot"><span>spotiflux ${VERSION} · esc closes</span><button class="ivlib-btn" id="sfx-set-close">close</button></div>
  </div>`;
  document.body.appendChild(setEl);
  // Spotify's own shortcuts never see typing in here.
  ["keydown", "keyup", "keypress"].forEach((t) => setEl.addEventListener(t, (e) => e.stopPropagation()));
  const settings = { open: false };
  function openSettings() {
    $("sfx-key").value = cfg.key();
    $("sfx-key").type = "password";
    $("sfx-key-show").textContent = "show";
    $("sfx-model").value = cfg.model();
    $("sfx-lang").value = cfg.lang();
    $("sfx-bridge").checked = cfg.bridge() === "1";
    $("sfx-port").value = bridgePort();
    $("sfx-control").checked = cfg.control() === "1";
    $("sfx-auto").checked = autoStart();
    renderBridgeStatus();
    settings.open = true;
    document.body.classList.add("sfx-settings-open");
    setTimeout(() => $("sfx-key").focus({ preventScroll: true }), 0); // Tab walks the fields from here
  }
  function closeSettings() {
    settings.open = false;
    document.body.classList.remove("sfx-settings-open");
    document.activeElement?.blur?.();
  }
  setEl.addEventListener("pointerdown", (e) => { if (e.target === setEl) closeSettings(); });
  $("sfx-set-close").addEventListener("click", closeSettings);
  $("sfx-key-show").addEventListener("click", () => {
    const k = $("sfx-key");
    k.type = k.type === "password" ? "text" : "password";
    $("sfx-key-show").textContent = k.type === "password" ? "show" : "hide";
  });
  $("sfx-key-clear").addEventListener("click", () => { $("sfx-key").value = ""; $("sfx-key").dispatchEvent(new Event("change")); });
  // Translation settings changed: retry this song with them.
  const retranslate = () => { lyrics.tr = null; lyricsChanged(); translate(); };
  $("sfx-key").addEventListener("change", () => { setCfg("key", $("sfx-key").value.trim()); retranslate(); });
  $("sfx-model").addEventListener("change", () => { setCfg("model", $("sfx-model").value.trim()); retranslate(); });
  $("sfx-lang").addEventListener("change", () => { setCfg("lang", $("sfx-lang").value.trim()); retranslate(); });
  $("sfx-bridge").addEventListener("change", () => { setCfg("bridge", $("sfx-bridge").checked ? "1" : "0"); bridgeRestart(); });
  $("sfx-port").addEventListener("change", () => { setCfg("port", $("sfx-port").value.trim()); $("sfx-port").value = bridgePort(); bridgeRestart(); });
  $("sfx-control").addEventListener("change", () => {
    setCfg("control", $("sfx-control").checked ? "1" : "0");
    bridgeSend(helloMsg()); // receivers learn the new control_allowed
  });
  $("sfx-auto").addEventListener("change", () => {
    localStorage.setItem(STORE_AUTO, $("sfx-auto").checked ? "1" : "0");
    autoItem?.setState(autoStart());
  });

  // ---------- bridge: send Spotify out (spotiflux-bridge v1, docs/bridge.md) ----------
  // A WebSocket client to ws://127.0.0.1:<port>; native apps run the server.
  // Read-only unless "allow control" is on. Reconnects after 2 s, 5 s, 15 s,
  // then every 60 s; logs once per state change. Nothing from the settings
  // (the Gemini key above all) is ever sent.
  const BRIDGE_RETRY_MS = [2000, 5000, 15000, 60000];
  const MAX_FRAME = 65536;
  const bridge = { ws: null, peer: "", tries: 0, timer: null, status: "", last: null, lastAt: 0, openAt: 0 };

  function setBridgeStatus(text) {
    if (text === bridge.status) return;
    bridge.status = text;
    console.info(`[spotiflux] ${text}`);
    renderBridgeStatus();
  }
  function renderBridgeStatus() { if ($("sfx-bridge-status")) $("sfx-bridge-status").textContent = bridge.status; }

  function bridgeConnect() {
    clearTimeout(bridge.timer);
    if (cfg.bridge() !== "1") { setBridgeStatus("bridge: off"); return; }
    const port = bridgePort();
    setBridgeStatus(`bridge: waiting for an app on 127.0.0.1:${port}`);
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`); } // localhost only, never anywhere else
    catch (e) { setBridgeStatus(`bridge: can't open a connection (${e.message})`); return bridgeLater(); }
    bridge.ws = ws;
    ws.onopen = () => {
      bridge.openAt = Date.now();
      bridge.peer = "";
      setBridgeStatus("bridge: connected to an app");
      bridgeSend(helloMsg());
      bridge.last = stateMsg();
      bridge.lastAt = bridge.last.at_epoch_ms;
      bridgeSend(bridge.last);
      if (!lyrics.loading) bridgeSend(lyricsMsg());
    };
    ws.onmessage = (e) => onBridgeFrame(e.data);
    ws.onclose = () => {
      if (bridge.ws !== ws) return; // replaced by bridgeRestart
      bridge.ws = null;
      if (Date.now() - bridge.openAt > 10000) bridge.tries = 0; // an app that drops us at once still backs off
      setBridgeStatus(`bridge: waiting for an app on 127.0.0.1:${port}`);
      bridgeLater();
    };
  }
  function bridgeLater() {
    const ms = BRIDGE_RETRY_MS[Math.min(bridge.tries++, BRIDGE_RETRY_MS.length - 1)];
    bridge.timer = setTimeout(bridgeConnect, ms);
  }
  function bridgeRestart() {
    const ws = bridge.ws;
    bridge.ws = null;
    try { ws?.close(); } catch {}
    bridge.tries = 0;
    bridgeConnect();
  }
  function bridgeSend(msg) {
    if (bridge.ws?.readyState !== WebSocket.OPEN) return;
    try { bridge.ws.send(JSON.stringify({ v: 1, ...msg })); } catch (e) { console.warn("[spotiflux] bridge send failed", e); }
  }

  const spotifyVersion = () => String(Spicetify.Platform?.version ?? Spicetify.Platform?.PlatformData?.client_version_triple ?? "");
  const helloMsg = () => ({ type: "hello", app: "spotiflux", version: VERSION, spotify_version: spotifyVersion(), control_allowed: cfg.control() === "1" });
  const REPEAT = ["off", "context", "track"];
  function stateMsg() {
    const P = Spicetify.Player, t = trackInfo(), c = P.data?.context;
    return {
      type: "state", playing: !!P.isPlaying?.(), uri: t.uri, title: t.title, artists: t.artists, album: t.album,
      album_uri: t.album_uri, cover_url: t.cover_url, duration_ms: Math.round(P.getDuration?.() || t.duration_ms),
      position_ms: Math.round(P.getProgress?.() ?? 0), at_epoch_ms: Date.now(), volume: Math.round((P.getVolume?.() ?? 1) * 100) / 100,
      shuffle: !!P.getShuffle?.(), repeat: REPEAT[P.getRepeat?.() ?? 0] ?? "off",
      context_uri: c?.uri ?? "", context_name: c?.metadata?.context_description ?? "",
    };
  }
  const lyricsMsg = () => ({
    type: "lyrics", uri: lyrics.uri ?? "", source: lyrics.lines.length ? lyrics.source : "none", synced: lyrics.synced, language: lyrics.language,
    lines: lyrics.lines.map((l, i) => {
      const x = lyrics.tr?.[i];
      return { start_ms: l.start_ms, text: l.text, ...(x?.t ? { translation: x.t } : {}), ...(x?.p ? { pronunciation: x.p } : {}) };
    }),
  });
  function queueMsg() {
    const { cur, nxt } = queueSnapshot();
    const out = (v) => ({ uri: v.uri, title: v.title, artists: v.artists, provider: v.provider });
    return { type: "queue", current: cur ? out(cur) : null, next: nxt.map(out) };
  }

  // Every 250 ms: send state on a change (song, play/pause, volume, shuffle,
  // repeat), on a seek (position off by more than 1.5 s), and every 5 s.
  function bridgeTick() {
    if (bridge.ws?.readyState !== WebSocket.OPEN) return;
    const s = stateMsg(), l = bridge.last, now = s.at_epoch_ms;
    const expected = l ? l.position_ms + (l.playing ? now - l.at_epoch_ms : 0) : 0;
    const changed = !l || ["playing", "uri", "volume", "shuffle", "repeat", "duration_ms"].some((k) => s[k] !== l[k]);
    if (changed || Math.abs(s.position_ms - expected) > 1500 || now - bridge.lastAt >= 5000) {
      bridge.last = s;
      bridge.lastAt = now;
      bridgeSend(s);
    }
  }

  // Incoming frames: validate everything, ignore what we don't know.
  const URI_TRACK = /^spotify:(track|episode):[A-Za-z0-9]{22}$/, URI_PLAYLIST = /^spotify:playlist:[A-Za-z0-9]{22}$/;
  const clampNum = (x, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null);
  function onBridgeFrame(data) {
    if (typeof data !== "string" || data.length > MAX_FRAME) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object" || m.v !== 1) return;
    const id = typeof m.id === "string" || Number.isFinite(m.id) ? String(m.id).slice(0, 64) : "";
    const ack = (ok, error) => bridgeSend({ type: "ack", id, ok, ...(error ? { error } : {}) });
    if (m.type === "hello") {
      bridge.peer = String(m.app ?? "an app").replace(/[^\w .:+()-]/g, "").slice(0, 64) || "an app";
      setBridgeStatus(`bridge: connected to ${bridge.peer}${m.version ? ` ${String(m.version).slice(0, 24)}` : ""}`);
    } else if (m.type === "get") {
      const makers = { state: stateMsg, lyrics: lyricsMsg, queue: queueMsg };
      if (Object.hasOwn(makers, m.what)) bridgeSend({ ...makers[m.what](), id }); else ack(false, "unknown what");
    } else if (m.type === "cmd") {
      if (cfg.control() !== "1") return ack(false, "control off");
      runBridgeCmd(m).then(() => ack(true), (e) => ack(false, String(e?.message ?? e).slice(0, 200)));
    }
  }
  async function runBridgeCmd(m) {
    const P = Spicetify.Player;
    switch (m.cmd) {
      case "play": return P.play();
      case "pause": return P.pause();
      case "toggle": return P.togglePlay();
      case "next": return P.next();
      case "prev": return P.back();
      case "seek": {
        const ms = clampNum(m.position_ms, 0, P.getDuration?.() || 0);
        if (ms === null) throw new Error("bad position_ms");
        return P.seek(Math.max(2, Math.round(ms))); // seek() reads 0..1 as a fraction
      }
      case "volume": {
        const v = clampNum(m.value, 0, 1);
        if (v === null) throw new Error("bad value");
        return P.setVolume(v);
      }
      case "queue_next":
        if (typeof m.uri !== "string" || !URI_TRACK.test(m.uri)) throw new Error("bad uri");
        if (!(await queueNext({ uri: m.uri, name: m.uri }))) throw new Error("queue refused");
        return;
      case "add_to_playlist": {
        let pl = pinned;
        if (m.playlist_uri != null) {
          if (typeof m.playlist_uri !== "string" || !URI_PLAYLIST.test(m.playlist_uri)) throw new Error("bad playlist_uri");
          pl = (await editablePlaylists()).find((p) => p.uri === m.playlist_uri);
          if (!pl) throw new Error("not an editable playlist");
        }
        if (!pl) throw new Error("no pinned playlist");
        if (!(await addToPlaylist(pl, P.data?.item?.uri))) throw new Error("add failed");
        return;
      }
      default: throw new Error("unknown cmd");
    }
  }

  // ---------- open / close the deck ----------
  // Play a context, open the deck with the library pane, and come back to
  // `from` when it's closed (playlist-home calls this).
  let returnPath = null;
  window.ivlib = {
    async launch(uri, from) {
      localStorage.setItem(STORE_OPEN, "1");
      try { await Spicetify.Player.playUri(uri); } catch (e) { console.error("[spotiflux] play failed", e); }
      if (document.body.classList.contains("ivlib-fs")) { focusZone("left"); return; }
      returnPath = from ?? null;
      enterFullscreen();
    },
  };

  function setFs(on) {
    if (on === document.body.classList.contains("ivlib-fs")) return;
    document.body.classList.toggle("ivlib-fs", on);
    if (on) {
      document.body.appendChild(root); // last in <body>: wins equal-z ties
      renderDeck();
      tickDeck();
      layout();
      setOpen(localStorage.getItem(STORE_OPEN) === "1");
      if (state.open) autoNow(); // pane was already open when the deck was left
      setFocus(state.open ? "left" : null);
      setTimeout(hideCornerChrome, 600);
      lyr.key = "";
      updateLyricBox();
    } else {
      if (state.open) state.hiddenAt = Date.now();
      if (document.activeElement === deck.vol) deck.vol.blur();
      closeHelp();
      closeCtx();
      closeSync();
      setFocus(null);
      setNext(false);
      if (returnPath) { Spicetify.Platform.History.push(returnPath); returnPath = null; }
    }
  }
  const enterFullscreen = () => setFs(true);
  const exitFullscreen = () => setFs(false);
  window.ivlib.enter = enterFullscreen;
  $("ivexit").addEventListener("click", exitFullscreen);
  try {
    const deckIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="3" height="10" rx=".8"/><rect x="5.5" y="2" width="5" height="12" rx="1"/><rect x="12" y="3" width="3" height="10" rx=".8"/></svg>`;
    new Spicetify.Topbar.Button("spotiflux deck", deckIcon, () => enterFullscreen());
  } catch (e) { console.warn("[spotiflux] top-bar button unavailable", e); }

  // At Spotify start: straight into the deck with the library pane (unless
  // switched off), else playlist-home (if installed) instead of Spotify's
  // home feed. Leaving the deck lands on that start page.
  try {
    const H = Spicetify.Platform.History;
    const home = Spicetify.Config?.custom_apps?.includes("playlist-home") ? "/playlist-home" : null;
    if (["/", "/home"].includes(H.location.pathname)) {
      if (home) H.replace(home);
      if (autoStart()) {
        if (localStorage.getItem(STORE_OPEN) === null) localStorage.setItem(STORE_OPEN, "1");
        returnPath = home ?? "/";
        enterFullscreen();
      }
    }
  } catch (e) { console.warn("[spotiflux] start-page redirect failed", e); }
  let autoItem = null;
  try {
    autoItem = new Spicetify.Menu.Item("Open the spotiflux deck at start", autoStart(), (item) => {
      localStorage.setItem(STORE_AUTO, autoStart() ? "0" : "1");
      item.setState(autoStart());
    });
    autoItem.register();
    new Spicetify.Menu.Item("spotiflux settings…", false, () => openSettings()).register();
  } catch (e) { console.warn("[spotiflux] profile-menu items unavailable", e); }

  // One clock for the deck, the lyric line and the bridge.
  setInterval(() => {
    if ((Spicetify.Player.data?.item?.uri ?? "") !== lyrics.uri) loadLyrics();
    lyricClock();
    if (document.body.classList.contains("ivlib-fs")) tickDeck();
    bridgeTick();
  }, 250);
  bridgeConnect();
})();
