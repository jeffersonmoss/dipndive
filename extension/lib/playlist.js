// YouTube playlists (1.10). A playlist link is summarized one video at a time: the panel asks the companion for the list
// (GET /playlist), summarizes the first video (or the video the link names), and the long arrows under the bottom row page
// through it. The playlist rides along with the slot and the back/forward trail item as { listId, title, entries, index },
// entries being [{ id, title }] in playlist order. DOM-free.

export const PLAYLIST_MAX = 200;
const LIST = /^[A-Za-z0-9_-]{2,64}$/;
const VID = /^[A-Za-z0-9_-]{11}$/;

// { listId, videoId } for a YouTube /playlist page or a /watch link inside a playlist, else null. Channels are not playlists.
export function playlistLink(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (!(h === "youtube.com" || h.endsWith(".youtube.com"))) return null;
  if (u.pathname !== "/playlist" && u.pathname !== "/watch") return null;
  const listId = u.searchParams.get("list") || "";
  if (!LIST.test(listId)) return null;
  const v = u.pathname === "/watch" ? u.searchParams.get("v") || "" : "";
  return { listId, videoId: VID.test(v) ? v : null };
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// A playlist as stored on a slot or trail item, checked; null when it is missing or malformed.
export function normPlaylist(p) {
  if (!p || typeof p !== "object" || !LIST.test(p.listId || "") || !Array.isArray(p.entries)) return null;
  const entries = p.entries.filter((e) => e && VID.test(e.id || "")).slice(0, PLAYLIST_MAX)
    .map((e) => ({ id: e.id, title: typeof e.title === "string" ? e.title : "" }));
  if (!entries.length) return null;
  const index = Number.isInteger(p.index) ? Math.max(0, Math.min(p.index, entries.length - 1)) : 0;
  return { listId: p.listId, title: typeof p.title === "string" ? p.title : "", entries, index };
}

// The companion's GET /playlist answer as a stored playlist.
export function fromCompanion(json) {
  if (!json) return null;
  return normPlaylist({ listId: json.list_id, title: json.title, entries: json.entries, index: json.index });
}

// The playlist moved `delta` videos along, or null past either end.
export function stepPlaylist(p, delta) {
  const pl = normPlaylist(p);
  if (!pl) return null;
  const index = pl.index + delta;
  if (index < 0 || index >= pl.entries.length) return null;
  return { ...pl, index };
}

// "3 of 24" (or "3 of 200+" when the companion stopped at its limit)
export function positionLabel(p) {
  const pl = normPlaylist(p);
  if (!pl) return "";
  return `${pl.index + 1} of ${pl.entries.length}${pl.entries.length >= PLAYLIST_MAX ? "+" : ""}`;
}
