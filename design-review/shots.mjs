// Design review screenshots for the Waterline design, day mode, 360 px wide and full side-panel height, taken from the
// panel as a plain page (lib/shim.js) against the dev harness companion (fake model binaries, no real model call), in a
// throwaway headless Chrome.
//   node design-review/shots.mjs [port]      writes design-review/after-*.png
// Each shot runs in its own browser context, so no stored mode, slot or thread leaks from one shot to the next.
// Everything it starts (Chrome, harness, temp folders) is removed on exit, also on failure and Ctrl-C.
import fs from "node:fs";
import path from "node:path";
import { withBrowser, Page } from "../tests/chrome/chrome-run.mjs";
import { REPO, panelUrl, sleep, startHarness, stopHarness, until } from "../tests/chrome/harness-run.mjs";

const port = Number(process.argv[2] || 8931);
const out = path.join(REPO, "design-review");
const SIZE = { width: 360, height: 820 };
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
  harness = await startHarness(port);
  const info = harness.info;
  await withBrowser({ purpose: "Waterline design review screenshots", args: ["--hide-scrollbars"] }, async (b) => {
    const shot = async (name, { params, ready, flow = async () => {}, md, clip }) => {
      const { browserContextId } = await b.send("Target.createBrowserContext");
      const { targetId } = await b.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(b, targetId, sessionId);
      try {
        await page.send("Page.enable");
        await page.send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 2, mobile: false });
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
        if (md) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: inject(md) });
        await page.send("Page.navigate", { url: panelUrl(info, params) });
        if (!await until(() => page.eval(ready), 20000)) throw new Error(`${name}: the page never became ready`);
        await flow(page);
        await page.eval(`document.fonts.ready.then(() => true)`);
        await sleep(450);
        const opts = { format: "png" };
        if (clip) opts.clip = { ...(await page.eval(clip)), scale: 1 };
        const { data } = await page.send("Page.captureScreenshot", opts);
        const file = path.join(out, `after-${name}.png`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log("wrote", file);
      } finally {
        await b.send("Target.closeTarget", { targetId }).catch(() => {});
        await b.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      }
    };
    const has = (word) => `document.getElementById("result").textContent.includes(${JSON.stringify(word)}) && !document.body.classList.contains("busy")`;
    const listen = async (page) => {
      await page.eval(`document.getElementById("mic").click()`);
      if (!await until(() => page.eval(`document.getElementById("askinput").value === ${JSON.stringify(SAY)}`), 15000)) throw new Error("the scripted words never appeared");
    };
    const dip = { mode: "claude-dip", url: `${info.pages}/crater-habitable`, mic: "granted", say: SAY, health: "codex-ready" };
    const dive = { ...dip, mode: "claude-dive", url: `${info.pages}/crater-habitable-dive` };
    await shot("empty", { params: { health: "codex-ready", mic: "granted" }, ready: `!document.getElementById("hint").hidden` });
    await shot("dip", { params: dip, md: DIP, ready: has("pyrite") });
    await shot("dive", { params: dive, md: DIVE, ready: has("refuge") });
    await shot("recording", { params: dip, md: DIP, ready: has("pyrite"), flow: listen });
    await shot("pressed", { params: dip, md: DIP, ready: has("pyrite"),
      clip: `(() => { const r = document.getElementById("buttons").getBoundingClientRect(); return { x: 0, y: r.top - 16, width: 360, height: r.height + 24 }; })()` });
    await shot("history", { params: dip, md: DIP, ready: has("pyrite"), flow: async (page) => {
      await page.eval(`document.getElementById("historylink").click()`);
      if (!await until(() => page.eval(`document.querySelectorAll("#historylist .hentry").length > 0`), 15000)) throw new Error("the history list never filled");
    } });
  });
} finally {
  stopHarness(harness);
}
