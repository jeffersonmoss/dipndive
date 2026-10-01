import test from "node:test";
import assert from "node:assert/strict";
import { Controller, describeError } from "../lib/controller.js";
import { slotKey } from "../lib/background-core.js";

// A fake companion plus fake chrome pieces. Timers are manual so polling is deterministic.
function rig({ cfg = { base: "http://c.test", token: "t".repeat(40) }, mode, slot, jobs = {}, shared, health } = {}) {
  const store = shared || { ...cfg, ...(mode ? { mode } : {}), ...(slot ? { [slotKey(1)]: slot } : {}) };
  const log = { fetches: [], tabs: [], clip: [], order: [] };
  const timers = [];
  const state = { last: null };
  const holds = []; // pending fetch resolvers for race tests
  let jobSeq = 0;
  const server = { jobs, clearGen: 0, hold: null, fail: null, sources: {}, health: health || { state: "starting" }, conflictOnce: false };
  const fetchImpl = async (url, init) => {
    const path = url.replace("http://c.test", "");
    const body = init.body ? JSON.parse(init.body) : null;
    log.fetches.push({ method: init.method, path, body, auth: init.headers.Authorization });
    if (server.fail) throw server.fail;
    const respond = (status, json) => ({ status, json: async () => json });
    const go = () => {
      if (path === "/health") return respond(200, server.health);
      if (init.method === "POST" && path === "/jobs") {
        if (server.conflictOnce) { server.conflictOnce = false; return respond(409, { error_code: "request_id_conflict" }); }
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
    storage: { get: async (keys) => keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
               set: async (o) => { Object.assign(store, o); },
               remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; } },
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
  assert.deepEqual(r.log.fetches.find((f) => f.method === "POST"), { method: "POST", path: "/jobs", body: { url: "https://v.test/watch", mode: "claude-dip", requestId: "slot-req-1", force: false }, auth: "Bearer " + "t".repeat(40) });
  assert.equal(r.store[slotKey(1)].jobId, "job1");
  assert.equal(r.store[slotKey(1)].consumed, true);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.busy, false);
});

test("default mode is Codex Dip", async () => {
  const r = rig({ slot: slot() });
  await r.c.init(1);
  assert.equal(r.log.fetches.find((f) => f.method === "POST").body.mode, "codex-dip");
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
  assert.equal(r.log.fetches.find((f) => f.method === "POST").body.mode, "source");
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

const wins = (store) => (w) => ({ ...store });

test("a mode change in another window does not change this panel's pressed button or trigger force", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot(), [slotKey(2)]: slot({ requestId: "other", windowId: 2 }) };
  const A = rig({ shared });
  const B = rig({ shared });
  B.c.windowId = 2;
  await A.c.init(1); await A.tick();
  B.c.windowId = 2;
  await B.c.init(2); await B.tick();
  await A.c.selectMode("claude-dive");   // window A switches; storage.mode changes
  B.c.onStorageChange({ mode: { newValue: "claude-dive" } }, "local");
  assert.equal(B.state.last.mode, "claude-dip", "B keeps its own pressed button");
  assert.match(B.state.last.result, /claude-dip/);
  await B.c.selectMode("claude-dive");
  const post = B.log.fetches.filter((f) => f.method === "POST").at(-1).body;
  assert.equal(post.mode, "claude-dive");
  assert.equal(post.force, false, "first Dive in B is not a forced rerun");
  await B.c.selectMode("claude-dive");
  assert.equal(B.log.fetches.filter((f) => f.method === "POST").at(-1).body.force, true, "own pressed button forces");
});

test("after a restart the newest slot is restored into this window and the old key is dropped", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip",
    "slot:5": slot({ url: "https://old.test/", requestId: "o", windowId: 5, ts: 10, consumed: true, jobId: "job1", mode: "claude-dip" }),
    "slot:6": slot({ url: "https://new.test/", requestId: "n", windowId: 6, ts: 20, consumed: true, jobId: "job1", mode: "claude-dip" }) };
  const r = rig({ shared, jobs: { job1: { state: "queued", mode: "claude-dip", url: "https://new.test/", polls: 1 } } });
  await r.c.init(1);
  assert.equal(shared[slotKey(1)].url, "https://new.test/");
  assert.equal(shared[slotKey(1)].windowId, 1);
  assert.ok(!("slot:6" in shared));
  assert.equal(r.state.last.source.url, "https://new.test/");
  assert.ok(!r.log.fetches.some((f) => f.method === "POST"), "restored, not resubmitted");
});

test("only the newest 20 slots are kept", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40) };
  for (let i = 0; i < 30; i++) shared[`slot:${100 + i}`] = slot({ requestId: `r${i}`, windowId: 100 + i, ts: i, consumed: true, jobId: "x" });
  const r = rig({ shared, jobs: {} });
  await r.c.init(1);
  const keys = Object.keys(shared).filter((k) => k.startsWith("slot:"));
  assert.ok(keys.length <= 20, String(keys.length));
  assert.ok(!keys.includes("slot:100") && (keys.includes("slot:129") || keys.includes("slot:1")));
});

test("Clear history removes every slot key", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot(), "slot:9": slot({ requestId: "z", windowId: 9, ts: 5 }) };
  const r = rig({ shared });
  await r.c.init(1); await r.tick();
  await r.c.clearHistory();
  assert.deepEqual(Object.keys(shared).filter((k) => k.startsWith("slot:")), []);
});

test("a 409 requestId conflict is retried once with a fresh requestId", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  r.server.conflictOnce = true;
  await r.c.init(1);
  const posts = r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.requestId, "slot-req-1");
  assert.notEqual(posts[1].body.requestId, "slot-req-1");
  assert.equal(r.state.last.error, null);
});

test("an unacknowledged slot resubmits with the mode it was first sent with", async () => {
  const r = rig({ slot: slot({ pendingMode: "claude-dive" }), mode: "codex-dip" });
  await r.c.init(1);
  const b = r.log.fetches.find((f) => f.method === "POST").body;
  assert.equal(b.mode, "claude-dive");
  assert.equal(b.requestId, "slot-req-1");
});

test("Codex unavailable: Claude Dip is the effective default, Codex buttons refuse presses; ready: Codex Dip is the default", async () => {
  const off = rig({ slot: slot(), health: { codex_ready: false, codex_logged_in: false } });
  await off.c.init(1);
  assert.equal(off.log.fetches.find((f) => f.method === "POST").body.mode, "claude-dip");
  assert.equal(off.state.last.codexOk, false);
  assert.match(off.state.last.codexReason, /not signed in/);
  const posts = off.log.fetches.filter((f) => f.method === "POST").length;
  await off.c.selectMode("codex-dive");
  assert.equal(off.log.fetches.filter((f) => f.method === "POST").length, posts);
  assert.equal(off.store.mode, undefined, "the stored preference is untouched");
  const iso = rig({ slot: slot(), health: { codex_ready: false, codex_logged_in: true, codex_isolation_ok: false } });
  await iso.c.init(1);
  assert.match(iso.state.last.codexReason, /isolation is not verified/);
  const on = rig({ slot: slot(), health: { codex_ready: true, codex_logged_in: true } });
  await on.c.init(1);
  assert.equal(on.log.fetches.find((f) => f.method === "POST").body.mode, "codex-dip");
  assert.equal(on.state.last.codexOk, true);
});

test("health unknown (starting or unreachable) leaves Codex enabled", async () => {
  const r = rig({ slot: slot() });
  await r.c.init(1);
  assert.equal(r.state.last.codexOk, null);
  assert.equal(r.log.fetches.find((f) => f.method === "POST").body.mode, "codex-dip");
});
