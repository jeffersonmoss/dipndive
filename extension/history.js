// The History page: the whole history log from the companion, newest first, with a live keyword search.
import { loadAllHistory, entryHtml, matches, searchText } from "./lib/history.js";
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
  rows = entries.map((e) => {
    const el = document.createElement("article");
    el.className = "hentry";
    el.setAttribute("role", "listitem");
    el.innerHTML = entryHtml(e);
    frag.appendChild(el);
    return { el, text: searchText(e) };
  });
  list.replaceChildren(frag);
  $("empty").hidden = entries.length > 0;
  applySearch();
}

$("search").addEventListener("input", applySearch);
const st = await chrome.storage.local.get(["base", "token"]);
const res = await loadAllHistory({
  fetch: (...a) => fetch(...a),
  cfg: { base: st.base, token: st.token },
  onProgress: (entries, total) => { $("count").textContent = `Loading... ${entries.length} of ${total}`; },
});
if (res.error) {
  $("error").hidden = false;
  $("error").textContent = res.error;
  $("count").textContent = "";
} else {
  render(res.entries);
}
document.body.dataset.loaded = res.error ? "error" : "yes";
