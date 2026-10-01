// Cross-machine Clear history: every POST /jobs carries the clear generation the panel knows, and a refusal from the
// companion (409 stale_clear_generation, no job made) resets the panel without resubmitting anything by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { slotKey } from "../lib/background-core.js";
import { STALE_CODE, STALE_MESSAGE, describeError } from "../lib/controller.js";
import { MIC } from "../lib/voice.js";
import { makePermissions, makeSpeech, rig, slot } from "./rig.mjs";

const posts = (r) => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
const gets = (r) => r.log.fetches.filter((f) => f.method === "GET" && f.path.startsWith("/jobs/"));
const flush = () => new Promise((x) => setTimeout(x, 0));

// Another machine presses Clear history: the companion's generation moves on and every job is gone. This panel is not told.
function clearedOnAnotherMachine(server) {
  server.clearGen++;
  for (const k of Object.keys(server.jobs)) delete server.jobs[k];
}

// A panel that has a summary on screen and one answered question, against a companion that enforces the rule.
async function ready(opts = {}) {
  const r = rig({ slot: slot(), mode: "claude-dip", ...opts });
  r.server.staleCheck = true;
  await r.c.init(1);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  await r.c.askQuestion("first question");
  await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  return r;
}

test("the first request of a panel that has heard nothing carries no generation; every later POST /jobs carries the one it knows", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1);
  assert.equal(posts(r)[0].body.clearGeneration, undefined, "nothing known yet: the field is left out");
  await r.tick();
  assert.equal(r.c.clearGen, 0);
  await r.c.askQuestion("a question");   // an ask
  await r.c.selectMode("claude-dive");   // a summary
  await r.c.selectMode("temp");          // Temp chat (source mode)
  const later = posts(r).slice(1);
  assert.deepEqual(later.map((p) => p.body.mode), ["claude-ask", "claude-dive", "source"]);
  for (const p of later) assert.equal(p.body.clearGeneration, 0, p.body.mode);
});

test("after Clear history here the panel sends the new generation and is not refused", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  r.server.staleCheck = true;
  await r.c.init(1);
  await r.tick();
  await r.c.clearHistory();
  assert.equal(r.c.clearGen, 1);
  await r.c.selectMode("claude-dive");
  assert.equal(posts(r).at(-1).body.clearGeneration, 1);
  assert.equal(r.state.last.error, null);
});

test("a mode button pressed after another machine cleared is refused: summary and thread are reset, the message is shown, nothing is resubmitted", async () => {
  const r = await ready();
  clearedOnAnotherMachine(r.server);
  const sent = posts(r).length, polled = gets(r).length;
  await r.c.selectMode("claude-dive");
  assert.equal(posts(r).length, sent + 1, "exactly the one press was sent");
  assert.equal(posts(r).at(-1).body.clearGeneration, 0);
  const st = r.state.last;
  assert.equal(st.error, STALE_MESSAGE);
  assert.equal(STALE_MESSAGE, "History was cleared on another machine.");
  assert.equal(st.result, null, "the summary is gone");
  assert.deepEqual(st.thread, [], "the thread is gone");
  assert.equal(st.busy, false);
  assert.equal(st.jobId, null);
  assert.equal(st.asking, null);
  assert.equal(Object.keys(r.server.jobs).length, 0, "the companion made no job");
  // nothing happens by itself afterwards: no poll scheduled, no new POST, however long it waits
  assert.equal(r.timers.length, 0);
  await r.tick(); await flush(); await r.tick();
  assert.equal(posts(r).length, sent + 1, "no automatic resubmission");
  assert.equal(gets(r).length, polled, "no polling of a job that was never made");
  assert.equal(r.c.clearGen, 1, "the companion's generation is adopted");
  // pressing again (the person's own action) works and carries the new generation
  await r.c.selectMode("claude-dive");
  assert.equal(posts(r).at(-1).body.clearGeneration, 1);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dive");
  assert.equal(r.state.last.error, null);
});

test("the pressed button stays pressed after a refusal and pressing it again is an ordinary press, not a forced rerun", async () => {
  const r = await ready();
  clearedOnAnotherMachine(r.server);
  await r.c.selectMode("claude-dive");
  assert.equal(r.state.last.mode, "claude-dive");
  await r.c.selectMode("claude-dive");
  assert.equal(posts(r).at(-1).body.force, false, "no job is on screen to rerun");
});

test("a question asked after another machine cleared is refused: thread and summary reset, the question goes back in the box, nothing is resent", async () => {
  const r = await ready();
  clearedOnAnotherMachine(r.server);
  const sent = posts(r).length;
  assert.equal(await r.c.askQuestion("and why?"), false);
  assert.equal(posts(r).length, sent + 1);
  const body = posts(r).at(-1).body;
  assert.equal(body.mode, "claude-ask");
  assert.equal(body.clearGeneration, 0);
  assert.equal(body.history.length, 1, "the refused request did carry the old thread; the companion is what refused it");
  const st = r.state.last;
  assert.equal(st.askError, STALE_MESSAGE);
  assert.deepEqual(st.thread, []);
  assert.equal(st.result, null, "the summary the question was about is gone");
  assert.equal(st.asking, null);
  assert.equal(st.draft, "and why?", "the question is back in the box for the person to send again");
  assert.equal(Object.keys(r.server.jobs).length, 0);
  assert.equal(r.timers.length, 0);
  await r.tick(); await flush();
  assert.equal(posts(r).length, sent + 1, "no automatic resubmission");
  // sending it again: the new generation, no thread, no summary, and it is answered
  assert.equal(await r.c.askQuestion(), true);
  const again = posts(r).at(-1).body;
  assert.equal(again.clearGeneration, 1);
  assert.deepEqual(again.history, []);
  assert.equal(again.summary, undefined);
  await r.tick();
  assert.deepEqual(r.state.last.thread, [{ q: "and why?", a: "Answer to: and why? [0 earlier]" }]);
  assert.equal(r.state.last.askError, null);
});

test("Temp chat is refused the same way", async () => {
  const r = rig({ slot: slot(), mode: "temp" });
  r.server.staleCheck = true;
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.tempReady, true);
  clearedOnAnotherMachine(r.server);
  await r.c.selectMode("claude-dip");   // refused (the panel did not know)
  assert.equal(r.state.last.error, STALE_MESSAGE);
  clearedOnAnotherMachine(r.server);
  await r.c.selectMode("temp");         // refused again, in source mode
  assert.equal(posts(r).at(-1).body.mode, "source");
  assert.equal(r.state.last.error, STALE_MESSAGE);
  assert.equal(r.state.last.tempReady, false);
});

test("a right-click that is refused is not submitted later by a reopened panel", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const first = rig({ shared });
  first.server.staleCheck = true;
  await first.c.init(1); await first.tick();
  clearedOnAnotherMachine(first.server);
  // a new right-click, as the background worker writes it
  const rc = slot({ requestId: "rc-1", url: "https://v.test/other" });
  shared[slotKey(1)] = rc;
  await first.c.onSlot(rc);
  assert.equal(first.state.last.error, STALE_MESSAGE);
  assert.equal(first.state.last.source.url, "https://v.test/other", "the link is still the panel's current one, so a button press works");
  assert.equal(shared[slotKey(1)], undefined, "the unsent slot was removed from storage");
  // the panel is closed and opened again: it submits nothing
  const reopened = rig({ shared, server: first.server });
  await reopened.c.init(1);
  assert.equal(posts(reopened).length, 0, "no automatic resubmission on reopen");
  assert.equal(reopened.state.last.source, null);
});

test("a refused Go (typed link) is handled the same way and the typed link stays usable", async () => {
  const r = await ready();
  clearedOnAnotherMachine(r.server);
  assert.equal(await r.c.submitTyped("https://v.test/typed"), true);
  assert.equal(r.state.last.error, STALE_MESSAGE);
  assert.equal(r.store[slotKey(1)], undefined);
  await r.c.selectMode("claude-dip");
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(posts(r).at(-1).body.url, "https://v.test/typed");
});

test("a refusal that arrives after the person pressed another button is ignored", async () => {
  const r = await ready();
  clearedOnAnotherMachine(r.server);
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-dive";
  const first = r.c.selectMode("claude-dive");     // sent with generation 0; the companion's answer is held
  await flush();
  r.server.hold = null;
  r.c.clearGen = 1;                                 // the panel has since heard the new generation (storage, a poll)
  await r.c.selectMode("codex-dip");                // the newer press is accepted
  assert.equal(r.state.last.error, null);
  r.holds.forEach((h) => h());                      // now the companion's answer to the older press arrives: a refusal
  await first;
  await r.tick();
  assert.equal(r.state.last.error, null, "the refusal of the older press is not shown");
  assert.equal(r.state.last.mode, "codex-dip");
  assert.equal(r.state.last.result, "Summary for codex-dip");
  assert.equal(r.c.clearGen, 1);
});

test("a refusal of a question that arrives after the panel was reset another way is ignored", async () => {
  const r = await ready();
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-ask";
  const ask = r.c.askQuestion("slow question");     // sent with generation 0; held
  await flush();
  r.server.hold = null;
  await r.c.clearHistory();                          // this window clears too: the thread is reset, the generation is now 1
  r.holds.forEach((h) => h());                       // the held request reaches the companion: it is stale, and so is its refusal
  assert.equal(await ask, false);
  const st = r.state.last;
  assert.equal(st.askError, null, "the refusal of a question the panel already dropped is not shown");
  assert.equal(st.draft, "", "and the question is not put back in the box");
  assert.equal(st.status, "History cleared.");
});

test("a Dip or Dive refused while a question is on its way drops that answer too", async () => {
  const r = await ready();
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-ask";
  const ask = r.c.askQuestion("slow question");     // held
  await flush();
  r.server.hold = null;
  clearedOnAnotherMachine(r.server);
  await r.c.selectMode("claude-dive");              // refused: the whole old history is gone
  assert.equal(r.state.last.error, STALE_MESSAGE);
  r.server.staleCheck = false;
  r.holds.forEach((h) => h());                      // the held question now reaches the companion and is answered
  await ask;
  await r.tick(); await r.tick();
  assert.deepEqual(r.state.last.thread, [], "an answer to a question asked on the old history is not shown");
  assert.equal(r.state.last.asking, null);
});

test("a refusal while the microphone is listening stops it (the box is reset with everything else)", async () => {
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted") });
  r.server.staleCheck = true;
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  assert.equal(r.state.last.mic.state, MIC.LISTENING);
  clearedOnAnotherMachine(r.server);
  await r.c.selectMode("claude-dive");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.ok(speech.last.calls.includes("abort"));
  assert.equal(r.state.last.error, STALE_MESSAGE);
});

test("describeError knows the refusal code", () => {
  assert.equal(STALE_CODE, "stale_clear_generation");
  assert.equal(describeError(STALE_CODE, "history was cleared since this client last synced"), STALE_MESSAGE);
});
