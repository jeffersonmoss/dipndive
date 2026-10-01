// Does webkitSpeechRecognition work on a chrome-extension:// page once the extension origin may use the mic?
// Runs the real Chrome on this Mac with a throwaway profile and a fake microphone fed from a WAV made by `say`.
//   node tools/speech-probe.mjs [--headed] [--phrase "text"] [--fake-ui]
// Prints one JSON object. Without --fake-ui the grant is made with Browser.grantPermissions (stored setting,
// like a user's Allow), so no prompt is bypassed by a flag.
import fs from "node:fs";
import path from "node:path";
import { withBrowser, sh, TMP } from "./chrome-run.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const phrase = val("--phrase", "Okay, what is the deal with the chocolate?"); // only used for the fake-mic WAV, which speech recognition does not read (see RESULTS)
const headed = flag("--headed");

const manifest = {
  manifest_version: 3, name: "speech probe", version: "1", permissions: ["sidePanel"],
  side_panel: { default_path: "probe.html" }, background: { service_worker: "sw.js" },
  action: { default_title: "probe" },
};
const page = `<!doctype html><meta charset=utf-8><title>probe</title><script src="probe.js"></script>`;
const script = `
window.run = async (ms) => {
  const out = { ua: navigator.userAgent, hasSR: typeof webkitSpeechRecognition, origin: location.origin, events: [] };
  try { out.permission = (await navigator.permissions.query({ name: "microphone" })).state; } catch (e) { out.permission = "query failed: " + e.message; }
  try {
    const s = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("no answer in 6 s (prompt pending?)")), 6000))]);
    out.getUserMedia = "ok"; s.getTracks().forEach((t) => t.stop());
  } catch (e) { out.getUserMedia = e.name + ": " + e.message; }
  if (typeof webkitSpeechRecognition === "undefined") return out;
  const r = new webkitSpeechRecognition();
  r.lang = "en-US"; r.interimResults = true; r.continuous = true;
  const t0 = performance.now(); const ev = (n, x) => out.events.push([Math.round(performance.now() - t0), n, x]);
  let finals = []; let interim = "";
  r.onstart = () => ev("start"); r.onaudiostart = () => ev("audiostart"); r.onspeechstart = () => ev("speechstart");
  r.onspeechend = () => ev("speechend"); r.onaudioend = () => ev("audioend");
  r.onerror = (e) => ev("error", e.error + (e.message ? " " + e.message : ""));
  r.onresult = (e) => { interim = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) finals.push(x[0].transcript); else interim += x[0].transcript; } ev("result", { finalWords: finals.join(" ").split(/\s+/).filter(Boolean).length, interimWords: interim.split(/\s+/).filter(Boolean).length }); };
  const ended = new Promise((res) => { r.onend = () => { ev("end"); res(); }; });
  try { r.start(); } catch (e) { ev("start threw", e.message); return out; }
  await new Promise((res) => setTimeout(res, ms));
  ev("stop() called"); try { r.stop(); } catch {}
  await Promise.race([ended, new Promise((res) => setTimeout(res, 5000))]);
  out.transcriptWords = (finals.join(" ").trim() || interim).split(/\s+/).filter(Boolean).length; // text withheld on purpose: it is ambient room audio
  return out;
};`;

const dir = fs.mkdtempSync(path.join(TMP, "dipdive-probesrc-"));
const wavDir = dir;
try {
  fs.writeFileSync(path.join(dir, "TEMP_README.md"), "# Temporary folder\n\nPurpose: speech probe extension and fake-mic WAV\nMade by: T1 Dip Dive chat, " + new Date().toISOString().slice(0, 10) + "\nNeeded until: the probe run ends\nCostly to recreate: no.\n");
  fs.mkdirSync(path.join(dir, "ext"));
  fs.writeFileSync(path.join(dir, "ext", "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "ext", "probe.html"), page);
  fs.writeFileSync(path.join(dir, "ext", "probe.js"), script);
  fs.writeFileSync(path.join(dir, "ext", "sw.js"), "");
  sh("say", ["-v", "Samantha", "-o", path.join(wavDir, "p.aiff"), phrase]);
  sh("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "2", path.join(wavDir, "p.aiff"), path.join(wavDir, "p.wav")]);
  const result = await withBrowser({
    extensions: [fs.realpathSync(path.join(dir, "ext"))], headless: !headed, purpose: "speech probe",
    // --no-sandbox: the sandboxed audio service cannot read the fake-mic WAV (verified: silence with the sandbox on).
    // Acceptable here only because this throwaway Chrome loads nothing but our own extension page.
    args: ["--no-sandbox", ...(headed ? ["--window-position=-3000,-3000", "--window-size=800,600"] : []), "--use-fake-device-for-media-stream", ...(flag("--no-file") ? [] : [`--use-file-for-fake-audio-capture=${path.join(wavDir, "p.wav")}${flag("--loop") ? "" : "%noloop"}`]),
      ...(flag("--fake-ui") ? ["--use-fake-ui-for-media-stream"] : [])],
  }, async (b) => {
    const id = b.ids[0];
    const origin = `chrome-extension://${id}`;
    let grant = "not attempted";
    if (!flag("--fake-ui") && !flag("--no-grant")) {
      try { await b.send("Browser.grantPermissions", { origin, permissions: ["audioCapture"] }); grant = "Browser.grantPermissions ok"; }
      catch (e) { grant = "Browser.grantPermissions failed: " + e.message; }
    }
    console.error("grant:", grant);
    let p = await b.open(`${origin}/probe.html`);
    await p.send("Page.bringToFront"); // a background page never gets getUserMedia answered
    await new Promise((r) => setTimeout(r, 800));
    let context = "tab";
    if (flag("--side-panel")) {
      // Open the real side panel (needs a user gesture, which Runtime.evaluate can supply), then attach to its target.
      const before = new Set((await b.send("Target.getTargets")).targetInfos.map((t) => t.targetId));
      await p.eval("chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id })).then(() => 'opened')", { userGesture: true });
      let sp = null;
      for (let i = 0; i < 30 && !sp; i++) {
        await new Promise((r) => setTimeout(r, 200));
        sp = (await b.send("Target.getTargets")).targetInfos.find((t) => !before.has(t.targetId) && t.url.startsWith(origin + "/probe.html"));
      }
      if (!sp) throw new Error("side panel target did not appear");
      const { sessionId } = await b.send("Target.attachToTarget", { targetId: sp.targetId, flatten: true });
      p = new (p.constructor)(b, sp.targetId, sessionId);
      context = "side panel (target type " + sp.type + ")";
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error("page open, running in", context);
    const res = await Promise.race([p.eval("run(8000)", { userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("probe timed out after 40 s")), 40000))]);
    return { extensionId: id, grant, context, headed, ...res };
  });
  console.log(JSON.stringify(result, null, 1));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
