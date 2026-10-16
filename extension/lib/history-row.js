// The two rows at the end of the summary card, DOM-free so it can be unit tested (panel.js draws what `view()` says).
//   YouTube row (YouTube sources only, never in Incognito): Watched checkbox, Like and Dislike.
//   Saved row: the history log's Saved checkbox, the status text while a Dip runs, and the Settings gear.
// The service worker owns the Watched countdown, queue and background watch and writes each video's state to
// chrome.storage.local (lib/video-state.js); this class only shows that state and sends the person's clicks.
import { youtubeVideoId } from "./watched.js";
import { VIDEO_STATES_KEY, normalizeVideoState, watchView, LOCKED_STATUSES } from "./video-state.js";

// Status text beside the gear: only while something is happening (a Dip in progress, or a message about the Saved box).
// Finished-and-fine messages say nothing, because the checkbox already shows them.
const QUIET_STATUSES = new Set(["Done.", "Saved to history.", "Removed from history."]);
export function rowStatus(s) {
  const text = s.status || "";
  if (!s.busy && QUIET_STATUSES.has(text)) return "";
  return text;
}

// The rows are shown whenever the card has something to hold: a source, a status message, or a panel that is not set up
// (so the gear is always one click away when it is needed).
export function rowsVisible(s) {
  return !s.configured || !!s.source || !!rowStatus(s);
}

const THUMBS = {
  like: { on: "unlike", off: "like", label: "Like", doneOn: "Liked" },
  dislike: { on: "undislike", off: "dislike", label: "Dislike", doneOn: "Disliked" },
};

export class HistoryRow {
  // deps: send(message) -> Promise<response>, storage.get(key) -> Promise<{[key]: value}>, requestAccess() -> Promise<boolean>
  //       (the optional YouTube host permission, asked inside the click), windowId() -> number|null, now(), setTimer(fn, ms),
  //       clearTimer(id), onChange(view)
  constructor(deps) {
    this.d = deps;
    this.url = null;
    this.videoId = null;
    this.incognito = false;
    this.state = normalizeVideoState(null);
    this.busy = null;        // { kind: "like" | "dislike" } while a thumb action runs
    this.notice = "";        // the notice line
    this.reasons = { like: "", dislike: "" };  // why the last attempt failed, shown as the button's tooltip
    this.watchReason = "";
    this.loadSeq = 0;
    this.tick = null;
  }

  get visible() { return !!this.videoId && !this.incognito; }

  emit() {
    this.scheduleTick();
    this.d.onChange(this.view());
  }

  view() {
    const w = watchView(this.state.watch, this.d.now());
    const wst = this.state.watch;
    const title = wst.status === "watching" ? `Watching in the background${wst.percent ? `: ${wst.percent}%` : ""}. Untick to stop.`
      : wst.status === "countdown" ? "Starts in a moment. Untick to cancel."
      : wst.status === "queued" ? "Waiting for another video's watch to finish. Untick to cancel."
      : wst.status === "partial" ? `Stopped after ${wst.percent ?? 0}% of the video.`
      : wst.status === "watched" ? "Watched all the way through."
      : (this.watchReason || wst.reason || "Watch this video in the background (muted, in a minimized window)");
    const thumb = (kind) => {
      const t = THUMBS[kind];
      const pressed = this.state[kind] === true;
      const working = this.busy?.kind === kind;
      return {
        pressed, busy: working, disabled: !!this.busy,
        label: pressed ? t.doneOn : t.label,
        title: working ? `${t.label} in progress` : this.reasons[kind] || (pressed ? `${t.doneOn}. Click to undo.` : `${t.label} this video`),
      };
    };
    return {
      visible: this.visible, videoId: this.videoId, notice: this.notice,
      watched: { ...w, title, status: wst.status },
      like: thumb("like"), dislike: thumb("dislike"),
    };
  }

  // One re-draw a second while the countdown runs, so its label counts down.
  scheduleTick() {
    if (this.tick !== null) { this.d.clearTimer(this.tick); this.tick = null; }
    if (this.visible && this.state.watch.status === "countdown") {
      this.tick = this.d.setTimer(() => { this.tick = null; this.emit(); }, 1000);
    }
  }

  // The source on screen (or none). Re-reads the video's remembered state only when the video changes.
  setSource(url, incognito = false) {
    const videoId = url ? youtubeVideoId(url) : null;
    const changed = videoId !== this.videoId;
    this.url = url || null;
    this.incognito = !!incognito;
    if (changed) {
      this.videoId = videoId;
      this.state = normalizeVideoState(null);   // defaults until the stored state is read
      this.busy = null; this.notice = ""; this.reasons = { like: "", dislike: "" }; this.watchReason = "";
      const seq = ++this.loadSeq;
      if (videoId) {
        this.d.storage.get(VIDEO_STATES_KEY).then((all) => {
          if (seq !== this.loadSeq) return;
          this.state = normalizeVideoState((all[VIDEO_STATES_KEY] || {})[videoId]);
          this.emit();
        }, () => {});
      }
    }
    this.emit();
  }

  // chrome.storage.onChanged
  onStorageChange(changes, area) {
    if (area !== "local" || !changes[VIDEO_STATES_KEY] || !this.videoId) return;
    const all = changes[VIDEO_STATES_KEY].newValue || {};
    this.loadSeq++;  // a read still on its way is older than this
    this.state = normalizeVideoState(all[this.videoId]);
    if (this.state.watch.status !== "idle") this.watchReason = "";
    this.emit();
  }

  // The service worker's note about a background watch (a stated reason when it could not start or was cut off).
  onProgress(message) {
    if (message?.type !== "youtube-watch-progress" || message.videoId !== this.videoId) return;
    if (message.status === "failed" && message.reason) { this.notice = message.reason; this.watchReason = message.reason; this.emit(); }
  }

  fail(kind, reason) {
    if (kind === "watch") this.watchReason = reason; else this.reasons[kind] = reason;
    this.notice = reason;
  }

  // The Watched checkbox was ticked or unticked. Locked states (finished, partial) cannot be changed.
  async toggleWatched(checked) {
    if (!this.visible) return;
    const status = this.state.watch.status;
    if (LOCKED_STATUSES.includes(status)) { this.emit(); return; }
    this.notice = ""; this.watchReason = "";
    if (checked && status === "idle") {
      // The permission prompt needs the click's user gesture, so it is the first thing awaited.
      let allowed = false;
      try { allowed = await this.d.requestAccess(); } catch { /* counts as declined */ }
      if (!allowed) { this.fail("watch", "YouTube access permission was declined"); this.emit(); return; }
      let r;
      try { r = await this.d.send({ type: "youtube-watch-start", url: this.url, panelWindowId: this.d.windowId(), incognito: this.incognito }); }
      catch (e) { r = { ok: false, reason: String(e?.message || e) }; }
      if (!r?.ok) { this.fail("watch", r?.reason || "The watch could not start"); this.emit(); return; }
      if (r.watch && this.state.watch.status === "idle") this.state = normalizeVideoState({ ...this.state, watch: r.watch });
      this.emit();
      return;
    }
    if (!checked && ["countdown", "queued", "watching"].includes(status)) {
      let r;
      try { r = await this.d.send({ type: "youtube-watch-untick", url: this.url, incognito: this.incognito }); }
      catch (e) { r = { ok: false, reason: String(e?.message || e) }; }
      if (!r?.ok) this.fail("watch", r?.reason || "The watch could not be stopped");
      else if (r.watch && ["idle", "partial"].includes(r.watch.status)) this.state = normalizeVideoState({ ...this.state, watch: r.watch });
    }
    this.emit();
  }

  // A thumb was clicked: toward the other state (on -> undo, off -> set). While it runs the button shows busy; on failure
  // the button goes back and the reason is its tooltip and the notice line.
  async toggleThumb(kind) {
    if (!this.visible || this.busy) return;
    const t = THUMBS[kind];
    const action = this.state[kind] ? t.on : t.off;
    this.notice = ""; this.reasons[kind] = "";
    let allowed = false;
    try { allowed = await this.d.requestAccess(); } catch { /* counts as declined */ }
    if (!allowed) { this.fail(kind, "YouTube access permission was declined"); this.emit(); return; }
    const videoId = this.videoId;
    this.busy = { kind, action };
    this.emit();
    let r;
    try { r = await this.d.send({ type: "youtube-action", action, url: this.url, panelWindowId: this.d.windowId(), incognito: this.incognito }); }
    catch (e) { r = { ok: false, reason: String(e?.message || e) }; }
    if (videoId !== this.videoId) return;  // another video is on screen now; the worker stored this one's result
    this.busy = null;
    if (r?.ok) {
      this.state = normalizeVideoState({ ...this.state, like: r.like === true, dislike: r.dislike === true });
    } else {
      this.fail(kind, r?.reason || `${t.label} could not run`);
    }
    this.emit();
  }
}
