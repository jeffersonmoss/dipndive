// Side panel logic, DOM-free so it can be unit-tested (plan 3.1.5 to 3.1.9, 3.1.11).
import { ApiError, request } from "./api.js";
import { clearCompanion } from "./clear.js";
import { makeSlot, pruneSlots, slotKey } from "./background-core.js";
import { normalizeTyped, pickUrl, sourceKey } from "./urls.js";
import { ASK_LIMITS, askProvider, capHistory, capSummary, charCount, cleanQuestion } from "./ask.js";
import { MIC, VoiceInput } from "./voice.js";
import { DEFAULT_MODE, MODE_IDS, normalizeMode } from "./modes.js";

export const POLL_MS = 1500;
export const ASK_POLL_MS = 1200;

// The companion refuses a POST /jobs that carries an older clear generation than its own (409, no job made): another
// machine pressed Clear history since this panel last heard from the companion.
export const STALE_CODE = "stale_clear_generation";
export const STALE_MESSAGE = "History was cleared on another machine.";
const isStaleRefusal = (r) => r.status === 409 && !!r.json && r.json.error_code === STALE_CODE;

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
  bad_request: "The companion refused that question. Try a shorter one.",
  [STALE_CODE]: STALE_MESSAGE,
};

export function describeError(code, message) {
  if (code === "auth") return `${message || "Sign-in problem"} Sign in again on the iMac.`;
  if (code === "quota") return `${message || "Usage limit reached."}`;
  return MESSAGES[code] || message || `Error: ${code}`;
}

export class Controller {
  constructor(deps) {
    // deps: storage {get,set}, fetch, openTab(url), uuid(), onState(state), setTimer(fn, ms) -> id, clearTimer(id),
    //       tabs {requestAccess(), activeTab(windowId)} for the pin button (see summarizePage)
    this.d = deps;
    this.windowId = null;
    this.cfg = null;
    this.selGen = 0;       // bumped on every selection; older responses are discarded
    this.savedRev = -1;    // newest history-log revision seen for the save box
    this.clearGen = null;  // highest companion clear generation seen
    this.timer = null;
    this.askTimer = null;
    this.askGen = 0;       // bumped on every new source, clear and send; older answers are discarded
    this.slot = null;
    this.micPrefix = "";   // what was typed in the box when the microphone started; spoken words are added after it
    this.s = {
      configured: false, source: null, mode: DEFAULT_MODE, jobId: null, jobState: null, title: null,
      result: null, error: null, status: "", busy: false,
      codexOk: null, codexReason: "",
      // the "Save this Dip to history" checkbox: true or false while the summary on screen has an entry in the companion's
      // history log, null when it has none (no summary, a log failure); savingSaved while a change is on its way
      saved: null, savingSaved: false, savedUnknown: false,  // (savedRev, the newest log revision seen, is kept on this)
      // question box: earlier turns for this source, the turn in flight, the box text (draftSeq changes when the
      // controller, not the user, writes it), and the microphone state
      thread: [], asking: null, askError: null, draft: "", draftSeq: 0,
      mic: null,
    };
    this.voice = new VoiceInput({
      SpeechRecognition: deps.speech || null,
      permissions: deps.permissions || null,
      setTimer: deps.setVoiceTimer || deps.setTimer,
      clearTimer: deps.clearVoiceTimer || deps.clearTimer,
      onChange: (m) => this.onMic(m),
      onFinal: (text, o) => this.onVoiceText(text, o),
    });
    this.s.mic = this.voice.snapshot();
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
    // An old install can have the removed "temp" mode stored: forget it, so every window and the menu fall back to the default.
    if (all.mode !== undefined && !MODE_IDS.includes(all.mode)) await this.d.storage.remove("mode");
    this.emit({ configured: !!(all.base && all.token), mode: normalizeMode(all.mode) });
    if (!this.s.configured) {
      this.emit({ status: "Set the companion URL and token in the extension options." });
      return;
    }
    await this.checkHealth();
    this.emit({ mode: this.effectiveMode(normalizeMode(all.mode)) });
    this.voice.refreshPermission();  // shows Enable microphone up front when the grant is missing
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
      this.emit({ status: "Paste a link above and press Go, or right-click a link or page." });
      return;
    }
    const isNew = !this.slot || this.slot.requestId !== slot.requestId;
    const prev = this.slot;
    this.slot = slot;
    this.emit({ source: { url: slot.url } });
    if (!isNew) return;
    // The question thread belongs to one source: another source starts a fresh one.
    if (!prev || sourceKey(prev.url) !== sourceKey(slot.url)) this.resetAsk();
    // Slots written by an old install can carry the removed "temp" mode (its job was a source-only fetch, with no summary).
    // That job is not resumed and nothing is submitted by itself: the page is shown and the person picks a mode.
    const legacy = (m) => !!m && !MODE_IDS.includes(m);
    if (legacy(slot.mode) || legacy(slot.pendingMode)) {
      this.slot = { url: slot.url, requestId: slot.requestId, windowId: slot.windowId, ts: slot.ts, consumed: false };
      this.emit({ status: "Choose a mode to summarize this page." });
      return;
    }
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

  // Writes a fresh slot for `url` to this window's key and submits it through onSlot with this panel's own selected mode.
  // Same slot as a right-click makes (makeSlot), so the same requestId, per-window slot, history and clear generation apply.
  async submitUrl(url) {
    const slot = { ...makeSlot(url, this.windowId, this.d.uuid()), pendingMode: this.s.mode };
    await this.d.storage.set({ [slotKey(this.windowId)]: slot });
    await pruneSlots(this.d.storage);
    await this.onSlot(slot);
  }

  // The URL field: same path as a right-click.
  async submitTyped(text) {
    if (!this.s.configured) { this.emit({ error: "Set the companion URL and token in the extension options." }); return false; }
    const url = normalizeTyped(text);
    if (!url) { this.emit({ error: "That does not look like a web link. Paste an http or https address." }); return false; }
    this.emit({ error: null });
    await this.submitUrl(url);
    return true;
  }

  // The pin button: summarize the page in the active tab of this panel's window with the selected mode, as if the person had
  // right-clicked the page and chosen Dip'n'Dive. It is an action, not a mode: it changes no setting and no pressed button.
  // Reading a tab's address from a side panel needs the optional "tabs" permission (a side-panel click grants no activeTab).
  // `tabs.requestAccess()` is called first, before any other await, because Chrome only shows its prompt for a call made
  // inside the click; when the permission is already held it answers true at once without asking. Returns true once a
  // summary was started.
  async summarizePage() {
    if (!this.s.configured) { this.emit({ error: "Set the companion URL and token in the extension options." }); return false; }
    const tabs = this.d.tabs;
    if (!tabs) { this.emit({ error: "This button needs the Chrome extension." }); return false; }
    let granted = false;
    try { granted = await tabs.requestAccess(); } catch { /* treated as not granted */ }
    if (!granted) {
      this.emit({ error: "To summarize the open page, Dip'n'Dive needs to read its address. Click the pin again and choose Allow, or paste a link above.", busy: false, status: "" });
      return false;
    }
    let tab = null;
    try { tab = await tabs.activeTab(this.windowId); } catch { /* no tab */ }
    if (!tab) { this.emit({ error: "No page is open in this window." }); return false; }
    const url = pickUrl({ pageUrl: tab.url });  // the right-click's own check: only http and https pages
    if (!url) { this.emit({ error: "This page cannot be summarized. Open a web page (an http or https address) and try again." }); return false; }
    this.emit({ error: null });
    await this.submitUrl(url);
    return true;
  }

  onStorageChange(changes, area) {
    if (area !== "local") return;
    // A mode change made in another window must not alter this panel's own selection or its pressed button.
    const k = slotKey(this.windowId);
    if (changes[k] && changes[k].newValue) this.onSlot(changes[k].newValue);
    // Clear history in another window writes the new generation here: this panel's thread and shown summary go too, or
    // its next question would send them to the companion again.
    const cg = changes.clearGen && changes.clearGen.newValue;
    if (typeof cg === "number" && this.clearGen !== null && cg > this.clearGen) this.clearedElsewhere(cg);
    // A save box was changed in some window (maybe for this very entry, or one this summary shares through the result
    // cache): ask the companion again rather than trust what this panel showed.
    if (changes.savedChange && changes.savedChange.newValue && typeof this.s.saved === "boolean") {
      if (this.s.savingSaved) this.noteIncoming(changes.savedChange.newValue.rev);  // kept for when this panel's own answer arrives
      this.refreshSaved();
    }
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
    this.savedRev = -1;  // the newest history-log revision this panel has seen for the box (see takeSaved)
    this.emit({ jobId: null, jobState: null, title: null, result: null, error: null,
                saved: null, savingSaved: false, savedUnknown: false, ...extra });
  }

  // Another window cleared the companion's history (generation `cg`): forget what this panel was showing and the
  // question thread built on it, and drop any job or answer still on its way.
  clearedElsewhere(cg, status = "History was cleared in another window or on the Options page.") {
    this.clearGen = cg;
    this.selGen++;
    this.stopTimer();
    if (this.slot) this.slot = { url: this.slot.url, requestId: this.d.uuid(), windowId: this.windowId, ts: Date.now(), consumed: false };
    this.resetAsk();
    this.resetView({ status, busy: false });
  }

  // Every POST /jobs (summaries and questions) carries the clear generation this panel knows, so the companion
  // can refuse work that was built on history another machine has since cleared. Unknown (nothing heard yet): omitted.
  genField() {
    return typeof this.clearGen === "number" ? { clearGeneration: this.clearGen } : {};
  }

  // The companion refused a POST /jobs as stale (409 stale_clear_generation, no job made). What this panel shows
  // (summary, thread) was built on history that is gone: forget it, adopt the companion's generation so the next press or
  // question works, say so, and send nothing again by itself. `q` is the question that was refused, if there was one: it
  // goes back in the box (the message sits next to it); otherwise the message is shown in the page.
  async staleRefused(json, q) {
    const cg = json && json.clear_generation;
    if (typeof cg === "number") this.clearGen = cg;
    this.selGen++;        // a job of this panel still on its way belongs to the old history
    this.stopTimer();
    // An unsent slot (a right-click or Go that was just refused) must not be submitted by a later panel reopen.
    const unsent = this.slot && !this.slot.consumed ? this.slot.requestId : null;
    if (this.slot) this.slot = { url: this.slot.url, requestId: this.d.uuid(), windowId: this.windowId, ts: Date.now(), consumed: false };
    this.resetAsk();      // thread, draft, any answer on its way, the microphone
    if (q === undefined) {
      this.resetView({ error: STALE_MESSAGE, status: "", busy: false });
    } else {
      this.resetView({ status: "", busy: false });
      this.restoreDraft(q, STALE_MESSAGE);
    }
    if (unsent) {
      const key = slotKey(this.windowId);
      const st = await this.d.storage.get([key]);
      if (st[key] && !st[key].consumed && st[key].requestId === unsent) await this.d.storage.remove(key);
    }
  }

  // Returns false when the response must be discarded: a stale selection, or a generation older than one already seen
  // (the companion was reset: adopt its generation and ask for another press so the panel never waits forever).
  // A newer generation means another window cleared the history; the question thread belonged to the old one.
  accept(gen, json) {
    if (gen !== this.selGen) return false;
    const cg = json && json.clear_generation;
    if (typeof cg === "number") {
      if (this.clearGen !== null && cg < this.clearGen) {
        this.clearGen = cg;
        this.stopTimer();
        this.emit({ error: "The companion was reset. Press the button again.", status: "", busy: false });
        return false;
      }
      if (this.clearGen !== null && cg > this.clearGen) this.resetAsk();
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
        { url: this.slot.url, mode, requestId, force: !!force, ...this.genField() }, 5000);
    } catch (e) { this.failure(gen, e); return; }
    if (gen !== this.selGen) return;
    if (isStaleRefusal(r)) { await this.staleRefused(r.json); return; }
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
      this.emit({ result: j.result_markdown, status: "Done.", busy: false,
                  saved: typeof j.history_saved === "boolean" ? j.history_saved : null });
      this.noteRev(j.history_rev);
    } else if (j.state === "error") {
      this.emit({ error: describeError(j.error_code, j.error_message), status: "", busy: false });
    } else {
      const label = { queued: "Queued...", fetching: "Fetching the source...", summarizing: "Summarizing..." }[j.state] || j.state;
      this.emit({ status: label });
      this.timer = this.d.setTimer(() => this.poll(jobId, gen), POLL_MS);
    }
  }

  // Clear history from this panel. The panel itself no longer shows the control (it lives on the Options page, behind a
  // confirmation, through the same clearCompanion), but the flow is kept whole for the tests and the dev harness.
  async clearHistory() {
    const gen = ++this.selGen;
    let res;
    try {
      // the extension must not keep a list of what was looked at either; the other windows' panels hear clearGen
      res = await clearCompanion({ fetch: this.d.fetch, cfg: this.cfg, storage: this.d.storage, onGeneration: (cg) => { this.clearGen = cg; } });
    } catch (e) { this.failure(gen, e); return; }
    if (res.ok && this.slot) this.slot = { url: this.slot.url, requestId: this.d.uuid(), windowId: this.windowId, ts: Date.now(), consumed: false };
    if (res.ok) this.resetAsk();  // the Q&A history goes too
    this.resetView({ status: res.ok ? (res.localError ? `History cleared. Could not reset this browser's panel state: ${res.localError}` : "History cleared.") : "Could not clear history.", busy: false });
  }

  // The "Save this Dip to history" checkbox. Unticked: the companion takes this summary's entry out of the history log
  // (POST /history/<job>/remove); ticked again: it puts it back where it was (/restore). Both are idempotent and carry
  // the clear generation this panel knows. The box follows the click at once and goes back if the companion refuses.
  // When the answer is lost (the companion may have made the change), the panel does not guess: it asks the companion
  // for the job (GET /jobs/<id>, which carries history_saved) and says the outcome is unknown until it hears.
  // Every change is announced to the other windows' panels (storage key savedChange), which then ask again too.
  // Returns true when the box ended up as clicked.
  async setSaved(on) {
    const jobId = this.s.jobId;
    if (!jobId || typeof this.s.saved !== "boolean" || this.s.savingSaved) return false;
    const gen = this.selGen, was = this.s.saved;
    this.savedSeq = (this.savedSeq || 0) + 1;  // a refresh that started before this change must not overwrite its result
    this.incoming = null;                      // revisions heard from other windows while this change is on its way (noteIncoming)
    this.emit({ saved: !!on, savingSaved: true, savedUnknown: false });
    const still = () => gen === this.selGen && this.s.jobId === jobId;
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "POST", `/history/${encodeURIComponent(jobId)}/${on ? "restore" : "remove"}`, { ...this.genField() }, 10000);
    } catch (e) {
      if (!still()) return false;
      return this.reconcileSaved(jobId, on, still, "No answer from the companion");
    }
    if (!still()) return false;
    if (isStaleRefusal(r)) { await this.staleRefused(r.json); return false; }
    if (r.status === 200 && typeof r.json.saved === "boolean") {
      // Another window (or a GET) may have shown a newer log revision while this answer was on its way. This answer is
      // then older than what is known: do not show it as the result, find out what the log says now.
      if (this.incomingNewerThan(r.json.history_rev)) return this.reconcileNewer(jobId, on, still, r.json);
      this.incoming = null;
      this.noteRev(r.json.history_rev);
      this.emit({ saved: r.json.saved, savingSaved: false, savedUnknown: false, status: r.json.saved ? "Saved to history." : "Removed from history." });
      await this.announceSaved(jobId, r.json.saved, r.json.history_rev);
      return r.json.saved === !!on;
    }
    // A server error may come after the change was made (the entry was written, then something else failed): ask the
    // companion what the log now says, as for a lost answer, and never just put the box back.
    if (r.status >= 500) return this.reconcileSaved(jobId, on, still, "The companion reported a problem");
    const why = r.status === 401 ? "The token was rejected. Check the options page."
      : r.status === 404 ? "This summary is no longer in the history log."
      : r.status === 409 && r.json.error_code === "entry_ambiguous" ? "This entry was edited by hand in the log, so it was left as it is."
      : "The history log could not be changed on the iMac.";
    const hadIncoming = this.incoming !== null;
    this.incoming = null;
    this.emit({ saved: r.status === 404 ? null : was, savingSaved: false, savedUnknown: false, status: why });
    if (hadIncoming && r.status !== 404) await this.refreshSaved();  // a refresh that was held back while this change ran
    return false;
  }

  // While this panel's own change is on its way, answers about the box that arrive from elsewhere (another window's
  // broadcast, a GET on focus) are not applied, but the newest revision they carry is kept. `rev` is not a number when
  // the sender did not say which revision: that is kept as "something newer, unknown".
  noteIncoming(rev) {
    const n = typeof rev === "number" ? rev : Infinity;
    if (this.incoming === null || n > this.incoming) this.incoming = n;
  }

  // True when something newer than the answer (revision `rev`) was heard while it was on its way.
  incomingNewerThan(rev) {
    if (this.incoming === null) return false;
    return typeof rev !== "number" || this.incoming > rev;
  }

  // The answer to this panel's change is older than a revision heard meanwhile (so its "saved" may no longer be true).
  // Ask the companion; apply the answer only if it is at least as new as what was heard. If that cannot be settled, show
  // the box as uncertain rather than as the older answer's outcome.
  async reconcileNewer(jobId, on, still, answer) {
    const heard = this.incoming;
    this.incoming = null;
    this.noteRev(answer.history_rev);
    this.emit({ status: "Another window changed this entry while this change was being made. Checking..." });
    const now = await this.refreshSaved({ force: true, atLeast: Number.isFinite(heard) ? heard : null });
    if (!still()) return false;
    if (typeof now === "boolean") {
      await this.announceSaved(jobId, now, this.savedRev);
      return now === !!on;
    }
    if (now === null && this.s.saved === null && this.s.jobId === jobId && !this.s.savingSaved) return false;  // the entry is gone: refreshSaved said so
    this.emit({ saved: answer.saved, savingSaved: false, savedUnknown: true,
      status: "Another window changed this entry at the same time, and the companion could not confirm what the log says now. Click the box to try again." });
    return false;
  }

  // After a lost answer or a server error: say the outcome is not known yet, ask the companion, announce what it says
  // like any change, and mark the box unknown if even that fails.
  async reconcileSaved(jobId, on, still, why) {
    this.emit({ status: `${why}, so it is not known yet whether the history log changed. Checking...` });
    const now = await this.refreshSaved({ force: true });
    if (still() && typeof now === "boolean") {
      if (now !== !!on) this.emit({ status: "The history log was not changed." });
      await this.announceSaved(jobId, now, this.savedRev);
    }
    if (still() && now === null) {
      this.emit({ saved: !!on, savingSaved: false, savedUnknown: true,
        status: "Cannot reach the companion, so it is not known whether the history log changed. Click the box to try again." });
    }
    return now === !!on;
  }

  // Answers about the box carry the log's revision (history_rev). Only an answer at least as new as the newest one seen
  // is applied, whatever its route (this panel's change, a GET, a GET prompted by another panel's broadcast), so a slow
  // older answer can never overwrite a newer state.
  noteRev(rev) {
    if (typeof rev === "number" && rev > this.savedRev) this.savedRev = rev;
  }

  async announceSaved(jobId, saved, rev) {
    try { await this.d.storage.set({ savedChange: { jobId, saved, rev, ts: Date.now() } }); } catch { /* the other panels also ask on focus */ }
  }

  // Ask the companion whether the summary on screen is in the history log (GET /jobs/<id>, field history_saved): after a
  // lost answer, when the panel gets the focus, and when another window changed a box. Returns true, false, or null
  // when it could not find out (the box is then left as it is). `force` also runs while a change is marked in flight.
  // An answer is dropped when a local change started after this request did (savedSeq), or the summary changed. When
  // the companion's clear generation has moved on (another machine pressed Clear history), the panel resets as a cleared
  // panel does: the old summary, its box and its thread go.
  // `atLeast`: with force, an answer whose revision is below it (or has none) is not trusted and not applied.
  async refreshSaved({ force = false, atLeast = null } = {}) {
    const jobId = this.s.jobId;
    if (!jobId || !this.s.result) return null;
    const busy = this.s.savingSaved && !force;  // a change of this panel is on its way: look, keep the revision, apply nothing
    const gen = this.selGen, seq = this.savedSeq || 0;
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "GET", `/jobs/${encodeURIComponent(jobId)}`, null, 5000);
    } catch { return null; }
    if (gen !== this.selGen || this.s.jobId !== jobId) return null;
    if (busy) {
      if (this.s.savingSaved && seq === (this.savedSeq || 0) && r.status === 200 && r.json) this.noteIncoming(r.json.history_rev);
      return null;
    }
    const cg = r.json && r.json.clear_generation;
    if (typeof cg === "number" && this.clearGen !== null && cg > this.clearGen) {
      this.clearedElsewhere(cg, STALE_MESSAGE);
      return null;
    }
    if (!force && seq !== (this.savedSeq || 0)) return null;  // a newer local change owns the box
    if (r.status !== 200 || !r.json) return null;
    const rev = r.json.history_rev;
    if (typeof rev === "number" && rev < this.savedRev) return null;  // an older answer than one already applied
    if (atLeast !== null && (typeof rev !== "number" || rev < atLeast)) return null;  // older than what was heard: no use
    this.noteRev(rev);
    const v = typeof r.json.history_saved === "boolean" ? r.json.history_saved : null;
    const patch = { saved: v, savingSaved: false, savedUnknown: false };
    if (force) patch.status = v === null ? "This summary is no longer in the history log." : v ? "Saved to history." : "Removed from history.";
    this.emit(patch);
    return v;
  }

  // ---------- question box ----------
  stopAskTimer() {
    if (this.askTimer !== null) { this.d.clearTimer(this.askTimer); this.askTimer = null; }
  }

  // New source or cleared history: forget the thread, drop any answer still on its way, stop listening.
  resetAsk() {
    this.askGen++;
    this.stopAskTimer();
    this.voice.cancel();
    this.emit({ thread: [], asking: null, askError: null, draft: "", draftSeq: this.s.draftSeq + 1 });
  }

  // The user typed in the box (no re-render: the field already shows it).
  typed(text) {
    this.s.draft = String(text ?? "");
  }

  // Spoken words go after whatever was typed in the box when the microphone started.
  withPrefix(text) {
    return [this.micPrefix, text].filter(Boolean).join(" ");
  }

  onMic(m) {
    const live = m.state === MIC.LISTENING || m.state === MIC.STOPPING;
    const patch = { mic: m };
    const shown = this.withPrefix(m.text);
    if (live && shown !== this.s.draft) { patch.draft = shown; patch.draftSeq = this.s.draftSeq + 1; }
    this.emit(patch);
  }

  // Recognized text lands in the box; it is sent automatically unless recognition failed part way or was held back.
  onVoiceText(text, { send }) {
    const full = this.withPrefix(text);
    this.emit({ draft: full, draftSeq: this.s.draftSeq + 1 });
    return send ? this.askQuestion(full) : undefined;
  }

  async toggleMic() {
    if (this.s.asking) return;
    if (!this.slot && this.s.mic.state === MIC.IDLE) {
      this.emit({ askError: "Paste a link or right-click a link first, then ask." });
      return;
    }
    this.emit({ askError: null });
    if (this.s.mic.state === MIC.IDLE) this.micPrefix = cleanQuestion(this.s.draft);
    await this.voice.toggle();
  }

  // The panel was hidden (another side panel took its place): stop listening, keep the words, send nothing.
  pauseMic() {
    this.voice.pause();
  }

  refreshMic() {
    return this.voice.refreshPermission();
  }

  // Side panels cannot show Chrome's permission prompt, so the one-time grant happens in a normal tab.
  openMicSetup() {
    this.d.openTab(this.d.micSetupUrl);
    this.voice.noteSetupOpened();
  }

  restoreDraft(q, error) {
    this.emit({ asking: null, askError: error, draft: q, draftSeq: this.s.draftSeq + 1 });
  }

  askFailure(gen, q, e) {
    if (gen !== this.askGen) return;
    this.stopAskTimer();
    const msg = e instanceof ApiError && e.kind === "config" ? "Set the companion URL and token in the extension options."
      : "Cannot reach the companion. Is the iMac on and connected to Tailscale?";
    this.restoreDraft(q, msg);
  }

  // False when the answer must be dropped. A generation that differs from the one this panel knows means the history
  // was cleared in another window (newer) or the companion was reset (older): the thread and this answer no longer
  // belong together, so the thread is forgotten and the question goes back in the box to be asked again.
  acceptAsk(gen, json, q) {
    if (gen !== this.askGen) return false;
    const cg = json && json.clear_generation;
    if (typeof cg === "number") {
      if (this.clearGen !== null && cg !== this.clearGen) {
        const newer = cg > this.clearGen;
        this.clearGen = cg;
        this.resetAsk();
        this.restoreDraft(q, newer ? "History was cleared in another window. Ask again." : "The companion was reset. Ask again.");
        return false;
      }
      this.clearGen = cg;
    }
    return true;
  }

  // Ask about the current source. `text` defaults to the box. Returns true once the question was sent.
  async askQuestion(text) {
    const q = cleanQuestion(text === undefined ? this.s.draft : text);
    if (!this.s.configured) { this.emit({ askError: "Set the companion URL and token in the extension options." }); return false; }
    if (!q) { this.emit({ askError: "Type or say a question first." }); return false; }
    if (charCount(q) > ASK_LIMITS.question) { this.emit({ askError: `That question is too long (over ${ASK_LIMITS.question} characters).` }); return false; }
    if (!this.slot) { this.emit({ askError: "Paste a link or right-click a link first, then ask." }); return false; }
    if (this.s.asking) { this.emit({ askError: "Wait for the current answer first." }); return false; }
    const gen = ++this.askGen;
    this.stopAskTimer();
    const url = this.slot.url;
    const history = capHistory(this.s.thread);
    // What the person was just shown, so "tell me more about the second one" has something to point at. Nothing is
    // sent while a Dip or Dive is still running.
    const summary = capSummary(this.s.result);
    this.emit({ asking: { q, label: "Thinking..." }, askError: null, draft: "", draftSeq: this.s.draftSeq + 1 });
    const mode = this.s.mode;
    if (!String(mode).startsWith("claude")) {
      await this.checkHealth();  // Codex may have signed out since the panel opened
      if (gen !== this.askGen) return false;
    }
    const provider = askProvider(mode, this.s.codexOk);
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "POST", "/jobs",
        { url, mode: `${provider}-ask`, requestId: this.d.uuid(), question: q, history, ...(summary ? { summary } : {}), force: false, ...this.genField() }, 5000);
    } catch (e) { this.askFailure(gen, q, e); return false; }
    if (gen !== this.askGen) return false;
    if (isStaleRefusal(r)) { await this.staleRefused(r.json, q); return false; }
    if (!this.acceptAsk(gen, r.json, q)) return false;
    if (r.status === 401) { this.restoreDraft(q, "The token was rejected. Check the options page."); return false; }
    if (r.status >= 400 || !r.json.job_id) { this.restoreDraft(q, describeError(r.json.error_code, r.json.error_message)); return false; }
    await this.pollAsk(r.json.job_id, gen, q);
    return true;
  }

  async pollAsk(jobId, gen, q) {
    if (gen !== this.askGen) return;
    let r;
    try {
      r = await request(this.d.fetch, this.cfg, "GET", `/jobs/${jobId}`, null, 5000);
    } catch (e) { this.askFailure(gen, q, e); return; }
    if (!this.acceptAsk(gen, r.json, q)) return;
    if (r.status === 404) { this.restoreDraft(q, "That answer is gone (history was cleared). Ask again."); return; }
    if (r.status >= 400) { this.restoreDraft(q, describeError(r.json.error_code, r.json.error_message)); return; }
    const j = r.json;
    if (j.state === "done") {
      this.emit({ thread: [...this.s.thread, { q, a: j.result_markdown || "" }], asking: null, askError: null });
    } else if (j.state === "error") {
      this.restoreDraft(q, describeError(j.error_code, j.error_message));
    } else {
      const label = { queued: "Thinking...", fetching: "Fetching the source...", summarizing: "Thinking..." }[j.state] || "Thinking...";
      this.emit({ asking: { q, label } });
      this.askTimer = this.d.setTimer(() => { this.askTimer = null; return this.pollAsk(jobId, gen, q); }, ASK_POLL_MS);
    }
  }
}
