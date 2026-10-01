// The History page (history.html): the panel's History button opens it in its own tab; it loads the whole history log
// (GET /history, followed page by page, starting again on history_changed) and filters it with a live keyword search.
// Flows run against a fake companion that pages the way the real one does (newest first, `before` cursor, revision).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PAGE_SIZE, entryHtml, loadAllHistory, matches, openHistoryTab, searchText } from "../lib/history.js";

const TOKEN = "t".repeat(40);
const CFG = { base: "http://c.test", token: TOKEN };
const entry = (i, extra = {}) => ({ title: `Title ${i}`, channel: i % 2 ? "" : `Chan ${i}`, date: "2026-10-01", time: "09:05", mode: "claude-dip", mode_label: "Claude Dip",
  url: `https://v.test/${i}`, summary: `Summary **${i}**`, index: i, ...extra });

// The log holds `n` entries, oldest first; GET /history pages them like dipdive/historylog.read_page, with a revision.
function companion(n, { status = 200, error = null } = {}) {
  const c = { n, rev: 0, calls: [], status, error, auths: [], onCall: null };
  c.fetch = async (url, init) => {
    c.calls.push(url);
    c.auths.push(init.headers.Authorization);
    if (c.onCall) c.onCall(c.calls.length, c);
    const respond = (code, json) => ({ status: code, json: async () => json });
    if (c.error) throw c.error;
    if (c.status !== 200) return respond(c.status, { error_code: c.status === 503 ? "log_unreadable" : "unauthorized" });
    const u = new URL(url);
    if (u.searchParams.has("revision") && Number(u.searchParams.get("revision")) !== c.rev) return respond(409, { error_code: "history_changed", revision: c.rev });
    const limit = Number(u.searchParams.get("limit"));
    const before = u.searchParams.has("before") ? Number(u.searchParams.get("before")) : c.n;
    const top = Math.min(before, c.n);
    const lo = Math.max(0, top - limit);
    const entries = [];
    for (let i = top - 1; i >= lo; i--) entries.push(entry(i));
    return respond(200, { entries, total: c.n, limit, next_before: lo > 0 ? lo : null, revision: c.rev });
  };
  return c;
}

test("loads every page of the log, newest first, with the token, following the cursor to the end", async () => {
  const c = companion(250);
  const seen = [];
  const r = await loadAllHistory({ fetch: c.fetch, cfg: CFG, onProgress: (e, t) => seen.push([e.length, t]) });
  assert.equal(r.entries.length, 250);
  assert.deepEqual(r.entries.slice(0, 2).map((e) => e.title), ["Title 249", "Title 248"]);
  assert.equal(r.entries.at(-1).title, "Title 0");
  assert.equal(new Set(r.entries.map((e) => e.index)).size, 250, "nothing repeated");
  assert.deepEqual(c.calls, [`http://c.test/history?limit=${PAGE_SIZE}`, `http://c.test/history?limit=${PAGE_SIZE}&before=150&revision=0`,
    `http://c.test/history?limit=${PAGE_SIZE}&before=50&revision=0`]);
  assert.ok(c.auths.every((a) => a === `Bearer ${TOKEN}`));
  assert.deepEqual(seen, [[100, 250], [200, 250], [250, 250]]);
});

test("an entry removed or restored while loading: the companion says history_changed and loading starts again", async () => {
  const c = companion(250);
  c.onCall = (n, co) => { if (n === 2) { co.n = 249; co.rev = 1; } };  // a removal lands between the first and second page
  const r = await loadAllHistory({ fetch: c.fetch, cfg: CFG });
  assert.equal(r.restarts, 1);
  assert.equal(r.entries.length, 249);
  assert.equal(new Set(r.entries.map((e) => e.index)).size, 249);
  assert.equal(c.calls[2], `http://c.test/history?limit=${PAGE_SIZE}`, "started again from the newest");
  assert.ok(c.calls.slice(3).every((u) => u.includes("revision=1")));
});

test("a log that keeps changing gives up after a few restarts with a plain message", async () => {
  const c = companion(250);
  c.onCall = (n, co) => { co.rev++; };
  const r = await loadAllHistory({ fetch: c.fetch, cfg: CFG });
  assert.match(r.error, /kept changing/);
});

test("an empty log, errors and missing settings", async () => {
  assert.deepEqual((await loadAllHistory({ fetch: companion(0).fetch, cfg: CFG })).entries, []);
  assert.match((await loadAllHistory({ fetch: companion(5, { status: 401 }).fetch, cfg: CFG })).error, /token/);
  assert.match((await loadAllHistory({ fetch: companion(5, { status: 503 }).fetch, cfg: CFG })).error, /cannot be read/);
  assert.match((await loadAllHistory({ fetch: companion(5, { error: new TypeError("x") }).fetch, cfg: CFG })).error, /Cannot reach/);
  assert.match((await loadAllHistory({ fetch: companion(5).fetch, cfg: {} })).error, /options/);
});

test("search: title, channel and summary, case-insensitive, every word must match, in any order", () => {
  const e = { title: "Could life start in a CRATER?", channel: "SciShow", summary: "Microbes lived in **hot water** for 8 million years." };
  const t = searchText(e);
  for (const q of ["", "  ", "crater", "CRATER microbes", "scishow water", "million crater", "hot water"]) assert.ok(matches(t, q), q);
  for (const q of ["volcano", "crater volcano", "scishowx"]) assert.ok(!matches(t, q), q);
  assert.ok(!matches(searchText({ title: "a", url: "https://only-in-url.test/" }), "only-in-url"), "the URL is not searched");
});

test("an entry shows the title as a new-tab link, channel, date and time, mode, and the summary rendered as Markdown", () => {
  const h = entryHtml(entry(2));
  assert.ok(h.includes('<a class="htitle" href="https://v.test/2" target="_blank" rel="noopener noreferrer">Title 2</a>'), h);
  assert.ok(h.includes('<div class="hchannel">Chan 2</div>'), h);
  assert.ok(h.includes('<div class="hmeta">2026-10-01 09:05 &middot; Claude Dip</div>'), h);
  assert.ok(h.includes("<strong>2</strong>"), h);
  assert.ok(!entryHtml(entry(1)).includes("hchannel"), "no channel, no channel line");
});

test("entry text is inert: HTML is escaped, non-http links are never links, images are text", () => {
  const h = entryHtml(entry(3, {
    title: '<img src=x onerror=alert(1)> "quoted"', channel: "<b>chan</b>", mode_label: "<i>m</i>", url: "javascript:alert(1)",
    summary: 'Raw <script>alert(1)</script> and [bad](javascript:alert(2)) and ![pic](https://e.test/p.png) and [ok](https://e.test/ok)',
  }));
  assert.ok(!/<(img|script|b|i)[\s>]/.test(h), h);
  assert.ok(!/href="javascript:/i.test(h), h);
  assert.ok(!h.includes('<a class="htitle"'), "a javascript: URL is not made a link");
  assert.ok(h.includes("&lt;img src=x onerror=alert(1)&gt;"), h);
  assert.ok(h.includes('<a href="https://e.test/ok" target="_blank" rel="noopener noreferrer">ok</a>'), h);
  assert.ok(!h.includes("<img"), h);
  const odd = entryHtml({ url: "https://v.test/z" });  // fields missing: still renders
  assert.ok(odd.includes("https://v.test/z"), odd);
});


test("the History button reuses an open History tab, else opens one", async () => {
  const calls = [];
  const api = (contexts) => ({
    runtime: { getContexts: async (f) => { calls.push(["getContexts", f]); return contexts; } },
    tabs: { update: async (id, o) => calls.push(["update", id, o]), create: async (o) => calls.push(["create", o]) },
    windows: { update: async (id, o) => calls.push(["focus", id, o]) },
  });
  const url = "chrome-extension://x/history.html";
  assert.equal(await openHistoryTab(api([{ tabId: 7, windowId: 3, contextType: "TAB" }]), url), "reused");
  assert.deepEqual(calls, [["getContexts", { contextTypes: ["TAB"], documentUrls: [url] }], ["update", 7, { active: true }], ["focus", 3, { focused: true }]]);
  calls.length = 0;
  assert.equal(await openHistoryTab(api([]), url), "opened");
  assert.deepEqual(calls.at(-1), ["create", { url }]);
  assert.equal(await openHistoryTab({ tabs: { create: async (o) => calls.push(["create", o]) } }, url), "opened", "the dev shim has no runtime");
});

test("panel.html: History is the first button of the bottom row; the status line has the save box and the Settings gear (no Clear history); panel.js opens the History tab", () => {
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const row = html.match(/<div id="askrow">([\s\S]*?)<\/form>/)[1];
  const order = [...row.matchAll(/\bid="(historylink|askinput|mic|askgo)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["historylink", "askinput", "mic", "askgo"], "History, the question box, Speak, Ask");
  assert.match(row, /<button id="historylink" class="rowbtn" type="button" aria-label="History" title="History"><svg[^>]*aria-hidden="true"/);
  const foot = html.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.deepEqual([...foot.matchAll(/\bid="(status|saveline|options)"/g)].map((m) => m[1]), ["status", "saveline", "options"]);
  assert.ok(!/id="clear"|Clear history|historyview/.test(html), "no Clear history and no in-panel history view");
  const ids = [...html.matchAll(/\bid="(\w+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of [...js.matchAll(/\$\("(\w+)"\)/g)].map((m) => m[1])) assert.ok(ids.includes(id), `panel.js uses #${id}, which panel.html lacks`);
  assert.match(js, /\$\("historylink"\)\.addEventListener\("click", \(\) => openHistoryTab\(chrome, historyUrl\)\)/);
  assert.match(js, /chrome\.runtime\.getURL\("history\.html"\)/);
});

// The real history.js run against a stubbed page: it loads everything, renders it safely, and the search filters live.
async function historyPage(c) {
  const els = {};
  const node = (id) => (els[id] ||= { id, hidden: false, textContent: "", value: "", handlers: {}, children: [],
    addEventListener(t, f) { this.handlers[t] = f; }, replaceChildren(...k) { this.children = k.flatMap((x) => x.children || [x]); } });
  for (const id of ["search", "count", "list", "empty", "error"]) node(id);
  const saved = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  globalThis.document = {
    getElementById: (id) => node(id), body: { dataset: {} },
    createElement: () => ({ hidden: false, className: "", innerHTML: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    createDocumentFragment: () => ({ children: [], appendChild(x) { this.children.push(x); } }),
  };
  globalThis.chrome = { storage: { local: { get: async () => ({ base: CFG.base, token: CFG.token }) } } };
  globalThis.fetch = c.fetch;
  const restore = () => Object.assign(globalThis, saved);
  try {
    await import(`../history.js?run=${Math.random()}`);
    for (let i = 0; i < 20 && !globalThis.document.body.dataset.loaded; i++) await new Promise((r) => setTimeout(r, 0));
  } catch (e) { restore(); throw e; }
  return { els, body: globalThis.document.body, restore };
}

test("history page: every entry is rendered, newest first, then a live search hides what does not match and counts", async () => {
  const c = companion(130);
  const p = await historyPage(c);
  try {
  assert.equal(p.body.dataset.loaded, "yes");
  const rows = p.els.list.children;
  assert.equal(rows.length, 130);
  assert.match(rows[0].innerHTML, /Title 129/);
  assert.equal(rows[0].attrs.role, "listitem");
  assert.equal(p.els.count.textContent, "130 entries, newest first");
  p.els.search.value = "title 12";
  p.els.search.handlers.input();
  const shown = rows.filter((r) => !r.hidden).length;
  assert.equal(shown, 12, "Title 12, Title 112 and Title 120 to 129 (words match anywhere in the text)");
  assert.equal(p.els.count.textContent, "12 of 130 entries match");
  p.els.search.value = "CHAN 128 summary";
  p.els.search.handlers.input();
  assert.equal(rows.filter((r) => !r.hidden).length, 1);
  p.els.search.value = "";
  p.els.search.handlers.input();
  assert.equal(rows.filter((r) => !r.hidden).length, 130);
  } finally { p.restore(); }
});

test("history page: an error is shown in plain words and nothing else", async () => {
  const p = await historyPage(companion(3, { status: 401 }));
  p.restore();
  assert.equal(p.body.dataset.loaded, "error");
  assert.equal(p.els.error.hidden, false);
  assert.match(p.els.error.textContent, /token/);
  assert.equal(p.els.list.children.length, 0);
});

test("history.html: a search box at the top, the list, its own script; no inline script", () => {
  const h = fs.readFileSync(new URL("../history.html", import.meta.url), "utf8");
  assert.match(h, /<input id="search" type="search"[^>]*aria-label="Search the history"/);
  assert.ok(h.indexOf('id="search"') < h.indexOf('id="list"'));
  assert.match(h, /<script type="module" src="history\.js"><\/script>/);
  assert.ok(!/<script[^>]*>[^<]/.test(h));
  const css = fs.readFileSync(new URL("../history.css", import.meta.url), "utf8");
  assert.match(css, /prefers-color-scheme: dark/, "light and dark");
});
