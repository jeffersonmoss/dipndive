// URL choice for a context-menu click (plan 3.1.3).
export function isHttp(u) {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

// True for URLs that name one YouTube video (watch, youtu.be, shorts, live, embed). The companion does the
// real normalization; this only decides whether a media srcUrl is trustworthy.
export function knownVideo(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "youtu.be") return /^\/[A-Za-z0-9_-]{11}/.test(url.pathname);
  if (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtube-nocookie.com" || h.endsWith(".youtube-nocookie.com")) {
    if (url.pathname === "/watch") return /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "");
    return /^\/(shorts|live|embed|v)\/[A-Za-z0-9_-]{11}/.test(url.pathname);
  }
  return false;
}

// Identity of a source for the question box: the YouTube video id when the URL names one video, else the URL
// without its fragment. Two links with the same key are the same source, so the Q&A thread is kept.
export function sourceKey(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return String(u);
  }
  if (knownVideo(u)) {
    const h = url.hostname.toLowerCase();
    const id = h === "youtu.be" ? url.pathname.slice(1, 12)
      : url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.split("/")[2].slice(0, 11);
    return `yt:${id}`;
  }
  url.hash = "";
  return url.href;
}

// linkUrl; then srcUrl only if http(s) and a known video (on YouTube it is usually a blob: URL);
// then frameUrl when it is a known video embed; then pageUrl.
export function pickUrl(info) {
  if (info.linkUrl && isHttp(info.linkUrl)) return info.linkUrl;
  if (info.srcUrl && isHttp(info.srcUrl) && knownVideo(info.srcUrl)) return info.srcUrl;
  // frameUrl only for known video embeds; comment widgets, ads and other iframes fall through to the page
  if (info.frameUrl && isHttp(info.frameUrl) && knownVideo(info.frameUrl)) return info.frameUrl;
  if (info.pageUrl && isHttp(info.pageUrl)) return info.pageUrl;
  return null;
}

// A link typed or pasted into the panel's field. Bare hosts get https://; anything that is not an http(s) link is
// refused (null). The companion does the real normalization (redirect unwrapping, video ids) for every source.
export function normalizeTyped(text) {
  let t = String(text ?? "").trim().replace(/^[<"'(]+|[>"')]+$/g, "").trim();
  if (!t || /\s/.test(t)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(t)) t = "https://" + t;
  return isHttp(t) ? t : null;
}

// The creator link under the title: the channel page plus "/videos", only for a YouTube channel page the companion named
// (https://www.youtube.com/@handle or /channel/UC...). Anything else gives null and the name shows as plain text. The address
// is rebuilt from the parsed parts, never passed through, and the name never comes from model output.
export function creatorVideosUrl(channelUrl) {
  if (typeof channelUrl !== "string") return null;
  let url;
  try {
    url = new URL(channelUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.port || url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (!/^\/(@[^/\s]+|channel\/UC[A-Za-z0-9_-]+)$/.test(path)) return null;
  return `https://www.youtube.com${path}/videos`;
}

// What the creator line shows for a controller state: { name, href }. Hidden (name "") when there is no name; href is null for
// plain text (articles, and any channel page that is not a YouTube @handle or /channel/UC... address).
// 1.11: the video's length and publication date follow the name on the same line ("Channel · 12:34 · 3 Nov 2026"); `full`
// is the whole line, shown on hover when it is cut short with an ellipsis.
export function creatorView(s) {
  const name = typeof s?.channel === "string" ? s.channel.trim() : "";
  const details = [formatDuration(s?.duration), formatPublished(s?.published)].filter(Boolean);
  return { name, href: name ? creatorVideosUrl(s.channelUrl) : null, details, full: [name, ...details].filter(Boolean).join(" · ") };
}

// 754 -> "12:34", 3723 -> "1:02:03"; "" for anything that is not a positive number of seconds.
export function formatDuration(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "";
  const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-11-03" -> "3 Nov 2026"; "" for anything else.
export function formatPublished(day) {
  const m = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return "";
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// The title link opens the summarized page in the tab he is looking at (the active tab of the panel's window), not a new
// tab. Only a plain left click: Cmd/Ctrl/Shift/Alt or a middle click keep the browser's own new-tab or new-window behavior.
export const isPlainClick = (e) => !!e && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// No "tabs" permission is needed: the active tab's id is visible without it, and tabs.update may set any http(s) url.
// When there is no tab to reuse, or Chrome refuses, it falls back to a new tab so the click never does nothing.
export async function openInCurrentTab(tabsApi, windowId, url) {
  try {
    const [tab] = await tabsApi.query({ active: true, windowId });
    if (tab && tab.id !== undefined) { await tabsApi.update(tab.id, { url }); return "current"; }
  } catch { /* fall through */ }
  await tabsApi.create({ url, windowId });
  return "new";
}
