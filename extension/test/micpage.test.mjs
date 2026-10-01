import test from "node:test";
import assert from "node:assert/strict";
import { ALLOW_BUTTON, BUSY_HELP, SYSTEM_BLOCK_HELP, classifyMicError } from "../lib/micerrors.js";

// The real mic.js run against a stubbed page: what each failure of getUserMedia tells the person.
let seq = 0;
async function runPage({ reject, state, stopped = [] }) {
  const els = {};
  for (const id of ["msg", "retry", "settings", "close"]) els[id] = { hidden: false, textContent: "", className: "", addEventListener() {} };
  const saved = { document: globalThis.document, chrome: globalThis.chrome, location: globalThis.location, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  globalThis.document = { getElementById: (id) => els[id] };
  globalThis.chrome = { runtime: { sendMessage: async () => {} }, tabs: {} };
  globalThis.location = { origin: "chrome-extension://abc" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => { if (reject) throw Object.assign(new Error(reject.message), { name: reject.name }); return { getTracks: () => [{ stop: () => stopped.push("stop") }] }; } },
    permissions: { query: async () => ({ state }) },
  } });
  try {
    await import(`../mic.js?run=${++seq}`);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const k of ["document", "chrome", "location"]) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; }
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
  return els;
}

test("classification: Chrome's block, the computer's block, a busy device, a closed prompt, no device", () => {
  assert.equal(classifyMicError("NotAllowedError", "Permission denied", "denied"), "chrome-blocked");
  assert.equal(classifyMicError("NotAllowedError", "Permission denied by system", "granted"), "system-blocked");
  assert.equal(classifyMicError("NotAllowedError", "Permission denied by system", null), "system-blocked");
  assert.equal(classifyMicError("NotAllowedError", "Permission denied by system", "prompt"), "system-blocked");
  assert.equal(classifyMicError("NotAllowedError", "Permission dismissed", "prompt"), "dismissed");
  assert.equal(classifyMicError("NotAllowedError", "Permission dismissed", "granted"), "system-blocked", "granted and still refused: not Chrome");
  assert.equal(classifyMicError("NotReadableError", "Could not start audio source", "granted"), "busy");
  assert.equal(classifyMicError("AbortError", "", "granted"), "busy");
  assert.equal(classifyMicError("NotFoundError", "Requested device not found", "granted"), "no-device");
  assert.equal(classifyMicError(undefined, undefined, null), "dismissed");
});

test("mic page: an operating-system block is explained for Mac and Windows, not 'try again and click Allow'", async () => {
  const els = await runPage({ reject: { name: "NotAllowedError", message: "Permission denied by system" }, state: "granted" });
  const t = els.msg.textContent;
  assert.match(t, /Your computer is blocking the microphone/);
  assert.match(t, /System Settings, Privacy and Security, Microphone/);
  assert.match(t, /quit and reopen Chrome/);
  assert.match(t, /Settings, Privacy and security, Microphone/);
  assert.match(t, /Let desktop apps access your microphone/);
  assert.ok(!/prompt was closed/.test(t));
  assert.equal(els.msg.className, "bad");
  assert.equal(els.retry.hidden, false);
  assert.ok(t.startsWith(SYSTEM_BLOCK_HELP));
});

test("mic page: a busy or failing microphone says so", async () => {
  const els = await runPage({ reject: { name: "NotReadableError", message: "Could not start audio source" }, state: "granted" });
  assert.equal(els.msg.textContent, BUSY_HELP);
  assert.match(els.msg.textContent, /Another app may be using it/);
  assert.equal(els.retry.hidden, false);
});

test("mic page: a closed prompt names the real button; a Chrome block offers Chrome's setting; no device is said plainly", async () => {
  const dismissed = await runPage({ reject: { name: "NotAllowedError", message: "Permission dismissed" }, state: "prompt" });
  assert.match(dismissed.msg.textContent, /prompt was closed/);
  assert.ok(dismissed.msg.textContent.includes(ALLOW_BUTTON));
  assert.equal(ALLOW_BUTTON, "Allow while visiting the site");
  assert.equal(dismissed.settings.hidden, true);
  const blocked = await runPage({ reject: { name: "NotAllowedError", message: "Permission denied" }, state: "denied" });
  assert.match(blocked.msg.textContent, /Chrome has blocked the microphone/);
  assert.equal(blocked.settings.hidden, false);
  const none = await runPage({ reject: { name: "NotFoundError", message: "Requested device not found" }, state: "granted" });
  assert.match(none.msg.textContent, /No microphone was found/);
});

test("mic page: success stops the tracks at once and says to go back to the panel", async () => {
  const stopped = [];
  const els = await runPage({ state: "granted", stopped });
  assert.deepEqual(stopped, ["stop"]);
  assert.equal(els.msg.className, "ok");
  assert.match(els.msg.textContent, /go back to the Dip'n'Dive panel/);
  assert.equal(els.close.hidden, false);
});
