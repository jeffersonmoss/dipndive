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

// Message that tells an open History page to load its data again (sent to a tab the History button brought forward).
export const HISTORY_REFRESH = "dipdive-history-refresh";
// Message the panel sends to the service worker, which alone opens or reuses the History tab (see createHistoryOpener).
export const OPEN_HISTORY = "dipdive-open-history";

// Runs `load()` for the History page, and again when asked to refresh. Only one load runs at a time: a refresh that
// arrives while one is running makes exactly one more load follow it (the data it fetched may be older than the request),
// so a burst of triggers (the tab brought forward, then becoming visible) costs at most two loads and a slow old load can
// never overwrite a newer one. `load` is the whole sequence for one pass (reread the settings, refetch every page, show).
// Resolves when no load is running or queued any more.
export function createHistoryRefresher(load) {
  let running = null, again = false;
  async function loop() {
    do {
      again = false;
      try { await load(); } catch { /* load reports its own failure to the page; the next trigger tries again */ }
    } while (again);
  }
  return {
    refresh() {
      if (running) { again = true; return running; }
      running = loop().finally(() => { running = null; });
      return running;
    },
  };
}

// The History button: show the History tab, reusing one that is already open (in any window) rather than opening
// another. chrome.runtime.getContexts needs no extra permission (Chrome 116+). A tab that is brought forward is told to
// reload its data (the page would otherwise show what it loaded when it was opened).
export async function openHistoryTab(chromeApi, url, known = {}) {
  try {
    let tab = null;
    if (typeof known.tabId === "number") {
      // a tab this worker opened a moment ago may not be listed by getContexts yet: ask for it directly
      const t = await chromeApi.tabs.get(known.tabId).catch(() => null);
      const at = t && (t.url || t.pendingUrl);  // an extension sees its own pages' addresses; the user may have navigated away
      if (t && typeof t.id === "number" && (!at || at === url)) tab = { tabId: t.id, windowId: t.windowId };
    }
    if (!tab && chromeApi.runtime && chromeApi.runtime.getContexts) {
      const open = await chromeApi.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
      tab = (open && open.find((c) => typeof c.tabId === "number" && c.tabId >= 0)) || null;
    }
    if (tab) {
      await chromeApi.tabs.update(tab.tabId, { active: true });
      if (chromeApi.windows && chromeApi.windows.update && typeof tab.windowId === "number") await chromeApi.windows.update(tab.windowId, { focused: true });
      try { await chromeApi.tabs.sendMessage(tab.tabId, { type: HISTORY_REFRESH }); } catch { /* the page is still loading (it loads on its own) or gone */ }
      return "reused";
    }
  } catch { /* fall through: open a new one */ }
  const t = await chromeApi.tabs.create({ url });
  if (known && t && typeof t.id === "number") known.tabId = t.id;
  return "opened";
}

// The service worker's opener: ONE lookup-or-create at a time, shared by every panel. A click that arrives while one is
// running joins it (same promise, same answer) instead of racing it to open a second tab; the tab it opened is
// remembered, so a click right after is found even before getContexts lists the new page.
export function createHistoryOpener(chromeApi, url) {
  let inflight = null;
  const known = {};
  return function open() {
    if (!inflight) inflight = openHistoryTab(chromeApi, url, known).finally(() => { inflight = null; });
    return inflight;
  };
}
