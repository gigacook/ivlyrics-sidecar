// playlist-home — Spicetify custom app.
// Your playlists (incl. Liked Songs), grouped by folder. Clicking one plays it
// and opens the spotiflux deck with its library pane open (via
// window.ivlib.launch). Leaving the deck brings you back here.

/** @type {React} */
const react = Spicetify.React;
const { useState, useEffect, useMemo } = react;

const ROUTE = "/playlist-home";
const KEEP = new Set(["playlist", "collection"]);

function render() {
  return react.createElement(PlaylistHome, null);
}

// [{ folder: "" | "A / B", items: [...] }] in library order, folders flattened.
async function loadGroups() {
  const groups = [];
  const walk = async (folderUri, label) => {
    const res = await Spicetify.Platform.LibraryAPI.getContents({
      offset: 0, limit: 9999, ...(folderUri ? { folderUri } : {}),
    });
    const here = [];
    const sub = [];
    for (const it of res?.items ?? []) {
      if (it.type === "folder") sub.push(it);
      else if (KEEP.has(it.type)) here.push(it);
    }
    if (here.length) groups.push({ folder: label, items: here });
    for (const f of sub) await walk(f.uri, label ? `${label} / ${f.name}` : f.name);
  };
  await walk(null, "");
  return groups;
}

function launch(uri) {
  if (window.ivlib?.launch) return window.ivlib.launch(uri, ROUTE);
  // spotiflux extension missing: at least play it.
  Spicetify.Player.playUri(uri);
}

function Card({ item, playing }) {
  const img = item.images?.[0]?.url;
  return react.createElement(
    "button",
    {
      className: `ph-card${playing ? " playing" : ""}`,
      title: item.name,
      onClick: () => launch(item.uri),
    },
    react.createElement(
      "div",
      { className: "ph-cover" },
      img
        ? react.createElement("img", { src: img, loading: "lazy", alt: "" })
        : react.createElement("span", null, item.type === "collection" ? "♥" : "♪"),
    ),
    react.createElement("div", { className: "ph-name" }, item.name),
  );
}

function PlaylistHome() {
  const [groups, setGroups] = useState(null);
  const [query, setQuery] = useState("");
  const [ctx, setCtx] = useState(Spicetify.Player.data?.context?.uri);

  useEffect(() => {
    let alive = true;
    const refresh = () => loadGroups().then((g) => alive && setGroups(g)).catch((e) => {
      console.error("[playlist-home]", e);
      alive && setGroups([]);
    });
    refresh();
    const em = Spicetify.Platform.LibraryAPI.getEvents?.()._emitter;
    em?.addListener("update", refresh, {});
    const onSong = () => setCtx(Spicetify.Player.data?.context?.uri);
    Spicetify.Player.addEventListener("songchange", onSong);
    return () => {
      alive = false;
      em?.removeListener("update", refresh);
      Spicetify.Player.removeEventListener("songchange", onSong);
    };
  }, []);

  const shown = useMemo(() => {
    if (!groups) return null;
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.name?.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length);
  }, [groups, query]);

  return react.createElement(
    "div",
    { className: "ph-root" },
    react.createElement("style", null, CSS),
    react.createElement("input", {
      className: "ph-search",
      placeholder: "Filter playlists…",
      value: query,
      spellCheck: false,
      onChange: (e) => setQuery(e.target.value),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Escape") setQuery("");
        if (e.key === "Enter") {
          const first = shown?.[0]?.items?.[0];
          if (first) launch(first.uri);
        }
      },
    }),
    shown === null
      ? react.createElement("div", { className: "ph-empty" }, "Loading…")
      : !shown.length
        ? react.createElement("div", { className: "ph-empty" }, "No playlists.")
        : shown.map((g) =>
          react.createElement(
            "section",
            { key: g.folder || "_root", className: "ph-group" },
            g.folder && react.createElement("h3", { className: "ph-folder" }, g.folder),
            react.createElement(
              "div",
              { className: "ph-grid" },
              g.items.map((it) => react.createElement(Card, { key: it.uri, item: it, playing: it.uri === ctx })),
            ),
          )),
  );
}

const CSS = `
.ph-root { padding: 16px 20px 32px; display: flex; flex-direction: column; gap: 14px; }
.ph-search {
  align-self: flex-start; width: min(320px, 100%); box-sizing: border-box;
  border: 0; outline: 0; border-radius: 8px; padding: 8px 12px; font-size: 13px;
  color: var(--spice-text); background: rgba(var(--spice-rgb-text), .08);
}
.ph-search:focus { background: rgba(var(--spice-rgb-text), .14); }
.ph-folder { margin: 4px 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; opacity: .5; }
.ph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.ph-card {
  all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 6px;
  padding: 6px; border-radius: 8px; min-width: 0; transition: background .12s;
}
.ph-card:hover, .ph-card:focus-visible { background: rgba(var(--spice-rgb-text), .08); }
.ph-cover {
  aspect-ratio: 1; border-radius: 6px; overflow: hidden; display: grid; place-items: center;
  background: rgba(var(--spice-rgb-text), .08); font-size: 28px;
}
.ph-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph-name { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-card.playing .ph-name { color: #eaff3d; text-shadow: 0 0 8px rgba(234,255,61,.45); }
.ph-empty { opacity: .5; font-size: 13px; }
/* Short windows: names-only list, no artwork. */
@media (max-height: 720px) {
  .ph-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 2px 12px; }
  .ph-cover { display: none; }
  .ph-card { padding: 5px 8px; }
  .ph-name { font-weight: 500; }
}
`;
