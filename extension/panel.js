import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";
import { MIC } from "./lib/voice.js";
import { HistoryBrowser, entryHtml } from "./lib/history.js";

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
  const shown = s.mode === "temp" ? "" : s.result || "";
  if (shown !== shownResult) { shownResult = shown; $("result").innerHTML = shown ? renderMarkdown(shown) : ""; }
  $("copy").hidden = !(s.mode === "temp" && s.tempReady);
  $("warn").hidden = !(s.mode === "temp" && s.tempWarn);
  renderAsk(s);
  $("note").hidden = !s.tempNote;
  $("note").textContent = s.tempNote;
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  $("status").textContent = s.status || "";
  renderSave(s);
  document.body.classList.toggle("busy", !!s.busy);
}

// ---------- "Save this Dip to history" ----------
// Shown only next to a finished Dip or Dive that has an entry in the companion's history log; never in Temp chat.
function renderSave(s) {
  const show = s.configured && s.mode !== "temp" && !!s.result && typeof s.saved === "boolean";
  $("saveline").hidden = !show;
  if (!show) return;
  $("savelabel").textContent = `Save this ${s.mode.endsWith("-dive") ? "Dive" : "Dip"} to history`;
  $("savehist").checked = s.saved;
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
  const show = s.configured && !!s.source;
  $("ask").hidden = !show;
  if (!show) return;
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
// Chrome keeps a side panel that another panel replaced alive (and recognition with it), with no Stop button in sight:
// stop listening when the panel is hidden, keeping the words in the box.
document.addEventListener("visibilitychange", () => { if (document.hidden) ctl.pauseMic(); else ctl.refreshMic(); });
window.addEventListener("pagehide", () => ctl.pauseMic());
if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "dipdive-mic-granted") ctl.refreshMic(); });
$("savehist").addEventListener("change", () => ctl.setSaved($("savehist").checked));

// ---------- history view ----------
// Entries already in the DOM stay (Show older only appends), so the list keeps its scroll position while a page loads.
let shownEntries = 0;
let pageScroll = 0;
function renderHistory(h) {
  document.body.classList.toggle("history-open", h.open);
  $("historyview").hidden = !h.open;
  if (!h.open) { shownEntries = 0; $("historylist").replaceChildren(); return; }
  const list = $("historylist");
  if (h.entries.length < shownEntries) { list.replaceChildren(); shownEntries = 0; }
  for (; shownEntries < h.entries.length; shownEntries++) {
    const el = document.createElement("article");
    el.className = "hentry";
    el.setAttribute("role", "listitem");
    el.innerHTML = entryHtml(h.entries[shownEntries]);
    list.appendChild(el);
  }
  $("historyempty").hidden = !(h.loaded && h.entries.length === 0);
  $("historyerror").hidden = !h.error;
  $("historyerror").textContent = h.error || "";
  $("historystatus").textContent = h.loading ? "Loading..." : h.loaded && h.entries.length ? `Showing ${h.entries.length} of ${h.total}` : "";
  const more = $("historymore");
  more.hidden = !(h.error ? true : h.loaded && h.nextBefore !== null);
  more.disabled = h.loading;
  more.textContent = h.error ? "Try again" : "Show older";
}

const historyView = new HistoryBrowser({
  fetch: (...a) => fetch(...a),
  getCfg: () => ctl.cfg,
  onState: renderHistory,
});
$("historylink").addEventListener("click", () => {
  ctl.pauseMic();  // the microphone controls are hidden while History is open: do not leave a recording running behind them
  pageScroll = $("page").scrollTop;
  historyView.open();
  $("historyview").scrollTop = 0;
  $("historyback").focus({ focusVisible: false });  // where Back is, for a screen reader; no ring for a mouse click
});
$("historyback").addEventListener("click", () => {
  historyView.back();
  $("page").scrollTop = pageScroll;
});
$("historymore").addEventListener("click", () => historyView.more());
// the gear: Settings (the Options page, where Clear history also lives)
$("options").addEventListener("click", () => {
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((c, a) => ctl.onStorageChange(c, a));

const win = await chrome.windows.getCurrent();
await ctl.init(win.id);
if (!ctl.s.source) $("urlinput").focus(); // nothing pending: empty field, focused, with the hint showing
