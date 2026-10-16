// What the panel remembers about one YouTube video, on this machine: the Watched checkbox and the two thumbs.
// The service worker is the only writer (it owns the countdown, the queue and the background watch); the panel reads the
// map from chrome.storage.local and follows chrome.storage.onChanged. One storage key holds the whole map, capped to the
// newest videos so it never grows without bound.
export const VIDEO_STATES_KEY = "youtubeVideoStates";
export const MAX_VIDEO_STATES = 500;

// watch.status: idle (unticked), countdown (endsAt), queued, watching (percent), watched (finished), partial (percent).
export const WATCH_STATUSES = ["idle", "countdown", "queued", "watching", "watched", "partial"];
export const LOCKED_STATUSES = ["watched", "partial"];

export const defaultVideoState = () => ({ watch: { status: "idle" }, like: false, dislike: false });

const clampPercent = (n) => Number.isFinite(Number(n)) ? Math.max(0, Math.min(100, Math.round(Number(n)))) : 0;

// Anything read from storage is untrusted data: keep only the known shape. A video with nothing stored gets the defaults.
export function normalizeVideoState(raw) {
  const out = defaultVideoState();
  if (!raw || typeof raw !== "object") return out;
  const w = raw.watch && typeof raw.watch === "object" ? raw.watch : {};
  if (WATCH_STATUSES.includes(w.status)) {
    out.watch = { status: w.status };
    if (w.status === "countdown") out.watch.endsAt = Number(w.endsAt) || 0;
    if (w.status === "watching" || w.status === "partial") out.watch.percent = clampPercent(w.percent);
    if (w.status === "idle" && typeof w.reason === "string" && w.reason) out.watch.reason = w.reason.slice(0, 300);
  }
  out.like = raw.like === true;
  out.dislike = raw.dislike === true && !out.like;  // the two are mutually exclusive
  if (Number.isFinite(raw.ts)) out.ts = raw.ts;
  return out;
}

// Keep the newest `max` videos (by their last change).
export function capVideoStates(map, max = MAX_VIDEO_STATES) {
  const entries = Object.entries(map || {});
  if (entries.length <= max) return map || {};
  entries.sort((a, b) => (Number(b[1]?.ts) || 0) - (Number(a[1]?.ts) || 0));
  return Object.fromEntries(entries.slice(0, max));
}

// The checkbox as the person sees it. `now` is only needed for the countdown.
export function watchView(watch, now = Date.now()) {
  const w = watch || { status: "idle" };
  switch (w.status) {
    case "countdown": return { checked: true, disabled: false, label: `Watch (${Math.max(0, Math.ceil(((Number(w.endsAt) || 0) - now) / 1000))}s)` };
    case "queued": return { checked: true, disabled: false, label: "Watch (queued)" };
    case "watching": return { checked: true, disabled: false, label: "Watching" };
    case "watched": return { checked: true, disabled: true, label: "Watched" };
    case "partial": return { checked: true, disabled: true, label: `Watched (${clampPercent(w.percent)}%)` };
    default: return { checked: false, disabled: false, label: "Watched" };
  }
}
