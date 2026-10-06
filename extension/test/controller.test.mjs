import test from "node:test";
import assert from "node:assert/strict";
import { Controller, describeError } from "../lib/controller.js";
import { slotKey } from "../lib/background-core.js";
import { rig, slot } from "./rig.mjs";

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
  await r.c.selectMode("claude-dip");
  const posts = () => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  const b = posts().at(-1).body;
  assert.equal(b.mode, "claude-dip"); assert.equal(b.force, false); assert.notEqual(b.requestId, "slot-req-1");
  assert.equal(r.store.mode, "claude-dip");
  await r.c.selectMode("claude-dip");
  assert.equal(posts().at(-1).body.force, true);
});

test("a stale response (older selection) is discarded", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1);
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-dip";
  const first = r.c.selectMode("claude-dip");  // held
  await new Promise((x) => setTimeout(x, 0));
  r.server.hold = null;
  await r.c.selectMode("claude-dip");           // newer selection completes
  r.holds.forEach((h) => h());                   // the old response now arrives
  await first;
  await r.tick();
  assert.equal(r.state.last.mode, "claude-dip");
  assert.ok(!r.state.last.result || r.state.last.result.includes("claude-dip"));
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

test("an old install's stored mode \"temp\" falls back to the default mode, forgets the key, and the job is a normal Dip", async () => {
  const r = rig({ slot: slot(), mode: "temp" });
  await r.c.init(1);
  assert.equal(r.state.last.mode, "codex-dip");
  assert.equal("mode" in r.store, false, "the removed mode is not kept in storage");
  assert.equal(r.log.fetches.find((f) => f.method === "POST").body.mode, "codex-dip");
  await r.tick();
  assert.equal(r.state.last.result, "Summary for codex-dip");
});

test("a stored slot of the removed temp mode is not resumed or resubmitted: the page is shown and a mode is chosen", async () => {
  for (const extra of [{ consumed: true, jobId: "old-source-job", mode: "temp" }, { pendingMode: "temp" }]) {
    const r = rig({ slot: slot(extra), mode: "claude-dip" });
    await r.c.init(1);
    assert.deepEqual(r.log.fetches.filter((f) => f.path.startsWith("/jobs")), [], "no job is created or polled by itself");
    assert.equal(r.state.last.source.url, "https://v.test/watch");
    assert.equal(r.state.last.mode, "claude-dip");
    assert.match(r.state.last.status, /Choose a mode/);
    await r.c.selectMode("claude-dip");
    const post = r.log.fetches.find((f) => f.method === "POST" && f.path === "/jobs");
    assert.equal(post.body.mode, "claude-dip");
    assert.equal(post.body.force, false);
  }
});

test("a stored Dive mode migrates to its Dip: storage is rewritten, the panel and the first job use the Dip", async () => {
  for (const [stored, want] of [["claude-dive", "claude-dip"], ["codex-dive", "codex-dip"]]) {
    const r = rig({ slot: slot(), mode: stored });
    await r.c.init(1);
    assert.equal(r.store.mode, want, "the stored mode is rewritten, so every window and the menu agree");
    assert.equal(r.state.last.mode, want);
    assert.equal(r.log.fetches.find((f) => f.method === "POST").body.mode, want, "a dive mode is never sent");
    await r.tick();
    assert.equal(r.state.last.result, `Summary for ${want}`);
  }
});

test("a stored slot that names a Dive mode is migrated, not treated as legacy: pending resubmits as the Dip, a running job is resumed", async () => {
  const p = rig({ slot: slot({ pendingMode: "claude-dive" }), mode: "codex-dip" });
  await p.c.init(1);
  assert.equal(p.log.fetches.find((f) => f.method === "POST").body.mode, "claude-dip");
  assert.equal(p.state.last.mode, "claude-dip");
  assert.ok(!/Choose a mode/.test(p.state.last.status || ""));
  const c = rig({ slot: slot({ consumed: true, jobId: "job9", mode: "codex-dive" }), mode: "claude-dip", jobs: { job9: { state: "queued", mode: "codex-dive", url: "https://v.test/watch", polls: 1 } } });
  await c.c.init(1);
  assert.ok(!c.log.fetches.some((f) => f.method === "POST"), "resumed, not resubmitted");
  assert.equal(c.state.last.mode, "codex-dip");
  assert.equal(c.state.last.resultMode, "codex-dive", "the resumed result keeps its original mode for result-specific UI");
  assert.equal(c.log.fetches.some((f) => /-dive/.test(JSON.stringify(f.body || {}))), false, "no dive mode is sent");
});

test("a pending Dive already accepted by the companion is recovered by requestId and remains a Dive result", async () => {
  const job = { state: "queued", mode: "claude-dive", url: "https://v.test/watch", polls: 0, logged: true, saved: true };
  const r = rig({ slot: slot({ pendingMode: "claude-dive" }), mode: "codex-dip", jobs: { accepted: job } });
  r.server.requests["slot-req-1"] = { url: "https://v.test/watch", mode: "claude-dive", jobId: "accepted" };
  await r.c.init(1);
  const posts = r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  assert.deepEqual(posts.map((f) => f.body.mode), ["claude-dip", "claude-dive"], "Dip conflicts, then replaying the original request recovers the accepted job");
  assert.deepEqual(posts.map((f) => f.body.requestId), ["slot-req-1", "slot-req-1"]);
  assert.equal(r.store[slotKey(1)].jobId, "accepted");
  assert.equal(r.store[slotKey(1)].mode, "claude-dive");
  await r.tick();
  assert.equal(r.state.last.mode, "claude-dip", "the selected button stays on the migrated Dip mode");
  assert.equal(r.state.last.resultMode, "claude-dive", "the result retains the mode the companion actually ran");
});

test("selecting a stored or old Dive id (a stale caller) selects the Dip and sends the Dip", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1); await r.tick();
  await r.c.selectMode("codex-dive");
  assert.equal(r.store.mode, "codex-dip");
  assert.equal(r.log.fetches.filter((f) => f.method === "POST").at(-1).body.mode, "codex-dip");
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
  const r = rig({ slot: slot({ consumed: true, jobId: "job9", mode: "claude-dip" }), mode: "codex-dip", jobs: { job9: { state: "queued", mode: "claude-dip", url: "https://v.test/watch", polls: 1 } } });
  await r.c.init(1);
  assert.ok(!r.log.fetches.some((f) => f.method === "POST"));
  assert.equal(r.state.last.mode, "claude-dip");
  assert.equal(r.state.last.result, "Summary for claude-dip");
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
  await A.c.selectMode("codex-dip");   // window A switches; storage.mode changes
  B.c.onStorageChange({ mode: { newValue: "codex-dip" } }, "local");
  assert.equal(B.state.last.mode, "claude-dip", "B keeps its own pressed button");
  assert.match(B.state.last.result, /claude-dip/);
  await B.c.selectMode("codex-dip");
  const post = B.log.fetches.filter((f) => f.method === "POST").at(-1).body;
  assert.equal(post.mode, "codex-dip");
  assert.equal(post.force, false, "first Dip of the other provider in B is not a forced rerun");
  await B.c.selectMode("codex-dip");
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
  const r = rig({ slot: slot({ pendingMode: "claude-dip" }), mode: "codex-dip" });
  await r.c.init(1);
  const b = r.log.fetches.find((f) => f.method === "POST").body;
  assert.equal(b.mode, "claude-dip");
  assert.equal(b.requestId, "slot-req-1");
});

test("Codex unavailable: Claude Dip is the effective default, Codex buttons refuse presses; ready: Codex Dip is the default", async () => {
  const off = rig({ slot: slot(), health: { codex_ready: false, codex_logged_in: false } });
  await off.c.init(1);
  assert.equal(off.log.fetches.find((f) => f.method === "POST").body.mode, "claude-dip");
  assert.equal(off.state.last.codexOk, false);
  assert.match(off.state.last.codexReason, /not signed in/);
  const posts = off.log.fetches.filter((f) => f.method === "POST").length;
  await off.c.selectMode("codex-dip");
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

test("typed link: same path as a right-click (slot, requestId, own mode, ack in slot), bare host normalized", async () => {
  const r = rig({ mode: "claude-dip" });
  await r.c.init(1);
  assert.match(r.state.last.status, /Paste a link above/);
  assert.equal(r.state.last.source, null);
  assert.equal(await r.c.submitTyped("  example.com/post  "), true);
  const post = r.log.fetches.find((f) => f.method === "POST" && f.path === "/jobs");
  assert.equal(post.body.url, "https://example.com/post");
  assert.equal(post.body.mode, "claude-dip");
  assert.equal(post.body.force, false);
  assert.ok(post.body.requestId.startsWith("uuid-"));
  const slot = r.store[slotKey(1)];
  assert.equal(slot.url, "https://example.com/post");
  assert.equal(slot.consumed, true);
  assert.equal(slot.jobId, "job1");
  assert.equal(slot.requestId, post.body.requestId);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.title, "A Title");
  assert.equal(r.state.last.source.url, "https://example.com/post");
});

test("typed link: resumes after a panel reopen like any other slot", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip" };
  const a = rig({ shared });
  await a.c.init(1);
  await a.c.submitTyped("https://example.com/a");
  const b = rig({ shared, jobs: a.server.jobs });
  await b.c.init(1);
  assert.equal(b.log.fetches.filter((f) => f.method === "POST").length, 0, "no resubmit");
  assert.equal(b.state.last.source.url, "https://example.com/a");
  assert.equal(b.state.last.result, "Summary for claude-dip");
});

test("typed link: junk is refused with a message and nothing is sent", async () => {
  const r = rig({ mode: "claude-dip" });
  await r.c.init(1);
  assert.equal(await r.c.submitTyped("not a link at all"), false);
  assert.match(r.state.last.error, /does not look like a web link/);
  assert.equal(r.log.fetches.filter((f) => f.method === "POST").length, 0);
  assert.equal(await r.c.submitTyped("javascript:alert(1)"), false);
});

test("typed link uses this panel's own selected mode, and a second link starts a fresh job", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip" });
  await r.c.init(1); await r.tick();
  await r.c.selectMode("claude-dip"); await r.tick();
  await r.c.submitTyped("https://example.com/second");
  const posts = r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  assert.equal(posts.at(-1).body.mode, "claude-dip");
  assert.equal(posts.at(-1).body.url, "https://example.com/second");
  assert.notEqual(posts.at(-1).body.requestId, posts[0].body.requestId);
});

test("typed link while unconfigured points to the options page", async () => {
  const r = rig({ cfg: {} });
  await r.c.init(1);
  assert.equal(await r.c.submitTyped("https://example.com/"), false);
  assert.match(r.state.last.error, /options/);
  assert.equal(r.log.fetches.length, 0);
});
