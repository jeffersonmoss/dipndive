import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";
import { MIC } from "./lib/voice.js";
import { OPEN_HISTORY, openHistoryTab } from "./lib/history.js";
import { request } from "./lib/api.js";
import { HANDOFF_SITES, buildHandoffText, fillHandoffComposer, handoffEnabled, injectionSite, validateHandoffUrl } from "./lib/handoff-sites.js";
import { creatorView } from "./lib/urls.js";
import { HistoryRow, rowStatus, rowsVisible } from "./lib/history-row.js";

installShim();
const $ = (id) => document.getElementById(id);

// The logos (icons/modes/, made by tools/mode_icons.py), always at full strength: each mode names its logo file in lib/modes.js.
// Decorative: the button's name is its hidden label.
const logo = (name) => `<img src="icons/modes/${name}-36.png" srcset="icons/modes/${name}-72.png 2x" width="34" height="34" alt="">`;
// The center button is an action, not a mode: a white map pin (a round head tapering to a point, with a small round hole), solid,
// with a thin black outline so it shows on the white buttons of light mode too (on the black buttons of dark mode it blends in).
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#ffffff" stroke="#000" stroke-width="1.3" paint-order="stroke" fill-rule="evenodd" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7ZM12 11.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"/></svg>';

// Buttons are built once; state changes only flip aria-pressed and classes.
const buttons = {};
const addButton = (m) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `mode ${m.id}`;
  b.dataset.mode = m.id;
  b.setAttribute("aria-pressed", "false");
  b.innerHTML = `${logo(m.logo)}<span class="sr-only">${m.label}</span>`;  // the name is the label; the tooltip too
  b.title = m.label;
  $("buttons").appendChild(b);
  buttons[m.id] = b;
};
function addHandoff(id, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `mode handoff handoff-${id}`;
  b.dataset.handoff = id;
  b.setAttribute("aria-label", label);
  b.title = label;
  const img = document.createElement("img");
  img.alt = "";
  img.width = img.height = 28;
  img.setAttribute("aria-hidden", "true");
  b.appendChild(img);
  $("buttons").appendChild(b);
  return b;
}
const claudeHandoff = addHandoff("claude", "Continue in Claude");
MODES.slice(0, 1).forEach(addButton);
const pin = document.createElement("button");
pin.type = "button";
pin.id = "pin";
pin.className = "mode action";   // same black square, never pressed or selected: no aria-pressed
pin.setAttribute("aria-label", "Summarize this page");
pin.title = "Summarize this page";
pin.innerHTML = PIN_ICON;
$("buttons").appendChild(pin);
MODES.slice(1).forEach(addButton);
const chatgptHandoff = addHandoff("chatgpt", "Continue in ChatGPT");

// One outlined arrow for both color schemes (white with a thin black outline, made by tools/handoff_icons.py): it shows on the
// white buttons of light mode and on the black buttons of dark mode.
for (const [id, b] of [["left", claudeHandoff], ["right", chatgptHandoff]]) {
  b.querySelector("img").src = `icons/handoff/handoff-${id}-outline-36.png`;
  b.querySelector("img").srcset = `icons/handoff/handoff-${id}-outline-72.png 2x`;
}

let urlDirty = false;
$("urlinput").addEventListener("input", () => { urlDirty = true; });
$("urlform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await ctl.submitTyped($("urlinput").value);
  if (ok) { urlDirty = false; $("urlinput").blur(); }
});

let shownResult = null;
let panelIncognito = false;
let winInfo = null;

// The YouTube row (Watched, Like, Dislike): a DOM-free class does the thinking, this draws what it says.
const historyRow = new HistoryRow({
  send: (m) => chrome.runtime.sendMessage(m),  // (rejects in the dev shim, which has no runtime: the row shows the reason)
  storage: { get: (k) => chrome.storage.local.get(k) },
  requestAccess: () => chrome.permissions.request({ origins: ["https://www.youtube.com/*"] }),
  windowId: () => winInfo?.id,
  now: () => Date.now(),
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (id) => clearTimeout(id),
  onChange: drawYoutubeRow,
});
function drawYoutubeRow(v) {
  $("ytrow").hidden = !v.visible;
  const w = v.watched;
  $("watched").checked = w.checked;
  $("watched").disabled = w.disabled;
  $("watchedlabel").textContent = w.label;
  $("watched").closest("label").title = w.title;
  for (const kind of ["like", "dislike"]) {
    const b = $(kind), t = v[kind];
    b.setAttribute("aria-pressed", String(t.pressed));
    b.dataset.state = t.busy ? "working" : "";
    b.disabled = t.disabled;
    b.title = t.title;
    b.setAttribute("aria-label", t.label);
  }
  $("youtubeactionnotice").textContent = v.notice;
  $("youtubeactionnotice").hidden = !v.visible || !v.notice;
}

function render(s) {
  for (const [id, b] of Object.entries(buttons)) {
    b.setAttribute("aria-pressed", String(id === s.mode));
    const off = s.codexOk === false && id.startsWith("codex");
    b.disabled = off;
    b.title = off ? s.codexReason : MODES.find((m) => m.id === id).label;
  }
  const ready = handoffEnabled(s);
  for (const b of [claudeHandoff, chatgptHandoff]) {
    b.disabled = !ready;
    b.title = ready ? b.getAttribute("aria-label") : "Available when a Dip has finished and its result is on screen.";
  }
  $("codexnote").hidden = !(s.codexOk === false);
  $("codexnote").textContent = s.codexOk === false ? s.codexReason : "";
  const t = $("title");
  const href = s.source && safeHref(s.source.url);
  t.textContent = s.title || (s.source ? s.source.url : "");
  t.hidden = !(s.title || s.source);
  if (href) t.href = href; else t.removeAttribute("href");
  renderCreator(s);
  // The field keeps showing the current URL, unless the user is mid-edit.
  if (!urlDirty && s.source && $("urlinput").value !== s.source.url) $("urlinput").value = s.source.url;
  $("hint").hidden = !!s.source || !!s.error;
  // Re-set only when the text changed: an emit happens on every interim speech result, and rebuilding the summary three
  // times a second would drop a text selection and make a screen reader re-read it.
  const shown = s.result || "";
  if (shown !== shownResult) { shownResult = shown; $("resulttext").innerHTML = shown ? renderMarkdown(shown) : ""; }
  renderAsk(s);
  $("pinmsg").hidden = !s.pinError;  // the pin's own line: it never replaces the status or error of a job
  $("pinmsg").textContent = s.pinError || "";
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  // The two rows close the summary card. The status text beside the gear is there only while a Dip is in progress.
  $("status").textContent = rowStatus(s);
  const showRows = rowsVisible(s);
  $("hist").hidden = !showRows;
  $("result").hidden = !shown && !showRows;
  renderSave(s);
  historyRow.setSource(s.source ? s.source.url : null, panelIncognito);
  document.body.classList.toggle("busy", !!s.busy);
}

// ---------- the creator line under the title ----------
// The channel name (or the article's site name) from the companion. A link to the channel's /videos page only when the companion
// named a YouTube channel page; otherwise plain text. Built with textContent, never innerHTML.
function renderCreator(s) {
  const el = $("creator");
  const { name, href } = creatorView(s);
  el.replaceChildren();
  el.hidden = !name;
  if (!name) return;
  if (!href) { el.textContent = name; return; }
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = name;
  el.appendChild(a);
}

// ---------- the Saved checkbox ----------
// Shown only for a finished Dip that has an entry in the companion's history log.
function renderSave(s) {
  const show = s.configured && !!s.result && typeof s.saved === "boolean";  // also while unknown
  $("saveline").hidden = !show;
  if (!show) return;
  $("savehist").checked = s.saved;
  $("savehist").indeterminate = !!s.savedUnknown;  // the companion's answer was lost: not known until it is asked again
  $("savehist").disabled = !!s.savingSaved;
  $("savelabel").textContent = s.saved ? "Summary saved" : "Summary deleted";
}

// ---------- question box ----------
// Short labels so the button keeps its size; the visible text is also its accessible name.
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
  const micLabel = m.state === MIC.IDLE ? "Start recording" : "Pause recording";
  mic.setAttribute("aria-label", micLabel);
  mic.title = micLabel;
  $("miclabel").textContent = micLabel;
  const box = $("askinput");
  box.readOnly = live;
  if (s.draftSeq !== shownDraftSeq) {
    shownDraftSeq = s.draftSeq;
    if (box.value !== s.draft) {
      const preserveSelection = document.activeElement === box && !box.readOnly;
      const start = preserveSelection ? box.selectionStart : null;
      const end = preserveSelection ? box.selectionEnd : null;
      box.value = s.draft;
      if (preserveSelection) box.setSelectionRange(Math.min(start, box.value.length), Math.min(end, box.value.length));
    }
  }
  if (live && document.activeElement !== box) box.scrollLeft = box.scrollWidth;  // show the newest words while they arrive
  box.placeholder = live ? "Listening..." : "Dive in...";
  $("askgo").disabled = !!s.asking;
  const line = m.state === MIC.LISTENING ? "Listening. Click Pause recording when you are done." : m.message;
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

const handoffUrls = { claude: HANDOFF_SITES.claude.defaultUrl, chatgpt: HANDOFF_SITES.chatgpt.defaultUrl };
chrome.storage.local.get([HANDOFF_SITES.claude.urlKey, HANDOFF_SITES.chatgpt.urlKey]).then((saved) => {
  for (const [id, site] of Object.entries(HANDOFF_SITES)) {
    const checked = validateHandoffUrl(saved[site.urlKey] || site.defaultUrl, site);
    if (checked.ok) handoffUrls[id] = checked.value;
  }
});

async function copyHandoff(payload) {
  await navigator.clipboard.writeText(payload.fullText);
}
function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      if (err) reject(err); else resolve();
    };
    const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    timer = setTimeout(() => finish(new Error("The destination page did not finish loading.")), 15000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") finish(); }, finish);
  });
}
async function handoff(id) {
  const s = ctl.s;
  if (!handoffEnabled(s)) return;
  const label = id === "claude" ? "Claude" : "ChatGPT";
  const button = id === "claude" ? claudeHandoff : chatgptHandoff;
  button.disabled = true;
  $("pinmsg").hidden = true;
  let payload = null;
  try {
    const originPermission = { origins: ["https://claude.ai/*", "https://chatgpt.com/*"] };
    const allowed = await chrome.permissions.request(originPermission);
    const sourceRes = await request((...args) => fetch(...args), ctl.cfg, "GET", `/source?job=${encodeURIComponent(s.jobId)}`, null, 10000).catch(() => null);
    const sourceText = sourceRes?.status === 200 && typeof sourceRes.json?.text === "string" ? sourceRes.json.text : "";
    payload = buildHandoffText({
      title: sourceText && sourceRes.json.title ? sourceRes.json.title : s.title,
      url: sourceText && sourceRes.json.url ? sourceRes.json.url : s.source.url,
      result: s.result,
      sourceText,
    });
    if (!allowed) {
      await copyHandoff(payload);
      $("pinmsg").textContent = "Dip'n'Dive: site access was declined. Everything is on your clipboard; paste it into the new conversation.";
      $("pinmsg").hidden = false;
      chrome.tabs.create({ url: handoffUrls[id] });
      return;
    }
    const tab = await chrome.tabs.create({ url: handoffUrls[id] });
    await waitForTab(tab.id);
    const site = injectionSite(id);
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillHandoffComposer, args: [payload, site] });
    if (!injected?.[0]?.result?.ok) {
      $("pinmsg").textContent = "Dip'n'Dive: couldn't fill the message box. Everything is on your clipboard; paste it here.";
      $("pinmsg").hidden = false;
      await copyHandoff(payload);
    }
  } catch {
    $("pinmsg").textContent = "Dip'n'Dive: couldn't fill the message box. Everything is on your clipboard; paste it here.";
    $("pinmsg").hidden = false;
    try { await copyHandoff(payload || buildHandoffText({ title: s.title, url: s.source.url, result: s.result })); } catch {}
  } finally {
    button.disabled = !handoffEnabled(ctl.s);
  }
}
claudeHandoff.addEventListener("click", () => handoff("claude"));
chatgptHandoff.addEventListener("click", () => handoff("chatgpt"));

for (const [id, b] of Object.entries(buttons)) b.addEventListener("click", () => ctl.selectMode(id));
pin.addEventListener("click", () => { ctl.summarizePage(); });  // calls tabs.requestAccess() first, inside this click
$("askform").addEventListener("submit", (e) => { e.preventDefault(); ctl.askQuestion(); });
$("askinput").addEventListener("input", () => ctl.typed($("askinput").value));
document.addEventListener("keydown", (e) => {
  const askInput = $("askinput"), mic = $("mic"), active = document.activeElement;
  const otherTextField = active && active !== askInput && active !== mic
    && active.matches("input[type='text'], input[type='url'], input[type='search'], textarea, [contenteditable='true']");
  if (e.key === "Escape" && (e.target === askInput || e.target === mic || !otherTextField)
      && !ctl.s.asking && !$("askform").hidden) { e.preventDefault(); ctl.cancelQuestion(); }
});
$("mic").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
$("mic").addEventListener("click", async () => { $("askinput").focus(); await ctl.toggleMic(); });
$("micsetup").addEventListener("click", () => ctl.openMicSetup());
// Coming back from the Enable microphone tab: look at the permission again (also reported by the tab itself).
window.addEventListener("focus", () => { ctl.refreshMic(); ctl.refreshSaved(); });  // and whether the summary is still in the log
// Chrome keeps a side panel that another panel replaced alive (and recognition with it), with no Stop button in sight:
// stop listening when the panel is hidden, keeping the words in the box.
document.addEventListener("visibilitychange", () => { if (document.hidden) ctl.pauseMic(); else ctl.refreshMic(); });
window.addEventListener("pagehide", () => ctl.pauseMic());
if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "dipdive-mic-granted") ctl.refreshMic(); });
$("savehist").addEventListener("change", () => ctl.setSaved($("savehist").checked));
// Watched: ticking starts the countdown, unticking cancels or stops (lib/history-row.js decides which). The permission prompt
// for YouTube is the first thing awaited inside the click.
$("watched").addEventListener("change", () => { void historyRow.toggleWatched($("watched").checked); });
$("like").addEventListener("click", () => { void historyRow.toggleThumb("like"); });
$("dislike").addEventListener("click", () => { void historyRow.toggleThumb("dislike"); });
chrome.runtime?.onMessage?.addListener((message) => historyRow.onProgress(message));

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
chrome.storage.onChanged.addListener((c, a) => { ctl.onStorageChange(c, a); historyRow.onStorageChange(c, a); });

winInfo = await chrome.windows.getCurrent();
panelIncognito = !!winInfo.incognito;
await ctl.init(winInfo.id);
if (!ctl.s.source) $("urlinput").focus(); // nothing pending: empty field, focused, with the hint showing
