import test from "node:test";
import assert from "node:assert/strict";
import { MIC, MIC_MESSAGES, VoiceInput } from "../lib/voice.js";
import { makePermissions, makeSpeech } from "./rig.mjs";

// VoiceInput on its own, with a scripted SpeechRecognition and manual timers.
function voice({ permission = "granted", noSpeech = false, noPermissions = false } = {}) {
  const speech = makeSpeech();
  const permissions = makePermissions(permission);
  const log = { changes: [], finals: [] };
  const timers = [];
  const v = new VoiceInput({
    SpeechRecognition: noSpeech ? null : speech.SR,
    permissions: noPermissions ? null : permissions,
    onChange: (m) => log.changes.push(m),
    onFinal: (text, o) => log.finals.push([text, o.send]),
    setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const fire = async (ms) => { const t = timers.find((x) => x.ms === ms && !x.cleared); assert.ok(t, `no live ${ms} ms timer`); t.cleared = true; await t.f(); };
  return { v, speech, permissions, log, timers, fire };
}
const R = (t, final = false) => ({ t, final });

test("click starts: a recognizer is made for English with interim results, listening begins at audio start", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  assert.equal(rec.lang, "en-US");
  assert.equal(rec.interimResults, true);
  assert.equal(rec.continuous, true);
  assert.deepEqual(rec.calls, ["start"]);
  assert.equal(x.v.state, MIC.STARTING);
  rec.fire("start");
  assert.equal(x.v.state, MIC.STARTING);
  rec.fire("audiostart");
  assert.equal(x.v.state, MIC.LISTENING);
});

test("interim text shows live; finals and the current guess are joined", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("okay")]);
  assert.equal(x.v.text, "okay");
  rec.result([R("okay what is", true), R("the deal")]);
  assert.equal(x.v.text, "okay what is the deal");
  assert.equal(x.log.changes.at(-1).text, "okay what is the deal");
  assert.equal(x.log.finals.length, 0, "nothing is sent while still listening");
});

test("second click stops; the final text is delivered once, to be sent, and the mic returns to idle", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("what about the chocolate")]);
  await x.v.toggle();
  assert.equal(x.v.state, MIC.STOPPING);
  assert.deepEqual(rec.calls, ["start", "stop"]);
  rec.finish([R("what about the chocolate", true)]);
  assert.deepEqual(x.log.finals, [["what about the chocolate", true]]);
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.text, "");
  assert.equal(x.v.message, "");
  rec.fire("end");  // a duplicate end from Chrome changes nothing
  assert.equal(x.log.finals.length, 1);
});

test("a guess that never became final is still delivered when recognition ends", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("one two", true), R("three")]);
  await x.v.toggle();
  rec.fire("end");
  assert.deepEqual(x.log.finals, [["one two three", true]]);
});

test("clicks while stopping are ignored", async () => {
  const x = voice();
  await x.v.toggle();
  x.speech.last.fire("audiostart");
  x.speech.last.result([R("hi")]);
  await x.v.toggle();
  await x.v.toggle(); await x.v.toggle();
  assert.deepEqual(x.speech.last.calls, ["start", "stop"]);
  assert.equal(x.speech.recs.length, 1);
});

test("silence: no text and no error gives one line and nothing is sent", async () => {
  const x = voice();
  await x.v.toggle();
  x.speech.last.fire("audiostart");
  await x.v.toggle();
  x.speech.last.fire("end");
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.nothing);
  assert.equal(x.v.kind, "error");
  assert.equal(x.log.finals.length, 0);
});

test("Chrome ending the session by itself (a long pause) keeps what was heard but does not send half a question", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("took a long pause", true)]);
  rec.fire("end");  // the person never clicked Stop
  assert.deepEqual(x.log.finals, [["took a long pause", false]]);
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.paused);
  assert.equal(x.v.kind, "info");
  assert.match(x.v.message, /Click Ask to send/);
  // the next recording starts clean
  await x.v.toggle();
  assert.equal(x.v.message, "");
  x.speech.last.fire("audiostart");
  x.speech.last.result([R("more", true)]);
  await x.v.toggle();
  x.speech.last.fire("end");
  assert.deepEqual(x.log.finals.at(-1), ["more", true], "a recording stopped by a click is sent");
});

test("errors become one actionable line each; permission errors ask for Enable microphone", async () => {
  const cases = [
    ["service-not-allowed", /not allowing its speech service/, false],
    ["no-speech", /did not hear/, false], ["audio-capture", /No microphone/, false],
    ["network", /Google's speech service/, false], ["language-not-supported", /English/, false],
    ["bad-grammar", /\(bad-grammar\)/, false],
  ];
  for (const [code, rx, perm] of cases) {
    const x = voice();
    await x.v.toggle();
    x.speech.last.fire("error", { error: code });
    assert.equal(x.v.state, MIC.IDLE, code);
    assert.match(x.v.message, rx, code);
    assert.equal(x.v.kind, "error", code);
    assert.equal(x.v.needPermission, perm, code);
    assert.equal(x.log.finals.length, 0, code);
    x.speech.last.fire("end");  // the end event that follows an error changes nothing
    assert.equal(x.log.finals.length, 0, code);
    assert.match(x.v.message, rx, code);
  }
});

test("an error part way keeps the partial text for the box but does not send it", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("half a question")]);
  rec.fire("error", { error: "network" });
  assert.deepEqual(x.log.finals, [["half a question", false]]);
  assert.match(x.v.message, /Google's speech service/);
});

test("not-allowed while Chrome's permission is granted means the computer blocks the microphone: say how to fix that", async () => {
  const x = voice({ permission: "granted" });
  await x.v.toggle();
  x.speech.last.fire("error", { error: "not-allowed" });
  x.speech.last.fire("end");
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.needPermission, false, "Enable microphone cannot fix an operating-system block");
  assert.equal(x.v.message, MIC_MESSAGES.systemBlocked);
  assert.match(x.v.message, /System Settings, Privacy and Security, Microphone/);
  assert.match(x.v.message, /Windows/);
  assert.match(x.v.message, /Let desktop apps access your microphone/);
  // coming back to the panel must not replace it with a cheerful line
  assert.equal(await x.v.refreshPermission(), "granted");
  assert.equal(x.v.message, MIC_MESSAGES.systemBlocked);
  assert.equal(x.v.needPermission, false);
});

test("permission missing: no recognizer is started, the setup button is offered", async () => {
  for (const [state, rx] of [["prompt", /Microphone is off/], ["denied", /blocked/]]) {
    const x = voice({ permission: state });
    await x.v.toggle();
    assert.equal(x.speech.recs.length, 0, state);
    assert.equal(x.v.state, MIC.IDLE);
    assert.equal(x.v.needPermission, true);
    assert.match(x.v.message, rx);
    assert.equal(x.v.kind, "error");
  }
});

test("permission shown up front: refresh at panel start offers Enable microphone before any click", async () => {
  const x = voice({ permission: "prompt" });
  assert.equal(await x.v.refreshPermission(), "prompt");
  assert.equal(x.v.needPermission, true);
  assert.equal(x.v.kind, "info");
  assert.equal(x.speech.recs.length, 0);
});

test("granting in the setup tab clears the warning without starting to listen", async () => {
  const x = voice({ permission: "prompt" });
  await x.v.refreshPermission();
  x.v.noteSetupOpened();
  assert.equal(x.v.message, MIC_MESSAGES.waiting);
  x.permissions.set("granted");  // PermissionStatus change event
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(x.v.needPermission, false);
  assert.equal(x.v.message, MIC_MESSAGES.granted);
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.speech.recs.length, 0, "it does not start listening on its own");
  await x.v.toggle();  // the next click really listens
  assert.equal(x.speech.recs.length, 1);
});

test("a permission query that is unsupported still tries to listen; the recognizer's own error decides", async () => {
  const x = voice({ noPermissions: true });
  await x.v.toggle();
  assert.equal(x.speech.recs.length, 1);
  x.speech.last.fire("error", { error: "not-allowed" });
  assert.equal(x.v.needPermission, true);
});

test("no SpeechRecognition in this browser: one line, the button does nothing", async () => {
  const x = voice({ noSpeech: true });
  assert.equal(x.v.available, false);
  assert.equal(x.v.message, MIC_MESSAGES.unavailable);
  await x.v.toggle();
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.unavailable);
  assert.equal(x.speech.recs.length, 0);
});

test("start() throwing (recognizer already running) is reported, not thrown", async () => {
  const x = voice();
  const orig = x.speech.SR.prototype.start;
  x.speech.SR.prototype.start = function () { throw new Error("InvalidStateError"); };
  await x.v.toggle();
  x.speech.SR.prototype.start = orig;
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.startFailed);
});

test("a second click before audio started cancels quietly; late events are ignored", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  await x.v.toggle();
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, "");
  assert.ok(rec.calls.includes("abort"));
  rec.fire("audiostart"); rec.result([R("ghost", true)]); rec.fire("end");
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.log.finals.length, 0);
});

test("a click while the permission is still being checked cancels that start", async () => {
  const x = voice();
  const first = x.v.toggle();   // awaiting the permission query
  await x.v.toggle();           // second click: cancel
  await first;
  assert.equal(x.speech.recs.length, 0);
  assert.equal(x.v.state, MIC.IDLE);
});

test("recognizer that never reports audio is given up after the start timeout, and aborted so it cannot start later", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  await x.fire(10000);
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.startFailed);
  assert.ok(rec.calls.includes("abort"), "a slow audio device must not leave Chrome listening with nobody there");
  rec.fire("audiostart"); rec.result([R("late", true)]); rec.fire("end");
  assert.equal(x.log.finals.length, 0);
});

test("cancelling must not make a later Chrome 'aborted' error look deliberate", async () => {
  const x = voice();
  await x.v.toggle();
  await x.v.toggle();  // second click while starting: cancel
  await x.v.toggle();  // a new recording
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("what is the deal with")]);
  rec.fire("error", { error: "aborted" });  // another page or extension took the recognizer
  rec.fire("end");
  assert.deepEqual(x.log.finals, [["what is the deal with", false]], "kept in the box, not sent");
  assert.match(x.v.message, /stopped \(aborted\)/);
});

test("the permission is queried once and watched once, however many times it is refreshed", async () => {
  const x = voice({ permission: "prompt" });
  for (let i = 0; i < 20; i++) await x.v.refreshPermission();
  assert.equal(x.permissions.liveHandlers, 1, "Chrome keeps every watched PermissionStatus alive");
  x.permissions.set("granted");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(x.v.needPermission, false);
  assert.equal(x.permissions.liveHandlers, 1);
  x.permissions.set("denied");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(x.v.needPermission, true);
  assert.equal(x.permissions.liveHandlers, 1);
});

test("pause (panel hidden) stops listening, keeps the words in the box and sends nothing", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("half of a question")]);
  x.v.pause();
  assert.deepEqual(rec.calls, ["start", "stop"]);
  rec.finish([R("half of a question", true)]);
  assert.deepEqual(x.log.finals, [["half of a question", false]]);
  assert.equal(x.v.state, MIC.IDLE);
  assert.equal(x.v.message, MIC_MESSAGES.hidden);
  // hidden before audio began: cancelled quietly
  const y = voice();
  await y.v.toggle();
  y.v.pause();
  assert.equal(y.v.state, MIC.IDLE);
  assert.equal(y.v.message, "");
  // idle: nothing happens
  const z = voice();
  z.v.pause();
  assert.equal(z.v.state, MIC.IDLE);
});

test("start timeout is cancelled once audio starts", async () => {
  const x = voice();
  await x.v.toggle();
  x.speech.last.fire("audiostart");
  assert.ok(x.timers.find((t) => t.ms === 10000).cleared);
});

test("if end never arrives after stop, the text is taken after the stop timeout", async () => {
  const x = voice();
  await x.v.toggle();
  const rec = x.speech.last;
  rec.fire("audiostart");
  rec.result([R("slow to finish", true)]);
  await x.v.toggle();
  assert.equal(x.log.finals.length, 0);
  await x.fire(3000);
  assert.deepEqual(x.log.finals, [["slow to finish", true]]);
  assert.ok(rec.calls.includes("abort"));
  assert.equal(x.v.state, MIC.IDLE);
});

test("a recognizer that has finished cannot change a later recording", async () => {
  const x = voice();
  await x.v.toggle();
  const old = x.speech.last;
  old.fire("audiostart"); old.result([R("first", true)]);
  await x.v.toggle(); old.fire("end");
  await x.v.toggle();
  const now = x.speech.last;
  assert.notEqual(now, old);
  now.fire("audiostart");
  old.result([R("stale words", true)]);
  assert.equal(x.v.text, "");
  now.result([R("fresh")]);
  assert.equal(x.v.text, "fresh");
});
