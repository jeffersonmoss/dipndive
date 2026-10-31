// A busy iMac can miss a status check: the panel retries up to POLL_RETRIES times in a row before it says
// "Cannot reach the companion", and a success in between resets the count.
import test from "node:test";
import assert from "node:assert/strict";
import { Controller, POLL_RETRIES } from "../lib/controller.js";

function make(script) {
  let calls = 0; const timers = [], states = [];
  const fetch = async () => {
    const step = script[Math.min(calls++, script.length - 1)];
    if (step === "fail") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return { status: 200, json: async () => step };
  };
  const c = new Controller({ storage: { get: async () => ({}), set: async () => {} }, fetch, openTab() {}, uuid: () => "u",
    onState: (s) => states.push({ ...s }), setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer() {}, tabs: {} });
  c.cfg = { base: "http://x", token: "t" }; c.slot = { url: "http://v" };
  const drain = async () => { while (timers.length) await timers.shift()(); };
  return { c, states, drain, calls: () => calls };
}

test("a summary survives POLL_RETRIES missed checks in a row", async () => {
  const t = make([...Array(POLL_RETRIES).fill("fail"), { state: "done", result_markdown: "OK" }]);
  await t.c.beginTracking("j", t.c.selGen); await t.drain();
  assert.equal(t.c.s.result, "OK"); assert.equal(t.c.s.error, null);
  assert.ok(t.states.some((s) => s.status === "Waiting for the iMac..."));
});

test("the panel gives up after POLL_RETRIES + 1 misses in a row", async () => {
  const t = make(["fail"]);
  await t.c.beginTracking("j", t.c.selGen); await t.drain();
  assert.equal(t.calls(), POLL_RETRIES + 1);
  assert.match(t.c.s.error, /Cannot reach the companion/);
});

test("one answered check resets the miss count", async () => {
  const misses = Array(POLL_RETRIES).fill("fail");
  const t = make([...misses, { state: "summarizing" }, ...misses, { state: "done", result_markdown: "Y" }]);
  await t.c.beginTracking("j", t.c.selGen); await t.drain();
  assert.equal(t.c.s.result, "Y");
});
