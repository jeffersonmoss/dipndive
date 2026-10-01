// Regenerates extension/docs/panel-light.jpg, panel-dark.jpg, panel-listening.jpg and panel-codex-off.jpg: the panel as a
// plain page (lib/shim.js) against the dev harness companion (fake model binaries), in a throwaway headless Chrome.
//   node tests/chrome/screenshots.mjs [outdir]        (default: extension/docs)
// Everything it starts (Chrome, harness, temp folders) is removed on exit, also on failure and Ctrl-C.
import fs from "node:fs";
import path from "node:path";
import { withBrowser } from "./chrome-run.mjs";
import { REPO, panelUrl, sleep, startHarness, stopHarness, until } from "./harness-run.mjs";

const out = path.resolve(process.argv[2] || path.join(REPO, "extension/docs"));
const WIDE = { width: 400, height: 680 }, NARROW = { width: 320, height: 560 };
const QUESTION = "Okay what is the deal with the chocolate";

let harness = null;
try {
  harness = await startHarness(8900 + (process.pid % 90));
  const info = harness.info;
  await withBrowser({ purpose: "panel screenshots for extension/docs", args: ["--hide-scrollbars"] }, async (b) => {
    const shot = async (name, { size, scheme, params, flow }) => {
      const page = await b.open(panelUrl(info, params));
      try {
        await page.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false });
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        const ok = await until(() => page.eval(`document.getElementById("result").textContent.includes("crater")`), 20000);
        if (!ok) throw new Error(`${name}: the Dip summary never appeared`);
        await flow(page);
        await sleep(300);
        const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
        fs.writeFileSync(path.join(out, name), Buffer.from(data, "base64"));
        console.log("wrote", path.join(out, name));
      } finally {
        await b.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      }
    };
    const ask = async (page) => {
      await page.eval(`(() => { const i = document.getElementById("askinput"); i.value = ${JSON.stringify(QUESTION)}; i.dispatchEvent(new Event("input")); document.getElementById("askform").requestSubmit(); })()`);
      if (!await until(() => page.eval(`document.querySelectorAll("#thread .turn:not(.pending)").length === 1`), 20000)) throw new Error("the answer never appeared");
      await page.eval(`document.getElementById("page").scrollTop = 0`);
    };
    const listen = async (page) => {
      await page.eval(`document.getElementById("mic").click()`);
      if (!await until(() => page.eval(`document.getElementById("askinput").value === "Okay what is the"`), 10000)) throw new Error("the scripted words never appeared");
    };
    // health=codex-ready: the panel treats Codex as available without waiting for the companion's (slow, cached) /health
    const base = { mode: "claude-dip", url: `${info.pages}/shot-listen`, mic: "granted", say: "Okay what is the", health: "codex-ready" };
    await shot("panel-light.jpg", { size: WIDE, scheme: "light", params: base, flow: ask });
    await shot("panel-dark.jpg", { size: WIDE, scheme: "dark", params: base, flow: ask });
    await shot("panel-listening.jpg", { size: WIDE, scheme: "light", params: base, flow: listen });
    await shot("panel-codex-off.jpg", { size: NARROW, scheme: "light", params: { mode: "codex-dip", url: `${info.pages}/shot-off`, health: "off", mic: "granted" }, flow: async () => {} });
  });
} finally {
  stopHarness(harness);
}
