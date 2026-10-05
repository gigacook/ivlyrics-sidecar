// ivlyrics-sidecar — Spicetify extension that rides along with ivLyrics.
// It never edits ivLyrics: it waits for ivLyrics fullscreen
// (`.lyrics-lyricsContainer-LyricsContainer.fullscreen-active`) and layers on top.
//
// Layout: library pane | player | queue pane. Both panes take the same slice
// of the window so the centred player is never covered. ivLyrics' lyrics
// column is hidden; the current line shows in a box above the player.
//
// Keys (one dispatcher, onKey): Space play/pause anywhere; Esc back to just
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
//
// Library: playlists open in place, newest tracks first; after a minute away
// it reopens on the playing playlist; q queues a track next;
// "back.." jumps to what's playing; search widens on Y / Enter / Tab from this
// view to all playlists to Spotify. Queue: up next, plus album / artist views
// from the title, album and artist links and the cover's right-click menu.
// Also: per-track sync offset dialog (gear by the lyric box), hidden window
// buttons until hovered, and window.ivlib.launch() for playlist-home.
(function ivlyricsSidecar() {
  if (!window.Spicetify?.Platform?.LibraryAPI || !Spicetify.Player || !document.body) {
    setTimeout(ivlyricsSidecar, 300);
    return;
  }

  const FS_SELECTOR = ".lyrics-lyricsContainer-LyricsContainer.fullscreen-active";
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
    /* ivLyrics' lyrics column is replaced by the lyric box; it keeps running
       (the box reads its active line) but is never shown or clickable. */
    body.ivlib-fs ${FS_SELECTOR} :is(.lyrics-lyricsContainer-SyncedLyricsPage, .lyrics-lyricsContainer-UnsyncedLyricsPage, .lyrics-lyricsContainer-LyricsUnavailablePage) {
      visibility: hidden !important; pointer-events: none !important;
    }
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
    /* Presentation switcher (standard/vinyl/video stage) pops up on album hover
       and is too easy to hit by accident. */
    .fullscreen-presentation-dock { display: none !important; }
    /* Album-cover right-click menu (replaces ivLyrics' AI "research"). */
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
    /* ivLyrics' hover hint advertising the AI right-click. */
    .album-mode-hint .album-mode-action.is-secondary { display: none !important; }

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
    #ivlyr-box .o { font-size: 17px; font-weight: 700; line-height: 1.3; }
    #ivlyr-box.dual .o { font-size: 9px; font-weight: 500; line-height: 1.15; opacity: .75; letter-spacing: -.01em; }
    #ivlyr-box.dual .t { font-size: 12px; font-weight: 700; line-height: 1.15; letter-spacing: -.01em; }
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

    /* ivLyrics' loading pill moves into the lyric box. */
    body.ivlib-fs .lyrics-generation-status-stack { display: none !important; }
    #ivlyr-box .ld { font-size: 10px; letter-spacing: .06em; opacity: .45; }

    /* ivLyrics' "LYRICS PROVIDER <name>" footer: gone. */
    .lyrics-lyricsContainer-Provider { display: none !important; }
    /* ivLyrics' floating-notes "no lyrics" animation: never. */
    svg.lyrics-noLyricsMotion { display: none !important; }
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
  root.innerHTML = `
    <button id="ivlib-tab" class="ivgrip" title="Library (Ctrl+A)"></button>
    <button id="ivnext-tab" class="ivgrip" title="Queue (Ctrl+E)"></button>
    <div class="ivedge" id="ivedge-l">◂ library</div>
    <div class="ivedge" id="ivedge-r">queue ▸</div>
    <div class="ivedge" id="ivkey-l">ctrl+a</div>
    <div class="ivedge" id="ivkey-r">ctrl+e</div>
    <div class="ivedge" id="ivexit" title="Leave fullscreen (Ctrl+Backspace)">ctrl+⌫ exit</div>
    <div id="ivhint"><span class="lf">lib <svg viewBox="0 0 16 12"><path d="M0 6 7 0v3.6h9v4.8H7V12z" fill="currentColor"/></svg></span><button id="ivhint-dot" title="Show / hide the arrow guide"></button><span class="rt"><svg viewBox="0 0 16 12"><path d="M16 6 9 0v3.6H0v4.8h9V12z" fill="currentColor"/></svg> que</span></div>
    <div id="ivvol"></div>
    <div id="ivnext-divider"><div class="zip"></div><svg class="cog" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.3"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="white" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></div>
    <div id="ivlib-ctx" hidden></div>
    <div id="ivlyr-box"></div>
    <button id="ivsync-gear" title="Lyrics sync offset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="currentColor" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></button>
    <div id="ivsync-dlg"></div>
    <aside id="ivnext-panel">
      <div id="ivnext-feedback">feedback · github.com/gigacook/ivlyrics-sidecar/issues</div>
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
      console.error("[ivlyrics-sidecar] load failed", e);
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
    try { await walk(null); } catch (e) { console.error("[ivlyrics-sidecar] flatten failed", e); }
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
          catch (e) { console.warn("[ivlyrics-sidecar] index skip", pl.name, e); }
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
        } catch (e) { console.warn(`[ivlyrics-sidecar] ${chunk} not readable, using built-in hash`, e); }
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
        if (!items) { console.warn(`[ivlyrics-sidecar] ${name}: no tracks`, res?.errors ?? res); continue; }
        return items.map((it) => {
          const d = it?.item?.data ?? it?.data ?? {};
          return toView(d.uri, d.name, (d.artists?.items ?? []).map((a) => a.profile?.name).join(", "));
        }).filter((t) => t.uri);
      } catch (e) { console.warn(`[ivlyrics-sidecar] ${name} failed`, e); }
    }
    try {
      const res = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/search?type=track&limit=30&q=${encodeURIComponent(q)}`);
      return (res?.tracks?.items ?? []).map((t) => toView(t.uri, t.name, t.artists.map((a) => a.name).join(", ")));
    } catch (e) {
      console.warn("[ivlyrics-sidecar] web api search failed", e);
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
    } catch (e) {
      console.warn("[ivlyrics-sidecar] queue next failed", e);
      Spicetify.showNotification?.(`Couldn't queue ${v.name}`, true);
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
      console.warn("[ivlyrics-sidecar] clear queue failed", e);
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
      catch (e) { console.warn("[ivlyrics-sidecar] context play failed", e); Spicetify.Player.playUri(v.uri); }
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
    } catch (e) { console.warn("[ivlyrics-sidecar] window buttons API not found", e); }
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
  const next = { views: [], timer: null, bandTimer: null, stack: [], qActive: -1, rendered: null };
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
      type: "track", section, uri, uid: ct.uid ?? t?.uid,
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
    catch (e) { console.warn(`[ivlyrics-sidecar] ${entry.kind} load failed`, e); node.error = true; }
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
      console.warn("[ivlyrics-sidecar] skip failed, playing track alone", e);
      Spicetify.Player.playUri(v.uri);
    }
  }

  // ---------- layout ----------
  // Library | player | queue. Both panes are the same width (27.5% of the
  // window, 200-380px) so the centred player never sits under one. The player
  // block (cover to controls) is moved with `translate`, leaving room above it
  // for the lyric box. The queue list fills the band from 33% to 66% of the
  // height, or the player's full height if that's taller.
  const leftPanel = () => document.querySelector(`${FS_SELECTOR} .lyrics-fullscreen-left-panel`);
  const paneWidth = () => Math.round(Math.min(380, Math.max(200, window.innerWidth * 0.275)));
  function readShift(lp) {
    const [x, y] = (lp.style.translate || "0px 0px").split(" ").map((v) => parseFloat(v) || 0);
    return { x, y };
  }

  function layout() {
    const css = document.documentElement.style;
    const W = window.innerWidth, H = window.innerHeight, pw = paneWidth();
    css.setProperty("--ivlib-w", `${pw}px`);
    css.setProperty("--ivnext-w", `${pw}px`);
    let top = H * 0.33, bottom = H * 0.66, playerTop = H * 0.3;
    const lp = leftPanel();
    if (lp) {
      const rects = [...lp.querySelectorAll(".lyrics-fullscreen-left-content, .fullscreen-left-controls")]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
      if (rects.length) {
        const cur = readShift(lp);
        const cTop = Math.min(...rects.map((r) => r.top)) - cur.y;
        const cBot = Math.max(...rects.map((r) => r.bottom)) - cur.y;
        const cMid = (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.right))) / 2 - cur.x;
        const h = cBot - cTop;
        // Top at 28% (room for the lyric box) unless that pushes it off-screen.
        let pTop = Math.max(H * 0.28, (H - h) / 2);
        if (pTop + h > H - 12) pTop = Math.max(8, H - 12 - h);
        const x = Math.round(W / 2 - cMid), y = Math.round(pTop - cTop);
        if (Math.abs(x - cur.x) > 1 || Math.abs(y - cur.y) > 1) lp.style.translate = `${x}px ${y}px`;
        top = Math.min(top, pTop);
        bottom = Math.max(bottom, pTop + h);
        playerTop = pTop;
      }
    }
    css.setProperty("--ivnext-top", `${Math.max(8, Math.round(top))}px`);
    css.setProperty("--ivnext-bottom", `${Math.max(8, Math.round(H - bottom))}px`);
    css.setProperty("--ivlyr-w", `${Math.max(160, Math.min(440, W - 2 * pw - 48))}px`);
    // The lyric box runs from under the arrow guide (top row) to just above the cover.
    css.setProperty("--ivlyr-bottom", `${Math.round(H - playerTop + 24)}px`);
    placeGear();
  }

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
    const field = e.target?.matches?.("input, textarea, [contenteditable='true']") ? e.target : null;

    // 1. Space: play/pause anywhere in Spotify, except mid-text in a text box.
    if (e.code === "Space" && !mod && !(field && (field.value ?? field.textContent ?? "").length)) {
      consume();
      if (!e.repeat) Spicetify.Player.togglePlay();
      return;
    }
    if (!fs) return;
    // F12 (or whatever ivLyrics' fullscreen key is) never leaves; Ctrl+Backspace does.
    const fsKey = (localStorage.getItem("ivLyrics:visual:fullscreen-key") || "f12").toLowerCase();
    if (e.key === "F12" || (!field && (e.key ?? "").toLowerCase() === fsKey)) { consume(); return; }
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
      if (e.key === "Backspace" && !(inFilter && ctx.filterEl.value)) { consume(); ctxBack(); return; }
      if (e.key === "Enter" && inFilter) { consume(); ctx.views[0]?.act(); return; }
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

  // Spotify binds Ctrl+A to its own "select all" and can swallow the keydown
  // before us (Ctrl+E has no such binding). Fallbacks: the key's release, and
  // the page-wide select-all it triggers. snapKeyAt stops double snaps.
  let snapKeyAt = 0, ctrlHeld = false, pointerHeld = false;
  window.addEventListener("keydown", (e) => { if (e.key === "Control") ctrlHeld = true; }, true);
  window.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
  window.addEventListener("pointerup", () => { pointerHeld = false; }, true);
  window.addEventListener("blur", () => { ctrlHeld = false; pointerHeld = false; });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control") { ctrlHeld = false; return; }
    if (!document.body.classList.contains("ivlib-fs") || e.altKey || e.metaKey) return;
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
    if (Date.now() - snapKeyAt < 600) return;
    snapKeyAt = Date.now();
    snapTo("left");
  }, true);

  // Snap to one side: that pane open and focused, the other closed. Already
  // there = nothing moves. A fresh snap puts the cursor on the top row.
  function snapTo(zone) {
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
  const ctx = { el: $("ivlib-ctx"), state: null, views: [], filterEl: null, editable: null };

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
    try {
      await Spicetify.Platform.PlaylistAPI.add(pl.uri, [trackUri], { after: "end" });
      Spicetify.showNotification?.(`Added to ${pl.name}`);
    } catch (e) {
      console.error("[ivlyrics-sidecar] add to playlist failed", e);
      Spicetify.showNotification?.(`Couldn't add to ${pl.name}`, true);
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
  }

  function ctxBack() {
    if (ctx.state?.mode === "playlists") { ctx.state.mode = "main"; renderCtx(); }
    else closeCtx();
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
    } else {
      if (!ctx.filterEl) {
        ctx.el.innerHTML = `<input type="text" placeholder="Add to playlist…" spellcheck="false" autocomplete="off"><div class="ivlib-ctx-list"></div>`;
        ctx.filterEl = ctx.el.querySelector("input");
        ctx.filterEl.addEventListener("input", () => { st.filter = ctx.filterEl.value; renderCtx(); });
        ["keydown", "keyup", "keypress"].forEach((t) => ctx.filterEl.addEventListener(t, (e) => e.stopPropagation()));
        setTimeout(() => ctx.filterEl?.focus(), 0);
      }
      const listEl = ctx.el.querySelector(".ivlib-ctx-list");
      if (!ctx.editable) listEl.innerHTML = `<div class="ivlib-empty">Loading playlists…</div>`;
      const lists = await editablePlaylists();
      if (ctx.state !== st || st.mode !== "playlists") return;
      const needle = (st.filter ?? "").toLowerCase();
      ctx.views = lists.filter((pl) => pl.name?.toLowerCase().includes(needle))
        .map((pl) => ({ label: pl.name, act: () => addToPlaylist(pl, st.trackUri) }));
      listEl.innerHTML = ctx.views.length
        ? ctx.views.map((v, i) => `<div class="ivlib-ctx-item" data-i="${i}"><span>${esc(v.label)}</span></div>`).join("")
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
  const onAlbumCover = (e) => document.body.classList.contains("ivlib-fs")
    && e.target?.closest?.(`${FS_SELECTOR} .lyrics-fullscreen-album-container`);
  // Capture on window runs before ivLyrics' React handlers (AI research / hold).
  window.addEventListener("contextmenu", (e) => {
    if (!onAlbumCover(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openCtx(e.clientX, e.clientY);
  }, true);
  // Album name / song title under the cover: ivLyrics links them to Spotify's
  // album/track page (leaving fullscreen). Open the album in the queue pane instead.
  const ALBUM_LINKS = [
    ".lyrics-fullscreen-album-name", ".fullscreen-tv-album-name", ".portrait-track-album-name",
    ".lyrics-fullscreen-title-container", ".fullscreen-tv-title-container",
    ".portrait-track-title", ".portrait-track-title-sub",
  ].map((c) => `${FS_SELECTOR} ${c}.fullscreen-navigation-link`).join(", ");
  const openAlbumFromLink = (e) => {
    if (!e.target?.closest?.(ALBUM_LINKS)) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const item = Spicetify.Player.data?.item;
    showAlbum(item?.album?.uri ?? item?.metadata?.album_uri);
  };
  window.addEventListener("click", openAlbumFromLink, true);
  window.addEventListener("keydown", openAlbumFromLink, true);

  // Artist name: same idea, opens the artist's releases in the right pane.
  const ARTIST_LINKS = [
    ".lyrics-fullscreen-artist-container", ".fullscreen-tv-artist-container",
    ".portrait-track-artist", ".portrait-track-artist-sub",
  ].map((c) => `${FS_SELECTOR} ${c}.fullscreen-navigation-link`).join(", ");
  const openArtistFromLink = (e) => {
    if (!e.target?.closest?.(ARTIST_LINKS)) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const item = Spicetify.Player.data?.item;
    showArtist(item?.artists?.[0]?.uri ?? item?.metadata?.artist_uri, item?.artists?.[0]?.name ?? item?.metadata?.artist_name);
  };
  window.addEventListener("click", openArtistFromLink, true);
  window.addEventListener("keydown", openArtistFromLink, true);


  // Layout is re-measured every 300ms in fullscreen: controls auto-hide and
  // title length change the player's height.
  function startBand(on) {
    clearInterval(next.bandTimer);
    if (on) { layout(); next.bandTimer = setInterval(layout, 300); }
  }

  // Marks songs without lyrics (hides the sync gear).
  function checkLyricsState() {
    if (!document.body.classList.contains("ivlib-fs")) return;
    const fs = document.querySelector(FS_SELECTOR);
    const none = !!fs?.querySelector(".lyrics-lyricsContainer-LyricsUnavailablePage") && !fs.classList.contains("fullscreen-lyrics-loading");
    document.body.classList.toggle("ivlib-nolyrics", none);
  }
  setInterval(checkLyricsState, 500);

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
  // later (-) through ivLyrics' own per-track offset.
  const SYNC_STEPS = [10, 50, 100, 250, 500, 1000];
  const SYNC_LIMIT = 10000; // ivLyrics clamps to +-10s
  const sync = {
    gear: $("ivsync-gear"), dlg: $("ivsync-dlg"), open: false, offset: 0, uri: null,
    step: SYNC_STEPS.includes(+localStorage.getItem("ivsync:step")) ? +localStorage.getItem("ivsync:step") : 100,
  };
  const syncApi = () => window.Utils;
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

  async function openSync() {
    sync.uri = Spicetify.Player.data?.item?.uri ?? null;
    sync.offset = sync.uri ? Number(await syncApi()?.getTrackSyncOffset?.(sync.uri)) || 0 : 0;
    sync.open = true;
    document.body.classList.add("ivsync-open");
    placeGear();
    renderSync();
  }

  function closeSync() {
    sync.open = false;
    document.body.classList.remove("ivsync-open");
  }

  async function nudgeSync(delta) {
    if (!sync.uri) return;
    sync.offset = Math.max(-SYNC_LIMIT, Math.min(SYNC_LIMIT, sync.offset + delta));
    renderSync();
    // Direction flash: the readout kicks the way the lyrics moved.
    const ro = sync.dlg.querySelector(".ivsync-readout");
    ro.classList.add(delta > 0 ? "kick-earlier" : "kick-later");
    try { await syncApi()?.setTrackSyncOffset?.(sync.uri, sync.offset); }
    catch (e) { console.warn("[ivlyrics-sidecar] sync offset write failed", e); }
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

  // ---------- lyric box: the current line above the player ----------
  // Mirrors ivLyrics' active line (its own column stays hidden). Per song,
  // decides once whether the lyrics are English: then only the original shows;
  // otherwise a tiny original plus the translation.
  const lyr = { el: $("ivlyr-box"), key: "", uri: null, english: null };
  const LINE_SKIP = ".lyrics-lyricsContainer-LyricsLine-translation, .lyrics-lyricsContainer-LyricsLine-phonetic,"
    + " .lyrics-lyricsContainer-LyricsLine-culturalNote, rt";
  // Also drops ivLyrics' cultural-note markers ("word[1]").
  const flat = (t) => (t ?? "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
  function lineText(line) {
    const c = line.cloneNode(true);
    c.querySelectorAll(LINE_SKIP).forEach((n) => n.remove());
    return flat(c.textContent);
  }
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
    const fs = document.querySelector(FS_SELECTOR);
    const uri = Spicetify.Player.data?.item?.uri;
    if (lyr.uri !== uri || lyr.english === null) {
      const lines = [...(fs?.querySelectorAll(".lyrics-lyricsContainer-LyricsLine:not(.lyrics-lyricsContainer-LyricsLine-paddingLine)") ?? [])]
        .slice(0, 60).map(lineText).filter(Boolean);
      lyr.uri = uri;
      lyr.english = lines.length ? looksEnglish(lines.join(" ")) : null;
    }
    // The scroll anchor is the true current line. Without one, the last
    // highlighted line: karaoke rows can stay "active" long after they end,
    // so the first match in the page would freeze on an old line.
    const active = fs?.querySelector(".lyrics-lyricsContainer-LyricsLine-scrollCurrent")
      ?? [...(fs?.querySelectorAll(".lyrics-lyricsContainer-LyricsLine-active:not(.lyrics-lyricsContainer-LyricsLine-paddingLine)") ?? [])].pop();
    const orig = active ? lineText(active) : "";
    const tr = flat(active?.querySelector(".lyrics-lyricsContainer-LyricsLine-translation")?.textContent);
    const dual = !!tr && lyr.english !== true;
    // ivLyrics' loading pill (hidden) -> a quiet "loading <provider>…" line.
    const pill = !orig && [...(fs?.querySelectorAll(".lyrics-generation-status-stack .lyrics-translation-loading-indicator") ?? [])]
      .find((el) => !/complete|done|success|hidden/i.test(el.dataset.phase ?? ""));
    const loading = pill ? flat(pill.querySelector(".lyrics-generation-status-loading-label")?.textContent).toLowerCase() || "lyrics" : "";
    const key = `${orig}\u0000${dual ? tr : ""}\u0000${loading}`;
    if (key === lyr.key) return;
    lyr.key = key;
    lyr.el.classList.toggle("dual", dual);
    lyr.el.innerHTML = orig ? `<div class="o">${esc(orig)}</div>${dual ? `<div class="t">${esc(tr)}</div>` : ""}`
      : loading ? `<div class="ld">loading ${esc(loading)}…</div>` : "";
    lyr.el.classList.remove("in");
    void lyr.el.offsetWidth; // restart the fade-in
    lyr.el.classList.add("in");
  }
  setInterval(updateLyricBox, 250);

  // ---------- pointer: one dispatcher ----------
  // Closes menus on outside clicks, keeps the cover's right-press away from
  // ivLyrics' hold-to-research, and moves focus to where you click. A click on
  // empty space in the middle also folds the queue away.
  const OWN_UI = "button, a, input, select, [role=button], [role=link], [role=slider], .fullscreen-progress-bar,"
    + " .lyrics-fullscreen-album-container, #ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg, #ivsync-gear, .ivgrip, #ivhint-dot, #ivexit";
  window.addEventListener("pointerdown", (e) => {
    if (ctx.state && !ctx.el.contains(e.target)) closeCtx();
    if (sync.open && !sync.dlg.contains(e.target) && !sync.gear.contains(e.target)) closeSync();
    if (e.button === 2 && onAlbumCover(e)) { e.stopImmediatePropagation(); return; }
    if (e.button !== 0 || !document.body.classList.contains("ivlib-fs")) return;
    if (e.target?.closest?.("#ivlib-panel, #ivlib-tab, #ivnext-tab")) return;
    if (e.target?.closest?.("#ivlib-panel")) { setFocus("left"); return; }
    if (e.target?.closest?.("#ivnext-panel")) { setFocus("right"); return; }
    if (e.target?.closest?.(OWN_UI) || !e.target?.closest?.(FS_SELECTOR)) return;
    if (isOpen("right")) setNext(false);
    setFocus("mid");
  }, true);

  window.addEventListener("keydown", onKey, true);

  // ---------- volume ----------
  // Wheel anywhere over the fullscreen except the panes (they scroll) changes
  // volume in steps of 2, snapped to even numbers: one wheel notch (100) is
  // five steps, 10 points. Trackpads accumulate.
  const vol = { acc: 0, timer: null, el: $("ivvol") };
  function stepVolume(d) {
    const cur = Math.round(((Spicetify.Player.getVolume?.() ?? 1) * 100) / 2) * 2;
    const v = Math.max(0, Math.min(100, cur + d));
    Spicetify.Player.setVolume(v / 100);
    vol.el.textContent = `vol ${v}`;
    vol.el.classList.add("on");
    clearTimeout(vol.timer);
    vol.timer = setTimeout(() => vol.el.classList.remove("on"), 700);
  }
  window.addEventListener("wheel", (e) => {
    if (!document.body.classList.contains("ivlib-fs")) return;
    if (e.target?.closest?.("#ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg")) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // also keeps ivLyrics' wheel font-size change away
    vol.acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    while (Math.abs(vol.acc) >= 20) {
      stepVolume(vol.acc < 0 ? 2 : -2);
      vol.acc -= Math.sign(vol.acc) * 20;
    }
    if (Math.abs(e.deltaY) >= 100) vol.acc = 0;
  }, { capture: true, passive: false });
  // Each Spotify start begins at full volume; after that Spotify keeps whatever you set.
  try { Spicetify.Player.setVolume(1); } catch {}

  // ivLyrics' own fullscreen volume slider: switch it back on.
  try {
    if (window.CONFIG?.visual && window.CONFIG.visual["fullscreen-show-volume"] !== true) {
      window.CONFIG.visual["fullscreen-show-volume"] = true;
      localStorage.setItem("ivLyrics:visual:fullscreen-show-volume", "true");
      window.dispatchEvent(new CustomEvent("ivLyrics", { detail: { type: "config", name: "fullscreen-show-volume", value: true } }));
    }
  } catch (e) { console.warn("[ivlyrics-sidecar] volume slider setting", e); }

  // ---------- launch API (used by playlist-home) ----------
  // Play a context, open ivLyrics fullscreen with the library panel, and come
  // back to `from` when fullscreen is exited.
  let returnPath = null;
  window.ivlib = {
    async launch(uri, from) {
      localStorage.setItem(STORE_OPEN, "1");
      try { await Spicetify.Player.playUri(uri); } catch (e) { console.error("[ivlyrics-sidecar] play failed", e); }
      if (document.body.classList.contains("ivlib-fs")) { focusZone("left"); return; }
      if (!Spicetify.Platform.History.location.pathname.startsWith("/ivLyrics")) Spicetify.Platform.History.push("/ivLyrics");
      for (let i = 0; i < 40; i++) {
        const lc = window.lyricContainer;
        if (typeof lc?.toggleFullscreen === "function") {
          if (!lc.state?.isFullscreen) lc.toggleFullscreen();
          returnPath = from ?? null;
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      console.warn("[ivlyrics-sidecar] ivLyrics not ready, stayed on its page");
    },
  };

  // Open ivLyrics fullscreen from anywhere (top-bar button).
  async function enterFullscreen() {
    if (document.body.classList.contains("ivlib-fs")) return;
    if (!Spicetify.Platform.History.location.pathname.startsWith("/ivLyrics")) Spicetify.Platform.History.push("/ivLyrics");
    for (let i = 0; i < 40; i++) {
      const lc = window.lyricContainer;
      if (typeof lc?.toggleFullscreen === "function") { if (!lc.state?.isFullscreen) lc.toggleFullscreen(); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  window.ivlib.enter = enterFullscreen;
  function exitFullscreen() {
    const lc = window.lyricContainer;
    if (lc?.state?.isFullscreen && typeof lc.toggleFullscreen === "function") lc.toggleFullscreen();
  }
  $("ivexit").addEventListener("click", exitFullscreen);
  try {
    const icon = `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="3" height="10" rx=".8"/><rect x="5.5" y="2" width="5" height="12" rx="1"/><rect x="12" y="3" width="3" height="10" rx=".8"/></svg>`;
    new Spicetify.Topbar.Button("ivLyrics deck", icon, () => enterFullscreen());
  } catch (e) { console.warn("[ivlyrics-sidecar] top-bar button unavailable", e); }

  // Start on playlist-home (if installed) instead of Spotify's home feed.
  try {
    const H = Spicetify.Platform.History;
    if (Spicetify.Config?.custom_apps?.includes("playlist-home") && ["/", "/home"].includes(H.location.pathname)) {
      H.replace("/playlist-home");
    }
  } catch (e) { console.warn("[ivlyrics-sidecar] start-page redirect failed", e); }

  // Show only while ivLyrics is fullscreen.
  const syncFs = () => {
    const fs = !!document.querySelector(FS_SELECTOR);
    if (fs === document.body.classList.contains("ivlib-fs")) return;
    document.body.classList.toggle("ivlib-fs", fs);
    // ivLyrics appends a fresh #lyrics-fullscreen-container to <body> on every
    // enter; move ourselves after it so equal-z ties resolve in our favour.
    if (fs) {
      document.body.appendChild(root);
      setOpen(localStorage.getItem(STORE_OPEN) === "1");
      if (state.open) autoNow(); // pane was already open when fullscreen was left
      setFocus(state.open ? "left" : null);
      setTimeout(hideCornerChrome, 600);
      startBand(true);
    } else {
      if (state.open) state.hiddenAt = Date.now();
      closeCtx();
      closeSync();
      setFocus(null);
      startBand(false);
      setNext(false);
      if (returnPath) { Spicetify.Platform.History.push(returnPath); returnPath = null; }
    }
  };
  // Karaoke mutates classes every frame; coalesce to one check per frame.
  let fsQueued = false;
  const queueFs = () => {
    if (fsQueued) return;
    fsQueued = true;
    requestAnimationFrame(() => { fsQueued = false; syncFs(); updateLyricBox(); });
  };
  new MutationObserver(queueFs).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
  syncFs();
})();
