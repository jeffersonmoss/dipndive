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

// linkUrl; then srcUrl only if http(s) and a known video (on YouTube it is usually a blob: URL);
// then frameUrl (catches embed iframes); then pageUrl.
export function pickUrl(info) {
  if (info.linkUrl && isHttp(info.linkUrl)) return info.linkUrl;
  if (info.srcUrl && isHttp(info.srcUrl) && knownVideo(info.srcUrl)) return info.srcUrl;
  if (info.frameUrl && isHttp(info.frameUrl)) return info.frameUrl;
  if (info.pageUrl && isHttp(info.pageUrl)) return info.pageUrl;
  return null;
}
