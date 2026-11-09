import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MIC_DEVICE, currentMic, displayName, micInfo, micWarning, sameMic } from "../lib/micdevice.js";
import { makePermissions, makeSpeech, rig, slot } from "./rig.mjs";

const dev = (deviceId, label) => ({ kind: "audioinput", deviceId, label });
const md = (list) => ({ enumerateDevices: async () => list });
const flush = () => new Promise((r) => setTimeout(r, 5));

test("the default input names the microphone dictation uses, on Mac and Windows labels", async () => {
  assert.deepEqual(await currentMic(md([dev("default", "Default - MacBook Pro Microphone (Built-in)"), dev("a1", "MacBook Pro Microphone (Built-in)")])),
    { name: "MacBook Pro Microphone (Built-in)", none: false });
  assert.deepEqual(await currentMic(md([dev("default", "Default - Microphone (2- USB Audio Device)"), dev("communications", "Communications - Realtek"), { kind: "videoinput", deviceId: "v", label: "cam" }])),
    { name: "Microphone (2- USB Audio Device)", none: false });
  assert.deepEqual(await currentMic(md([dev("x", "Only Mic")])), { name: "Only Mic", none: false });
  assert.deepEqual(await currentMic(md([dev("default", "")])), { name: "", none: false }, "names hidden until allowed");
  assert.deepEqual(await currentMic(md([])), { name: "", none: true });
  assert.equal(await currentMic(null), null);
  assert.equal(await currentMic({ enumerateDevices: async () => { throw new Error("x"); } }), null);
});

test("Windows' re-plug number, case and the Default prefix do not make a different microphone", () => {
  assert.ok(sameMic("Microphone (2- USB Audio Device)", "Microphone (3- USB Audio Device)"));
  assert.ok(sameMic("Default - Microphone (USB Audio Device)", "microphone (usb audio device)"));
  assert.ok(!sameMic("Microphone (Realtek(R) Audio)", "Microphone (2- USB Audio Device)"));
  assert.ok(!sameMic("", ""));
  assert.equal(displayName("Communications - Headset"), "Headset");
});

test("no warning unless a microphone was marked on this computer", () => {
  const usb = "Microphone (2- USB Audio Device)";
  assert.equal(micWarning({ name: "MacBook Pro Microphone", none: false }, ""), "", "the Macs never mark one, so never warn");
  assert.equal(micWarning({ name: "Microphone (4- USB Audio Device)", none: false }, usb), "");
  assert.match(micWarning({ name: "Microphone (Realtek(R) Audio)", none: false }, usb), /Dictation is using Microphone \(Realtek\(R\) Audio\), not Microphone \(2- USB Audio Device\)\. Unplug/);
  assert.match(micWarning({ name: "", none: true }, usb), /No microphone found/);
  assert.equal(micWarning({ name: "", none: false }, usb), "", "names hidden: nothing to compare");
  assert.equal(micWarning(null, usb), "");
});

test("the right-click popup: name, whether it is his, and which buttons show", () => {
  assert.deepEqual(micInfo({ name: "USB Mic", none: false }, ""), { line: "USB Mic", mine: false, canMark: true, canForget: false, preferred: "" });
  assert.deepEqual(micInfo({ name: "USB Mic", none: false }, "USB Mic"), { line: "USB Mic", mine: true, canMark: false, canForget: true, preferred: "USB Mic" });
  assert.equal(micInfo({ name: "Built-in", none: false }, "USB Mic").canMark, true);
  assert.match(micInfo({ name: "", none: false }, "").line, /once the microphone is allowed/);
  assert.equal(micInfo({ name: "", none: true }, "").line, "No microphone found.");
  assert.equal(micInfo(null, "").canMark, false);
});

function devices(name) {
  const d = { name, fns: [], current: async () => (d.name === null ? { name: "", none: true } : { name: d.name, none: false }), watch: (fn) => d.fns.push(fn) };
  d.change = (n) => { d.name = n; d.fns.forEach((f) => f()); };
  return d;
}

test("controller: warns when a recording starts on another mic, follows a drop-out and a re-plug, and stays quiet with no marked mic", async () => {
  const usb = "Microphone (2- USB Audio Device)";
  const d = devices("Microphone (Realtek(R) Audio)");
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), micDevices: d });
  r.store[MIC_DEVICE.preferredKey] = usb;
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.preferredMic, usb);
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await flush();
  assert.match(r.state.last.micWarn, /Dictation is using Microphone \(Realtek/);
  d.change("Microphone (3- USB Audio Device)");  // he re-plugged it
  await flush();
  assert.equal(r.state.last.micWarn, "");
  d.change(null);  // the hub dropped out mid-dictation
  await flush();
  assert.match(r.state.last.micWarn, /No microphone found/);
  await r.c.setPreferredMic("");  // Stop checking
  assert.equal(r.state.last.micWarn, "");
  assert.equal(r.store[MIC_DEVICE.preferredKey], undefined);
  await r.c.setPreferredMic("USB Mic");
  assert.equal(r.store[MIC_DEVICE.preferredKey], "USB Mic");
});

test("controller: without a marked microphone nothing is checked or shown", async () => {
  const d = devices("MacBook Pro Microphone");
  let asked = 0;
  const cur = d.current; d.current = async () => { asked++; return cur(); };
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), micDevices: d });
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await flush();
  assert.equal(r.state.last.micWarn, "");
  assert.equal(asked, 0);
});

test("panel: right-click on the mic opens the popup, which Escape and an outside click close", () => {
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  assert.match(js, /\$\("mic"\)\.addEventListener\("contextmenu", \(e\) => \{ e\.preventDefault\(\);/);
  assert.match(js, /window\.addEventListener\("keydown", \(e\) => \{\s*if \(e\.key === "Escape" && !\$\("micinfo"\)\.hidden\)/);
  assert.match(js, /micDevices: \{ current: \(\) => currentMic\(mediaDevices\), watch:/);
  for (const id of ["micwarn", "micinfo", "micinfo-name", "micinfo-mark", "micinfo-forget", "micinfo-close"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(!/storage\.sync/.test(fs.readFileSync(new URL("../lib/micdevice.js", import.meta.url), "utf8")), "the marked mic stays on this computer");
});
