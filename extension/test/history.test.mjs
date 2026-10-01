// History link: the panel asks the companion for the history log (GET /history) and shows it in place of the summary and the
// question box. Flows run against a fake companion that pages the way the real one does (newest first, `before` cursor).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HistoryBrowser, PAGE_SIZE, entryHtml } from "../lib/history.js";

const TOKEN = "t".repeat(40);
const entry = (i, extra = {}) => ({ title: `Title ${i}`, channel: i % 2 ? "" : `Chan ${i}`, date: "2026-10-01", time: "09:05", mode: "claude-dip", mode_label: "Claude Dip",
  url: `https://v.test/${i}`, summary: `Summary **${i}**`, index: i, ...extra });

// The log holds `n` entries, oldest first; GET /history pages them like dipdive/historylog.read_page.
function companion(n, { status = 200, error = null, hold = false } = {}) {
  const c = { n, calls: [], status, error, held: [], auths: [] };
  c.fetch = async (url, init) => {
    c.calls.push({ url, method: init.method });
    c.auths.push(init.headers.Authorization);
    const go = () => {
      const respond = (code, json) => ({ status: code, json: async () => json });
      if (c.error) throw c.error;
      if (c.status !== 200) return respond(c.status, { error_code: c.status === 503 ? "log_unreadable" : "unauthorized" });
      const u = new URL(url);
      const limit = Number(u.searchParams.get("limit"));
      const before = u.searchParams.has("before") ? Number(u.searchParams.get("before")) : c.n;
      const top = Math.min(before, c.n);
      const lo = Math.max(0, top - limit);
      const entries = [];
      for (let i = top - 1; i >= lo; i--) entries.push(entry(i));
      return respond(200, { entries, total: c.n, limit, next_before: lo > 0 ? lo : null });
    };
    if (hold) return new Promise((res, rej) => c.held.push(() => { try { res(go()); } catch (e) { rej(e); } }));
    return go();
  };
  return c;
}

function make(c, cfg = { base: "http://c.test", token: TOKEN }) {
  const states = [];
  const h = new HistoryBrowser({ fetch: c.fetch, getCfg: () => cfg, onState: (s) => states.push(s) });
  return { h, states, get last() { return states[states.length - 1]; } };
}
const titles = (s) => s.entries.map((e) => e.title);

test("opening asks for the newest page with the token and shows it newest first", async () => {
  const c = companion(45);
  const m = make(c);
  await m.h.open();
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].method, "GET");
  assert.equal(c.calls[0].url, `http://c.test/history?limit=${PAGE_SIZE}`);
  assert.equal(c.auths[0], `Bearer ${TOKEN}`);
  assert.equal(m.last.open, true);
  assert.equal(m.last.loading, false);
  assert.equal(m.last.entries.length, 20);
  assert.deepEqual(titles(m.last).slice(0, 2), ["Title 44", "Title 43"]);
  assert.equal(m.last.total, 45);
  assert.equal(m.last.nextBefore, 25);
  assert.equal(m.last.error, null);
});

test("the view reports loading while a page is on its way and is open at once", async () => {
  const c = companion(3, { hold: true });
  const m = make(c);
  const p = m.h.open();
  assert.deepEqual([m.last.open, m.last.loading, m.last.loaded], [true, true, false]);
  c.held.shift()();
  await p;
  assert.deepEqual([m.last.loading, m.last.loaded, m.last.entries.length], [false, true, 3]);
});

test("Show older appends the next pages in order until the log ends", async () => {
  const c = companion(45);
  const m = make(c);
  await m.h.open();
  await m.h.more();
  assert.equal(c.calls[1].url, `http://c.test/history?limit=${PAGE_SIZE}&before=25`);
  assert.equal(m.last.entries.length, 40);
  assert.equal(m.last.entries[20].title, "Title 24");
  await m.h.more();
  assert.equal(m.last.entries.length, 45);
  assert.equal(m.last.entries.at(-1).title, "Title 0");
  assert.equal(m.last.nextBefore, null);
  const calls = c.calls.length;
  await m.h.more();  // nothing older: no request
  assert.equal(c.calls.length, calls);
  assert.equal(new Set(titles(m.last)).size, 45, "no entry twice");
});

test("a second Show older while one is loading sends nothing", async () => {
  const c = companion(45, { hold: true });
  const m = make(c);
  const p = m.h.open();
  c.held.shift()();
  await p;
  const p2 = m.h.more();
  const p3 = m.h.more();
  assert.equal(c.held.length, 1);
  c.held.shift()();
  await Promise.all([p2, p3]);
  assert.equal(m.last.entries.length, 40);
});

test("an empty log is a loaded, empty list", async () => {
  const m = make(companion(0));
  await m.h.open();
  assert.deepEqual([m.last.loaded, m.last.entries.length, m.last.nextBefore, m.last.error], [true, 0, null, null]);
});

test("Back closes the view and drops the entries; opening again starts from the newest page", async () => {
  const c = companion(45);
  const m = make(c);
  await m.h.open();
  await m.h.more();
  m.h.back();
  assert.deepEqual([m.last.open, m.last.entries.length], [false, 0]);
  c.n = 46;  // a summary finished while History was closed
  await m.h.open();
  assert.equal(m.last.entries.length, 20);
  assert.equal(m.last.entries[0].title, "Title 45");
  assert.equal(c.calls.at(-1).url, `http://c.test/history?limit=${PAGE_SIZE}`);
});

test("a page that arrives after Back, or for an older opening, is dropped", async () => {
  const c = companion(45, { hold: true });
  const m = make(c);
  const p = m.h.open();
  m.h.back();
  c.held.shift()();
  await p;
  assert.deepEqual([m.last.open, m.last.entries.length, m.last.loading], [false, 0, false]);
  // Back then open again: the first opening's answer must not land in the second
  const p1 = m.h.open();
  m.h.back();
  const p2 = m.h.open();
  assert.equal(c.held.length, 2);
  c.held[1]();  // the second opening answers first
  await p2;
  c.held[0]();  // the stale one answers late
  await p1;
  assert.equal(m.last.entries.length, 20);
  assert.equal(m.last.open, true);
});

test("errors are named in plain words, keep what is already shown, and Try again repeats the same page", async () => {
  const c = companion(45);
  const m = make(c);
  await m.h.open();
  c.status = 503;
  await m.h.more();
  assert.equal(m.last.error, "The history log cannot be read on the iMac.");
  assert.equal(m.last.entries.length, 20, "the page already on screen stays");
  assert.equal(m.last.loading, false);
  c.status = 200;
  await m.h.more();  // the Try again button calls more() as well
  assert.equal(c.calls.at(-1).url, `http://c.test/history?limit=${PAGE_SIZE}&before=25`);
  assert.equal(m.last.error, null);
  assert.equal(m.last.entries.length, 40);
});

test("a first load that fails can be retried from the newest page", async () => {
  const c = companion(5);
  c.status = 401;
  const m = make(c);
  await m.h.open();
  assert.match(m.last.error, /did not accept the token/);
  assert.deepEqual([m.last.loaded, m.last.entries.length], [false, 0]);
  c.status = 200;
  await m.h.more();
  assert.equal(c.calls.at(-1).url, `http://c.test/history?limit=${PAGE_SIZE}`);
  assert.deepEqual([m.last.error, m.last.entries.length], [null, 5]);
});

test("cannot reach the companion, a timeout and missing settings each give their own message", async () => {
  const net = companion(5, { error: new TypeError("fetch failed") });
  let m = make(net);
  await m.h.open();
  assert.equal(m.last.error, "Cannot reach the companion.");
  const slow = companion(5, { error: Object.assign(new Error("aborted"), { name: "AbortError" }) });
  m = make(slow);
  await m.h.open();
  assert.match(m.last.error, /did not answer within 5 seconds/);
  m = make(companion(5), { base: "", token: "" });
  await m.h.open();
  assert.equal(m.last.error, "Set the companion URL and token in the extension options.");
  m = make(companion(5), null);
  await m.h.open();
  assert.match(m.last.error, /extension options/);
});

test("an answer that is not a history page is an error, not a crash", async () => {
  const m = make({ calls: [], fetch: async () => ({ status: 200, json: async () => ({ nope: 1 }) }) });
  await m.h.open();
  assert.match(m.last.error, /Could not load the history/);
  const m2 = make({ fetch: async () => ({ status: 500, json: async () => { throw new Error("not json"); } }) });
  await m2.h.open();
  assert.match(m2.last.error, /Could not load the history \(error 500\)/);
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

test("panel.html: a History link between Clear history and Options, a view with a Back button, and panel.js wires them", () => {
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const links = [...html.match(/<div class="links">([\s\S]*?)<\/div>/)[1].matchAll(/<a id="(\w+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [["clear", "Clear history"], ["historylink", "History"], ["options", "Options"]]);
  assert.match(html, /<button id="historyback" type="button">[^<]*Back<\/button>/);
  assert.match(html, /<button id="historymore" type="button" hidden>/);
  const ids = [...html.matchAll(/\bid="(\w+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of [...js.matchAll(/\$\("(\w+)"\)/g)].map((m) => m[1])) assert.ok(ids.includes(id), `panel.js uses #${id}, which panel.html lacks`);
  assert.match(js, /\$\("historylink"\)\.addEventListener\("click"/);
  assert.match(js, /\$\("historyback"\)\.addEventListener\("click"/);
  assert.match(js, /\$\("historymore"\)\.addEventListener\("click"/);
  assert.match(css, /body\.history-open #page, body\.history-open #ask \{ display: none; \}/);
  assert.ok(!/<script[^>]*>[^<]/.test(html), "no inline script");
});
