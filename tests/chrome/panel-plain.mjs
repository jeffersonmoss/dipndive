// The panel as a plain page (lib/shim.js) against the dev harness's REAL companion (fake model binaries), in a throwaway
// headless Chrome: the left-to-right order of the five buttons (on screen and in the Tab order), and the cross-machine
// Clear history refusal with the panel's own code reacting to the companion's real 409.
//   node tests/chrome/panel-plain.mjs
// Prints one JSON report and exits 1 if any check failed. Everything it starts is removed on exit.
import { withBrowser } from "./chrome-run.mjs";
import { panelUrl, sleep, startHarness, stopHarness, until } from "./harness-run.mjs";

const EXPECTED = ["claude-dive", "claude-dip", "temp", "codex-dip", "codex-dive"];
const MESSAGE = "History was cleared on another machine.";
const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

let harness = null;
try {
  harness = await startHarness(8800 + (process.pid % 90));
  const info = harness.info;
  // Another machine presses Clear history: straight to the companion, not through the panel.
  const clearElsewhere = async () => {
    const r = await fetch(`${info.front}/c/clear`, { method: "POST", headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" }, body: "{}" });
    return (await r.json()).clear_generation;
  };
  await withBrowser({ purpose: "panel-plain checks (button order, cross-machine clear)", args: ["--hide-scrollbars"] }, async (b) => {
    const page = await b.open(panelUrl(info, { mode: "claude-dip", url: `${info.pages}/plain-a`, health: "codex-ready" }));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 680, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.bringToFront");
    const q = (js) => page.eval(js);
    const shown = (sel) => q(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const ready = await until(() => q(`document.getElementById("result").textContent.includes("crater")`), 20000);
    check("the Dip appeared", ready);

    // 1. order on screen and in the Tab order
    const dom = await q(`[...document.querySelectorAll("#buttons button")].map((b) => b.dataset.mode)`);
    check("buttons are in the DOM order Claude Dive, Claude Dip, Temp chat, Codex Dip, Codex Dive", JSON.stringify(dom) === JSON.stringify(EXPECTED), dom);
    const lefts = await q(`[...document.querySelectorAll("#buttons button")].map((b) => Math.round(b.getBoundingClientRect().left))`);
    check("left edges increase in that order (it is also the visual order)", lefts.every((x, i) => i === 0 || x > lefts[i - 1]), lefts);
    const sizes = await q(`[...document.querySelectorAll("#buttons button")].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
    // Waterline: the buttons are columns hanging to their depth (Dive deepest, Temp chat shallowest), at least 56 px wide
    const depth = sizes.map(([, h]) => h);
    check("the five columns are 56 px or wider and hang to their depth (Dive > Dip > Temp chat)", sizes.every(([w, h]) => w >= 56 && h >= 56) &&
      depth[0] === depth[4] && depth[1] === depth[3] && depth[0] > depth[1] && depth[1] > depth[2], sizes);
    const labels = await q(`[...document.querySelectorAll("#buttons button")].map((b) => b.title)`);
    check("titles read Claude Dive, Claude Dip, Temp chat, Codex Dip, Codex Dive", JSON.stringify(labels) === JSON.stringify(["Claude Dive", "Claude Dip", "Temp chat", "Codex Dip", "Codex Dive"]), labels);
    await q(`document.getElementById("go").focus()`);
    const tabbed = [];
    for (let i = 0; i < 12 && tabbed.length < 5; i++) {
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const m = await q(`document.activeElement && document.activeElement.dataset && document.activeElement.dataset.mode || ""`);
      if (m) tabbed.push(m);
    }
    check("Tab visits the five buttons in the same left-to-right order", JSON.stringify(tabbed) === JSON.stringify(EXPECTED), tabbed);
    const pressed = await q(`[...document.querySelectorAll("#buttons button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.mode)`);
    check("exactly one button is pressed: the selected mode", JSON.stringify(pressed) === JSON.stringify(["claude-dip"]), pressed);

    // 2. a question is answered (so there is a thread), then another machine clears
    await q(`(() => { const i = document.getElementById("askinput"); i.value = "first question"; i.dispatchEvent(new Event("input")); document.getElementById("askform").requestSubmit(); })()`);
    const answered = await until(() => q(`document.querySelectorAll("#thread .turn:not(.pending)").length === 1`), 20000);
    check("a question was answered (a thread exists)", answered);
    const gen = await clearElsewhere();
    check("another machine cleared (the companion's generation moved on)", gen >= 1, gen);

    // 3. the next question is refused: thread and summary reset, the message shown next to the box, the question back in it
    await q(`(() => { const i = document.getElementById("askinput"); i.value = "second question"; i.dispatchEvent(new Event("input")); document.getElementById("askform").requestSubmit(); })()`);
    const refusedAsk = await until(() => q(`document.getElementById("askerror").textContent === ${JSON.stringify(MESSAGE)}`), 8000);
    check("the question was refused with the message next to the box", refusedAsk, await shown("#askerror"));
    check("the question is back in the box", (await q(`document.getElementById("askinput").value`)) === "second question");
    check("thread and summary are gone", (await q(`document.querySelectorAll("#thread .turn").length === 0 && document.getElementById("result").textContent === ""`)));
    await sleep(1500);
    check("nothing was sent again by itself (no answer, not busy)", await q(`document.querySelectorAll("#thread .turn").length === 0 && !document.body.classList.contains("busy")`));

    // 4. the same question again (the person's own action) works with the new generation
    await q(`document.getElementById("askform").requestSubmit()`);
    const second = await until(() => q(`document.querySelectorAll("#thread .turn:not(.pending)").length === 1`), 20000);
    check("asking again works and the thread starts over", second && (await q(`document.getElementById("askerror").hidden`)));

    // 5. a mode button after another machine cleared: refused in the page, nothing resubmitted, pressing again works
    await clearElsewhere();
    await q(`document.querySelector('button.mode[data-mode="claude-dive"]').click()`);
    const refusedBtn = await until(() => q(`document.getElementById("error").textContent === ${JSON.stringify(MESSAGE)}`), 8000);
    check("a button press was refused with the message in the page", refusedBtn, await shown("#error"));
    check("summary and thread are empty and the panel is not busy", await q(`document.getElementById("result").textContent === "" && document.querySelectorAll("#thread .turn").length === 0 && !document.body.classList.contains("busy")`));
    await sleep(1500);
    check("no automatic resubmission (still no summary after waiting)", await q(`document.getElementById("result").textContent === ""`));
    await q(`document.querySelector('button.mode[data-mode="claude-dive"]').click()`);
    const again = await until(() => q(`document.getElementById("result").textContent.includes("crater") && document.getElementById("error").hidden`), 20000);
    check("pressing again works", again);
  });
} finally {
  stopHarness(harness);
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
