// The pin button ("Summarize this page"): the controller flow with a fake tabs API, and the manifest and panel wiring.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerBackground, slotKey } from "../lib/background-core.js";
import { MODE_IDS } from "../lib/modes.js";
import { rig, slot } from "./rig.mjs";

const posts = (r) => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("the pin summarizes the active tab's page with the selected mode: a per-window slot, a requestId, a normal job", async () => {
  const r = rig({ mode: "claude-dive", tab: { id: 4, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s" } });
  await r.c.init(1);
  assert.deepEqual(posts(r), [], "nothing is sent before the click");
  assert.equal(await r.c.summarizePage(), true);
  const s = r.store[slotKey(1)];
  assert.equal(s.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "the address is handed over as it is; the companion normalizes it, as for a right-click");
  assert.equal(s.windowId, 1);
  assert.equal(s.consumed, true, "acknowledged once the companion made the job");
  assert.equal(s.jobId, "job1");
  assert.equal(s.mode, "claude-dive");
  const p = posts(r);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { url: s.url, mode: "claude-dive", requestId: s.requestId, force: false });
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dive");
  assert.equal(r.state.last.saved, true, "it is in the history log like any other Dip or Dive");
  assert.equal(r.state.last.mode, "claude-dive");
});

test("the slot is the one a right-click makes (same fields, same writer), plus the mode this panel had selected", async () => {
  // the background worker's own click handler, with a minimal chrome
  const store = {};
  const L = { clicked: [] };
  registerBackground({
    runtime: { lastError: undefined, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: { get: async () => ({ ...store }), set: async (o) => { Object.assign(store, o); }, remove: async () => {} }, onChanged: { addListener() {} } },
    contextMenus: { create() {}, update() {}, onClicked: { addListener: (f) => L.clicked.push(f) } },
    sidePanel: { open() {}, setPanelBehavior() {} },
  }, () => "req-bg");
  L.clicked[0]({ pageUrl: "https://v.test/page" }, { windowId: 1 });
  await new Promise((res) => setTimeout(res, 5));
  const fromMenu = store[slotKey(1)];
  const r = rig({ mode: "codex-dive", tab: { url: "https://v.test/page" } });
  await r.c.init(1);
  await r.c.summarizePage();
  const fromPin = r.store[slotKey(1)];
  const shape = (o) => Object.keys(o).filter((k) => !["jobId", "mode", "pendingMode"].includes(k)).sort();
  assert.deepEqual(shape(fromPin), shape(fromMenu));
  assert.equal(fromPin.url, fromMenu.url);
  assert.equal(typeof fromPin.requestId, "string");
  assert.equal(fromPin.mode, "codex-dive");
});

test("the permission is asked first, before the tab is read, and on every click until it is held", async () => {
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/a" }, tabsGrant: false });
  await r.c.init(1);
  const done = r.c.summarizePage();
  assert.deepEqual(r.log.order, ["ask"], "the request is the first thing the click does, synchronously (Chrome needs the user gesture)");
  assert.equal(await done, false);
  assert.deepEqual(r.log.order, ["ask"], "refused: the tab was never read");
  assert.deepEqual(posts(r), []);
  assert.equal(slotKey(1) in r.store, false, "no slot written");
  assert.match(r.state.last.error, /needs to read its address/);
  assert.match(r.state.last.error, /choose Allow/);
  assert.equal(r.state.last.busy, false);
});

test("a refusal is not remembered: the next click asks again and, once allowed, summarizes", async () => {
  let allow = false;
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/a" }, tabsGrant: () => allow });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  allow = true;
  assert.equal(await r.c.summarizePage(), true);
  assert.equal(r.log.tabAsks, 2);
  assert.equal(r.state.last.error, null, "the message is cleared by the next try");
  assert.equal(posts(r).length, 1);
});

test("a permission request that throws counts as refused", async () => {
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/a" }, tabsGrant: () => { throw new Error("no gesture"); } });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.deepEqual(posts(r), []);
  assert.match(r.state.last.error, /needs to read its address/);
});

test("a page that is not http or https gets one short message and nothing is sent or changed", async () => {
  for (const url of ["chrome://newtab/", "chrome://extensions", "chrome-extension://abc/history.html", "about:blank", "file:///etc/passwd", "view-source:https://a.test/", "data:text/html,hi", "ftp://a.test/x", "javascript:alert(1)", undefined, ""]) {
    const r = rig({ slot: slot({ consumed: true, jobId: "job9", mode: "claude-dip" }), mode: "claude-dip", tab: { url }, jobs: { job9: { state: "done", mode: "claude-dip", url: "https://v.test/watch", polls: 5, logged: true, saved: true } } });
    await r.c.init(1);
    const before = { ...r.store[slotKey(1)] };
    const n = r.log.fetches.length;
    assert.equal(await r.c.summarizePage(), false, String(url));
    assert.equal(r.state.last.error, "This page cannot be summarized. Open a web page (an http or https address) and try again.", String(url));
    assert.equal(r.log.fetches.length, n, `no request for ${url}`);
    assert.deepEqual(r.store[slotKey(1)], before, `slot untouched for ${url}`);
    assert.equal(r.state.last.result, "Summary for claude-dip", "the summary on screen stays");
  }
});

test("no tab in the window gets its own message", async () => {
  const r = rig({ mode: "claude-dip", tab: null });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.equal(r.state.last.error, "No page is open in this window.");
  assert.deepEqual(posts(r), []);
});

test("it reads the tab of this panel's own window and writes that window's slot", async () => {
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/win7" } });
  await r.c.init(7);
  await r.c.summarizePage();
  assert.deepEqual(r.log.tabQueries, [7]);
  assert.equal(r.store[slotKey(7)].url, "https://v.test/win7");
  assert.equal(slotKey(1) in r.store, false);
});

test("it is an action: no mode, stored setting or pressed state changes; another summary of the same page is a fresh job", async () => {
  const r = rig({ mode: "claude-dive", tab: { url: "https://v.test/same" } });
  await r.c.init(1);
  const states = [];
  const orig = r.c.d.onState;
  r.c.d.onState = (st) => { states.push(st.mode); orig(st); };
  await r.c.summarizePage(); await r.tick(); await r.tick();
  assert.equal(r.store.mode, "claude-dive");
  assert.ok(states.every((m) => m === "claude-dive"));
  await r.c.summarizePage();
  const [a, b] = posts(r);
  assert.notEqual(a.body.requestId, b.body.requestId);
  assert.equal(b.body.force, false);
});

test("with Codex unavailable the pin summarizes with Claude Dip, like a right-click would", async () => {
  const r = rig({ mode: "codex-dive", tab: { url: "https://v.test/x" }, health: { codex_ready: false, codex_logged_in: false } });
  await r.c.init(1);
  await r.c.summarizePage();
  assert.equal(posts(r)[0].body.mode, "claude-dip");
});

test("not set up: the same message as the URL field, and the permission is not even asked", async () => {
  const r = rig({ cfg: {}, tab: { url: "https://v.test/x" } });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.match(r.state.last.error, /Set the companion URL and token/);
  assert.equal(r.log.tabAsks, 0);
});

test("the old temp mode in storage: the pin summarizes with the default mode, not with a mode that no longer exists", async () => {
  const r = rig({ mode: "temp", tab: { url: "https://v.test/x" } });
  await r.c.init(1);
  await r.c.summarizePage();
  assert.equal(posts(r)[0].body.mode, "codex-dip");
  assert.ok(MODE_IDS.includes(posts(r)[0].body.mode));
});

test("wiring: the panel asks for the optional tabs permission inside the click and reads the active tab of its window", () => {
  const js = read("panel.js");
  assert.match(js, /requestAccess: \(\) => chrome\.permissions\.request\(\{ permissions: \["tabs"\] \}\)/);
  assert.match(js, /chrome\.tabs\.query\(\{ active: true, windowId \}\)/);
  // the click handler calls the controller directly: no await before it, so the request is made inside the user gesture
  assert.match(js, /pin\.addEventListener\("click", \(\) => \{ ctl\.summarizePage\(\); \}\)/);
  const c = read("lib/controller.js");
  const body = c.slice(c.indexOf("async summarizePage()"), c.indexOf("onStorageChange(changes, area)"));
  assert.ok(body.indexOf("tabs.requestAccess()") < body.indexOf("tabs.activeTab("), "permission first");
  const beforeRequest = body.slice(0, body.indexOf("await tabs.requestAccess()"));
  assert.ok(!/\bawait\b/.test(beforeRequest), "nothing is awaited before the permission request");
});

test("manifest: tabs is optional only (asking later does not disable installed copies), and no host access was added", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.deepEqual(m.optional_permissions, ["tabs"]);
  assert.ok(!(m.permissions || []).includes("tabs"));
  assert.equal(m.host_permissions, undefined);
  assert.ok(!(m.optional_host_permissions || []).some((h) => /youtube|\*:\/\/\*|<all_urls>|https:\/\/\*\/\*/.test(h)));
});
