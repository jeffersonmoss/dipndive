import test from "node:test";
import assert from "node:assert/strict";
import { TRAIL, canBack, canForward, emptyTrail, pushTrail, stepTrail } from "../lib/trail.js";
import { rig, slot } from "./rig.mjs";

const it = (n) => ({ url: `https://v.test/${n}`, jobId: `j${n}`, entryId: `j${n}`, title: `T${n}`, mode: "claude-dip", result: `S${n}` });
const flush = () => new Promise((r) => setTimeout(r, 5));

test("trail: works like a browser's back and forward, and a new summary after going back cuts off the forward part", () => {
  let t = emptyTrail();
  for (const n of [1, 2, 3]) t = pushTrail(t, it(n));
  assert.deepEqual([t.pos, canBack(t), canForward(t)], [2, true, false]);
  t = stepTrail(t, -1).trail; t = stepTrail(t, -1).trail;
  assert.deepEqual([t.pos, canBack(t), canForward(t)], [0, false, true]);
  assert.equal(stepTrail(t, -1), null);
  assert.equal(stepTrail(t, 1).item.jobId, "j2");
  t = pushTrail(t, it(4));  // a new branch from the first
  assert.deepEqual(t.items.map((x) => x.jobId), ["j1", "j4"]);
  assert.equal(canForward(t), false);
  t = pushTrail(t, it(1));  // already on the trail: only the position moves
  assert.deepEqual([t.items.length, t.pos], [2, 0]);
  let big = emptyTrail();
  for (let n = 0; n < TRAIL.max + 5; n++) big = pushTrail(big, it(n));
  assert.equal(big.items.length, TRAIL.max);
  assert.equal(big.items[0].jobId, "j5");
});

async function three() {
  const r = rig({ slot: slot({ url: "https://v.test/1" }), mode: "claude-dip" });
  await r.c.init(1);
  await r.tick(); await r.tick();
  for (const n of [2, 3]) { await r.c.submitTyped(`https://v.test/${n}`); await r.tick(); await r.tick(); }
  return r;
}

test("panel: back shows the earlier summary at once without resubmitting, forward returns, buttons follow", async () => {
  const r = await three();
  assert.equal(r.state.last.source.url, "https://v.test/3");
  assert.deepEqual([r.state.last.trailBack, r.state.last.trailForward], [true, false]);
  const posts = r.log.fetches.filter((f) => f.method === "POST").length;
  assert.equal(await r.c.goTrail(-1), true);
  assert.equal(r.state.last.source.url, "https://v.test/2");
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.busy, false);
  assert.deepEqual([r.state.last.trailBack, r.state.last.trailForward], [true, true]);
  assert.equal(r.log.fetches.filter((f) => f.method === "POST").length, posts, "nothing was resubmitted");
  await r.c.goTrail(-1);
  assert.equal(r.state.last.source.url, "https://v.test/1");
  assert.equal(await r.c.goTrail(-1), false);
  await r.c.goTrail(1); await r.c.goTrail(1);
  assert.equal(r.state.last.source.url, "https://v.test/3");
  assert.equal(r.state.last.trailForward, false);
  assert.equal(r.store[TRAIL.key].items.length, 3, "kept for every window on this computer");
});

test("panel: going back then summarizing a new link starts a new branch", async () => {
  const r = await three();
  await r.c.goTrail(-1); await r.c.goTrail(-1);
  await r.c.submitTyped("https://v.test/9"); await r.tick(); await r.tick();
  assert.deepEqual(r.store[TRAIL.key].items.map((x) => x.url), ["https://v.test/1", "https://v.test/9"]);
  assert.deepEqual([r.state.last.trailBack, r.state.last.trailForward], [true, false]);
});

test("panel: questions asked about a summary come back with it, and new ones are filed under its entry", async () => {
  const r = await three();
  await r.c.goTrail(-1);
  const entry = r.state.last.entryId;
  await r.c.askQuestion("what about two?"); await r.tick();
  const askPost = r.log.fetches.filter((f) => f.method === "POST" && f.body.mode.endsWith("-ask")).at(-1);
  assert.equal(askPost.body.entry, entry);
  await r.c.goTrail(1);
  assert.deepEqual(r.state.last.thread, []);
  await r.c.goTrail(-1); await flush();
  assert.deepEqual(r.state.last.thread.map((t) => t.q), ["what about two?"]);
});

test("panel: another window moving along the trail updates the buttons here", async () => {
  const r = await three();
  r.c.onStorageChange({ [TRAIL.key]: { newValue: { items: r.store[TRAIL.key].items, pos: 0 } } }, "local");
  assert.deepEqual([r.state.last.trailBack, r.state.last.trailForward], [false, true]);
});

// ---- the controller: Back and Forward show stored summaries with their Q&A, and submit nothing ----
test("back and forward show the stored summary and its kept Q&A without a new job", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1);
  await r.tick();                                   // job1's summary is shown and recorded in the trail
  assert.equal(r.state.last.trailBack, false);
  await r.c.askQuestion("why?");
  await r.tick();                                   // the answer is kept with entry job1 on the companion
  await r.c.recordTrail({ url: "https://v.test/other", jobId: "job9", entryId: "job9", title: "Other", mode: "claude-dive", result: "Other summary" });
  const postsBefore = r.log.fetches.filter((f) => f.method === "POST").length;
  assert.equal(await r.c.goTrail(-1), true);
  for (let i = 0; i < 5; i++) await new Promise((x) => setTimeout(x, 0));
  const s = r.state.last;
  assert.equal(s.result, "Summary for claude-dip");
  assert.equal(s.entryId, "job1");
  assert.equal(s.trailBack, false);
  assert.equal(s.trailForward, true);
  assert.deepEqual(s.thread.map((t) => t.q), ["why?"], "its questions come back from the companion");
  assert.equal(r.log.fetches.filter((f) => f.method === "POST").length, postsBefore, "nothing was resubmitted");
  assert.equal(await r.c.goTrail(1), true);
  assert.equal(r.state.last.result, "Other summary");
  assert.equal(await r.c.goTrail(1), false, "no further forward");
});
