// Speech input for the question box: a click-to-start, click-to-stop state machine around webkitSpeechRecognition.
// DOM-free (everything is injected) so it can be tested with a mocked SpeechRecognition.
//
// States: idle -> starting -> listening -> stopping -> idle. Click once to start, click again to stop; the recognized
// text goes to onFinal(text, {send}) and the controller sends it. Errors become one actionable line (message).
import { SYSTEM_BLOCK_HELP } from "./micerrors.js";

export const MIC = Object.freeze({ IDLE: "idle", STARTING: "starting", LISTENING: "listening", STOPPING: "stopping" });

export const MIC_MESSAGES = Object.freeze({
  unavailable: "Voice input is not available in this browser. Type your question instead.",
  needPermission: "Microphone is off. Click Enable microphone, allow it in the new tab, then come back here.",
  blocked: "Microphone is blocked for this extension. Click Enable microphone to see how to turn it back on.",
  systemBlocked: SYSTEM_BLOCK_HELP,
  waiting: "Allow the microphone in the new tab, then come back here.",
  granted: "Microphone is on. Click the mic and talk.",
  nothing: "I did not hear anything. Click the mic and try again.",
  noMic: "No microphone was found. Connect one, then click the mic and try again.",
  network: "Speech recognition could not reach Google's speech service. Check the internet connection and try again.",
  language: "English speech recognition is not available in this browser.",
  startFailed: "Could not start listening. Click the mic and try again.",
  serviceBlocked: "Chrome is not allowing its speech service here (a setting or a work policy may turn it off). Type your question instead.",
  paused: "Stopped after a long pause. Click Ask to send what was heard, or click the mic to add more.",
  hidden: "Stopped listening because the panel was hidden. Click Ask to send what was heard, or click the mic to add more.",
});

export class VoiceInput {
  // deps: SpeechRecognition (constructor or null), permissions ({query} or null), onChange(snapshot),
  //       onFinal(text, {send}), setTimer(fn, ms), clearTimer(id)
  constructor(deps) {
    this.d = { lang: "en-US", startTimeoutMs: 10000, stopTimeoutMs: 3000, ...deps };
    this.SR = deps.SpeechRecognition || null;
    this.state = MIC.IDLE;
    this.text = "";          // live text: final results so far plus the current interim guess
    this.finalText = "";
    this.interimText = "";
    this.message = "";       // one actionable line, "" when there is nothing to say
    this.kind = "";          // "error" | "info" | ""
    this.needPermission = false;
    this.available = !!this.SR;
    this.sid = 0;            // session token: events from an old recognizer are ignored
    this.rec = null;
    this.timers = {};
    this.status = null;      // PermissionStatus, kept and watched for changes made in the Enable microphone tab
    this.permAtStart = null; // what the permission said when this recording began
    this.deliberateAbort = false;
    this.hold = false;       // deliver the words but do not send them (the panel was hidden, or Chrome ended a long pause)
    this.heldMessage = "";   // what to say when words were delivered but held back
    if (!this.SR) { this.message = MIC_MESSAGES.unavailable; this.kind = "info"; }
  }

  snapshot() {
    return { state: this.state, text: this.text, finalText: this.finalText, interimText: this.interimText, message: this.message, kind: this.kind,
             needPermission: this.needPermission, available: this.available };
  }

  _set(patch) {
    Object.assign(this, patch);
    this.d.onChange(this.snapshot());
  }

  _timer(name, fn, ms) {
    this._untimer(name);
    this.timers[name] = this.d.setTimer(fn, ms);
  }

  _untimer(name) {
    if (this.timers[name] !== undefined) { this.d.clearTimer(this.timers[name]); delete this.timers[name]; }
  }

  async toggle() {
    if (this.state === MIC.IDLE) return this.start();
    if (this.state === MIC.STARTING) return this.cancel();  // a second click before audio began: cancel quietly
    if (this.state === MIC.LISTENING) return this.stop();
    return undefined;                                       // stopping: wait for the final text
  }

  // "granted" | "prompt" | "denied", or null when the browser cannot say.
  async _permission() {
    if (!this.d.permissions) return null;
    try {
      // Chrome hands back a new PermissionStatus object on every query, and each one with a handler stays alive and
      // is told about every change. So ask once, keep that one (its state follows the permission) and watch only it.
      if (!this.status) {
        const st = await this.d.permissions.query({ name: "microphone" });
        if (!this.status) {
          this.status = st;
          st.onchange = () => { this.refreshPermission(); };
        }
      }
      return this.status.state;
    } catch { return null; }
  }

  // Called at panel start, when the panel regains focus, and when the Enable microphone tab reports back.
  async refreshPermission() {
    const p = await this._permission();
    if (this.state !== MIC.IDLE) return p;
    if (p === "granted" && this.needPermission) this._set({ needPermission: false, message: MIC_MESSAGES.granted, kind: "info" });
    else if ((p === "prompt" || p === "denied") && this.available) {
      this._set({ needPermission: true, message: p === "denied" ? MIC_MESSAGES.blocked : MIC_MESSAGES.needPermission, kind: "info" });
    }
    return p;
  }

  noteSetupOpened() {
    this._set({ message: MIC_MESSAGES.waiting, kind: "info" });
  }

  async start() {
    const sid = ++this.sid;
    this.deliberateAbort = false;
    this.hold = false;
    this._set({ state: MIC.STARTING, text: "", message: "", kind: "", needPermission: false });
    this.finalText = "";
    this.interimText = "";
    if (!this.SR) { this._set({ state: MIC.IDLE, message: MIC_MESSAGES.unavailable, kind: "info" }); return; }
    // Chrome cannot show a permission prompt inside a side panel, so a missing grant must go through the setup tab.
    const p = await this._permission();
    if (sid !== this.sid) return;
    this.permAtStart = p;
    if (p === "prompt" || p === "denied") {
      this._set({ state: MIC.IDLE, needPermission: true, kind: "error",
                  message: p === "denied" ? MIC_MESSAGES.blocked : MIC_MESSAGES.needPermission });
      return;
    }
    let rec;
    try {
      rec = new this.SR();
      rec.lang = this.d.lang;
      rec.interimResults = true;
      rec.continuous = true;   // keep listening through pauses; the second click ends the recording
      rec.maxAlternatives = 1;
    } catch { this._fail(sid, "start-failed"); return; }
    this.rec = rec;
    this.results = [];
    this.err = null;
    rec.onaudiostart = () => { if (sid === this.sid && this.state === MIC.STARTING) this._listening(); };
    rec.onresult = (e) => this._onResult(sid, e);
    rec.onerror = (e) => this._onError(sid, e);
    rec.onend = () => this._finish(sid);
    // Gave up waiting: abort the recognizer too, or a slow audio device could still start it and Chrome would go on
    // sending the room's sound to the speech service with nobody listening.
    this._timer("start", () => { if (sid === this.sid && this.state === MIC.STARTING) { this._abort(); this._fail(sid, "start-failed"); } }, this.d.startTimeoutMs);
    try { rec.start(); } catch { this._fail(sid, "start-failed"); }
  }

  _listening() {
    this._untimer("start");
    this._set({ state: MIC.LISTENING });
  }

  _onResult(sid, e) {
    if (sid !== this.sid) return;
    if (this.state === MIC.STARTING) this._listening();
    // e.results is the whole list for this recording (continuous mode): rebuild the text from it every time.
    const finals = [], interim = [];
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      const t = String((r[0] && r[0].transcript) || "").trim();
      if (t) (r.isFinal ? finals : interim).push(t);
    }
    this.finalText = finals.join(" ").trim();
    this.interimText = interim.join(" ").trim();
    this._set({ text: [this.finalText, this.interimText].filter(Boolean).join(" ") });
  }

  _onError(sid, e) {
    if (sid !== this.sid) return;
    const code = (e && e.error) || "unknown";
    if (code === "aborted" && this.deliberateAbort) return;
    this._fail(sid, code);
  }

  // One actionable line per failure; any partial text is kept in the box but not sent.
  _fail(sid, code) {
    if (sid !== this.sid) return;
    const denied = code === "not-allowed";
    // Chrome's own permission was fine when this recording began, so the refusal comes from the computer (macOS or
    // Windows privacy settings): the Enable microphone tab cannot fix that, so say what can.
    const system = denied && this.permAtStart === "granted";
    const permission = denied && !system;
    const message = system ? MIC_MESSAGES.systemBlocked
      : permission ? MIC_MESSAGES.needPermission
      : code === "service-not-allowed" ? MIC_MESSAGES.serviceBlocked
      : code === "no-speech" ? MIC_MESSAGES.nothing
      : code === "audio-capture" ? MIC_MESSAGES.noMic
      : code === "network" ? MIC_MESSAGES.network
      : code === "language-not-supported" ? MIC_MESSAGES.language
      : code === "start-failed" ? MIC_MESSAGES.startFailed
      : `Speech recognition stopped (${code}). Click the mic and try again.`;
    this.err = code;
    this._end(sid, { message, kind: "error", needPermission: permission });
  }

  stop() {
    if (this.state !== MIC.LISTENING) return;
    const sid = this.sid;
    this._set({ state: MIC.STOPPING });
    try { this.rec.stop(); } catch { this._finish(sid); return; }
    // Chrome sends the last results and then onend; if onend never comes, take what we have.
    this._timer("stop", () => { this._abort(); this._finish(sid); }, this.d.stopTimeoutMs);
  }

  cancel() {
    if (this.state === MIC.IDLE) return;
    this.sid++;   // anything the old recognizer still says is ignored
    this._abort();
    this._detach();
    this.deliberateAbort = false;  // its events are ignored by the session token now; the next recording starts clean
    this.hold = false;
    this._set({ state: MIC.IDLE, text: "", message: "", kind: "" });
  }

  // The panel was hidden while listening (Chrome keeps a hidden side panel alive, and a recording would go on with no
  // Stop button in sight): stop now, keep the words in the box, send nothing.
  pause() {
    if (this.state === MIC.LISTENING) { this.hold = true; this.heldMessage = MIC_MESSAGES.hidden; this.stop(); }
    else if (this.state === MIC.STARTING) this.cancel();
  }

  _abort() {
    this.deliberateAbort = true;
    try { if (this.rec) this.rec.abort(); } catch { /* already stopped */ }
  }

  _detach() {
    this._untimer("start"); this._untimer("stop");
    if (this.rec) this.rec.onaudiostart = this.rec.onresult = this.rec.onerror = this.rec.onend = null;
    this.rec = null;
  }

  // Recognizer ended: after stop() (deliver and send), or on its own. Chrome ends a session by itself after about 15
  // seconds of silence, and the person never clicked Stop, so those words are kept in the box and not sent: a long
  // pause in the middle of a question must not send half of it.
  _finish(sid) {
    if (sid !== this.sid || this.state === MIC.IDLE) return;
    if (!this.text) { this._end(sid, { message: MIC_MESSAGES.nothing, kind: "error" }); return; }
    const byChrome = this.state === MIC.LISTENING && !this.hold;
    if (byChrome) { this.hold = true; this.heldMessage = MIC_MESSAGES.paused; }
    this._end(sid, { message: "", kind: "" });
  }

  _end(sid, { message, kind, needPermission = false }) {
    if (sid !== this.sid) return;
    const text = this.text.trim();
    const failed = this.err !== null && this.err !== undefined;
    const hold = this.hold;
    const heldMessage = this.heldMessage;
    this._detach();
    this.sid++;  // late events from this recognizer are ignored from here on
    this.err = null;
    this.deliberateAbort = false;
    this.hold = false;
    const quiet = text && !failed && !hold;
    this._set({ state: MIC.IDLE, text: "", message: quiet ? "" : (text && !failed ? heldMessage : message),
                kind: quiet ? "" : (text && !failed ? "info" : kind), needPermission });
    if (text) this.d.onFinal(text, { send: !failed && !hold });
  }
}
