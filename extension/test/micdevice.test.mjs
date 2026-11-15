import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MIC_DEVICE, displayName, listMics, micInfo, micWarning, resolveMic, sameMic } from "../lib/micdevice.js";
import { MIC } from "../lib/voice.js";
import { makePermissions, makeSpeech, rig, slot } from "./rig.mjs";

const dev = (deviceId, label) => ({ kind: "audioinput", deviceId, label });
const md = (list) => ({ enumerateDevices: async () => list });
const flush = () => new Promise((r) => setTimeout(r, 5));
const USB = "Microphone (2- USB Audio Device)", BUILTIN = "Microphone (Realtek(R) Audio)";
const windows = (usb = true) => [dev("default", `Default - ${usb ? USB : BUILTIN}`), dev("communications", `Communications - ${BUILTIN}`),
  ...(usb ? [dev("usb1", USB)] : []), dev("rt1", BUILTIN), { kind: "videoinput", deviceId: "v", label: "cam" }];

test("every microphone is listed, with the one Chrome uses by default named", async () => {
  const l = await listMics(md(windows()));
  assert.deepEqual(l, { inputs: [{ id: "usb1", label: USB }, { id: "rt1", label: BUILTIN }], defaultName: USB, none: false, named: true });
  assert.deepEqual(await listMics(md([dev("x", "Only Mic")])), { inputs: [{ id: "x", label: "Only Mic" }], defaultName: "Only Mic", none: false, named: true });
  assert.equal((await listMics(md([dev("default", ""), dev("a", "")]))).named, false, "names hidden until allowed");
  assert.deepEqual(await listMics(md([])), { inputs: [], defaultName: "", none: true, named: false });
  assert.equal(await listMics(null), null);
  assert.equal(await listMics({ enumerateDevices: async () => { throw new Error("x"); } }), null);
});

test("Windows' re-plug number, case and the Default prefix do not make a different microphone", () => {
  assert.ok(sameMic("Microphone (2- USB Audio Device)", "Microphone (3- USB Audio Device)"));
  assert.ok(sameMic("Default - Microphone (USB Audio Device)", "microphone (usb audio device)"));
  assert.ok(!sameMic(BUILTIN, USB));
  assert.ok(!sameMic("", ""));
  assert.equal(displayName("Communications - Headset"), "Headset");
});

test("the picked microphone is used while connected; missing, the default input is used and a warning shows", async () => {
  const on = await listMics(md(windows(true))), off = await listMics(md(windows(false)));
  assert.deepEqual(resolveMic(on, "Microphone (3- USB Audio Device)"), { use: { id: "usb1", label: USB }, missing: false });
  assert.deepEqual(resolveMic(off, USB), { use: null, missing: true });
  assert.deepEqual(resolveMic(on, ""), { use: null, missing: false });
  assert.equal(micWarning(on, USB), "");
  assert.equal(micWarning(on, ""), "", "nothing picked (the Macs): never a warning");
  assert.equal(micWarning(off, USB), `${USB} is not connected. Dictation is using ${BUILTIN} instead. Unplug it and plug it back in.`);
  assert.match(micWarning({ inputs: [], defaultName: "", none: true, named: false }, USB), /No microphone found/);
  assert.equal(micWarning(null, USB), "");
});

test("the popup lists System default and every microphone, with the one in use checked", async () => {
  const on = await listMics(md(windows(true))), off = await listMics(md(windows(false)));
  assert.deepEqual(micInfo(on, "").rows, [
    { id: "", label: `System default (${USB})`, chosen: true }, { id: "usb1", label: USB, chosen: false }, { id: "rt1", label: BUILTIN, chosen: false }]);
  assert.deepEqual(micInfo(on, USB).rows.map((r) => r.chosen), [false, true, false]);
  const missing = micInfo(off, USB).rows;
  assert.deepEqual(missing.at(-1), { id: "", label: `${USB} (not connected)`, chosen: true, missing: true, value: USB });
  assert.match(micInfo({ inputs: [{ id: "a", label: "" }], defaultName: "", none: false, named: false }, "").line, /once the microphone is allowed/);
  assert.equal(micInfo(null, "").line, "Chrome cannot list microphones here.");
});

function devices(withUsb = true) {
  const d = { usb: withUsb, fns: [], opened: [],
    list: async () => listMics(md(windows(d.usb))),
    watch: (fn) => d.fns.push(fn),
    track: async (id) => { const t = { id, stopped: false, stop() { this.stopped = true; } }; d.opened.push(t); return t; } };
  d.change = (usb) => { d.usb = usb; d.fns.forEach((f) => f()); };
  return d;
}

test("controller: each recording opens the picked microphone and hands it to Chrome, and closes it after", async () => {
  const d = devices(true);
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), micDevices: d });
  r.store[MIC_DEVICE.preferredKey] = USB;
  await r.c.init(1); await r.tick();
  const startArgs = [];
  const orig = speech.SR.prototype.start;
  speech.SR.prototype.start = function (...a) { startArgs.push(a[0]); return orig.apply(this, a); };
  await r.c.toggleMic();
  assert.equal(d.opened.length, 1);
  assert.equal(d.opened[0].id, "usb1");
  assert.equal(startArgs[0], d.opened[0], "the USB track is what Chrome listens to");
  speech.last.fire("audiostart");
  await r.c.toggleMic();
  speech.last.fire("end");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.equal(d.opened[0].stopped, true, "the microphone is released when the recording ends");
  await r.c.setPreferredMic("");  // System default
  await r.c.toggleMic();
  assert.equal(d.opened.length, 1, "no track: Chrome's default input");
  assert.equal(startArgs.at(-1), undefined);
  speech.SR.prototype.start = orig;
});

test("controller: the picked microphone dropping out shows a warning; plugging it back in clears it", async () => {
  const d = devices(false);
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), micDevices: d });
  r.store[MIC_DEVICE.preferredKey] = USB;
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  assert.equal(d.opened.length, 0, "not connected: nothing opened, the default input is used");
  speech.last.fire("audiostart");
  await flush();
  assert.match(r.state.last.micWarn, /is not connected\. Dictation is using Microphone \(Realtek/);
  d.change(true);
  await flush();
  assert.equal(r.state.last.micWarn, "");
  await r.c.setPreferredMic("");
  assert.equal(r.store[MIC_DEVICE.preferredKey], undefined);
});

test("controller: with nothing picked, nothing is opened, checked or shown", async () => {
  const d = devices(true);
  let listed = 0;
  const l = d.list; d.list = async () => { listed++; return l(); };
  const speech = makeSpeech();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), micDevices: d });
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  speech.last.fire("audiostart");
  await flush();
  assert.equal(r.state.last.micWarn, "");
  assert.equal(listed, 0);
  assert.equal(d.opened.length, 0);
});

test("panel: right-click on the mic opens the picker, which Escape and an outside click close; the pick stays on this computer", () => {
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  assert.match(js, /\$\("mic"\)\.addEventListener\("contextmenu", \(e\) => \{ e\.preventDefault\(\);/);
  assert.match(js, /window\.addEventListener\("keydown", \(e\) => \{\s*if \(e\.key === "Escape" && !\$\("micinfo"\)\.hidden\)/);
  assert.match(js, /micDevices: \{ list: \(\) => listMics\(mediaDevices\), watch:/);
  for (const id of ["micwarn", "micinfo", "micinfo-list", "micinfo-close"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(!/storage\.sync/.test(fs.readFileSync(new URL("../lib/micdevice.js", import.meta.url), "utf8")));
});
