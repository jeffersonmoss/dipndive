// Back and forward through the summaries shown in the panel, the way a browser's buttons work. One trail per computer,
// shared by every Chrome window (chrome.storage.local "trail"). A new summary after going back cuts off the forward
// part, like a browser; showing a summary that is already on the trail just moves there.
// Each item keeps what the panel needs to show it at once: { url, jobId, entryId, title, channel, channelUrl, mode, result, ts },
// plus `playlist` for a video of a YouTube playlist (the whole playlist is one stop, see pushTrail).

export const TRAIL = Object.freeze({ key: "trail", max: 100 });

export function emptyTrail() { return { items: [], pos: -1 }; }

export function normTrail(t) {
  if (!t || !Array.isArray(t.items)) return emptyTrail();
  const items = t.items.filter((x) => x && typeof x.url === "string" && typeof x.jobId === "string");
  const pos = Number.isInteger(t.pos) ? Math.max(-1, Math.min(t.pos, items.length - 1)) : items.length - 1;
  return { items, pos };
}

// The trail after a summary is shown. Already on it (the same job): only the position moves.
export function pushTrail(trail, item) {
  const t = normTrail(trail);
  // A YouTube playlist is one stop: paging through it (lib/playlist.js) replaces the stop it is on, forward part kept.
  const list = item && item.playlist && item.playlist.listId;
  if (list && t.pos >= 0 && t.items[t.pos].playlist && t.items[t.pos].playlist.listId === list) {
    const items = t.items.slice();
    items[t.pos] = item;
    return { items, pos: t.pos };
  }
  const at = t.items.findIndex((x) => x.jobId === item.jobId);
  if (at >= 0) {
    const items = t.items.slice();
    items[at] = { ...items[at], ...item };   // a newer title or result for the same job
    return { items, pos: at };
  }
  let items = t.items.slice(0, t.pos + 1);
  items.push(item);
  if (items.length > TRAIL.max) items = items.slice(items.length - TRAIL.max);
  return { items, pos: items.length - 1 };
}

// { trail, item } one step back (-1) or forward (+1), or null when there is nothing that way.
export function stepTrail(trail, delta) {
  const t = normTrail(trail);
  const pos = t.pos + delta;
  if (pos < 0 || pos >= t.items.length) return null;
  return { trail: { items: t.items, pos }, item: t.items[pos] };
}

export const canBack = (trail) => normTrail(trail).pos > 0;
export const canForward = (trail) => { const t = normTrail(trail); return t.pos >= 0 && t.pos < t.items.length - 1; };
