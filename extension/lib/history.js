// History view logic, DOM-free so it can be unit-tested. The panel asks the companion for the history log (GET /history,
// newest first, one page at a time) and shows it in place of the summary and the question box until Back is pressed.
import { ApiError, request } from "./api.js";
import { esc, renderMarkdown, safeHref } from "./markdown.js";

export const PAGE_SIZE = 20;
const TIMEOUT_MS = 10000;  // the companion reads and parses the whole log for each page

const MESSAGES = {
  unauthorized: "The companion did not accept the token. Check the token in the extension options.",
  log_unreadable: "The history log cannot be read on the iMac.",
};

export function describeHistoryError(e, status, code) {
  if (e instanceof ApiError) return e.kind === "config" ? "Set the companion URL and token in the extension options." : e.message;
  return MESSAGES[code] || `Could not load the history (${code || "error " + status}).`;
}

export class HistoryBrowser {
  constructor({ fetch, getCfg, onState }) {
    this.d = { fetch, getCfg, onState };
    this.gen = 0;  // bumped on open and Back: a page that was still on its way for an older view is dropped
    this.s = { open: false, loading: false, entries: [], total: 0, nextBefore: null, error: null, loaded: false };
  }

  emit(patch) {
    Object.assign(this.s, patch);
    this.d.onState({ ...this.s, entries: this.s.entries });
  }

  // Always starts again from the newest entry, so a summary that finished since the last look is in it.
  async open() {
    this.gen++;
    this.emit({ open: true, loading: false, entries: [], total: 0, nextBefore: null, error: null, loaded: false });
    await this.load(null);
  }

  back() {
    this.gen++;
    this.emit({ open: false, loading: false, entries: [], error: null, loaded: false });
  }

  // The next, older page (also the retry after an error).
  async more() {
    if (!this.s.open || this.s.loading) return;
    if (this.s.loaded && this.s.nextBefore === null) return;
    await this.load(this.s.nextBefore);
  }

  async load(before) {
    const gen = this.gen;
    this.emit({ loading: true, error: null });
    const qs = `limit=${PAGE_SIZE}${before === null ? "" : `&before=${before}`}`;
    let r;
    try {
      r = await request(this.d.fetch, this.d.getCfg(), "GET", `/history?${qs}`, null, TIMEOUT_MS);
    } catch (e) {
      if (gen === this.gen) this.emit({ loading: false, error: describeHistoryError(e) });
      return;
    }
    if (gen !== this.gen) return;
    const j = r.json || {};
    if (r.status !== 200 || !Array.isArray(j.entries)) {
      this.emit({ loading: false, error: describeHistoryError(null, r.status, r.status === 401 ? "unauthorized" : j.error_code) });
      return;
    }
    this.emit({ loading: false, loaded: true, entries: [...this.s.entries, ...j.entries], total: typeof j.total === "number" ? j.total : 0,
      nextBefore: typeof j.next_before === "number" ? j.next_before : null });
  }
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
