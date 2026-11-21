import { repairAvailable, recoveryContext, launchRecovery, RECOVERY_HOST } from "./lib/recovery.js";
import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";
import { MIC } from "./lib/voice.js";
import { createMediaClient } from "./lib/media-hush.js";
import { listMics, micInfo } from "./lib/micdevice.js";
import { openHistoryHere } from "./lib/history.js";
import { request } from "./lib/api.js";
import { normPlaylist, positionLabel } from "./lib/playlist.js";
import { HANDOFF_SITES, buildHandoffText, fillHandoffComposer, handoffEnabled, injectionSite, validateHandoffUrl } from "./lib/handoff-sites.js";
import { creatorView, isPlainClick, openInCurrentTab } from "./lib/urls.js";
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
let recoveryPlatform = "";
let recoveryLaunching = false;
let recoveryTimer = null;
let recoveryClosed = false;

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
  const repair = repairAvailable(s, recoveryPlatform);
  for (const [b, normal, fixing] of [
    [claudeHandoff, "Continue in Claude", "Repair in Claude Code"],
    [chatgptHandoff, "Continue in ChatGPT", "Repair in Codex"],
  ]) {
    b.disabled = recoveryLaunching || (!ready && !repair);
    b.setAttribute("aria-label", repair ? fixing : normal);
    b.title = repair ? fixing : ready ? normal : (recoveryPlatform === "mac" ? "Available after a finished Dip or a failed summary attempt." : "Available when a Dip has finished and its result is on screen.");
  }
  $("recover").hidden = !repair;
  $("recover-btn").disabled = recoveryLaunching;
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

// The question field is shown while the mic is on, while it holds text, or once he starts typing or clicks the row's
// empty space; sending (or Escape) closes it again.
let fieldOpen = false;
function sizeField() {
  const box = $("askinput");
  if (box.hidden) return;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + 2}px`;  // grows upward: the row stays docked at the bottom (max-height in CSS)
  box.style.overflowY = box.scrollHeight + 2 > window.innerHeight * 0.45 ? "auto" : "hidden";  // a scrollbar only at the cap
}
function openField() {
  if (!ctl.s.configured || !ctl.s.source) return false;
  fieldOpen = true;
  render(ctl.s);
  $("askinput").focus();
  return true;
}

function renderPlaylist(s, show) {
  const pl = show ? normPlaylist(s.playlist) : null;
  $("plrow").hidden = !pl;
  if (!pl) return;
  $("plprev").disabled = pl.index <= 0;
  $("plnext").disabled = pl.index >= pl.entries.length - 1;
  $("plcount").textContent = positionLabel(pl);
  $("pltitle").textContent = pl.title;
  $("plpos").title = pl.title ? `${pl.title}: ${positionLabel(pl)}` : positionLabel(pl);
  const near = (d) => pl.entries[pl.index + d]?.title;
  $("plprev").title = near(-1) ? `Previous: ${near(-1)}` : "Previous video in the playlist";
  $("plnext").title = near(1) ? `Next: ${near(1)}` : "Next video in the playlist";
}

function renderAsk(s) {
  // The bottom row is there whenever the companion is set up, so History, Back and Forward are always one click away;
  // the mic and Ask only once there is a source to ask about.
  $("ask").hidden = !s.configured;
  $("askform").hidden = !s.configured;
  $("trailback").disabled = !s.trailBack;
  $("trailfwd").disabled = !s.trailForward;
  const show = s.configured && !!s.source;
  for (const id of ["mic", "askgo", "askspace"]) $(id).hidden = !show;
  renderPlaylist(s, show);
  if (!show) {
    for (const id of ["micmsg", "micsetup", "askerror", "askinput"]) $(id).hidden = true;
    fieldOpen = false;
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
  const box = $("askinput");   // always editable, even while listening (typed() keeps his edits)
  if (s.draftSeq !== shownDraftSeq) {
    shownDraftSeq = s.draftSeq;
    if (box.value !== s.draft) {
      const preserveSelection = document.activeElement === box;
      const start = preserveSelection ? box.selectionStart : null;
      const end = preserveSelection ? box.selectionEnd : null;
      box.value = s.draft;
      if (preserveSelection) box.setSelectionRange(Math.min(start, box.value.length), Math.min(end, box.value.length));
    }
  }
  if (s.asking) fieldOpen = false;  // sent: the question moves into the thread
  box.hidden = !(live || fieldOpen || !!s.draft.trim());
  sizeField();
  if (live && document.activeElement !== box) box.scrollTop = box.scrollHeight;  // show the newest words while they arrive
  box.placeholder = live ? "Listening..." : "Dive in...";
  $("askgo").disabled = !!s.asking;
  const line = m.state === MIC.LISTENING ? "Listening. Click Pause recording when you are done." : m.message;
  $("micmsg").hidden = !line;
  $("micmsg").textContent = line;
  $("micmsg").classList.toggle("err", m.kind === "error" && m.state === MIC.IDLE);
  $("micsetup").hidden = !m.needPermission;
  $("askerror").hidden = !s.askError;
  $("askerror").textContent = s.askError || "";
  $("micwarn").hidden = !s.micWarn;
  $("micwarn").textContent = s.micWarn || "";
  if (!$("micinfo").hidden) void showMicInfo();  // the marked microphone changed while the popup is open
}

// ---------- right-click on the mic: pick the microphone dictation uses (lib/micdevice.js) ----------
const mediaDevices = navigator.mediaDevices || null;
let micInfoSeq = 0;
async function showMicInfo() {
  const seq = ++micInfoSeq;
  const list = await listMics(mediaDevices);
  if (seq !== micInfoSeq) return;
  const info = micInfo(list, ctl.s.preferredMic);
  $("micinfo-line").textContent = info.line;
  $("micinfo-line").hidden = !info.line;
  const box = $("micinfo-list");
  box.replaceChildren(...info.rows.map((row) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "micopt" + (row.missing ? " missing" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(row.chosen));
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = row.chosen ? "\u2713" : "";
    const name = document.createElement("span");
    name.textContent = row.label;   // device names are plain text
    b.append(tick, name);
    // The default row stores nothing; a device row stores its name (names survive re-plugging, device ids may not).
    b.addEventListener("click", () => { if (!row.missing) void ctl.setPreferredMic(row.id ? row.label : ""); });
    return b;
  }));
  $("micinfo").hidden = false;
}
function hideMicInfo() { micInfoSeq++; $("micinfo").hidden = true; }

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
  media: createMediaClient(chrome),
  micDevices: { list: () => listMics(mediaDevices), watch: (fn) => mediaDevices?.addEventListener?.("devicechange", fn),
                track: async (id) => (await mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } })).getAudioTracks()[0] },
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
async function recoverOrRepair(provider = null) {
  if (recoveryLaunching || !repairAvailable(ctl.s, recoveryPlatform)) return;
  recoveryLaunching = true;
  render(ctl.s);
  const context = recoveryContext(ctl.s, chrome.runtime.getManifest().version, ctl.cfg?.token);
  $("recover-status").textContent = "Opening Terminal. Enter passwords there or in Screen Sharing.";
  try {
    const answer = await launchRecovery(chrome, provider ? "repair" : "recover", provider, context);
    $("recover-status").textContent = answer?.message || "The recovery helper did not answer.";
    if (answer?.ok) pollRecovery(Date.now() + 20 * 60 * 1000);
  } catch {
    $("recover-status").textContent = "Could not launch recovery. Try again.";
  } finally {
    recoveryLaunching = false;
    render(ctl.s);
  }
}
function pollRecovery(deadline) {
  clearTimeout(recoveryTimer);
  if (recoveryClosed) return;
  recoveryTimer = setTimeout(async () => {
    try {
      const answer = await chrome.runtime.sendNativeMessage(RECOVERY_HOST, { action: "status" });
      if (recoveryClosed) return;
      $("recover-status").textContent = answer?.message || "";
      if (answer?.ok && !["done", "error", "idle"].includes(answer.phase) && Date.now() < deadline) pollRecovery(deadline);
    } catch {
      if (!recoveryClosed) $("recover-status").textContent = "Recovery status is unavailable. Check its Terminal window.";
    }
  }, 2500);
}
$("recover-btn").addEventListener("click", () => recoverOrRepair());
claudeHandoff.addEventListener("click", () => repairAvailable(ctl.s, recoveryPlatform) ? recoverOrRepair("claude") : handoff("claude"));
chatgptHandoff.addEventListener("click", () => repairAvailable(ctl.s, recoveryPlatform) ? recoverOrRepair("codex") : handoff("chatgpt"));
window.addEventListener("pagehide", () => { recoveryClosed = true; clearTimeout(recoveryTimer); });

for (const [id, b] of Object.entries(buttons)) b.addEventListener("click", () => ctl.selectMode(id));
pin.addEventListener("click", () => { ctl.summarizePage(); });
// The title opens the summarized page in the current tab (lib/urls.js); modified clicks keep Chrome's own behavior.
$("title").addEventListener("click", (e) => {
  const href = $("title").getAttribute("href");
  if (!isPlainClick(e) || !href || href === "#") return;
  e.preventDefault();
  void openInCurrentTab(chrome.tabs, winInfo?.id, $("title").href);
});  // calls tabs.requestAccess() first, inside this click
$("askform").addEventListener("submit", (e) => { e.preventDefault(); ctl.askQuestion(); });
$("askinput").addEventListener("input", () => { ctl.typed($("askinput").value); sizeField(); });
// Enter sends, Shift+Enter starts a new line
$("askinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ctl.askQuestion(); }
});
$("askinput").addEventListener("blur", () => { if (!$("askinput").value.trim() && ctl.s.mic.state === MIC.IDLE && fieldOpen) { fieldOpen = false; render(ctl.s); } });
$("askspace").addEventListener("click", () => { openField(); });
window.addEventListener("resize", sizeField);  // a narrower panel wraps the question onto more lines
// ---------- back and forward (lib/trail.js): buttons, Alt or Cmd + arrow keys, and a two-finger swipe ----------
$("plprev").addEventListener("click", () => { void ctl.stepPlaylist(-1); });
$("plnext").addEventListener("click", () => { void ctl.stepPlaylist(1); });
$("trailback").addEventListener("click", () => { void ctl.goTrail(-1); });
$("trailfwd").addEventListener("click", () => { void ctl.goTrail(1); });
document.addEventListener("keydown", (e) => {
  if (!(e.altKey || e.metaKey) || e.ctrlKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const a = document.activeElement;
  if (a && a.matches("input, textarea, select, [contenteditable='true']")) return;  // those keys move the cursor there
  e.preventDefault();
  void ctl.goTrail(e.key === "ArrowLeft" ? -1 : 1);
});
let swipeX = 0, swipeTimer = null, swipeDone = false;
document.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") return;  // scrolls sideways itself
  }
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => { swipeX = 0; swipeDone = false; }, 300);  // the gesture ended
  if (swipeDone) return;  // one step per swipe
  swipeX += e.deltaX;
  if (Math.abs(swipeX) < 150) return;
  swipeDone = true;
  // fingers moving right scroll left (negative deltaX): back, as in Chrome's own swipe
  void ctl.goTrail(swipeX < 0 ? -1 : 1);
}, { passive: true });
document.addEventListener("keydown", (e) => {
  const askInput = $("askinput"), mic = $("mic"), active = document.activeElement;
  const otherTextField = active && active !== askInput && active !== mic
    && active.matches("input[type='text'], input[type='url'], input[type='search'], textarea, [contenteditable='true']");
  if (e.key === "Escape" && (e.target === askInput || e.target === mic || !otherTextField)
      && !ctl.s.asking && !$("askform").hidden) { e.preventDefault(); ctl.cancelQuestion(); }
});
// Typing a letter anywhere in the panel (outside other text fields) opens the field and types into it.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.isComposing) return;
  const a = document.activeElement;
  if (a && a.matches("input, textarea, select, [contenteditable='true']")) return;
  if (!$("askinput").hidden) { $("askinput").focus(); return; }
  openField();
});
// Escape (handled above) also folds the question field away.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fieldOpen && !ctl.s.asking) { fieldOpen = false; render(ctl.s); }
});
$("mic").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
$("mic").addEventListener("click", async () => { $("askinput").focus(); await ctl.toggleMic(); });
$("micsetup").addEventListener("click", () => ctl.openMicSetup());
$("mic").addEventListener("contextmenu", (e) => { e.preventDefault(); void showMicInfo().then(() => $("micinfo-close").focus()); });
$("micinfo-close").addEventListener("click", () => { hideMicInfo(); $("mic").focus(); });
// Escape closes the popup first (before the question box's own Escape); a click anywhere else closes it too.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("micinfo").hidden) { e.preventDefault(); e.stopPropagation(); hideMicInfo(); $("mic").focus(); }
}, true);
document.addEventListener("mousedown", (e) => { if (!$("micinfo").hidden && !$("micinfo").contains(e.target) && e.target !== $("mic") && !$("mic").contains(e.target)) hideMicInfo(); });
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
$("historylink").addEventListener("click", () => { void openHistoryHere(chrome, historyUrl, winInfo?.id); });
// the gear: Settings (the Options page)
$("options").addEventListener("click", () => {
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((c, a) => { ctl.onStorageChange(c, a); historyRow.onStorageChange(c, a); });

try { recoveryPlatform = (await chrome.runtime.getPlatformInfo()).os === "mac" ? "mac" : ""; } catch { /* dev harness / unsupported platform */ }
winInfo = await chrome.windows.getCurrent();
panelIncognito = !!winInfo.incognito;
await ctl.init(winInfo.id);
if (!ctl.s.source) $("urlinput").focus(); // nothing pending: empty field, focused, with the hint showing
