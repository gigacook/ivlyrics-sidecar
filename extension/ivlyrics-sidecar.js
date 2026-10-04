// ivlyrics-sidecar — Spicetify extension that rides along with ivLyrics.
// It never edits ivLyrics: it waits for ivLyrics fullscreen
// (`.lyrics-lyricsContainer-LyricsContainer.fullscreen-active`) and layers on top.
//
// Left pane (Alt+L or the edge tab): your library. Playlists open in place,
// newest tracks first; Backspace / Esc go up a level, then close the pane.
// Browsing never changes playback: click selects, double-click plays, q (chip
// or key) queues the track next, "back.." jumps to what's playing.
// Search starts in the current view and widens on Y / Enter / Tab to all
// playlists, then to Spotify.
//
// Right pane (Alt+R): the queue around the current track; folds away like a
// book cover. Opens by itself when a song has no lyrics. Album name, title,
// artist name and the album-cover right-click menu open album / artist views
// in it (arrows, Enter, Backspace / Esc).
//
// Focus moves between the queue and the middle: ← in the queue (or a click on
// empty space in the middle) folds the queue away and parks a blinking caret
// above the player; → from there reopens the queue, ← opens the library.
// Space toggles play/pause anywhere in Spotify (except mid-word in a text box).
// Lyrics side: clicking a line never seeks; a faint gear (level with play /
// pause) opens a per-track sync-offset dialog.
// Also: hides window buttons until hovered, removes the presentation switcher,
// the "no lyrics" animation and the AI right-click, centres the album column,
// tightens lyric spacing, and exposes window.ivlib.launch() for playlist-home.
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
    /* Wide windows: push the lyrics over. Narrow: float over the album art. */
    @media (min-width: 1100px) {
      body.ivlib-fs.ivlib-open ${FS_SELECTOR} {
        padding-left: var(--ivlib-w) !important;
        transition: padding-left .22s ease;
      }
    }
    #ivlib-tab {
      position: fixed; left: 0; top: 50%; transform: translateY(-50%);
      z-index: 2147483647; width: 18px; height: 72px; border: 0; padding: 0;
      border-radius: 0 8px 8px 0; cursor: pointer;
      background: rgba(255,255,255,.08); color: rgba(255,255,255,.7);
      font-size: 12px; transition: left .22s ease, background .15s;
      backdrop-filter: blur(8px);
    }
    #ivlib-tab:hover { background: rgba(255,255,255,.18); color: #fff; }
    body.ivlib-open #ivlib-tab { left: var(--ivlib-w); }
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
    .ivlib-row:hover, .ivlib-row.active { background: rgba(255,255,255,.1); }
    .ivlib-row.playing .ivlib-name { color: var(--spice-button, #1db954); }
    /* Browsing: selected row, and a hover chip that queues the track next. */
    #ivlib-list .ivlib-row.sel { background: rgba(255,255,255,.12); box-shadow: inset 2px 0 0 rgba(255,255,255,.6); }
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
    /* The list fills the shared band (--ivnext-top/bottom, set by alignBand):
       at least 33%–66% of the height, stretched to the album column if taller. */
    /* Closed = folded back like a book cover, hinged on the divider (left edge):
       right edge swings away from the viewer, then fades. */
    #ivnext-panel {
      position: fixed; right: 0; top: 0; bottom: 0; width: var(--ivnext-w, 50vw);
      z-index: 2147483645; color: #fff; pointer-events: none;
      font-family: var(--ivmono);
      background: var(--ivpane-bg); backdrop-filter: var(--ivpane-blur);
      transform-origin: left center;
      transform: perspective(1400px) rotateY(88deg);
      opacity: 0;
      transition: transform .15s cubic-bezier(.6, 0, .9, .4), opacity .06s linear .09s;
    }
    body.ivnext-open #ivnext-panel {
      transform: perspective(1400px) rotateY(0deg);
      opacity: 1;
      transition: transform .15s cubic-bezier(.1, .6, .3, 1), opacity .05s linear;
    }
    body:not(.ivnext-open) #ivnext-list { pointer-events: none !important; }
    /* No lyrics and pane folded: the album column slides to the centre (see
       moveLeftX); the empty "no lyrics" page on the right goes away. */
    body.ivlib-fs.ivlib-nolyrics:not(.ivnext-open) ${FS_SELECTOR} .lyrics-lyricsContainer-LyricsUnavailablePage { display: none !important; }
    body.ivlib-fs.ivnext-open ${FS_SELECTOR} :is(.lyrics-lyricsContainer-SyncedLyricsPage, .lyrics-lyricsContainer-UnsyncedLyricsPage, .lyrics-lyricsContainer-LyricsUnavailablePage) {
      visibility: hidden !important;
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
    /* Only between two columns: hidden in the single-column no-lyrics layout. */
    body.ivlib-fs.ivlib-nolyrics:not(.ivnext-open) #ivnext-divider { display: none; }
    #ivnext-divider .cog { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; transform: translate(-50%, -50%); }
    #ivnext-list .ivlib-row { opacity: .6; }
    #ivnext-list .ivlib-row:hover { opacity: 1; }
    #ivnext-list .ivlib-row.current { opacity: 1; background: rgba(255,255,255,.1); }
    #ivnext-list .ivlib-row.current .ivlib-name { color: var(--spice-button, #1db954); }
    #ivnext-list .ivlib-name { font-size: 13px; }
    /* Presentation switcher (standard/vinyl/video stage) pops up on album hover
       and is too easy to hit by accident. */
    .fullscreen-presentation-dock { display: none !important; }
    /* Lyrics: current line one third from the top (ivLyrics default 0.5), and
       row spacing from the real text size — ivLyrics steps rows by the legacy
       base font-size setting (44px here) while the text is 20px. Scrolled view
       gets the same tight gaps. */
    ${FS_SELECTOR} { --ivfs-lyrics-anchor-ratio: 0.34 !important; }
    ${FS_SELECTOR} .lyrics-lyricsContainer-SyncedLyrics {
      --lyrics-line-height: calc(4px + var(--lyrics-original-font-size, var(--lyrics-font-size))) !important;
      --scroll-line-gap: 8px !important;
    }
    /* Unsynced lyrics: 80% size, phrases packed, starting near the divider. */
    ${FS_SELECTOR} > .lyrics-lyricsContainer-UnsyncedLyricsPage { padding-left: 24px !important; padding-right: 24px !important; }
    ${FS_SELECTOR} .lyrics-lyricsContainer-UnsyncedLyricsPage .lyrics-lyricsContainer-LyricsLine {
      font-size: calc(var(--lyrics-original-font-size, var(--lyrics-font-size)) * .8) !important;
      margin-bottom: 2px !important;
    }
    ${FS_SELECTOR} .lyrics-lyricsContainer-UnsyncedLyricsPage .lyrics-lyricsContainer-LyricsLine-translation {
      font-size: calc(var(--lyrics-translation-font-size, calc(var(--lyrics-font-size) * .7)) * .8) !important;
      line-height: 1.3 !important;
      margin-top: 0 !important;
    }
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
    #ivlib-head .ivlib-btn[hidden] { display: none; }
    .ivnext-album-head { display: flex; gap: 12px; align-items: center; padding: 4px 8px 10px; }
    .ivnext-album-head img { width: 64px; height: 64px; border-radius: 4px; object-fit: cover; flex: none; }
    .ivnext-album-title { font-size: 14px; font-weight: 700; }
    .ivnext-album-sub { font-size: 11px; opacity: .55; margin-top: 2px; }
    .ivlib-num { flex: none; width: 18px; text-align: right; font-size: 11px; opacity: .45; font-variant-numeric: tabular-nums; }
    /* Middle focus: a thin blinking caret above the player, like an editor cursor. */
    #ivfocus-caret {
      position: fixed; z-index: 2147483640; width: 2px; height: 16px; border-radius: 1px;
      left: var(--ivcaret-x, 50vw); top: 12vh; transform: translateX(-50%);
      background: #fff; box-shadow: 0 0 6px rgba(255,255,255,.7), 0 0 14px rgba(255,255,255,.3);
      display: none; pointer-events: none;
    }
    body.ivlib-fs.ivfocus-mid #ivfocus-caret { display: block; animation: ivcaret 1.06s steps(1, end) infinite; }
    @keyframes ivcaret { 0% { opacity: .55; } 50% { opacity: 0; } }
    /* Lyric lines are not seek targets any more. */
    ${FS_SELECTOR} :is(.lyrics-lyricsContainer-LyricsLine, .lyrics-lyricsContainer-LyricsLine-scrollView) { cursor: default !important; }
    ${FS_SELECTOR} .lyrics-lyricsContainer-LyricsLine-scrollView:hover { transform: none !important; }

    /* Sync gear: invisible until the pointer is on the lyrics side. */
    #ivsync-gear {
      position: fixed; z-index: 2147483646; width: 26px; height: 26px; padding: 4px; margin: -13px 0 0 0;
      border: 0; border-radius: 50%; background: transparent; color: #fff; cursor: pointer;
      opacity: 0; pointer-events: none; transition: opacity .25s ease, background .15s;
    }
    body.ivlib-fs.ivsync-hot #ivsync-gear { opacity: .22; pointer-events: auto; }
    body.ivlib-fs #ivsync-gear:hover, body.ivsync-open #ivsync-gear { opacity: .85; pointer-events: auto; background: rgba(255,255,255,.08); }
    body.ivlib-fs.ivlib-nolyrics:not(.ivnext-open) #ivsync-gear { display: none; }
    #ivsync-gear svg { width: 100%; height: 100%; display: block; }

    /* Sync dialog, opening upward from the gear. */
    #ivsync-dlg {
      position: fixed; z-index: 2147483647; width: 236px; padding: 12px; box-sizing: border-box;
      left: var(--ivsync-x, 50vw); bottom: var(--ivsync-y, 30vh);
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
    <button id="ivlib-tab" title="Library (Alt+L)">▸</button>
    <div id="ivnext-divider"><div class="zip"></div><svg class="cog" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.3"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="white" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></div>
    <div id="ivlib-ctx" hidden></div>
    <div id="ivfocus-caret"></div>
    <button id="ivsync-gear" title="Lyrics sync offset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.8"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `<rect x="10.8" y="2.6" width="2.4" height="3.2" rx=".5" fill="currentColor" stroke="none" transform="rotate(${k * 45} 12 12)"/>`).join("")}</svg></button>
    <div id="ivsync-dlg"></div>
    <aside id="ivnext-panel">
      <div id="ivnext-crumb"></div>
      <div id="ivnext-hint"></div>
      <div class="ivlib-list" id="ivnext-list"></div>
    </aside>
    <aside id="ivlib-panel">
      <div class="ivlib-head" id="ivlib-head">
        <button class="ivlib-btn" id="ivlib-back">‹</button>
        <div class="ivlib-title" id="ivlib-title"></div>
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
  const input = $("ivlib-search"), back = $("ivlib-back"), title = $("ivlib-title"), head = $("ivlib-head"), nowBtn = $("ivlib-now");

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
    nowBtn.hidden = !ctxUri || at?.uri === ctxUri;
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

  // Put a track first in the queue without touching what's playing.
  async function queueNext(v, rowEl) {
    if (!v?.uri) return;
    const P = Spicetify.Platform.PlayerAPI;
    try {
      if (typeof P?.playAsNextInQueue === "function") await P.playAsNextInQueue([{ uri: v.uri }]);
      else await Spicetify.addToQueue([{ uri: v.uri }]);
      rowEl?.classList.add("queued");
      if (document.body.classList.contains("ivnext-open")) setTimeout(renderNext, 300);
    } catch (e) {
      console.warn("[ivlyrics-sidecar] queue next failed", e);
      Spicetify.showNotification?.(`Couldn't queue ${v.name}`, true);
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
      input.blur();
      setOpen(false);
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
    state.open = open;
    localStorage.setItem(STORE_OPEN, open ? "1" : "0");
    document.body.classList.toggle("ivlib-open", open);
    tab.textContent = open ? "◂" : "▸";
    setTimeout(() => document.body.classList.contains("ivnext-open") && sizeNext(), 250); // after the push transition
    if (open && !state.items?.length) loadLibrary();
  }

  // ---------- events ----------
  tab.addEventListener("click", () => setOpen(!state.open));
  back.addEventListener("click", goUp);
  nowBtn.addEventListener("click", goToNow);
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".ivlib-row");
    if (!row) return;
    const v = listViews[+row.dataset.i];
    setTimeout(() => input.focus({ preventScroll: true }), 0);
    if (e.target.closest(".ivlib-q")) return queueNext(v, row);
    // Tracks: a click only selects, so browsing never interrupts playback.
    if (v?.type === "track") { state.sel = +row.dataset.i; markSel(); return; }
    activate(v);
  });
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".ivlib-row");
    const v = row && listViews[+row.dataset.i];
    if (v?.type === "track" && !e.target.closest(".ivlib-q")) activate(v);
  });
  input.addEventListener("input", onQuery);
  // Keep typing from triggering Spotify / ivLyrics shortcuts (space, F12…).
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // → at the end of the text: close the library, focus the middle.
    if (e.key === "ArrowRight" && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      e.preventDefault();
      input.blur();
      setOpen(false);
      setFocus("mid");
      return;
    }
    if (!search.q) {
      // Browsing: arrows move the selection, Enter opens / plays, Q (empty box) queues next.
      const n = listViews.length;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
        e.preventDefault();
        let i = state.sel;
        if (i < 0) {
          const playing = listViews.findIndex((v) => v.uri === Spicetify.Player.data?.item?.uri);
          i = playing >= 0 ? playing : e.key === "ArrowDown" ? -1 : n;
        }
        state.sel = Math.max(0, Math.min(n - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        markSel();
        list.querySelector(".ivlib-row.sel")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && state.sel >= 0) {
        e.preventDefault();
        activate(listViews[state.sel]);
      } else if ((e.key === "q" || e.key === "Q") && !input.value && listViews[state.sel]?.type === "track") {
        e.preventDefault();
        queueNext(listViews[state.sel], list.querySelector(".ivlib-row.sel"));
      }
      return;
    }
    const n = listViews.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      search.active = (search.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (search.active >= 0) activate(listViews[search.active]);
      else if (!resultCount()) widen();
      else activate(listViews[0]);
    } else if ((e.key === "y" || e.key === "Y") && !resultCount() && listViews.some((v) => v.type === "widen")) {
      e.preventDefault(); // "y" answers the prompt instead of typing
      widen();
    }
  });
  ["keyup", "keypress"].forEach((t) => input.addEventListener(t, (e) => e.stopPropagation()));

  window.addEventListener("keydown", (e) => {
    // Space = play/pause anywhere in Spotify. Only exception: a text box that
    // already has text, so multi-word searches can still be typed.
    if (e.code === "Space" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const field = e.target?.matches?.("input, textarea, [contenteditable='true']") ? e.target : null;
      const typingWords = field && (field.value ?? field.textContent ?? "").length > 0;
      if (!typingWords) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) Spicetify.Player.togglePlay();
        return;
      }
    }
    if (syncKeys(e)) return;
    if ((e.key === "q" || e.key === "Q") && !e.altKey && !e.ctrlKey && state.open
        && document.body.classList.contains("ivlib-fs")
        && !e.target?.matches?.("input, textarea, [contenteditable='true']")
        && listViews[state.sel]?.type === "track") {
      e.preventDefault();
      e.stopImmediatePropagation();
      queueNext(listViews[state.sel], list.querySelector(".ivlib-row.sel"));
      return;
    }
    // Tab in the search box widens the search scope (here -> playlists -> Spotify).
    if (e.key === "Tab" && e.target === input && search.q) {
      e.preventDefault();
      e.stopImmediatePropagation();
      widen();
      return;
    }
    const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const isBack = (e.key === "Escape" || e.key === "Backspace") && !e.altKey && !e.ctrlKey;
    // Open right-click menu: Esc/Backspace step back (playlist picker -> menu -> closed).
    if (ctx.state) {
      const inFilter = e.target === ctx.filterEl;
      if (isBack && !(e.key === "Backspace" && inFilter && ctx.filterEl.value)) { consume(); ctxBack(); return; }
      if (e.key === "Enter" && inFilter) { consume(); ctx.views[0]?.act(); return; }
      if (inFilter) return;
    }
    const typing = e.target?.matches?.("input, textarea, [contenteditable='true']");
    // Middle focus (caret showing): → opens the queue, ← opens the library.
    if (focus.zone === "mid" && !typing && !e.altKey && !e.ctrlKey && !e.metaKey
        && document.body.classList.contains("ivlib-fs") && !document.body.classList.contains("ivnext-open")) {
      if (e.key === "ArrowRight") { consume(); toggleNext(true); setFocus("right"); return; }
      if (e.key === "ArrowLeft") { consume(); setFocus(null); setOpen(true); setTimeout(() => input.focus(), 50); return; }
    }
    // Right pane (when open, not typing): Esc/Backspace up a level, arrows
    // move the highlight, Enter opens a release / plays a track.
    if (!typing && !e.altKey && !e.ctrlKey && !e.metaKey
        && document.body.classList.contains("ivnext-open") && document.body.classList.contains("ivlib-fs")) {
      if (isBack && next.stack.length) { consume(); popNest(); return; }
      if (e.key === "ArrowLeft") { consume(); toggleNext(false); setFocus("mid"); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { consume(); moveActive(e.key === "ArrowDown" ? 1 : -1); return; }
      if (e.key === "Enter" && getActive() >= 0) { consume(); activateNext(next.views[getActive()]); return; }
    }
    // Backspace / Esc: clear search, else up one level, else close the pane.
    // Capture phase on window runs before ivLyrics' Esc (exit fullscreen).
    if ((e.key === "Escape" || e.key === "Backspace") && !e.altKey && !e.ctrlKey
        && state.open && document.body.classList.contains("ivlib-fs")) {
      const t = e.target;
      const otherField = t !== input && t?.matches?.("input, textarea, [contenteditable='true']");
      if (otherField) return;
      if (t === input && input.value) {
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); clearSearch(); renderList(); }
        return; // Backspace edits the text
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      goUp();
      return;
    }
    if (e.altKey && !e.ctrlKey && e.code === "KeyL" && document.body.classList.contains("ivlib-fs")) {
      e.preventDefault();
      setOpen(!state.open);
      if (state.open) { setFocus(null); setTimeout(() => input.focus(), 50); }
    }
    if (e.altKey && !e.ctrlKey && e.code === "KeyR" && document.body.classList.contains("ivlib-fs")) {
      e.preventDefault();
      toggleNext(!document.body.classList.contains("ivnext-open"));
    }
  }, true);

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
  // dismissedUri: track whose no-lyrics auto-open the user closed with Alt+R.
  const next = {
    pinned: false, auto: false, views: [], timer: null, noLyricsSince: 0, dismissedUri: null,
    animating: false, holdUntil: 0, stack: [], qActive: -1, rendered: null,
  };
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
    next.pinned = true;
    next.dismissedUri = null;
    if (document.body.classList.contains("ivnext-open")) renderNext(); else setNext(true);
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
    hint.textContent = next.stack.length ? "esc back · alt+r close" : "alt+r to close";
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

  // Lyrics column sits right of the album panel; size the pane to match it.
  // Both panes share one width: the average of the library pane's base width
  // and the lyrics column (half the window). Based on the window only, so the
  // library pane pushing the layout can't feed back into it.
  function sizeNext() {
    const w = Math.max(240, Math.round((PANEL_W + window.innerWidth / 2) / 2));
    const css = document.documentElement.style;
    css.setProperty("--ivnext-w", `${w}px`);
    css.setProperty("--ivlib-w", `${w}px`);
  }

  // Centre ivLyrics' album column (art -> controls) on the window's midline,
  // then size the list band to the larger of 33%-66% and that column, so both
  // sides share top and bottom edges. Uses the `translate` property so it
  // doesn't fight ivLyrics' own transform animations.
  const leftPanel = () => document.querySelector(`${FS_SELECTOR} .lyrics-fullscreen-left-panel`);
  // Horizontal: centred across the free area when there are no lyrics and the
  // right pane is folded, else ivLyrics' own column. Moves between the two are
  // animated (moveLeftX); resizes snap.
  const wantCentered = () => document.body.classList.contains("ivlib-nolyrics") && !document.body.classList.contains("ivnext-open");
  function readShift(lp) {
    const [x, y] = (lp.style.translate || "0px 0px").split(" ").map((v) => parseFloat(v) || 0);
    return { x, y };
  }
  function alignBand({ animate = true } = {}) {
    sizeNext();
    placeGear();
    if (focus.zone === "mid") placeCaret();
    const H = window.innerHeight;
    let top = H * 0.33, bottom = H * 0.66;
    const lp = leftPanel();
    if (next.animating && Date.now() > (next.animUntil ?? 0)) next.animating = false;
    if (lp && !next.animating) {
      const rects = [...lp.querySelectorAll(".lyrics-fullscreen-left-content, .fullscreen-left-controls")]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
      if (rects.length) {
        const cur = readShift(lp);
        const cTop = Math.min(...rects.map((r) => r.top)) - cur.y;
        const cBot = Math.max(...rects.map((r) => r.bottom)) - cur.y;
        const y = Math.round(H / 2 - (cTop + cBot) / 2);
        let x = 0;
        if (wantCentered()) {
          const fs = document.querySelector(FS_SELECTOR);
          const fr = fs.getBoundingClientRect();
          const pl = parseFloat(getComputedStyle(fs).paddingLeft) || 0;
          const cMid = (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.right))) / 2 - cur.x;
          x = Math.round(fr.left + pl + (fr.width - pl) / 2 - cMid);
        }
        if (Math.abs(x - cur.x) > 24 && animate && Date.now() >= next.holdUntil) moveLeftX(lp, cur.x, x, y);
        else if (Math.abs(x - cur.x) > 1 || Math.abs(y - cur.y) > 1) {
          if (Date.now() >= next.holdUntil || Math.abs(x - cur.x) <= 24) lp.style.translate = `${x}px ${y}px`;
        }
        top = Math.min(top, cTop + y);
        bottom = Math.max(bottom, cBot + y);
      }
    }
    const css = document.documentElement.style;
    css.setProperty("--ivnext-top", `${Math.max(8, Math.round(top))}px`);
    css.setProperty("--ivnext-bottom", `${Math.max(8, Math.round(H - bottom))}px`);
  }

  // Album column move: slow start, hard acceleration, heavy braking, a snap
  // over the last few px, then a small landing shake. 140ms + 90ms shake.
  const MOVE_MS = 140, FOLD_MS = 150;
  function moveLeftX(lp, from, to, y) {
    next.animating = true;
    next.animUntil = Date.now() + MOVE_MS + 260; // watchdog if an animation never ends
    const sgn = Math.sign(to - from) || 1;
    const near = to - sgn * Math.min(5, Math.abs(to - from) * 0.04);
    const move = lp.animate([
      { translate: `${from}px ${y}px`, easing: "cubic-bezier(.8, 0, .15, 1)" },
      { translate: `${near}px ${y}px`, offset: 0.86, easing: "linear" },
      { translate: `${to}px ${y}px` },
    ], { duration: MOVE_MS, fill: "forwards" });
    move.onfinish = () => {
      lp.style.translate = `${to}px ${y}px`;
      move.cancel();
      const shake = lp.animate([
        { translate: `${to}px ${y}px` },
        { translate: `${to + sgn * 3}px ${y}px` },
        { translate: `${to - sgn * 1.5}px ${y}px` },
        { translate: `${to + sgn * 0.6}px ${y}px` },
        { translate: `${to}px ${y}px` },
      ], { duration: 90, easing: "ease-out" });
      shake.onfinish = shake.oncancel = () => { next.animating = false; };
    };
    // ivLyrics can rebuild the column mid-move; never stay locked.
    move.oncancel = () => { if (!lp.isConnected || lp.style.translate !== `${to}px ${y}px`) next.animating = false; };
  }

  function setNext(open, opts = {}) {
    const lp = leftPanel();
    if (next.animating && Date.now() > (next.animUntil ?? 0)) next.animating = false;
    const centered = lp && Math.abs(readShift(lp).x) > 24;
    if (open && centered && !next.animating) {
      // Player leaves the centre first; the pane unfolds behind it, chasing.
      const { x, y } = readShift(lp);
      moveLeftX(lp, x, 0, y);
      setTimeout(() => applyNext(true, opts), MOVE_MS * 0.6);
      return;
    }
    applyNext(open, opts);
    if (!open) {
      // Fold first; only then may the player slide to the centre.
      next.holdUntil = Date.now() + FOLD_MS;
      setTimeout(() => alignBand(), FOLD_MS + 5);
    }
  }

  function applyNext(open, { auto = false } = {}) {
    next.auto = open && auto;
    document.body.classList.toggle("ivnext-open", open);
    clearInterval(next.timer);
    if (open) {
      sizeNext();
      alignBand();
      renderNext();
      setTimeout(sizeNext, 500); // grid may still be animating back from single column
      // Queue has no reliable change event; the album view is static.
      next.timer = setInterval(() => { if (!next.view) renderNext(); }, 4000);
    } else {
      next.view = null;
    }
  }

  // One way to open/close the queue pane for keys and clicks. Closing it on a
  // song keeps it closed (no auto-reopen) until the next song.
  function toggleNext(open) {
    next.pinned = open;
    next.dismissedUri = open ? null : Spicetify.Player.data?.item?.uri ?? null;
    setNext(open);
  }

  // ---------- focus: queue <-> middle ----------
  const focus = { zone: null, caret: $("ivfocus-caret") };
  function setFocus(zone) {
    focus.zone = zone;
    document.body.classList.toggle("ivfocus-mid", zone === "mid");
    if (zone === "mid") placeCaret();
  }
  // Caret sits over the player column's centre line.
  function placeCaret() {
    const r = leftPanel()?.querySelector(".lyrics-fullscreen-left-content")?.getBoundingClientRect();
    if (r?.width) document.documentElement.style.setProperty("--ivcaret-x", `${Math.round(r.left + r.width / 2)}px`);
  }
  // Left click on empty space in the middle: fold the queue away, focus the middle.
  // Controls, links, the cover and the sidecar's own UI keep their normal clicks.
  const OWN_UI = "button, a, input, select, [role=button], [role=link], [role=slider], .fullscreen-progress-bar,"
    + " .lyrics-fullscreen-album-container, #ivlib-panel, #ivnext-panel, #ivlib-ctx, #ivsync-dlg, #ivsync-gear, #ivlib-tab";
  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !document.body.classList.contains("ivlib-fs")) return;
    if (e.target?.closest?.("#ivnext-panel")) { setFocus("right"); return; }
    if (e.target?.closest?.(OWN_UI) || !e.target?.closest?.(FS_SELECTOR)) return;
    if (document.body.classList.contains("ivnext-open")) toggleNext(false);
    setFocus("mid");
  }, true);

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
  // album/track page (leaving fullscreen). Open the Alt+R album view instead.
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

  window.addEventListener("pointerdown", (e) => {
    if (ctx.state && !ctx.el.contains(e.target)) closeCtx();
    if (e.button === 2 && onAlbumCover(e)) e.stopImmediatePropagation(); // no hold-to-research timer
  }, true);

  // The album column stays centred for the whole fullscreen session, so
  // opening/closing Alt+R never moves it. Controls auto-hide and title length
  // change its height, hence the polling.
  function startBand(on) {
    clearInterval(next.bandTimer);
    if (on) { sizeNext(); alignBand({ animate: false }); next.bandTimer = setInterval(alignBand, 300); }
  }

  // No lyrics -> open by itself; lyrics come back -> close if we opened it.
  function checkLyricsState() {
    if (!document.body.classList.contains("ivlib-fs")) return;
    const fs = document.querySelector(FS_SELECTOR);
    const none = !!fs?.querySelector(".lyrics-lyricsContainer-LyricsUnavailablePage") && !fs.classList.contains("fullscreen-lyrics-loading");
    const isOpen = document.body.classList.contains("ivnext-open");
    if (document.body.classList.contains("ivlib-nolyrics") !== none) {
      document.body.classList.toggle("ivlib-nolyrics", none);
      setTimeout(() => alignBand(), 0);
    }
    if (none) {
      next.noLyricsSince ||= Date.now();
      // Debounce: track changes flash the unavailable page briefly.
      const uri = Spicetify.Player.data?.item?.uri;
      if (!isOpen && uri !== next.dismissedUri && Date.now() - next.noLyricsSince > 700) setNext(true, { auto: true });
    } else {
      next.noLyricsSince = 0;
      if (isOpen && next.auto && !next.pinned) setNext(false);
    }
  }
  // Mutations stop when nothing animates; poll too so the debounce can finish.
  setInterval(checkLyricsState, 500);

  nextList.addEventListener("click", (e) => {
    const row = e.target.closest(".ivlib-row");
    if (!row) return;
    setActive(+row.dataset.i);
    activateNext(next.views[+row.dataset.i]);
  });
  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("ivlib-fs")) return;
    sizeNext();
    alignBand();
  });
  Spicetify.Player.addEventListener("songchange", () => {
    if (document.body.classList.contains("ivnext-open")) setTimeout(renderNext, 300);
  });

  // ---------- lyric clicks: never seek ----------
  // ivLyrics jumps the song to a line when you click it. Swallow those clicks.
  const LINE_SEL = `${FS_SELECTOR} :is(.lyrics-lyricsContainer-LyricsLine, .lyrics-lyricsContainer-LyricsLine-scrollView)`;
  window.addEventListener("click", (e) => {
    if (!document.body.classList.contains("ivlib-fs") || !e.target?.closest?.(LINE_SEL)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // ---------- lyrics sync offset: gear + dialog ----------
  // A faint gear on the lyrics side, level with play/pause, shows while the
  // pointer is over that side. It opens a dialog that nudges this track's
  // lyrics earlier (+) or later (-) through ivLyrics' own per-track offset.
  const SYNC_STEPS = [10, 50, 100, 250, 500, 1000];
  const SYNC_LIMIT = 10000; // ivLyrics clamps to +-10s
  const sync = {
    gear: $("ivsync-gear"), dlg: $("ivsync-dlg"), open: false, offset: 0, uri: null,
    step: SYNC_STEPS.includes(+localStorage.getItem("ivsync:step")) ? +localStorage.getItem("ivsync:step") : 100,
  };
  const syncApi = () => window.Utils;
  const fmtOffset = (ms) => `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;

  // Gear sits at the left edge of the lyrics column, on the play button's line.
  function placeGear() {
    const g = sync.gear.getBoundingClientRect();
    if (g.width) {
      document.documentElement.style.setProperty("--ivsync-x", `${Math.round(Math.min(g.left, window.innerWidth - 248))}px`);
      document.documentElement.style.setProperty("--ivsync-y", `${Math.round(window.innerHeight - g.top + 10)}px`);
    }
    const play = document.querySelector(`${FS_SELECTOR} .fullscreen-control-play`);
    const r = play?.getBoundingClientRect();
    if (r?.height) sync.gear.style.top = `${Math.round(r.top + r.height / 2)}px`;
    sync.gear.style.left = `${Math.round(window.innerWidth - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ivnext-w")) || window.innerWidth / 2) + 34)}px`;
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
  // Close when clicking anywhere else.
  window.addEventListener("pointerdown", (e) => {
    if (sync.open && !sync.dlg.contains(e.target) && !sync.gear.contains(e.target)) closeSync();
  }, true);
  // Pointer over the lyrics side wakes the gear.
  window.addEventListener("mousemove", (e) => {
    if (!document.body.classList.contains("ivlib-fs")) return;
    const edge = window.innerWidth - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ivnext-w")) || window.innerWidth / 2);
    document.body.classList.toggle("ivsync-hot", e.clientX > edge);
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

  // ---------- launch API (used by playlist-home) ----------
  // Play a context, open ivLyrics fullscreen with the library panel, and come
  // back to `from` when fullscreen is exited.
  let returnPath = null;
  window.ivlib = {
    async launch(uri, from) {
      localStorage.setItem(STORE_OPEN, "1");
      try { await Spicetify.Player.playUri(uri); } catch (e) { console.error("[ivlyrics-sidecar] play failed", e); }
      if (document.body.classList.contains("ivlib-fs")) { setOpen(true); return; }
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
      setTimeout(hideCornerChrome, 600);
      startBand(true);
    } else {
      closeCtx();
      closeSync();
      setFocus(null);
      startBand(false);
      next.pinned = false;
      setNext(false);
      if (returnPath) { Spicetify.Platform.History.push(returnPath); returnPath = null; }
    }
  };
  // Karaoke mutates classes every frame; coalesce to one check per frame.
  let fsQueued = false;
  const queueFs = () => {
    if (fsQueued) return;
    fsQueued = true;
    requestAnimationFrame(() => { fsQueued = false; syncFs(); });
  };
  new MutationObserver(queueFs).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
  syncFs();
})();
