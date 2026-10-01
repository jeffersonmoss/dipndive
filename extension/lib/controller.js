// Side panel logic, DOM-free so it can be unit-tested (plan 3.1.5 to 3.1.9, 3.1.11).
import { ApiError, request } from "./api.js";
import { pruneSlots, slotKey } from "./background-core.js";
import { DEFAULT_MODE, TEMP_CHAT_URL, TEMP_PREFIX, TEMP_WARN_CHARS, apiMode, normalizeMode } from "./modes.js";

export const POLL_MS = 1500;

const MESSAGES = {
  no_captions: "This video has no usable captions, so there is nothing to summarize.",
  no_article_text: "Could not get the article text (it may be paywalled, behind a login, or not an article).",
  live_in_progress: "This is a live stream that is still running.",
  too_long: "The source is too long to summarize.",
  not_a_video: "That YouTube link is a playlist or channel, not one video.",
  blocked_address: "That address is not allowed.",
  timeout: "The summary took too long and was stopped.",
  queue_full: "The companion is busy. Try again in a minute.",
  interrupted: "The companion restarted during this job. Press the button again.",
  request_id_conflict: "Internal request conflict. Right-click the link again.",
};

export function describeError(code, message) {
  if (code === "auth") return `${message || "Sign-in problem"} Sign in again on the iMac.`;
  if (code === "quota") return `${message || "Usage limit reached."}`;
  return MESSAGES[code] || message || `Error: ${code}`;
}

export class Controller {
  constructor(deps) {
    // deps: storage {get,set}, fetch, clipboard {writeText}, openTab(url), uuid(), onState(state),
    //       setTimer(fn, ms) -> id, clearTimer(id)
    this.d = deps;
    this.windowId = null;
    this.cfg = null;
    this.selGen = 0;       // bumped on every selection; older responses are discarded
    this.clearGen = null;  // highest companion clear generation seen
    this.timer = null;
    this.slot = null;
    this.tempText = null;
    this.s = {
      configured: false, source: null, mode: DEFAULT_MODE, jobId: null, jobState: null, title: null,
      result: null, error: null, status: "", tempReady: false, tempChars: 0, tempWarn: false, tempNote: "", busy: false,
      codexOk: null, codexReason: "",
    };
  }

  emit(patch = {}) {
    Object.assign(this.s, patch);
    this.d.onState({ ...this.s });
  }

  // Codex availability from the companion's /health. While Codex is logged out or its isolation is unverified,
  // Codex buttons are disabled and Claude Dip is the effective default; null means unknown (buttons stay enabled).
  async checkHealth() {
    let ok = null, reason = "";
    try {
      if (this.d.healthOverride) {
        ok = this.d.healthOverride === "codex-ready";
        reason = "Codex is unavailable on the iMac. Using Claude.";
      } else {
        const r = await request(this.d.fetch, this.cfg, "GET", "/health", null, 5000);
        const h = r.json || {};
        if (r.status === 200 && typeof h.codex_ready === "boolean") {
          ok = h.codex_ready;
          if (!ok) reason = !h.codex_logged_in ? "Codex is not signed in on the iMac. Using Claude."
            : "Codex isolation is not verified on the iMac. Using Claude.";
        }
      }
    } catch { /* unknown: leave Codex enabled, the job itself will report a real error */ }
    this.emit({ codexOk: ok, codexReason: reason });
  }

  effectiveMode(m) {
    return this.s.codexOk === false && m.startsWith("codex") ? "claude-dip" : m;
  }

  async init(windowId) {
    this.windowId = windowId;
    const all = await this.d.storage.get(null);
    this.cfg = { base: all.base, token: all.token };
    this.emit({ configured: !!(all.base && all.token), mode: normalizeMode(all.mode) });
    if (!this.s.configured) {
      this.emit({ status: "Set the companion URL and token in the extension options." });
      return;
    }
    await this.checkHealth();
    this.emit({ mode: this.effectiveMode(normalizeMode(all.mode)) });
    let mine = all[slotKey(windowId)];
    if (!mine) {
      // After a browser restart window ids change: take the newest slot and move it to this window.
      const newest = Object.entries(all).filter(([k]) => k.startsWith("slot:")).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))[0];
      if (newest) {
        mine = { ...newest[1], windowId };
        await this.d.storage.set({ [slotKey(windowId)]: mine });
        await this.d.storage.remove(newest[0]);
      }
    }
    await pruneSlots(this.d.storage);
    await this.onSlot(mine);
  }

  // New or changed slot. An unconsumed slot is submitted; a consumed one is resumed after a panel reopen.
  async onSlot(slot) {
    if (!slot || !slot.url) {
      this.emit({ status: "Right-click a link or page and choose Dip and Dive." });
      return;
    }
    const isNew = !this.slot || this.slot.requestId !== slot.requestId;
    this.slot = slot;
    this.emit({ source: { url: slot.url } });
    if (!isNew) return;
    if (slot.consumed && slot.jobId) {
      this.emit({ mode: this.effectiveMode(normalizeMode(slot.mode || this.s.mode)) });
      await this.beginTracking(slot.jobId);
      return;
    }
    // A fresh right-click uses the last mode chosen anywhere; an unacknowledged resubmit keeps the mode it
    // was first sent with, so the same requestId never meets a different mode.
    let mode = slot.pendingMode;
    if (!mode) {
      const st = await this.d.storage.get(["mode"]);
      await this.checkHealth();
      mode = this.effectiveMode(normalizeMode(st.mode));
    }
    this.emit({ mode });
    await this.submit(mode, { requestId: slot.requestId, force: false, fromSlot: true });
  }

  onStorageChange(changes, area) {
    if (area !== "local") return;
    // A mode change made in another window must not alter this panel's own selection or its pressed button.
    const k = slotKey(this.windowId);
    if (changes[k] && changes[k].newValue) this.onSlot(changes[k].newValue);
    if (changes.base || changes.token) {
      this.d.storage.get(["base", "token"]).then((st) => {
        this.cfg = { base: st.base, token: st.token };
        this.emit({ configured: !!(st.base && st.token) });
      });
    }
  }

  async selectMode(id) {
    id = normalizeMode(id);
    if (this.s.codexOk === false && id.startsWith("codex")) return;
    if (!this.slot) { this.emit({ status: "Right-click a link or page first." }); return; }
    const same = id === this.s.mode;
    this.emit({ mode: id });
    await this.d.storage.set({ mode: id }); // the background worker relabels the menu on this change
    // Force only when this panel's own pressed button is clicked again and a job for it is on screen.
    await this.submit(id, { requestId: this.d.uuid(), force: same && !!this.slot.jobId });
  }

  stopTimer() {
    if (this.timer !== null) { this.d.clearTimer(this.timer); this.timer = null; }
  }

  resetView(extra = {}) {
    this.stopTimer();
    this.tempText = null;
    this.emit({ jobId: null, jobState: null, title: null, result: null, error: null, tempReady: false,
                tempChars: 0, tempWarn: false, tempNote: "", ...extra });
  }

  // Returns false when the response must be discarded (stale selection or older clear generation).
  accept(gen, json) {
    if (gen !== this.selGen) return false;
    const cg = json && json.clear_generation;
    if (typeof cg === "number") {
      if (this.clearGen !== null && cg < this.clearGen) return false;
      this.clearGen = cg;
    }
    return true;
  }

  failure(gen, e) {
    if (gen !== this.selGen) return;
    this.stopTimer();
    const msg = e instanceof ApiError && e.kind === "config" ? "Set the companion URL and token in the extension options."
      : "Cannot reach the companion. Is the iMac on and connected to Tailscale?";
    this.emit({ error: msg, status: "", busy: false });
  }

  async submit(mode, { requestId, force, fromSlot, retried }) {
    const gen = ++this.selGen;
    this.resetView({ status: "Submitting...", busy: true });
    if (fromSlot && !this.slot.consumed && this.slot.pendingMode !== mode) {
      this.slot = { ...this.slot, pendingMode: mode };
      await this.d.storage.set({ [slotKey(this.windowId)]: this.slot });
    }
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "POST", "/jobs",
        { url: this.slot.url, mode: apiMode(mode), requestId, force: !!force }, 5000);
    } catch (e) { this.failure(gen, e); return; }
    if (!this.accept(gen, r.json)) return;
    if (r.status === 409 && !retried) {  // requestId already used for another mode: start over with a fresh id
      return this.submit(mode, { requestId: this.d.uuid(), force, fromSlot: false, retried: true });
    }
    if (r.status === 401) { this.emit({ error: "The token was rejected. Check the options page.", status: "", busy: false }); return; }
    if (r.status === 429 || r.status === 409 || r.status >= 400 || !r.json.job_id) {
      this.emit({ error: describeError(r.json.error_code, r.json.error_message), status: "", busy: false });
      return;
    }
    const slot = { ...this.slot, jobId: r.json.job_id, mode, consumed: true, pendingMode: undefined };
    this.slot = slot;
    await this.d.storage.set({ [slotKey(this.windowId)]: slot });
    await this.beginTracking(r.json.job_id, gen);
  }

  beginTracking(jobId, gen = ++this.selGen) {
    this.emit({ jobId, busy: true, status: "Queued...", error: null });
    return this.poll(jobId, gen);
  }

  async poll(jobId, gen) {
    if (gen !== this.selGen) return;
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "GET", `/jobs/${jobId}`, null, 5000);
    } catch (e) { this.failure(gen, e); return; }
    if (!this.accept(gen, r.json)) return;
    if (r.status === 404) { this.emit({ error: "That result is gone (history was cleared). Press the button again.", status: "", busy: false }); return; }
    if (r.status >= 400) { this.emit({ error: describeError(r.json.error_code, r.json.error_message), status: "", busy: false }); return; }
    const j = r.json;
    this.emit({ title: j.title || this.s.title, source: { url: j.url || this.slot.url }, jobState: j.state });
    if (j.state === "done") {
      if (this.s.mode === "temp") { await this.loadTemp(jobId, gen); return; }
      this.emit({ result: j.result_markdown, status: "Done.", busy: false });
    } else if (j.state === "error") {
      this.emit({ error: describeError(j.error_code, j.error_message), status: "", busy: false });
    } else {
      const label = { queued: "Queued...", fetching: "Fetching the source...", summarizing: "Summarizing..." }[j.state] || j.state;
      this.emit({ status: label });
      this.timer = this.d.setTimer(() => this.poll(jobId, gen), POLL_MS);
    }
  }

  async loadTemp(jobId, gen) {
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "GET", `/source?job=${encodeURIComponent(jobId)}`, null, 5000);
    } catch (e) { this.failure(gen, e); return; }
    if (!this.accept(gen, r.json)) return;
    if (r.status !== 200) { this.emit({ error: describeError(r.json.error_code, r.json.error_message), status: "", busy: false }); return; }
    const title = r.json.title || this.s.title || "";
    // Built now, so the click handler has nothing to do but write it.
    this.tempText = `${TEMP_PREFIX}\n\nTitle: ${title}\nURL: ${r.json.url || this.slot.url}\n\n<source>\n${r.json.text}\n</source>\n`;
    const chars = r.json.text.length;
    this.emit({ tempReady: true, tempChars: chars, tempWarn: chars > TEMP_WARN_CHARS, status: "Source ready.", busy: false, title });
  }

  // Click handler for "Copy and open ChatGPT": write first, open the tab only after the write succeeded
  // (opening the tab first would unfocus the panel and fail the write).
  async copyAndOpen() {
    if (!this.tempText) return false;
    try {
      await this.d.clipboard.writeText(this.tempText);
    } catch (e) {
      this.emit({ tempNote: "Copy failed. Click the button again." });
      return false;
    }
    this.d.openTab(TEMP_CHAT_URL);
    this.emit({ tempNote: "Copied. Press Cmd/Ctrl+V then Enter." });
    return true;
  }

  async clearHistory() {
    const gen = ++this.selGen;
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "POST", "/clear", {}, 5000);
    } catch (e) { this.failure(gen, e); return; }
    if (typeof r.json.clear_generation === "number") this.clearGen = r.json.clear_generation;
    if (r.status === 200) {  // the extension must not keep a list of what was looked at either
      const all = await this.d.storage.get(null);
      await this.d.storage.remove(Object.keys(all).filter((k) => k.startsWith("slot:")));
      if (this.slot) this.slot = { url: this.slot.url, requestId: this.d.uuid(), windowId: this.windowId, ts: Date.now(), consumed: false };
    }
    this.resetView({ status: r.status === 200 ? "History cleared." : "Could not clear history.", busy: false });
  }
}
