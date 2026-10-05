import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { slotKey } from "../lib/background-core.js";
import { ASK_LIMITS, askProvider, capHistory, capSummary, cleanQuestion, normalizeText } from "../lib/ask.js";
import { MIC } from "../lib/voice.js";
import { renderMarkdown } from "../lib/markdown.js";
import { sourceKey } from "../lib/urls.js";
import { makePermissions, makeSpeech, rig, slot } from "./rig.mjs";

const posts = (r) => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
const asks = (r) => posts(r).filter((p) => p.body.mode.endsWith("-ask"));
// Let one pending asynchronous step (a held fetch, a resolved promise chain) run.
const flush = () => new Promise((x) => setTimeout(x, 0));

// A panel with a summary already shown and the question box usable.
async function ready(opts = {}) {
  const r = rig({ slot: slot(), mode: "claude-dip", ...opts });
  await r.c.init(1);
  await r.tick();  // summary job finishes
  return r;
}

test("ask: the question is sent about the current source, an answer lands in the thread, the summary stays", async () => {
  const r = await ready();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(await r.c.askQuestion("okay, what is the deal with the chocolate?"), true);
  const [p] = asks(r);
  assert.deepEqual(p.body, { url: "https://v.test/watch", mode: "claude-ask", requestId: p.body.requestId, question: "okay, what is the deal with the chocolate?", history: [], summary: "Summary for claude-dip", force: false, clearGeneration: 0 });
  assert.ok(p.body.requestId.startsWith("uuid-"));
  assert.equal(p.auth, "Bearer " + "t".repeat(40));
  assert.equal(r.state.last.asking.q, "okay, what is the deal with the chocolate?");
  await r.tick();
  assert.deepEqual(r.state.last.thread, [{ q: "okay, what is the deal with the chocolate?", a: "Answer to: okay, what is the deal with the chocolate? [0 earlier]" }]);
  assert.equal(r.state.last.asking, null);
  assert.equal(r.state.last.result, "Summary for claude-dip", "the Dip result is untouched");
  assert.equal(r.state.last.draft, "");
});

test("ask works with no summary at all (a question instead of Dip)", async () => {
  const r = rig({ slot: slot({ consumed: true, jobId: "x" }), mode: "claude-dip" });
  r.server.jobs.x = { state: "queued", mode: "claude-dip", url: "https://v.test/watch", polls: 0 };
  await r.c.init(1);
  await r.c.askQuestion("just tell me about the chocolate");
  await r.tick(); await r.tick();
  assert.equal(r.state.last.thread.length, 1);
});

test("follow-ups send the earlier questions and answers in this panel for this source", async () => {
  const r = await ready();
  await r.c.askQuestion("first?"); await r.tick();
  await r.c.askQuestion("and why?"); await r.tick();
  await r.c.askQuestion("last one"); await r.tick();
  const [a, b, c] = asks(r);
  assert.deepEqual(a.body.history, []);
  assert.deepEqual(b.body.history, [{ q: "first?", a: "Answer to: first? [0 earlier]" }]);
  assert.equal(c.body.history.length, 2);
  assert.equal(c.body.history[1].q, "and why?");
  assert.equal(r.state.last.thread.length, 3);
  assert.equal(r.state.last.thread[2].a, "Answer to: last one [2 earlier]");
});

test("history sent is capped to the newest turns and the character budget", async () => {
  const r = await ready();
  for (let i = 0; i < 9; i++) r.c.s.thread.push({ q: `old question ${i}`, a: "w".repeat(1100) });
  await r.c.askQuestion("now?");
  const h = asks(r)[0].body.history;
  assert.ok(h.length <= ASK_LIMITS.turns);
  assert.equal(h.at(-1).q, "old question 8");
  assert.ok(!h.some((t) => t.q === "old question 2"));
  assert.ok(h.reduce((n, t) => n + t.q.length + t.a.length, 0) <= ASK_LIMITS.budget);
});

test("capHistory matches the Python cap on the shared fixtures", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("../../tests/ask_cap_fixtures.json", import.meta.url), "utf8"));
  assert.ok(fx.length >= 6);
  for (const c of fx) assert.deepEqual(capHistory(c.history), c.expected, c.name);
  assert.equal(cleanQuestion("  a \n b\t c "), "a b c");
});

test("provider follows the pressed button; a Codex button asks Claude when Codex is unavailable", async () => {
  assert.equal(askProvider("claude-dip", true), "claude");
  assert.equal(askProvider("claude-dive", false), "claude");
  assert.equal(askProvider("codex-dip", true), "codex");
  assert.equal(askProvider("codex-dive", null), "codex");
  assert.equal(askProvider("codex-dive", false), "claude");
  const cases = [["claude-dive", "claude-ask"], ["codex-dip", "codex-ask"], ["codex-dive", "codex-ask"]];
  for (const [mode, want] of cases) {
    const r = rig({ slot: slot(), mode, health: { codex_ready: true, codex_logged_in: true } });
    await r.c.init(1);
    await r.c.selectMode(mode);  // press that button
    await r.c.askQuestion("who said it?");
    assert.equal(asks(r)[0].body.mode, want, mode);
  }
  const off = rig({ slot: slot(), mode: "codex-dive", health: { codex_ready: false, codex_logged_in: false } });
  await off.c.init(1);
  await off.c.askQuestion("who said it?");
  assert.equal(asks(off)[0].body.mode, "claude-ask", "with Codex unavailable the question goes to Claude");
});

test("Codex health is looked at again when asking, so a sign-out after the panel opened is noticed", async () => {
  const r = rig({ slot: slot(), mode: "codex-dip", health: { codex_ready: true, codex_logged_in: true } });
  await r.c.init(1);
  await r.tick();
  r.server.health = { codex_ready: false, codex_logged_in: false };
  await r.c.askQuestion("still there?");
  assert.equal(asks(r)[0].body.mode, "claude-ask");
  assert.equal(r.state.last.codexOk, false);
});

test("a Claude ask makes no health request", async () => {
  const r = await ready();
  const before = r.log.fetches.filter((f) => f.path === "/health").length;
  await r.c.askQuestion("hello?");
  assert.equal(r.log.fetches.filter((f) => f.path === "/health").length, before);
});

test("a new source starts a fresh thread; the same source keeps it", async () => {
  const r = await ready();
  await r.c.askQuestion("q1"); await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  // the same video written another way, a new right-click on it: same source, thread kept
  await r.c.onSlot(slot({ url: "https://v.test/watch#t=5", requestId: "again" })); await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  assert.equal(sourceKey("https://youtu.be/dQw4w9WgXcQ?t=5"), sourceKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9"));
  assert.notEqual(sourceKey("https://youtu.be/dQw4w9WgXcQ"), sourceKey("https://youtu.be/aaaaaaaaaaa"));
  assert.equal(sourceKey("https://example.com/a#x"), sourceKey("https://example.com/a#y"));
  // another source: right-click
  await r.c.onSlot(slot({ url: "https://other.test/page", requestId: "other" }));
  assert.deepEqual(r.state.last.thread, []);
  await r.tick();
  await r.c.askQuestion("q2");
  assert.deepEqual(asks(r).at(-1).body.history, [], "nothing from the old source is sent");
  await r.tick();
  // another source: typed link
  await r.c.submitTyped("https://third.test/x");
  assert.deepEqual(r.state.last.thread, []);
  assert.equal(r.state.last.asking, null);
});

test("an answer that arrives after the source changed is discarded", async () => {
  const r = await ready();
  r.server.hold = (path, body) => path === "/jobs" && body.mode === "claude-ask";
  const pending = r.c.askQuestion("slow question");
  await flush();
  r.server.hold = null;
  await r.c.onSlot(slot({ url: "https://other.test/page", requestId: "other" }));
  r.holds.forEach((h) => h());
  await pending;
  await r.tick(); await r.tick();
  assert.deepEqual(r.state.last.thread, []);
  assert.equal(r.state.last.asking, null);
  assert.equal(r.state.last.draft, "", "the old question does not come back into the box");
});

test("clear history clears the Q&A thread, the box and any answer on its way", async () => {
  const r = await ready();
  await r.c.askQuestion("q1"); await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  r.server.hold = (path) => path.startsWith("/jobs/job");  // the poll for q2 is held on the wire
  const pending = r.c.askQuestion("q2");
  await flush();
  r.c.typed("half typed");
  await r.c.clearHistory();
  assert.deepEqual(r.state.last.thread, []);
  assert.equal(r.state.last.asking, null);
  assert.equal(r.state.last.draft, "");
  r.server.hold = null;
  r.holds.forEach((h) => h());
  await pending;
  await flush();
  assert.deepEqual(r.state.last.thread, [], "a pre-clear answer is not shown");
  assert.equal(r.state.last.asking, null);
  // after the clear the same panel asks with no earlier turns
  await r.c.onSlot(slot({ url: "https://v.test/watch", requestId: "after-clear" })); await r.tick();
  await r.c.askQuestion("q3");
  assert.deepEqual(asks(r).at(-1).body.history, []);
});

test("an old clear generation in an answer ends the turn: the panel is not left on Thinking", async () => {
  const r = await ready();
  r.c.clearGen = 5;  // the companion answers with generation 0: it was reset
  assert.equal(await r.c.askQuestion("q"), false);
  const st = r.state.last;
  assert.equal(st.asking, null, "not stuck waiting");
  assert.equal(st.draft, "q", "the question is back in the box");
  assert.match(st.askError, /companion was reset/);
  assert.deepEqual(st.thread, []);
  assert.equal(r.c.clearGen, 0, "the companion's generation is adopted, so the next question can work");
  assert.equal(r.timers.length, 0, "no polling goes on in the background");
  assert.equal(await r.c.askQuestion(), true, "asking again is allowed");
  await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  assert.equal(r.state.last.askError, null);
});

test("an old generation seen while polling an answer also ends the turn, and the mic is usable again", async () => {
  const { r, speech } = await micReady();
  await r.c.askQuestion("slow one");
  r.c.clearGen = 7;
  await r.tick();
  assert.equal(r.state.last.asking, null);
  assert.equal(r.state.last.draft, "slow one");
  await r.c.toggleMic();
  assert.equal(speech.recs.length, 1, "the mic is not blocked by a question that will never be answered");
});

test("a newer generation in an answer (history cleared in another window) forgets the thread and drops the answer", async () => {
  const r = await ready();
  await r.c.askQuestion("before the clear"); await r.tick();
  assert.equal(r.state.last.thread.length, 1);
  r.server.clearGen = 3;  // someone cleared; this panel was not told by storage
  assert.equal(await r.c.askQuestion("after the clear"), false);
  assert.deepEqual(r.state.last.thread, []);
  assert.equal(r.state.last.asking, null);
  assert.equal(r.state.last.draft, "after the clear");
  assert.match(r.state.last.askError, /cleared in another window/);
  assert.equal(r.c.clearGen, 3);
  assert.equal(await r.c.askQuestion(), true);
  assert.deepEqual(asks(r).at(-1).body.history, [], "the pre-clear turns are not sent again");
});

// ---------- two windows ----------

function twoPanels() {
  const store = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip",
                  [slotKey(1)]: slot(), [slotKey(2)]: slot({ windowId: 2, requestId: "slot-req-2", url: "https://v.test/other" }) };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  return { A: rig({ shared: store, server, bus }), B: rig({ shared: store, server, bus }), store, server };
}

test("Clear history in one window clears the question thread and summary in the other window's panel", async () => {
  const { A, B, store } = twoPanels();
  await A.c.init(1); await B.c.init(2);
  await A.tick(); await B.tick();
  await A.c.askQuestion("my private zebra question"); await A.tick();
  assert.equal(A.state.last.thread.length, 1);
  assert.equal(A.state.last.result, "Summary for claude-dip");
  await B.c.clearHistory();
  assert.equal(B.state.last.status, "History cleared.");
  assert.deepEqual(A.state.last.thread, [], "window A forgot the thread when window B cleared");
  assert.equal(A.state.last.result, null);
  assert.match(A.state.last.status, /cleared in another window/);
  assert.equal(A.state.last.busy, false);
  assert.equal(A.c.clearGen, 1);
  assert.equal(store.clearGen, 1);
  assert.ok(!Object.keys(store).some((k) => k.startsWith("slot:")), "no list of what was looked at is kept");
  // the next question from A carries nothing from before the clear
  await A.c.askQuestion("and then?");
  const body = asks(A).at(-1).body;
  assert.deepEqual(body.history, []);
  assert.ok(!JSON.stringify(body).includes("zebra"));
  assert.equal(body.summary, undefined, "the cleared summary is not sent back either");
  await A.tick();
  assert.equal(A.state.last.thread.length, 1);
});

test("the window that cleared is not reset a second time by its own storage write", async () => {
  const { A, B } = twoPanels();
  await A.c.init(1); await B.c.init(2);
  await A.tick(); await B.tick();
  await A.c.clearHistory();
  assert.equal(A.state.last.status, "History cleared.");
  assert.equal(A.c.clearGen, 1);
  assert.equal(B.state.last.result, null);
});

test("a Dip in flight in another window when history is cleared is dropped, not shown as a fresh result", async () => {
  const { A, B } = twoPanels();
  await A.c.init(1); await B.c.init(2);
  await B.tick(); await A.tick();
  await A.c.selectMode("claude-dive");  // submits; polling is queued
  assert.equal(A.state.last.busy, true);
  await B.c.clearHistory();
  assert.equal(A.state.last.busy, false);
  assert.equal(A.state.last.result, null);
  await A.tick();  // the poll that was already scheduled does nothing
  assert.equal(A.state.last.result, null);
});

// ---------- the summary on screen goes with a question ----------

test("the Dip or Dive text on screen is sent with a question, for follow-ups such as 'the second one'", async () => {
  const r = await ready();
  await r.c.askQuestion("tell me more about the second one"); await r.tick();
  assert.equal(asks(r)[0].body.summary, "Summary for claude-dip");
  assert.deepEqual(asks(r)[0].body.history, []);
  // Dive instead
  const d = rig({ slot: slot(), mode: "claude-dive" });
  await d.c.init(1); await d.tick();
  await d.c.askQuestion("and the third?");
  assert.equal(asks(d)[0].body.summary, "Summary for claude-dive");
});

test("no summary is sent while a Dip is still running or after Clear history", async () => {
  const running = rig({ slot: slot(), mode: "claude-dip" });
  await running.c.init(1);  // job not finished
  await running.c.askQuestion("instead of a summary");
  assert.equal("summary" in asks(running)[0].body, false);
  const r = await ready();
  await r.c.clearHistory();
  await r.c.askQuestion("after clear");
  assert.equal("summary" in asks(r)[0].body, false);
});

test("a long summary is cut like the companion cuts it (shared fixtures)", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("../../tests/ask_summary_fixtures.json", import.meta.url), "utf8"));
  assert.ok(fx.length >= 5);
  for (const c of fx) assert.equal(capSummary(c.summary), c.expected, c.name);
  assert.equal(capSummary(""), "");
  assert.equal(capSummary(null), "");
});

// ---------- characters outside the basic plane ----------

test("cutting a long answer never splits a character into a lone surrogate", () => {
  const a = "x".repeat(2996) + "\u{1F600}" + "y".repeat(20);  // the emoji would straddle the cut with a UTF-16 slice
  const [t] = capHistory([{ q: "list everything", a }]);
  assert.ok(t.a.isWellFormed(), "well-formed text can be encoded as UTF-8");
  assert.equal(Array.from(t.a).length, 3000);
  assert.ok(t.a.includes("\u{1F600}"));
  assert.ok(capSummary("z".repeat(3996) + "\u{1F600}" + "w".repeat(9)).isWellFormed());
  assert.equal(normalizeText("\u{1D413}\u{1D421}\u{1D41E}"), "The", "the bold letters of many titles are plain letters after NFKC");
  assert.equal(normalizeText("a \ud83d b"), "a \ufffd b");
  assert.equal(normalizeText("\ufb01ne\u200b \u034f\ufe0f"), "fine ");
  // a question of 2000 emoji is 2000 characters, not 4000
  assert.equal(cleanQuestion("\u{1F600}".repeat(1500)).length, 3000);
});

test("a question of 1500 emoji is allowed (the limit counts characters the way the companion does)", async () => {
  const r = await ready();
  assert.equal(await r.c.askQuestion("\u{1F600}".repeat(1500)), true);
  assert.equal(await r.c.askQuestion("\u{1F600}".repeat(1)), false);  // one at a time
});

test("only one question at a time; the second is refused with a message", async () => {
  const r = await ready();
  await r.c.askQuestion("one");
  assert.equal(await r.c.askQuestion("two"), false);
  assert.match(r.state.last.askError, /Wait for the current answer/);
  assert.equal(asks(r).length, 1);
});

test("empty, too long, unconfigured and no-source cases are refused with one line and send nothing", async () => {
  const r = await ready();
  assert.equal(await r.c.askQuestion("   "), false);
  assert.match(r.state.last.askError, /Type or say a question/);
  assert.equal(await r.c.askQuestion("x".repeat(ASK_LIMITS.question + 1)), false);
  assert.match(r.state.last.askError, /too long/);
  assert.equal(asks(r).length, 0);
  const none = rig({ mode: "claude-dip" });
  await none.c.init(1);
  assert.equal(await none.c.askQuestion("hello"), false);
  assert.match(none.state.last.askError, /Paste a link or right-click/);
  const off = rig({ cfg: {} });
  await off.c.init(1);
  assert.equal(await off.c.askQuestion("hello"), false);
  assert.match(off.state.last.askError, /options/);
  assert.equal(off.log.fetches.length, 0);
});

test("failures keep the question in the box so it can be sent again", async () => {
  const r = await ready();
  r.server.fail = new Error("down");
  await r.c.askQuestion("will fail");
  assert.match(r.state.last.askError, /Cannot reach the companion/);
  assert.equal(r.state.last.draft, "will fail");
  assert.equal(r.state.last.asking, null);
  assert.deepEqual(r.state.last.thread, []);
  r.server.fail = null;
  await r.c.askQuestion();  // from the box
  await r.tick();
  assert.equal(r.state.last.thread[0].q, "will fail");
  assert.equal(r.state.last.askError, null);

  const e = await ready();
  e.server.postStatus = 429; e.server.postError = "queue_full";
  await e.c.askQuestion("busy");
  assert.match(e.state.last.askError, /busy/);
  assert.equal(e.state.last.draft, "busy");
  e.server.postStatus = 401; e.server.postError = "unauthorized";
  await e.c.askQuestion();
  assert.match(e.state.last.askError, /token was rejected/);

  const j = await ready();
  await j.c.askQuestion("model trouble");
  const id = Object.keys(j.server.jobs).at(-1);
  j.server.jobs[id].fail = "timeout";
  await j.tick(); await j.tick();
  assert.match(j.state.last.askError, /took too long/);
  assert.equal(j.state.last.draft, "model trouble");
  assert.deepEqual(j.state.last.thread, []);
});

test("a job that disappeared (history cleared elsewhere) says so and keeps the question", async () => {
  const r = await ready();
  await r.c.askQuestion("gone soon");
  const id = Object.keys(r.server.jobs).at(-1);
  delete r.server.jobs[id];
  await r.tick();
  assert.match(r.state.last.askError, /history was cleared/);
  assert.equal(r.state.last.draft, "gone soon");
});

test("the typed draft is tracked without re-rendering the field", async () => {
  const r = await ready();
  const seq = r.state.last.draftSeq;
  r.c.typed("what happens next");
  assert.equal(r.state.last.draftSeq, seq);
  await r.c.askQuestion();  // from the box
  assert.equal(asks(r)[0].body.question, "what happens next");
});

test("answers are rendered by the safe renderer and questions are plain text in the panel", () => {
  const html = renderMarkdown('Fine <img src=x onerror=alert(1)> [x](javascript:alert(1)) ![p](https://e.test/p.png) **ok**');
  assert.ok(!/<img/i.test(html));
  assert.ok(!/href="javascript/i.test(html));
  assert.match(html, /<strong>ok<\/strong>/);
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /qe\.textContent = q;/, "the question goes in as text");
  assert.match(js, /ae\.innerHTML = html/);
  assert.match(js, /addEventListener\("keydown", \(e\) => \{\s*if \(e\.key === "Escape"\)/);
  assert.match(js, /box\.readOnly = live/);
  assert.match(js, /preserveSelection/);
  assert.ok(!/innerHTML = [^;]*\.q\b/.test(js), "a question is never put through innerHTML");
});

// ---------- the microphone through the controller ----------

async function micReady({ permission = "granted", ...opts } = {}) {
  const speech = makeSpeech();
  const permissions = makePermissions(permission);
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions, ...opts });
  await r.c.init(1);
  await r.tick();
  return { r, speech, permissions };
}
const R = (t, final = false) => ({ t, final });

test("mic: click starts, live words appear, and click again pauses without sending", async () => {
  const { r, speech } = await micReady();
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  await r.c.toggleMic();
  const rec = speech.last;
  rec.fire("start"); rec.fire("audiostart");
  assert.equal(r.state.last.mic.state, MIC.LISTENING);
  const seq = r.state.last.draftSeq;
  rec.result([R("okay what is")]);
  assert.equal(r.state.last.draft, "okay what is");
  assert.ok(r.state.last.draftSeq > seq, "the panel is told to redraw the box");
  rec.result([R("okay what is the deal with the chocolate")]);
  assert.equal(r.state.last.draft, "okay what is the deal with the chocolate");
  assert.equal(asks(r).length, 0, "nothing is sent before the second click");
  await r.c.toggleMic();
  assert.equal(r.state.last.mic.state, MIC.STOPPING);
  rec.finish([R("okay what is the deal with the chocolate", true)]);
  await flush();
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.equal(r.state.last.draft, "okay what is the deal with the chocolate");
  await r.c.askQuestion();
  assert.equal(asks(r).length, 1);
  assert.equal(asks(r)[0].body.question, "okay what is the deal with the chocolate");
  assert.equal(r.state.last.asking.q, "okay what is the deal with the chocolate");
  assert.equal(r.state.last.draft, "");
  await r.tick();
  assert.equal(r.state.last.thread.length, 1);
});

test("mic: a spoken follow-up carries the earlier turns", async () => {
  const { r, speech } = await micReady();
  await r.c.askQuestion("typed first"); await r.tick();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await r.c.toggleMic();
  speech.last.finish([R("and why is that", true)]);
  await flush();
  assert.equal(asks(r).length, 1, "pausing never sends the spoken follow-up");
  await r.c.askQuestion();
  assert.deepEqual(asks(r)[1].body.history.map((t) => t.q), ["typed first"]);
});

test("mic: silence sends nothing and says so", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await r.c.toggleMic();
  speech.last.finish();
  await flush();
  assert.equal(asks(r).length, 0);
  assert.match(r.state.last.mic.message, /did not hear anything/);
});

test("mic: a recognition error keeps the partial words in the box and does not send them", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  speech.last.result([R("half of a thought")]);
  speech.last.fire("error", { error: "network" });
  await flush();
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.draft, "half of a thought");
  assert.match(r.state.last.mic.message, /Google's speech service/);
  await r.c.askQuestion();  // the user can still send it with the Ask button
  assert.equal(asks(r)[0].body.question, "half of a thought");
});

test("mic: permission missing at start offers Enable microphone; the setup button opens the extension page in a tab", async () => {
  const { r, speech, permissions } = await micReady({ permission: "prompt" });
  await r.c.refreshMic();
  assert.equal(r.state.last.mic.needPermission, true, "offered up front, before any click");
  assert.match(r.state.last.mic.message, /Enable microphone/);
  await r.c.toggleMic();
  assert.equal(speech.recs.length, 0);
  assert.equal(r.state.last.mic.needPermission, true);
  r.c.openMicSetup();
  assert.deepEqual(r.log.tabs, ["chrome-extension://test/mic.html"]);
  assert.match(r.state.last.mic.message, /Allow the microphone in the new tab/);
  permissions.set("granted");  // the user clicked Allow in the tab and came back
  await flush();
  assert.equal(r.state.last.mic.needPermission, false);
  assert.match(r.state.last.mic.message, /Microphone is on/);
  assert.equal(speech.recs.length, 0, "no listening starts by itself");
  await r.c.toggleMic();
  assert.equal(speech.recs.length, 1);
  speech.last.fire("audiostart");
  assert.equal(r.state.last.mic.state, MIC.LISTENING);
});

test("mic: a not-allowed error when the browser cannot report the permission offers Enable microphone", async () => {
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech });  // no permissions API
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  speech.last.fire("error", { error: "not-allowed" });
  assert.equal(r.state.last.mic.needPermission, true);
  assert.match(r.state.last.mic.message, /Enable microphone/);
});

test("mic: not-allowed with the permission granted says the computer is blocking, and the panel keeps saying it", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("error", { error: "not-allowed" });
  speech.last.fire("end");
  assert.equal(r.state.last.mic.needPermission, false);
  assert.match(r.state.last.mic.message, /Your computer is blocking the microphone/);
  assert.match(r.state.last.mic.message, /Privacy and Security/);
  await r.c.refreshMic();  // the panel regained focus
  assert.match(r.state.last.mic.message, /Your computer is blocking the microphone/);
});

test("mic: paused edits survive resume and later final results append once", async () => {
  const { r, speech } = await micReady();
  r.c.typed("what about the chocolate");
  await r.c.toggleMic();
  const first = speech.last;
  first.fire("audiostart");
  assert.equal(r.state.last.draft, "what about the chocolate", "starting to listen does not wipe the box");
  first.result([R("in the second half")]);
  assert.equal(r.state.last.draft, "what about the chocolate in the second half");
  await r.c.toggleMic();
  first.finish([R("in the second half", true)]);
  await flush();
  assert.equal(asks(r).length, 0);
  r.c.typed("what about cocoa");
  await r.c.toggleMic();
  const resumed = speech.last;
  resumed.fire("audiostart");
  resumed.result([R("the second half")]);
  assert.equal(r.state.last.draft, "what about cocoa the second half");
  await r.c.toggleMic();
  resumed.finish([R("the second half", true)]);
  assert.equal(r.state.last.draft, "what about cocoa the second half");
  await r.c.askQuestion();
  assert.equal(asks(r)[0].body.question, "what about cocoa the second half");
});

test("mic: Ask stops listening, includes the final result, and sends exactly once", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  const rec = speech.last;
  rec.fire("audiostart");
  rec.result([R("what is the", true), R(" chocolate")]);
  assert.equal(r.state.last.mic.state, MIC.LISTENING);
  await r.c.askQuestion();
  assert.equal(r.state.last.mic.state, MIC.STOPPING);
  assert.deepEqual(rec.calls.slice(-1), ["stop"]);
  rec.finish([R("what is the", true), R(" chocolate", true)]);
  await flush();
  assert.equal(asks(r).length, 1);
  assert.equal(asks(r)[0].body.question, "what is the chocolate");
});

test("mic: Ask during STARTING cancels recognition and sends the existing draft once", async () => {
  const { r, speech } = await micReady();
  r.c.typed("typed before audio");
  const starting = r.c.toggleMic();
  assert.equal(r.state.last.mic.state, MIC.STARTING);
  await r.c.askQuestion();
  await starting;
  assert.equal(asks(r).length, 1);
  assert.equal(asks(r)[0].body.question, "typed before audio");
  assert.equal(speech.recs.length, 0, "the pending permission check cannot resurrect a recognizer");
  await flush();
  assert.equal(asks(r).length, 1);
  assert.equal(r.state.last.draft, "");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
});

test("mic: Ask after the recognizer starts but before audio cancels it and ignores late events", async () => {
  const { r, speech } = await micReady();
  r.c.typed("send before audio");
  await r.c.toggleMic();
  const rec = speech.last;
  assert.equal(r.state.last.mic.state, MIC.STARTING);
  await r.c.askQuestion();
  assert.ok(rec.calls.includes("abort"));
  rec.fire("audiostart"); rec.result([R("ghost words", true)]); rec.fire("end");
  await flush();
  assert.equal(asks(r).length, 1);
  assert.equal(asks(r)[0].body.question, "send before audio");
  assert.equal(r.state.last.draft, "");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
});

test("mic: the question box is read-only while recording", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /box\.readOnly = live/);
  assert.equal(r.state.last.mic.state, MIC.LISTENING);
  r.c.cancelQuestion();
  assert.equal(r.state.last.draft, "");
});

test("Escape cancels listening and typing without sending, while keeping earlier turns", async () => {
  const { r, speech } = await micReady();
  await r.c.askQuestion("earlier question"); await r.tick();
  const thread = r.state.last.thread;
  r.c.typed("typed draft");
  await r.c.toggleMic();
  const rec = speech.last;
  rec.fire("audiostart");
  rec.result([R("heard words")]);
  r.c.cancelQuestion();
  assert.equal(r.state.last.draft, "");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  rec.finish([R("heard words", true)]);
  await flush();
  assert.equal(asks(r).length, 1);
  assert.deepEqual(r.state.last.thread, thread);
  r.c.typed("another typed draft");
  r.c.cancelQuestion();
  assert.equal(r.state.last.draft, "");
  assert.equal(asks(r).length, 1);
  assert.deepEqual(r.state.last.thread, thread);
});

test("Escape clears the question and mic message in idle, STARTING and STOPPING states", async () => {
  const idle = await micReady();
  idle.r.c.typed("discard this");
  idle.r.c.voice._set({ message: "Stopped after a long pause. Click Ask to send what was heard, or click the mic to add more." });
  idle.r.c.cancelQuestion();
  assert.equal(idle.r.state.last.draft, "");
  assert.equal(idle.r.state.last.mic.message, "");

  const starting = await micReady();
  const startPromise = starting.r.c.toggleMic();
  assert.equal(starting.r.state.last.mic.state, MIC.STARTING);
  starting.r.c.cancelQuestion();
  await startPromise;
  assert.equal(starting.speech.recs.length, 0, "Escape cancels before the recognizer is created");
  assert.equal(starting.r.state.last.mic.state, MIC.IDLE);
  assert.equal(starting.r.state.last.draft, "");
  assert.equal(starting.r.state.last.mic.message, "");

  const stopping = await micReady();
  await stopping.r.c.toggleMic();
  const rec = stopping.speech.last;
  rec.fire("audiostart"); rec.result([R("discard during stop")]);
  stopping.r.c.toggleMic();
  assert.equal(stopping.r.state.last.mic.state, MIC.STOPPING);
  stopping.r.c.cancelQuestion();
  rec.finish([R("discard during stop", true)]);
  await flush();
  assert.equal(stopping.r.state.last.draft, "");
  assert.equal(stopping.r.state.last.mic.message, "");
  assert.equal(asks(stopping.r).length, 0);
});

test("resetAsk cancels a pending stop-and-send without sending", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  const rec = speech.last;
  rec.fire("audiostart"); rec.result([R("pending question")]);
  r.c.askQuestion();
  assert.equal(r.state.last.mic.state, MIC.STOPPING);
  r.c.resetAsk();
  rec.finish([R("pending question final", true)]);
  await flush();
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.draft, "");
  assert.equal(r.state.last.thread.length, 0);
});

test("Enter submits through the same Ask form handler", () => {
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /\$\("askform"\)\.addEventListener\("submit"/);
  assert.match(fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8"), /<form id="askform"/);
});

test("mic: nothing heard leaves the typed words in the box", async () => {
  const { r, speech } = await micReady();
  r.c.typed("what about the chocolate");
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await r.c.toggleMic();
  speech.last.finish();
  await flush();
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.draft, "what about the chocolate");
  assert.match(r.state.last.mic.message, /did not hear anything/);
  await r.c.askQuestion();  // and it can still be sent
  assert.equal(asks(r)[0].body.question, "what about the chocolate");
});

test("mic: a pause that Chrome ends keeps the words in the box unsent; Ask sends them, the mic adds more", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  speech.last.result([R("so what is the", true)]);
  speech.last.fire("end");  // Chrome gave up on the silence; nobody clicked Stop
  await flush();
  assert.equal(asks(r).length, 0, "half a question is not sent");
  assert.equal(r.state.last.draft, "so what is the");
  assert.match(r.state.last.mic.message, /Stopped after a long pause/);
  await r.c.toggleMic();  // add more
  speech.last.fire("audiostart");
  speech.last.result([R("deal with the chocolate")]);
  assert.equal(r.state.last.draft, "so what is the deal with the chocolate");
  await r.c.toggleMic();
  speech.last.finish([R("deal with the chocolate", true)]);
  await flush();
  await r.c.askQuestion();
  assert.equal(asks(r)[0].body.question, "so what is the deal with the chocolate");
});

test("mic: the panel being hidden stops the recording and keeps the words unsent", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  speech.last.result([R("I was saying")]);
  r.c.pauseMic();
  speech.last.finish([R("I was saying", true)]);
  await flush();
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.draft, "I was saying");
  assert.match(r.state.last.mic.message, /panel was hidden/);
});

test("mic: not offered without a source, and ignored while an answer is being fetched", async () => {
  const speech = makeSpeech();
  const none = rig({ mode: "claude-dip", speech, permissions: makePermissions() });
  await none.c.init(1);
  await none.c.toggleMic();
  assert.equal(speech.recs.length, 0);
  assert.match(none.state.last.askError, /Paste a link or right-click/);
  const { r, speech: sp2 } = await micReady();
  await r.c.askQuestion("pending one");
  await r.c.toggleMic();
  assert.equal(sp2.recs.length, 0, "the mic is off while a question is in flight");
});

test("mic: changing the source while listening stops the recording and sends nothing", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  speech.last.result([R("about the first video")]);
  await r.c.onSlot(slot({ url: "https://other.test/page", requestId: "other" }));
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.ok(speech.last.calls.includes("abort"));
  speech.last.finish([R("about the first video", true)]);
  await flush();
  assert.equal(asks(r).length, 0);
  assert.equal(r.state.last.draft, "");
});

test("mic: clear history while listening stops the recording too", async () => {
  const { r, speech } = await micReady();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await r.c.clearHistory();
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.ok(speech.last.calls.includes("abort"));
});

test("mic: no SpeechRecognition in the browser leaves the button unavailable with one line", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1);
  await r.c.refreshMic();
  assert.equal(r.state.last.mic.available, false);
  assert.match(r.state.last.mic.message, /not available in this browser/);
});

test("the Ask button and Enter are the same path as the mic (askQuestion with the box text)", async () => {
  const r = await ready();
  r.c.typed("  typed   question ");
  await r.c.askQuestion();
  assert.equal(asks(r)[0].body.question, "typed question");
});

test("slots and storage are untouched by questions (nothing about them is persisted)", async () => {
  const r = await ready();
  const before = JSON.stringify(r.store);
  await r.c.askQuestion("private question"); await r.tick();
  assert.equal(JSON.stringify(r.store), before);
  assert.ok(!JSON.stringify(r.store).includes("private question"));
  assert.ok(r.store[slotKey(1)]);
});
