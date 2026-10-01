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
