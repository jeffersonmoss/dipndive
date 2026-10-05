import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";
import { MIC } from "./lib/voice.js";
import { OPEN_HISTORY, openHistoryTab } from "./lib/history.js";

installShim();
const $ = (id) => document.getElementById(id);

// The logos (icons/modes/, made by tools/mode_icons.py): full strength for Dive, the same logo partly transparent over the black button (darker) for Dip. Decorative: the
// button's name is its hidden label.
const logo = (name) => `<img src="icons/modes/${name}-36.png" srcset="icons/modes/${name}-72.png 2x" width="34" height="34" alt="">`;
const MODE_ICON = {
  "claude-dive": logo("claude-dive"), "claude-dip": logo("claude-dip"), "codex-dip": logo("codex-dip"), "codex-dive": logo("codex-dive"),
};
// The center button is an action, not a mode: a white map pin (a round head tapering to a point, with a small round hole), solid.
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#ffffff" fill-rule="evenodd" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7ZM12 11.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"/></svg>';

// Buttons are built once; state changes only flip aria-pressed and classes. The pin sits in the center slot.
const buttons = {};
const addButton = (m) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `mode ${m.id}`;
  b.dataset.mode = m.id;
  b.setAttribute("aria-pressed", "false");
  b.innerHTML = `${MODE_ICON[m.id]}<span class="sr-only">${m.label}</span>`;  // the name is the label; the tooltip too
  b.title = m.label;
  $("buttons").appendChild(b);
  buttons[m.id] = b;
};
MODES.slice(0, 2).forEach(addButton);
const pin = document.createElement("button");
pin.type = "button";
pin.id = "pin";
pin.className = "mode action";   // same black square, never pressed or selected: no aria-pressed
pin.setAttribute("aria-label", "Summarize this page");
pin.title = "Summarize this page";
pin.innerHTML = PIN_ICON;
$("buttons").appendChild(pin);
MODES.slice(2).forEach(addButton);

let urlDirty = false;
$("urlinput").addEventListener("input", () => { urlDirty = true; });
$("urlform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await ctl.submitTyped($("urlinput").value);
  if (ok) { urlDirty = false; $("urlinput").blur(); }
});

let shownResult = null;

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
  // Re-set only when the text changed: an emit happens on every interim speech result, and rebuilding the summary three
  // times a second would drop a text selection and make a screen reader re-read it.
  const shown = s.result || "";
  if (shown !== shownResult) { shownResult = shown; $("result").innerHTML = shown ? renderMarkdown(shown) : ""; }
  renderAsk(s);
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  $("status").textContent = s.status || "";
  renderSave(s);
  document.body.classList.toggle("busy", !!s.busy);
}

// ---------- "Save this Dip to history" ----------
// Shown only next to a finished Dip or Dive that has an entry in the companion's history log.
function renderSave(s) {
  const show = s.configured && !!s.result && typeof s.saved === "boolean";  // also while unknown
  $("saveline").hidden = !show;
  if (!show) return;
  $("savelabel").textContent = `Save this ${s.mode.endsWith("-dive") ? "Dive" : "Dip"} to history`;
  $("savehist").checked = s.saved;
  $("savehist").indeterminate = !!s.savedUnknown;  // the companion's answer was lost: not known until it is asked again
  $("savehist").disabled = !!s.savingSaved;
}

// ---------- question box ----------
// Short labels so the button keeps its size; the visible text is also its accessible name.
const MIC_LABEL = { idle: "Speak", starting: "Wait...", listening: "Stop", stopping: "Send..." };
let shownDraftSeq = -1;
let shownTurns = 0;       // answered turns already in the DOM
let scrolledFor = "";     // what the last scroll was for, so polling does not keep scrolling

const turnNode = (q, html) => {
  const turn = document.createElement("div");
  turn.className = "turn";
  const qe = document.createElement("div");
  qe.className = "q";
  qe.textContent = q;                     // the question is plain text, never HTML
  const ae = document.createElement("div");
  ae.className = html === null ? "a pending" : "a";
  if (html !== null) ae.innerHTML = html; // answers go through the safe renderer
  turn.append(qe, ae);
  return turn;
};

// The thread only grows (a turn is added, the pending line changes), so new nodes are appended and the ones already on
// screen are left alone: answers keep their scroll position and a screen reader does not re-read the conversation.
function renderThread(s) {
  const th = $("thread");
  if (s.thread.length < shownTurns) {  // the thread was reset (another source, Clear history): start again
    th.replaceChildren();
    shownTurns = 0;
  }
  const pending = th.querySelector(".turn.pending");
  if (pending) pending.remove();
  for (; shownTurns < s.thread.length; shownTurns++) th.appendChild(turnNode(s.thread[shownTurns].q, renderMarkdown(s.thread[shownTurns].a)));
  if (s.asking) {
    const node = turnNode(s.asking.q, null);
    node.classList.add("pending");
    node.querySelector(".a").textContent = s.asking.label;
    th.appendChild(node);
  }
  const key = `${s.thread.length}${s.asking ? "p" : ""}`;
  const last = th.lastElementChild;
  if (key !== scrolledFor) {
    scrolledFor = key;
    // Show the whole turn if it fits, else its start (read from the top), inside the scrolling area above the controls.
    if (last) last.scrollIntoView({ block: last.offsetHeight > $("page").clientHeight ? "start" : "nearest" });
  }
}

function renderAsk(s) {
  // The bottom row is there whenever the companion is set up, so History is always one click away; the question box,
  // Speak and Ask only once there is a source to ask about.
  $("ask").hidden = !s.configured;
  const show = s.configured && !!s.source;
  $("askform").hidden = !show;
  if (!show) {
    for (const id of ["micmsg", "micsetup", "askerror"]) $(id).hidden = true;
    return;
  }
  renderThread(s);
  const m = s.mic;
  const live = m.state !== MIC.IDLE;
  const mic = $("mic");
  mic.dataset.state = m.state;
  mic.disabled = !m.available || !!s.asking || m.state === MIC.STOPPING;
  $("miclabel").textContent = MIC_LABEL[m.state] || "Speak";
  const box = $("askinput");
  if (s.draftSeq !== shownDraftSeq) { shownDraftSeq = s.draftSeq; box.value = s.draft; }
  box.readOnly = live;
  if (live) box.scrollLeft = box.scrollWidth;  // show the newest words while they arrive
  box.placeholder = m.state === MIC.LISTENING ? "Listening..." : "Ask a question";
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
  // The pin button: the optional "tabs" permission (asked inside the click) and the active tab of this panel's window.
  tabs: {
    requestAccess: () => chrome.permissions.request({ permissions: ["tabs"] }),
    activeTab: async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0] || null,
  },
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
pin.addEventListener("click", () => { ctl.summarizePage(); });  // calls tabs.requestAccess() first, inside this click
$("askform").addEventListener("submit", (e) => { e.preventDefault(); ctl.askQuestion($("askinput").value); });
$("askinput").addEventListener("input", () => ctl.typed($("askinput").value));
$("mic").addEventListener("click", () => ctl.toggleMic());
$("micsetup").addEventListener("click", () => ctl.openMicSetup());
// Coming back from the Enable microphone tab: look at the permission again (also reported by the tab itself).
window.addEventListener("focus", () => { ctl.refreshMic(); ctl.refreshSaved(); });  // and whether the summary is still in the log
// Chrome keeps a side panel that another panel replaced alive (and recognition with it), with no Stop button in sight:
// stop listening when the panel is hidden, keeping the words in the box.
document.addEventListener("visibilitychange", () => { if (document.hidden) ctl.pauseMic(); else ctl.refreshMic(); });
window.addEventListener("pagehide", () => ctl.pauseMic());
if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "dipdive-mic-granted") ctl.refreshMic(); });
$("savehist").addEventListener("change", () => ctl.setSaved($("savehist").checked));

// ---------- History: its own tab (history.html), reused when one is already open ----------
const historyUrl = chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("history.html") : new URL("history.html", location.href).href;
// The service worker does the lookup-or-create (one at a time for every panel), so two quick clicks open one tab. Only when
// the worker cannot be reached does the panel do it itself.
$("historylink").addEventListener("click", async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: OPEN_HISTORY });
    if (r && r.ok) return;
  } catch { /* no worker answered */ }
  openHistoryTab(chrome, historyUrl);
});
// the gear: Settings (the Options page, where Clear history also lives)
$("options").addEventListener("click", () => {
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((c, a) => ctl.onStorageChange(c, a));

const win = await chrome.windows.getCurrent();
await ctl.init(win.id);
if (!ctl.s.source) $("urlinput").focus(); // nothing pending: empty field, focused, with the hint showing
