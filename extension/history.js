// The History page: the whole history log from the companion, newest first, with a live keyword search.
import { HISTORY_REFRESH, createHistoryRefresher, loadAllHistory, entryHtml, matches, searchText, turnHtml } from "./lib/history.js";
import { askEntry } from "./lib/cardask.js";
import { request } from "./lib/api.js";
import { MIC, VoiceInput } from "./lib/voice.js";
import { listMics, resolveMic } from "./lib/micdevice.js";
import { installShim } from "./lib/shim.js";

installShim();  // inert inside the extension; lets the page run as a plain page against the dev harness
const $ = (id) => document.getElementById(id);
let rows = [];  // { el, text }

function applySearch() {
  const q = $("search").value;
  let shown = 0;
  for (const r of rows) {
    const on = matches(r.text, q);
    r.el.hidden = !on;
    if (on) shown++;
  }
  const n = rows.length;
  $("count").textContent = !q.trim() ? `${n} ${n === 1 ? "entry" : "entries"}, newest first`
    : `${shown} of ${n} ${n === 1 ? "entry matches" : "entries match"}`;
}

function render(entries) {
  const list = $("list");
  const frag = document.createDocumentFragment();
  const old = new Map(rows.map((r) => [r.entry.job_id, r]));
  rows = entries.map((e) => {
    // A card being asked on (or holding an unsent question) is kept as it is, so a reload never drops his words.
    const prev = e.job_id && old.get(e.job_id);
    if (prev && (prev.busy || prev.box.value.trim() || voiceRow === prev)) {
      prev.entry = { ...e, qa: prev.entry.qa.length > (e.qa || []).length ? prev.entry.qa : (e.qa || []) };
      prev.text = searchText(prev.entry);
      frag.appendChild(prev.el);
      return prev;
    }
    const el = document.createElement("article");
    el.className = "hentry";
    el.setAttribute("role", "listitem");
    el.innerHTML = entryHtml(e);
    const r = { el, entry: { ...e, qa: Array.isArray(e.qa) ? e.qa : [] }, text: searchText(e), busy: false, box: null };
    if (e.job_id && e.url) addAskRow(r);
    frag.appendChild(el);
    return r;
  });
  list.replaceChildren(frag);
  $("empty").hidden = entries.length > 0;
  applySearch();
}

$("search").addEventListener("input", applySearch);

// ---------- asking on a card: a small growing box, a mic and Ask (lib/cardask.js) ----------
const MIC_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ASK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M19 5v7.5a2 2 0 0 1-2 2H6M10 10.5l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let settings = { base: null, token: null };
let codexOk = null;
const grow = (box) => { box.style.height = "auto"; box.style.height = `${box.scrollHeight + 2}px`; };
globalThis.addEventListener?.("resize", () => { for (const r of rows) if (r.box && r.box.value) grow(r.box); });

function addAskRow(r) {
  const form = document.createElement("form");
  form.className = "hask";
  form.innerHTML = `<textarea class="haskinput" rows="1" placeholder="Dive in..." aria-label="Ask about this entry" maxlength="2000" spellcheck="true"></textarea>`
    + `<button class="hbtn hmic" type="button" data-state="idle" aria-label="Start recording" title="Start recording">${MIC_SVG}</button>`
    + `<button class="hbtn hgo" type="submit" aria-label="Ask" title="Ask">${ASK_SVG}</button>`;
  const note = document.createElement("div");
  note.className = "hnote muted";
  note.hidden = true;
  r.el.append(form, note);
  r.box = form.querySelector("textarea");
  r.mic = form.querySelector(".hmic");
  r.go = form.querySelector(".hgo");
  r.note = note;
  r.box.addEventListener("input", () => {
    grow(r.box);
    if (voiceRow === r && voice.state !== MIC.IDLE) { voiceBase = r.box.value; voice.commit(); }  // his edit wins
  });
  r.box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendCard(r); }
  });
  r.mic.addEventListener("click", () => { void toggleMic(r); });
  form.addEventListener("submit", (e) => { e.preventDefault(); void sendCard(r); });
}

function setNote(r, text, err = false) {
  r.note.hidden = !text;
  r.note.textContent = text || "";
  r.note.classList.toggle("err", !!err);
}

async function sendCard(r) {
  if (r.busy) return;
  if (voiceRow === r && voice.state !== MIC.IDLE) voice.cancel();  // what he said so far is already in the box
  const question = r.box.value;
  if (!question.trim()) { setNote(r, "Type or say a question first.", true); return; }
  r.busy = true;
  r.go.disabled = r.mic.disabled = true;
  const thread = r.el.querySelector(".hthread");
  const pending = document.createElement("div");
  pending.className = "turn";
  pending.innerHTML = `<div class="q"></div><div class="a pending">Thinking...</div>`;
  pending.querySelector(".q").textContent = question.trim();
  thread.appendChild(pending);
  r.box.value = "";
  grow(r.box);
  setNote(r, "");
  if (String(r.entry.mode).startsWith("codex")) {
    // as on the panel: a Codex entry's question goes to Claude when Codex is unavailable on the iMac
    try {
      const h = await request((...a) => fetch(...a), settings, "GET", "/health", null, 10000);
      codexOk = h.status === 200 && typeof h.json?.codex_ready === "boolean" ? h.json.codex_ready : null;
    } catch { codexOk = null; }
  }
  const res = await askEntry({
    fetch: (...a) => fetch(...a), cfg: settings, uuid: () => crypto.randomUUID(), codexOk,
    wait: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    onLabel: (t) => { pending.querySelector(".a").textContent = t; },
  }, r.entry, question);
  r.busy = false;
  r.go.disabled = r.mic.disabled = false;
  if (res.error) {
    pending.remove();
    if (!r.box.value.trim()) { r.box.value = question; grow(r.box); }  // give his question back
    setNote(r, res.error, true);
    return;
  }
  pending.outerHTML = turnHtml(res);
  r.entry.qa = [...r.entry.qa, { q: res.q, a: res.a }];
  r.text = searchText(r.entry);
}

// One recording at a time, on whichever card's mic was clicked last.
let voiceRow = null, voiceBase = "";
const speech = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
const media = globalThis.navigator?.mediaDevices || null;
const voice = new VoiceInput({
  SpeechRecognition: speech,
  permissions: globalThis.navigator?.permissions || null,
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (id) => clearTimeout(id),
  audioTrack: async () => {
    // the microphone picked in the panel's mic popup on this computer, when it is connected
    const { preferredMic } = await chrome.storage.local.get("preferredMic");
    if (!preferredMic || !media) return null;
    const { use } = resolveMic(await listMics(media), preferredMic);
    if (!use) return null;
    const s = await media.getUserMedia({ audio: { deviceId: { exact: use.id } } });
    return s.getAudioTracks()[0] || null;
  },
  onChange: (m) => {
    const r = voiceRow;
    if (!r) return;
    const live = m.state !== MIC.IDLE;
    r.mic.dataset.state = m.state;
    const label = live ? "Pause recording" : "Start recording";
    r.mic.setAttribute("aria-label", label);
    r.mic.title = label;
    if (live) {
      r.box.value = [voiceBase.trimEnd(), String(m.text || "").trim()].filter(Boolean).join(" ");
      grow(r.box);
      r.box.placeholder = "Listening...";
      setNote(r, m.state === MIC.LISTENING ? "Listening. Click the mic again to pause." : "");
    } else {
      r.box.placeholder = "Dive in...";
      setNote(r, m.message, m.kind === "error");
    }
  },
});

async function toggleMic(r) {
  if (voiceRow && voiceRow !== r && voice.state !== MIC.IDLE) voice.cancel();
  if (voiceRow !== r) {
    if (voiceRow) { voiceRow.mic.dataset.state = "idle"; voiceRow.box.placeholder = "Dive in..."; setNote(voiceRow, ""); }
    voiceRow = r;
  }
  if (voice.state === MIC.IDLE) voiceBase = r.box.value;
  r.box.focus();
  await voice.toggle();
}

// One pass: reread the companion URL and token from storage (they may have been corrected since), refetch every page,
// show the result. The search box is left alone, so a query typed before a reload still filters the new entries.
// A failure keeps the entries already shown (they are all there is) and puts the reason in the error line; a success clears it.
async function load() {
  const st = await chrome.storage.local.get(["base", "token"]);
  settings = { base: st.base, token: st.token };
  const res = await loadAllHistory({
    fetch: (...a) => fetch(...a),
    cfg: { base: st.base, token: st.token },
    onProgress: (entries, total) => { $("count").textContent = `Loading... ${entries.length} of ${total}`; },
  });
  if (res.error) {
    $("error").hidden = false;
    $("error").textContent = res.error;
    if (rows.length) applySearch(); else $("count").textContent = "";
  } else {
    $("error").hidden = true;
    $("error").textContent = "";
    render(res.entries);
  }
  document.body.dataset.loaded = res.error ? "error" : "yes";
}
const refresher = createHistoryRefresher(load);

// The History button brings this tab forward and sends a refresh message; coming back to the tab also reloads.
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === HISTORY_REFRESH) refresher.refresh(); });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresher.refresh(); });
await refresher.refresh();
