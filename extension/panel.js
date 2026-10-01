import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";
import { MIC } from "./lib/voice.js";

installShim();
const $ = (id) => document.getElementById(id);

// Buttons are built once; state changes only flip aria-pressed and classes.
const buttons = {};
for (const m of MODES) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `mode ${m.id}`;
  b.dataset.mode = m.id;
  b.setAttribute("aria-pressed", "false");
  b.innerHTML = `<span>${m.top}</span><span>${m.bottom}</span>`;
  b.title = m.label;
  $("buttons").appendChild(b);
  buttons[m.id] = b;
}

let urlDirty = false;
$("urlinput").addEventListener("input", () => { urlDirty = true; });
$("urlform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await ctl.submitTyped($("urlinput").value);
  if (ok) { urlDirty = false; $("urlinput").blur(); }
});

function render(s) {
  for (const [id, b] of Object.entries(buttons)) {
    b.setAttribute("aria-pressed", String(id === s.mode));
    const off = s.codexOk === false && id.startsWith("codex");
    b.disabled = off;
    b.title = off ? s.codexReason : MODES.find((m) => m.id === id).label;
  }
  $("codexnote").hidden = !(s.codexOk === false);
  $("codexnote").textContent = s.codexOk === false ? s.codexReason : "";
  const t = $("title");
  const href = s.source && safeHref(s.source.url);
  t.textContent = s.title || (s.source ? s.source.url : "");
  t.hidden = !(s.title || s.source);
  if (href) t.href = href; else t.removeAttribute("href");
  // The field keeps showing the current URL, unless the user is mid-edit.
  if (!urlDirty && s.source && $("urlinput").value !== s.source.url) $("urlinput").value = s.source.url;
  $("hint").hidden = !!s.source || !!s.error;
  $("result").innerHTML = s.mode === "temp" ? "" : s.result ? renderMarkdown(s.result) : "";
  $("copy").hidden = !(s.mode === "temp" && s.tempReady);
  $("warn").hidden = !(s.mode === "temp" && s.tempWarn);
  renderAsk(s);
  $("note").hidden = !s.tempNote;
  $("note").textContent = s.tempNote;
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  $("status").textContent = s.status || "";
  document.body.classList.toggle("busy", !!s.busy);
}

// ---------- question box ----------
const MIC_LABEL = { idle: "Speak", starting: "Starting...", listening: "Stop", stopping: "Sending..." };
let shownDraftSeq = -1;
let shownTurns = -1;
let shownPending = null;

function renderAsk(s) {
  const show = s.configured && !!s.source;
  $("ask").hidden = !show;
  if (!show) return;
  // The thread is rebuilt only when it changes (turn added, pending label changed), so answers keep their scroll.
  const pend = s.asking ? `${s.asking.q}\u0000${s.asking.label}` : null;
  if (s.thread.length !== shownTurns || pend !== shownPending) {
    shownTurns = s.thread.length; shownPending = pend;
    const th = $("thread");
    th.replaceChildren();
    const add = (q, html, cls) => {
      const turn = document.createElement("div");
      turn.className = "turn";
      const qe = document.createElement("div");
      qe.className = "q";
      qe.textContent = q;                     // the question is plain text, never HTML
      const ae = document.createElement("div");
      ae.className = `a ${cls}`.trim();
      if (html === null) ae.textContent = s.asking.label; else ae.innerHTML = html;  // answers go through the safe renderer
      turn.append(qe, ae);
      th.appendChild(turn);
    };
    for (const t of s.thread) add(t.q, renderMarkdown(t.a), "");
    if (s.asking) add(s.asking.q, null, "pending");
    if (th.lastElementChild) th.lastElementChild.scrollIntoView({ block: "nearest" });
  }
  const m = s.mic;
  const live = m.state !== MIC.IDLE;
  const mic = $("mic");
  mic.dataset.state = m.state;
  mic.setAttribute("aria-pressed", String(m.state === MIC.LISTENING || m.state === MIC.STARTING));
  mic.disabled = !m.available || !!s.asking || m.state === MIC.STOPPING;
  $("miclabel").textContent = MIC_LABEL[m.state] || "Speak";
  mic.setAttribute("aria-label", m.state === MIC.LISTENING ? "Listening. Click to stop and send." : "Speak your question");
  const box = $("askinput");
  if (s.draftSeq !== shownDraftSeq) { shownDraftSeq = s.draftSeq; box.value = s.draft; }
  box.readOnly = live;
  if (live) box.scrollLeft = box.scrollWidth;  // show the newest words while they arrive
  box.placeholder = m.state === MIC.LISTENING ? "Listening..." : "Ask about this source";
  $("askgo").disabled = live || !!s.asking;
  const line = m.state === MIC.LISTENING ? "Listening. Click Stop when you are done." : m.message;
  $("micmsg").hidden = !line;
  $("micmsg").textContent = line;
  $("micmsg").classList.toggle("err", m.kind === "error" && m.state === MIC.IDLE);
  $("micsetup").hidden = !m.needPermission;
  $("askerror").hidden = !s.askError;
  $("askerror").textContent = s.askError || "";
}

const speech = window.__devSpeech !== undefined ? window.__devSpeech : { SpeechRecognition: window.SpeechRecognition || window.webkitSpeechRecognition, permissions: navigator.permissions };
const micSetupUrl = chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("mic.html") : new URL("mic.html", location.href).href;

const ctl = new Controller({
  storage: { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o), remove: (k) => chrome.storage.local.remove(k) },
  fetch: (...a) => fetch(...a),
  clipboard: { writeText: (t) => navigator.clipboard.writeText(t) },
  openTab: (url) => chrome.tabs.create({ url }),
  uuid: () => crypto.randomUUID(),
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (id) => clearTimeout(id),
  healthOverride: window.__devHealth,
  speech: speech && speech.SpeechRecognition,
  permissions: speech && speech.permissions,
  micSetupUrl,
  onState: render,
});

for (const [id, b] of Object.entries(buttons)) b.addEventListener("click", () => ctl.selectMode(id));
$("copy").addEventListener("click", () => ctl.copyAndOpen());
$("askform").addEventListener("submit", (e) => { e.preventDefault(); ctl.askQuestion($("askinput").value); });
$("askinput").addEventListener("input", () => ctl.typed($("askinput").value));
$("mic").addEventListener("click", () => ctl.toggleMic());
$("micsetup").addEventListener("click", () => ctl.openMicSetup());
// Coming back from the Enable microphone tab: look at the permission again (also reported by the tab itself).
window.addEventListener("focus", () => ctl.refreshMic());
document.addEventListener("visibilitychange", () => { if (!document.hidden) ctl.refreshMic(); });
if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "dipdive-mic-granted") ctl.refreshMic(); });
$("clear").addEventListener("click", (e) => { e.preventDefault(); ctl.clearHistory(); });
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((c, a) => ctl.onStorageChange(c, a));

const win = await chrome.windows.getCurrent();
await ctl.init(win.id);
if (!ctl.s.source) $("urlinput").focus(); // nothing pending: empty field, focused, with the hint showing
