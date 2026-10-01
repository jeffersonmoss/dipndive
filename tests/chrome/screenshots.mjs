// Regenerates the panel screenshots in extension/docs/: the Waterline design at 360 px wide and full side-panel height, in
// day and night (prefers-color-scheme light and dark), 2x JPEG:
//   waterline-{empty,dip,dive,recording,pressed,history,options,mic}-{light,dark}.jpg
// The panel (and the Options and microphone pages) run as plain pages (lib/shim.js) against the dev harness companion,
// which has fake model binaries: no real model is ever called. A throwaway headless Chrome, one browser context per shot so
// no stored mode, slot or thread leaks from one shot to the next.
//   node tests/chrome/screenshots.mjs [port] [outdir]      (default port 8931, outdir extension/docs)
// Everything it starts (Chrome, harness, temp folders) is removed on exit, also on failure and Ctrl-C.
import fs from "node:fs";
import path from "node:path";
import { withBrowser, Page } from "./chrome-run.mjs";
import { REPO, panelUrl, sleep, startHarness, stopHarness, until } from "./harness-run.mjs";

const port = Number(process.argv[2] || 8931);
const out = path.resolve(process.argv[3] || path.join(REPO, "extension/docs"));
const SIZE = { width: 360, height: 820 };
fs.mkdirSync(out, { recursive: true });
const SAY = "Okay so how did the microbes get";
const TITLE = "Could life have started inside an asteroid crater?";

// A Dip: three sentences and two bullets.
const DIP = [
  "No, the crater did not start life, but it gave microbes a warm, wet home for about 8 million years. Hot water kept moving through the cracked rock long after the impact cooled. That long window is why the team thinks craters like this are the best places to look on Mars.",
  "",
  "- Only 8 of 70 similar craters show any sign of life",
  "- The evidence is sulfur chemistry in pyrite, not fossils",
].join("\n");

// A Dive in the shape the Dive prompt asks for: the direct answer first, then items.
const DIVE = [
  "Probably not started, but certainly hosted. The crater stayed warm and wet for up to **8 million years**, long enough for microbes to move in, and the rock record shows they did.",
  "",
  "## What stands out",
  "",
  "- **Heat lasted far longer than expected.** Models had the impact melt cooling in under a million years; mineral veins show hot water circulating for eight times that.",
  "- **Only 8 of 70 similar craters show life.** The difference was groundwater: the habitable ones sat on fractured, water-bearing rock.",
  "- **The evidence is chemical, not fossil.** Sulfur isotopes in pyrite carry the signature that only sulfate-reducing microbes leave behind.",
  "- **Colonization was fast.** The first traces appear within about 1,000 years of the impact, once the water dropped below roughly 120 degrees C.",
  "- **Early Mars had the same setup.** Jezero and Gale both sit in impact basins with long-lived hot springs.",
  "",
  "## The obvious next question",
  "",
  "Could the impact have *started* life rather than just hosted it? The authors say no: the microbes arrived from the surrounding rock, and the crater only offered a long-lived refuge.",
  "",
  "1. Drill core taken in 2016, analysed over six years.",
  "2. Dated by argon-argon on the melt rock, cross-checked with uranium-lead.",
  "3. The team names two follow-up sites in Australia and Canada.",
  "",
  "Full paper: [the study](https://example.com/study).",
].join("\n");

// Replaces the summary text and title in the companion's job answer, so the panel renders them like any other answer.
const inject = (md) => `(() => {
  const MD = ${JSON.stringify(md)}, TITLE = ${JSON.stringify(TITLE)};
  const orig = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await orig(...a);
    const u = String((a[0] && a[0].url) || a[0]).split("?")[0];
    if (!/\\/jobs\\/[^/]+$/.test(u)) return r;
    const j = await r.clone().json().catch(() => null);
    if (!j) return r;
    j.title = TITLE;
    if (typeof j.result_markdown === "string" && !j.question) j.result_markdown = MD;
    return new Response(JSON.stringify(j), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
})();`;

let harness = null;
try {
  process.env.DIPDIVE_HARNESS_HISTORY = "12";  // the History shot needs a few entries; the harness log is a temp file
  harness = await startHarness(port);
  const info = harness.info;
  const page = (name, params) => `${info.front}/ext/${name}?${new URLSearchParams({ base: `${info.front}/c`, token: info.token, ...params })}`;
  await withBrowser({ purpose: "Waterline screenshots for extension/docs", args: ["--hide-scrollbars"] }, async (b) => {
    const shot = async (name, scheme, { url, ready, flow = async () => {}, md, clip }) => {
      const { browserContextId } = await b.send("Target.createBrowserContext");
      const { targetId } = await b.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
      const p = new Page(b, targetId, sessionId);
      try {
        await p.send("Page.enable");
        await p.send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 2, mobile: false });
        await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        if (md) await p.send("Page.addScriptToEvaluateOnNewDocument", { source: inject(md) });
        await p.send("Page.navigate", { url });
        if (!await until(() => p.eval(ready), 20000)) throw new Error(`${name}: the page never became ready`);
        await flow(p);
        await p.eval(`document.fonts.ready.then(() => true)`);
        await sleep(450);
        const opts = { format: "jpeg", quality: 90 };
        if (clip) opts.clip = { ...(await p.eval(clip)), scale: 1 };
        const { data } = await p.send("Page.captureScreenshot", opts);
        const file = path.join(out, `waterline-${name}-${scheme}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log("wrote", file);
      } finally {
        await b.send("Target.closeTarget", { targetId }).catch(() => {});
        await b.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      }
    };
    const has = (word) => `document.getElementById("result").textContent.includes(${JSON.stringify(word)}) && !document.body.classList.contains("busy") && !document.getElementById("saveline").hidden`;
    const listen = async (p) => {
      await p.eval(`document.getElementById("mic").click()`);
      if (!await until(() => p.eval(`document.getElementById("askinput").value === ${JSON.stringify(SAY)}`), 15000)) throw new Error("the scripted words never appeared");
    };
    const dip = { mode: "claude-dip", url: `${info.pages}/crater-habitable`, mic: "granted", say: SAY, health: "codex-ready" };
    const dive = { ...dip, mode: "codex-dive", url: `${info.pages}/crater-habitable-dive` };
    for (const scheme of ["light", "dark"]) {
      await shot("empty", scheme, { url: panelUrl(info, { health: "codex-ready", mic: "granted" }), ready: `!document.getElementById("hint").hidden` });
      // scrolled to the foot of the page: the "Save this Dip to history" box, History and the gear
      await shot("dip", scheme, { url: panelUrl(info, dip), md: DIP, ready: has("pyrite"), flow: async (p) => {
        await p.eval(`(() => { const pg = document.getElementById("page"); pg.scrollTop = pg.scrollHeight; return true; })()`);
      } });
      await shot("dive", scheme, { url: panelUrl(info, dive), md: DIVE, ready: has("refuge") });
      await shot("recording", scheme, { url: panelUrl(info, dip), md: DIP, ready: has("pyrite"), flow: listen });
      await shot("pressed", scheme, { url: panelUrl(info, { ...dip, mode: "claude-dive" }), md: DIP, ready: has("pyrite"),
        clip: `(() => { const r = document.getElementById("buttons").getBoundingClientRect(); return { x: 0, y: r.top - 16, width: 360, height: r.height + 24 }; })()` });
      await shot("history", scheme, { url: panelUrl(info, dip), md: DIP, ready: has("pyrite"), flow: async (p) => {
        await p.eval(`document.getElementById("historylink").click()`);
        if (!await until(() => p.eval(`document.querySelectorAll("#historylist .hentry").length > 2`), 15000)) throw new Error("the history list never filled");
      } });
      await shot("options", scheme, { url: page("options.html", {}), ready: `document.getElementById("token").value.length > 30`, flow: async (p) => {
        await p.eval(`document.getElementById("clear").click()`);  // the confirmation step, not confirmed
      } });
      await shot("mic", scheme, { url: page("mic.html", {}), ready: `!document.getElementById("retry").hidden` });
    }
  });
} finally {
  stopHarness(harness);
}
