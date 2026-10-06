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
  const r = rig({ mode: "claude-dip", tab: { id: 4, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s" } });
  await r.c.init(1);
  assert.deepEqual(posts(r), [], "nothing is sent before the click");
  assert.equal(await r.c.summarizePage(), true);
  const s = r.store[slotKey(1)];
  assert.equal(s.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "the address is handed over as it is; the companion normalizes it, as for a right-click");
  assert.equal(s.windowId, 1);
  assert.equal(s.consumed, true, "acknowledged once the companion made the job");
  assert.equal(s.jobId, "job1");
  assert.equal(s.mode, "claude-dip");
  const p = posts(r);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { url: s.url, mode: "claude-dip", requestId: s.requestId, force: false });
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.saved, true, "it is in the history log like any other Dip or Dive");
  assert.equal(r.state.last.mode, "claude-dip");
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
  const r = rig({ mode: "codex-dip", tab: { url: "https://v.test/page" } });
  await r.c.init(1);
  await r.c.summarizePage();
  const fromPin = r.store[slotKey(1)];
  const shape = (o) => Object.keys(o).filter((k) => !["jobId", "mode", "pendingMode"].includes(k)).sort();
  assert.deepEqual(shape(fromPin), shape(fromMenu));
  assert.equal(fromPin.url, fromMenu.url);
  assert.equal(typeof fromPin.requestId, "string");
  assert.equal(fromPin.mode, "codex-dip");
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
  assert.match(r.state.last.pinError, /needs to read its address/);
  assert.match(r.state.last.pinError, /choose Allow/);
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
  assert.equal(r.state.last.pinError, null, "the message is cleared by the next try");
  assert.equal(posts(r).length, 1);
});

test("a permission request that throws counts as refused", async () => {
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/a" }, tabsGrant: () => { throw new Error("no gesture"); } });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.deepEqual(posts(r), []);
  assert.match(r.state.last.pinError, /needs to read its address/);
});

test("a page that is not http or https gets one short message and nothing is sent or changed", async () => {
  for (const url of ["chrome://newtab/", "chrome://extensions", "chrome-extension://abc/history.html", "about:blank", "file:///etc/passwd", "view-source:https://a.test/", "data:text/html,hi", "ftp://a.test/x", "javascript:alert(1)", undefined, ""]) {
    const r = rig({ slot: slot({ consumed: true, jobId: "job9", mode: "claude-dip" }), mode: "claude-dip", tab: { url }, jobs: { job9: { state: "done", mode: "claude-dip", url: "https://v.test/watch", polls: 5, logged: true, saved: true } } });
    await r.c.init(1);
    const before = { ...r.store[slotKey(1)] };
    const n = r.log.fetches.length;
    assert.equal(await r.c.summarizePage(), false, String(url));
    assert.equal(r.state.last.pinError, "This page cannot be summarized. Open a web page (an http or https address) and try again.", String(url));
    assert.equal(r.log.fetches.length, n, `no request for ${url}`);
    assert.deepEqual(r.store[slotKey(1)], before, `slot untouched for ${url}`);
    assert.equal(r.state.last.result, "Summary for claude-dip", "the summary on screen stays");
  }
});

test("no tab in the window gets its own message", async () => {
  const r = rig({ mode: "claude-dip", tab: null });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.equal(r.state.last.pinError, "No page is open in this window.");
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
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/same" } });
  await r.c.init(1);
  const states = [];
  const orig = r.c.d.onState;
  r.c.d.onState = (st) => { states.push(st.mode); orig(st); };
  await r.c.summarizePage(); await r.tick(); await r.tick();
  assert.equal(r.store.mode, "claude-dip");
  assert.ok(states.every((m) => m === "claude-dip"));
  await r.c.summarizePage();
  const [a, b] = posts(r);
  assert.notEqual(a.body.requestId, b.body.requestId);
  assert.equal(b.body.force, false);
});

test("with Codex unavailable the pin summarizes with Claude Dip, like a right-click would", async () => {
  const r = rig({ mode: "codex-dip", tab: { url: "https://v.test/x" }, health: { codex_ready: false, codex_logged_in: false } });
  await r.c.init(1);
  await r.c.summarizePage();
  assert.equal(posts(r)[0].body.mode, "claude-dip");
});

test("not set up: the same message as the URL field, and the permission is not even asked", async () => {
  const r = rig({ cfg: {}, tab: { url: "https://v.test/x" } });
  await r.c.init(1);
  assert.equal(await r.c.summarizePage(), false);
  assert.match(r.state.last.pinError, /Set the companion URL and token/);
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
  const beforeRequest = body.slice(0, body.indexOf("tabs.requestAccess()"));
  assert.ok(!/\bawait\b/.test(beforeRequest), "nothing is awaited before the permission request");
});

test("manifest: tabs is optional only (asking later does not disable installed copies), and no host access was added", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.deepEqual(m.optional_permissions, ["tabs"]);
  assert.ok(!(m.permissions || []).includes("tabs"));
  assert.equal(m.host_permissions, undefined);
  assert.ok(!(m.optional_host_permissions || []).some((h) => /youtube|\*:\/\/\*|<all_urls>|https:\/\/\*\/\*/.test(h)));
});

// ---- review fixes: a pending pin, a fresh panel's mode, and a pin message next to a running job ----
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const nextTick = () => new Promise((res) => setTimeout(res, 0));

test("a pin still waiting for its permission does not override a newer typed link", async () => {
  const d = deferred();
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/from-pin" }, tabsGrant: () => d.promise });
  await r.c.init(1);
  const pin = r.c.summarizePage();
  assert.deepEqual(r.log.order, ["ask"], "the permission request is still the first thing");
  assert.equal(await r.c.submitTyped("https://typed.test/newer"), true);
  d.resolve(true);
  assert.equal(await pin, false, "the old pin is dropped");
  assert.deepEqual(posts(r).map((p) => p.body.url), ["https://typed.test/newer"]);
  assert.equal(r.state.last.source.url, "https://typed.test/newer");
  assert.equal(r.store[slotKey(1)].url, "https://typed.test/newer");
  assert.deepEqual(r.log.order, ["ask"], "the tab was never read for the stale pin");
});

test("a pin still waiting does not override a newer mode button press (a mode-driven rerun)", async () => {
  const d = deferred();
  const r = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/from-pin" }, tabsGrant: () => d.promise });
  await r.c.init(1);
  const pin = r.c.summarizePage();
  await r.c.selectMode("claude-dip");
  d.resolve(true);
  assert.equal(await pin, false);
  assert.deepEqual(posts(r).map((p) => [p.body.url, p.body.mode]), [["https://v.test/watch", "claude-dip"], ["https://v.test/watch", "claude-dip"]]);
  assert.equal(r.state.last.source.url, "https://v.test/watch");
});

test("a pin still waiting does not survive Clear history (another window's, this panel's own, or a stale refusal)", async () => {
  // another window cleared: the storage event the panel hears
  let d = deferred();
  let r = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/from-pin" }, tabsGrant: () => d.promise });
  await r.c.init(1); await r.tick();
  const n = posts(r).length;
  let pin = r.c.summarizePage();
  r.c.onStorageChange({ clearGen: { newValue: r.c.clearGen + 1 } }, "local");
  d.resolve(true);
  assert.equal(await pin, false);
  assert.equal(posts(r).length, n, "nothing was recreated after the clear");
  assert.equal(r.state.last.result, null);
  // this panel's own Clear history
  d = deferred();
  r = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/from-pin" }, tabsGrant: () => d.promise });
  await r.c.init(1); await r.tick();
  const m = posts(r).length;
  pin = r.c.summarizePage();
  await r.c.clearHistory();
  d.resolve(true);
  assert.equal(await pin, false);
  assert.equal(posts(r).length, m);
  // the clear generation moving on without an event reaching the panel (heard from a companion answer)
  d = deferred();
  r = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/from-pin" }, tabsGrant: () => d.promise });
  await r.c.init(1); await r.tick();
  const k = posts(r).length;
  pin = r.c.summarizePage();
  r.c.clearGen = 7;
  d.resolve(true);
  assert.equal(await pin, false);
  assert.equal(posts(r).length, k);
});

test("two pins in a row: only the newest one goes on, and a refusal of the older one says nothing", async () => {
  const first = deferred(), second = deferred();
  const queue = [first, second];
  const r = rig({ mode: "claude-dip", tab: { url: "https://v.test/p" }, tabsGrant: () => queue.shift().promise });
  await r.c.init(1);
  const a = r.c.summarizePage();
  const b = r.c.summarizePage();
  first.resolve(false);   // the older prompt is refused
  assert.equal(await a, false);
  assert.equal(r.state.last.pinError, null, "a dropped pin shows no message");
  second.resolve(true);
  assert.equal(await b, true);
  assert.equal(posts(r).length, 1);
});

test("a polling job does not make a pin stale: the pin that waited during a running job still goes on", async () => {
  const d = deferred();
  const r = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/other" }, tabsGrant: () => d.promise });
  await r.c.init(1);
  const pin = r.c.summarizePage();
  await r.tick();       // the running job's poll goes on meanwhile
  d.resolve(true);
  assert.equal(await pin, true);
  assert.equal(posts(r).at(-1).body.url, "https://v.test/other");
});

test("choosing a mode on a fresh panel with no source is kept, moves the pressed mode, sends nothing, and the pin then uses it", async () => {
  const r = rig({ tab: { url: "https://v.test/fresh" } });
  await r.c.init(1);
  assert.equal(r.state.last.mode, "codex-dip");
  await r.c.selectMode("claude-dip");
  assert.equal(r.state.last.mode, "claude-dip", "the pressed look moves");
  assert.equal(r.store.mode, "claude-dip", "and the choice is stored, so a right-click uses it too");
  assert.deepEqual(posts(r), [], "no source, nothing submitted");
  assert.equal(r.state.last.busy, false);
  await r.c.summarizePage();
  assert.equal(posts(r).length, 1);
  assert.equal(posts(r)[0].body.mode, "claude-dip");
  assert.equal(posts(r)[0].body.url, "https://v.test/fresh");
  // a disabled Codex button is still refused when Codex is unavailable
  const off = rig({ health: { codex_ready: false, codex_logged_in: false } });
  await off.c.init(1);
  await off.c.selectMode("codex-dip");
  assert.equal(off.store.mode, undefined);
});

test("a refused permission or a pin error leaves a running job's busy flag and status alone, on the pin's own line", async () => {
  for (const [name, opts, line] of [
    ["denied", { tabsGrant: false }, /needs to read its address/],
    ["browser page", { tab: { url: "chrome://newtab/" } }, /cannot be summarized/],
    ["no tab", { tab: null }, /No page is open/],
  ]) {
    const r = rig({ slot: slot(), mode: "claude-dip", ...opts });
    await r.c.init(1);                          // the job is running: busy, a status line
    const before = { busy: r.state.last.busy, status: r.state.last.status, error: r.state.last.error, jobId: r.state.last.jobId };
    assert.equal(before.busy, true, name);
    assert.ok(before.status, name);
    assert.equal(await r.c.summarizePage(), false, name);
    assert.match(r.state.last.pinError, line, name);
    assert.equal(r.state.last.busy, before.busy, `${name}: still busy`);
    assert.equal(r.state.last.status, before.status, `${name}: status untouched`);
    assert.equal(r.state.last.error, before.error, `${name}: the job's own error line untouched`);
    assert.equal(r.state.last.jobId, before.jobId);
    await r.tick();                             // the job goes on and finishes
    assert.equal(r.state.last.result, "Summary for claude-dip", name);
    assert.equal(r.state.last.busy, false, name);
  }
});

test("a pin message is cleared by the next submission of any kind, and a job's error does not use the pin's line", async () => {
  const r = rig({ mode: "claude-dip", tab: { url: "chrome://newtab/" } });
  await r.c.init(1);
  await r.c.summarizePage();
  assert.ok(r.state.last.pinError);
  assert.equal(await r.c.submitTyped("https://typed.test/x"), true);
  assert.equal(r.state.last.pinError, null);
  const j = rig({ slot: slot(), mode: "claude-dip", tab: { url: "https://v.test/x" } });
  j.server.postStatus = 429; j.server.postError = "queue_full";
  await j.c.init(1);
  assert.ok(j.state.last.error);
  assert.equal(j.state.last.pinError, null);
});

test("wiring: the pin's message has its own line in the panel, apart from the job's error line", () => {
  const h = read("panel.html"), js = read("panel.js");
  assert.match(h, /<div id="pinmsg" class="error" role="alert" hidden><\/div>/);
  assert.match(js, /\$\("pinmsg"\)\.hidden = !s\.pinError;/);
  assert.match(js, /\$\("pinmsg"\)\.textContent = s\.pinError \|\| "";/);
  assert.ok(h.indexOf('id="buttons"') < h.indexOf('id="pinmsg"') && h.indexOf('id="pinmsg"') < h.indexOf('id="error"'));
});
