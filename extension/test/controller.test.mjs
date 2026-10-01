import test from "node:test";
import assert from "node:assert/strict";
import { Controller, describeError } from "../lib/controller.js";
import { slotKey } from "../lib/background-core.js";

// A fake companion plus fake chrome pieces. Timers are manual so polling is deterministic.
function rig({ cfg = { base: "http://c.test", token: "t".repeat(40) }, mode, slot, jobs = {} } = {}) {
  const store = { ...cfg, ...(mode ? { mode } : {}), ...(slot ? { [slotKey(1)]: slot } : {}) };
  const log = { fetches: [], tabs: [], clip: [], order: [] };
  const timers = [];
  const state = { last: null };
  const holds = []; // pending fetch resolvers for race tests
  let jobSeq = 0;
  const server = { jobs, clearGen: 0, hold: null, fail: null, sources: {} };
  const fetchImpl = async (url, init) => {
    const path = url.replace("http://c.test", "");
    const body = init.body ? JSON.parse(init.body) : null;
    log.fetches.push({ method: init.method, path, body, auth: init.headers.Authorization });
    if (server.fail) throw server.fail;
    const respond = (status, json) => ({ status, json: async () => json });
    const go = () => {
      if (init.method === "POST" && path === "/jobs") {
        const id = `job${++jobSeq}`;
        server.jobs[id] = { state: "queued", mode: body.mode, url: body.url, polls: 0 };
        return respond(202, { job_id: id, clear_generation: server.clearGen });
      }
      if (init.method === "POST" && path === "/clear") { server.clearGen++; return respond(200, { clear_generation: server.clearGen }); }
      let m;
      if ((m = path.match(/^\/jobs\/(.+)$/))) {
        const j = server.jobs[m[1]];
        if (!j) return respond(404, { error_code: "no_such_job" });
        j.polls++;
        const done = j.polls >= 2;
        return respond(200, { job_id: m[1], state: done ? (j.fail ? "error" : "done") : "summarizing", title: "A Title", url: j.url, mode: j.mode,
          result_markdown: done && !j.fail ? `Summary for ${j.mode}` : null, error_code: done && j.fail ? j.fail : null, error_message: null, clear_generation: server.clearGen });
      }
      if ((m = path.match(/^\/source\?job=(.+)$/))) return respond(200, { title: "A Title", url: "https://v.test/x", text: server.sourceText || "source body", clear_generation: server.clearGen });
      return respond(404, {});
    };
    if (server.hold && server.hold(path, body)) {
      return new Promise((res) => holds.push(() => res(go())));
    }
    return go();
  };
  const c = new Controller({
    storage: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
               set: async (o) => { Object.assign(store, o); } },
    fetch: fetchImpl,
    clipboard: { writeText: async (t) => { if (server.clipFail) throw new Error("denied"); log.order.push("clip"); log.clip.push(t); } },
    openTab: (u) => { log.order.push("tab"); log.tabs.push(u); },
    uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(),
    setTimer: (f) => { timers.push(f); return timers.length; },
    clearTimer: () => {},
    onState: (s) => { state.last = s; },
  });
  const tick = async () => { const f = timers.shift(); if (f) await f(); };
  return { c, store, log, server, state, tick, timers, holds };
}
const slot = (extra = {}) => ({ url: "https://v.test/watch", requestId: "slot-req-1", windowId: 1, ts: 1, consumed: false, ...extra });

test("an unconsumed slot is submitted with the slot requestId as the idempotency key, then acknowledged in the slot", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1);
  assert.deepEqual(r.log.fetches[0], { method: "POST", path: "/jobs", body: { url: "https://v.test/watch", mode: "claude-dip", requestId: "slot-req-1", force: false }, auth: "Bearer " + "t".repeat(40) });
  assert.equal(r.store[slotKey(1)].jobId, "job1");
  assert.equal(r.store[slotKey(1)].consumed, true);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.busy, false);
});

test("default mode is Codex Dip", async () => {
  const r = rig({ slot: slot() });
  await r.c.init(1);
  assert.equal(r.log.fetches[0].body.mode, "codex-dip");
});

test("pressing a different button submits that mode with a fresh requestId; pressing the pressed one forces a rerun", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1);
  await r.tick();
  await r.c.selectMode("claude-dive");
  const posts = () => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  const b = posts().at(-1).body;
  assert.equal(b.mode, "claude-dive"); assert.equal(b.force, false); assert.notEqual(b.requestId, "slot-req-1");
  assert.equal(r.store.mode, "claude-dive");
  await r.c.selectMode("claude-dive");
  assert.equal(posts().at(-1).body.force, true);
});

test("a stale response (older selection) is discarded", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1);
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-dip";
  const first = r.c.selectMode("claude-dip");  // held
  await new Promise((x) => setTimeout(x, 0));
  r.server.hold = null;
  await r.c.selectMode("claude-dive");           // newer selection completes
  r.holds.forEach((h) => h());                   // the old response now arrives
  await first;
  await r.tick();
  assert.equal(r.state.last.mode, "claude-dive");
  assert.ok(!r.state.last.result || r.state.last.result.includes("claude-dive"));
  assert.equal(r.store[slotKey(1)].jobId, "job2", "old response did not overwrite the slot");
});

test("an older companion clear generation is discarded, a newer one is adopted", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1);
  assert.equal(r.c.clearGen, 0);
  r.c.clearGen = 5;
  assert.equal(r.c.accept(r.c.selGen, { clear_generation: 4 }), false);
  assert.equal(r.c.accept(r.c.selGen, { clear_generation: 6 }), true);
  assert.equal(r.c.clearGen, 6);
});

test("Temp chat: source-only job, then copy writes the clipboard BEFORE opening the tab", async () => {
  const r = rig({ slot: slot(), mode: "temp" });
  await r.c.init(1);
  assert.equal(r.log.fetches[0].body.mode, "source");
  await r.tick();
  assert.equal(r.state.last.tempReady, true);
  assert.equal(r.state.last.result, null, "no summary is shown for Temp chat");
  assert.equal(await r.c.copyAndOpen(), true);
  assert.deepEqual(r.log.order, ["clip", "tab"]);
  assert.match(r.log.clip[0], /^You are summarizing a source/);
  assert.ok(r.log.clip[0].includes("<source>\nsource body\n</source>"));
  assert.ok(r.log.clip[0].includes("wait for my follow-up questions"));
  assert.equal(r.log.tabs[0], "https://chatgpt.com/?temporary-chat=true");
  assert.match(r.state.last.tempNote, /Copied\. Press Cmd\/Ctrl\+V then Enter\./);
});

test("Temp chat: a failed clipboard write opens no tab and leaves the button for another try", async () => {
  const r = rig({ slot: slot(), mode: "temp" });
  await r.c.init(1); await r.tick();
  r.server.clipFail = true;
  assert.equal(await r.c.copyAndOpen(), false);
  assert.deepEqual(r.log.tabs, []);
  assert.equal(r.state.last.tempReady, true);
  r.server.clipFail = false;
  assert.equal(await r.c.copyAndOpen(), true);
});

test("Temp chat warns above 100,000 characters", async () => {
  const r = rig({ slot: slot(), mode: "temp" });
  r.server.sourceText = "x".repeat(100001);
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.tempWarn, true);
});

test("unreachable companion gives a clear error naming the iMac, no endless polling", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  r.server.fail = Object.assign(new Error("x"), { name: "TypeError" });
  await r.c.init(1);
  assert.match(r.state.last.error, /Cannot reach the companion\. Is the iMac on/);
  assert.equal(r.timers.length, 0);
});

test("a timeout (AbortError) is reported within the 5 s fetch deadline", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  r.server.fail = Object.assign(new Error("aborted"), { name: "AbortError" });
  await r.c.init(1);
  assert.ok(r.state.last.error);
});

test("a job error code becomes a plain message; no summary is invented", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1);
  r.server.jobs.job1.fail = "no_captions";
  await r.tick();
  assert.match(r.state.last.error, /no usable captions/);
  assert.equal(r.state.last.result, null);
  assert.equal(describeError("auth", "claude: Not logged in"), "claude: Not logged in Sign in again on the iMac.");
});

test("reopening the panel resumes a consumed slot without resubmitting", async () => {
  const r = rig({ slot: slot({ consumed: true, jobId: "job9", mode: "claude-dive" }), mode: "codex-dip", jobs: { job9: { state: "queued", mode: "claude-dive", url: "https://v.test/watch", polls: 1 } } });
  await r.c.init(1);
  assert.ok(!r.log.fetches.some((f) => f.method === "POST"));
  assert.equal(r.state.last.mode, "claude-dive");
  assert.equal(r.state.last.result, "Summary for claude-dive");
});

test("a new slot (right-click while the panel is open) is submitted; our own acknowledgement write is not", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1);
  const posts = () => r.log.fetches.filter((f) => f.method === "POST").length;
  assert.equal(posts(), 1);
  r.c.onStorageChange({ [slotKey(1)]: { newValue: r.store[slotKey(1)] } }, "local");
  assert.equal(posts(), 1);
  r.c.onStorageChange({ [slotKey(1)]: { newValue: slot({ requestId: "slot-req-2", url: "https://other.test/" }) } }, "local");
  await new Promise((x) => setTimeout(x, 0));
  assert.equal(posts(), 2);
  assert.equal(r.log.fetches.filter((f) => f.method === "POST")[1].body.requestId, "slot-req-2");
});

test("unconfigured extension says where to set it up and makes no request", async () => {
  const r = rig({ cfg: {}, slot: slot() });
  await r.c.init(1);
  assert.equal(r.log.fetches.length, 0);
  assert.match(r.state.last.status, /options/);
});

test("clear history calls /clear and resets the view", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1); await r.tick();
  await r.c.clearHistory();
  assert.equal(r.log.fetches.at(-1).path, "/clear");
  assert.equal(r.state.last.result, null);
  assert.equal(r.c.clearGen, 1);
});
