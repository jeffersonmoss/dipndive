// The History page: the whole history log from the companion, newest first, with a live keyword search.
import { HISTORY_REFRESH, createHistoryRefresher, loadAllHistory, entryHtml, matches, searchText } from "./lib/history.js";
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

// One pass: reread the companion URL and token from storage (they may have been corrected since), refetch every page,
// show the result. The search box is left alone, so a query typed before a reload still filters the new entries.
// A failure keeps the entries already shown (they are all there is) and puts the reason in the error line; a success clears it.
async function load() {
  const st = await chrome.storage.local.get(["base", "token"]);
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
