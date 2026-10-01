// The History page (history.html), DOM-free so it can be unit-tested. The page loads the whole history log from the
// companion (GET /history, newest first, followed page by page until the end), so the browser's own find (Cmd/Ctrl+F)
// sees every entry, and filters it live with a keyword search.
import { ApiError, request } from "./api.js";
import { esc, renderMarkdown, safeHref } from "./markdown.js";

export const PAGE_SIZE = 100;     // the companion's largest page
const TIMEOUT_MS = 10000;         // the companion reads and parses the whole log for each page
const MAX_RESTARTS = 5;           // entries removed or restored while loading: start again, but not forever

const MESSAGES = {
  unauthorized: "The companion did not accept the token. Check the token in the extension options.",
  log_unreadable: "The history log cannot be read on the iMac.",
  log_locked: "The history log is locked on the iMac (its lock file cannot be used).",
};

export function describeHistoryError(e, status, code) {
  if (e instanceof ApiError) return e.kind === "config" ? "Set the companion URL and token in the extension options." : e.message;
  return MESSAGES[code] || `Could not load the history (${code || "error " + status}).`;
}

// Every entry, newest first. Each later page carries the revision of the first one; when the companion answers
// 409 history_changed (an entry was removed or restored meanwhile, so positions moved), loading starts again from the
// newest so nothing is repeated or skipped. onProgress(entriesSoFar, total) after each page.
// Resolves { entries, total, restarts } or { error }.
export async function loadAllHistory({ fetch, cfg, onProgress = () => {} }) {
  for (let restarts = 0; restarts <= MAX_RESTARTS; restarts++) {
    let entries = [], before = null, rev = null, total = 0, changed = false;
    for (;;) {
      const qs = `limit=${PAGE_SIZE}${before === null ? "" : `&before=${before}`}${before !== null && rev !== null ? `&revision=${rev}` : ""}`;
      let r;
      try {
        r = await request(fetch, cfg, "GET", `/history?${qs}`, null, TIMEOUT_MS);
      } catch (e) {
        return { error: describeHistoryError(e) };
      }
      const j = r.json || {};
      if (r.status === 409 && j.error_code === "history_changed") { changed = true; break; }
      if (r.status !== 200 || !Array.isArray(j.entries)) {
        return { error: describeHistoryError(null, r.status, r.status === 401 ? "unauthorized" : j.error_code) };
      }
      if (before === null) rev = typeof j.revision === "number" ? j.revision : null;
      entries = entries.concat(j.entries);
      total = typeof j.total === "number" ? j.total : entries.length;
      onProgress(entries, total);
      if (typeof j.next_before !== "number") return { entries, total, restarts };
      before = j.next_before;
    }
    if (!changed) break;
  }
  return { error: "The history kept changing while it was loading. Reload the page to try again." };
}

// The text a search looks in: title, channel and summary, lower case.
export function searchText(e) {
  return [e.title, e.channel, e.summary].filter(Boolean).join("\n").toLowerCase();
}

// Every word of the query must appear (case-insensitive, in any order). An empty query matches everything.
export function matches(text, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w));
}

// One entry as HTML. Every text goes through esc() or the safe Markdown renderer; the link is http(s) only and opens in a
// new tab. A URL that is not http(s) is shown as plain text, never as a link.
export function entryHtml(e) {
  const href = safeHref(e.url);
  const title = esc(e.title || e.url || "Untitled");
  const head = href ? `<a class="htitle" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span class="htitle">${title}</span>`;
  const meta = [e.date && e.time ? `${e.date} ${e.time}` : e.date || "", e.mode_label || e.mode || ""].filter(Boolean).map(esc).join(" &middot; ");
  const ch = e.channel ? `<div class="hchannel">${esc(e.channel)}</div>` : "";
  const body = e.summary ? `<div class="hsummary">${renderMarkdown(e.summary)}</div>` : "";
  return `${head}${ch}<div class="hmeta">${meta}</div>${body}`;
}

// The History button: show the History tab, reusing one that is already open (in any window) rather than opening
// another. chrome.runtime.getContexts needs no extra permission (Chrome 116+).
export async function openHistoryTab(chromeApi, url) {
  try {
    if (chromeApi.runtime && chromeApi.runtime.getContexts) {
      const open = await chromeApi.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
      const tab = open && open.find((c) => typeof c.tabId === "number" && c.tabId >= 0);
      if (tab) {
        await chromeApi.tabs.update(tab.tabId, { active: true });
        if (chromeApi.windows && chromeApi.windows.update && typeof tab.windowId === "number") await chromeApi.windows.update(tab.windowId, { focused: true });
        return "reused";
      }
    }
  } catch { /* fall through: open a new one */ }
  await chromeApi.tabs.create({ url });
  return "opened";
}
