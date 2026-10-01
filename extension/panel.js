import { Controller } from "./lib/controller.js";
import { MODES } from "./lib/modes.js";
import { renderMarkdown, safeHref } from "./lib/markdown.js";
import { slotKey } from "./lib/background-core.js";
import { installShim } from "./lib/shim.js";

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

function render(s) {
  for (const [id, b] of Object.entries(buttons)) b.setAttribute("aria-pressed", String(id === s.mode));
  const t = $("title");
  const href = s.source && safeHref(s.source.url);
  t.textContent = s.title || (s.source ? s.source.url : "");
  t.hidden = !(s.title || s.source);
  if (href) t.href = href; else t.removeAttribute("href");
  $("url").textContent = s.source ? s.source.url : "";
  $("result").innerHTML = s.mode === "temp" ? "" : s.result ? renderMarkdown(s.result) : "";
  $("copy").hidden = !(s.mode === "temp" && s.tempReady);
  $("warn").hidden = !(s.mode === "temp" && s.tempWarn);
  $("note").hidden = !s.tempNote;
  $("note").textContent = s.tempNote;
  $("error").hidden = !s.error;
  $("error").textContent = s.error || "";
  $("status").textContent = s.status || "";
  document.body.classList.toggle("busy", !!s.busy);
}

const ctl = new Controller({
  storage: { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) },
  fetch: (...a) => fetch(...a),
  clipboard: { writeText: (t) => navigator.clipboard.writeText(t) },
  openTab: (url) => chrome.tabs.create({ url }),
  uuid: () => crypto.randomUUID(),
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (id) => clearTimeout(id),
  onState: render,
});

for (const [id, b] of Object.entries(buttons)) b.addEventListener("click", () => ctl.selectMode(id));
$("copy").addEventListener("click", () => ctl.copyAndOpen());
$("clear").addEventListener("click", (e) => { e.preventDefault(); ctl.clearHistory(); });
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((c, a) => ctl.onStorageChange(c, a));

const win = await chrome.windows.getCurrent();
await ctl.init(win.id);
