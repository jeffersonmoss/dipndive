// The panel as a plain page (lib/shim.js) against the dev harness's REAL companion (fake model binaries), in a throwaway
// headless Chrome: the left-to-right order of the five buttons (four modes and the pin in the center) (on screen and in the Tab order), and the cross-machine
// Clear history refusal with the panel's own code reacting to the companion's real 409.
//   node tests/chrome/panel-plain.mjs
// Prints one JSON report and exits 1 if any check failed. Everything it starts is removed on exit.
import { withBrowser } from "./chrome-run.mjs";
import { panelUrl, sleep, startHarness, stopHarness, until } from "./harness-run.mjs";

// the pin has no data-mode: it is an action, so it shows as "pin" in these lists
const EXPECTED = ["claude-dive", "claude-dip", "pin", "codex-dip", "codex-dive"];
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
    const dom = await q(`[...document.querySelectorAll("#buttons button")].map((b) => b.dataset.mode || b.id)`);
    check("buttons are in the DOM order Claude Dive, Claude Dip, pin, Codex Dip, Codex Dive", JSON.stringify(dom) === JSON.stringify(EXPECTED), dom);
    const lefts = await q(`[...document.querySelectorAll("#buttons button")].map((b) => Math.round(b.getBoundingClientRect().left))`);
    check("left edges increase in that order (it is also the visual order)", lefts.every((x, i) => i === 0 || x > lefts[i - 1]), lefts);
    const sizes = await q(`[...document.querySelectorAll("#buttons button")].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
    check("the five squares are square and 56 px or larger", sizes.every(([w, h]) => Math.abs(w - h) <= 2 && w >= 56), sizes);
    const labels = await q(`[...document.querySelectorAll("#buttons button")].map((b) => b.title)`);
    check("titles read Claude Dive, Claude Dip, Summarize this page, Codex Dip, Codex Dive", JSON.stringify(labels) === JSON.stringify(["Claude Dive", "Claude Dip", "Summarize this page", "Codex Dip", "Codex Dive"]), labels);
    await q(`document.getElementById("go").focus()`);
    const tabbed = [];
    for (let i = 0; i < 12 && tabbed.length < 5; i++) {
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const m = await q(`document.activeElement && (document.activeElement.dataset.mode || (document.activeElement.closest("#buttons") ? document.activeElement.id : "")) || ""`);
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

    // 6. the pin: summarizes the "active tab" (the shim's stand-in) with the selected mode (Claude Dive after step 5), never pressed
    const SHORT = "This page cannot be summarized. Open a web page (an http or https address) and try again.";
    const pressedNow = () => q(`[...document.querySelectorAll("#buttons button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.mode)`);
    await q(`window.__devTab = ${JSON.stringify(info.pages + "/plain-b")}; document.getElementById("pin").click()`);
    const pinned = await until(() => q(`document.getElementById("urlinput").value.endsWith("/plain-b") && document.getElementById("result").textContent.includes("crater") && !document.body.classList.contains("busy")`), 20000);
    check("the pin summarized the active tab's page with the selected mode", pinned);
    check("the permission was asked inside that click", (await q(`window.__permAsks`)) === 1);
    check("the pin never took the pressed look; Claude Dive is still the only pressed button", JSON.stringify(await pressedNow()) === JSON.stringify(["claude-dive"]) && (await q(`document.getElementById("pin").getAttribute("aria-pressed")`)) === null);
    check("the pin is the same size as the mode squares", await q(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const a = r("pin"), b = document.querySelector('button.mode[data-mode="claude-dip"]').getBoundingClientRect(); return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1; })()`));
    const urlBefore = await q(`document.getElementById("urlinput").value`);
    await q(`window.__devTab = "chrome://newtab/"; document.getElementById("pin").click()`);
    const refused = await until(() => q(`document.getElementById("error").textContent`), 4000);
    check("a browser page in the active tab gives the short message", refused === SHORT, refused);
    check("and the summary and source on screen stay, not busy", (await q(`document.getElementById("result").textContent.includes("crater") && document.getElementById("urlinput").value === ${JSON.stringify(urlBefore)} && !document.body.classList.contains("busy")`)));
    await q(`window.__devTab = ""; document.getElementById("pin").click()`);
    check("no tab in the window: its own message", await until(() => q(`document.getElementById("error").textContent === "No page is open in this window."`), 4000));
  });

  // 7. the tabs permission refused: the pin explains and sends nothing
  await withBrowser({ purpose: "panel-plain pin: permission refused", args: ["--hide-scrollbars"] }, async (b) => {
    const page = await b.open(panelUrl(info, { mode: "claude-dip", health: "codex-ready", perm: "denied", tab: `${info.pages}/plain-c` }));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 680, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.bringToFront");
    const q = (js) => page.eval(js);
    await until(() => q(`document.getElementById("pin") !== null && !document.getElementById("hint").hidden`), 10000);
    await q(`document.getElementById("pin").click()`);
    const msg = await until(() => q(`document.getElementById("error").textContent`), 4000);
    check("permission refused: one clear message with the way forward", /needs to read its address/.test(msg || "") && /choose Allow/.test(msg || ""), msg);
    await sleep(800);
    check("permission refused: nothing summarized, not busy", await q(`document.getElementById("result").textContent === "" && !document.body.classList.contains("busy") && document.getElementById("urlinput").value === ""`));
  });

  // 8. an old install's stored mode "temp": the default mode is used and the key is forgotten
  await withBrowser({ purpose: "panel-plain: old temp mode", args: ["--hide-scrollbars"] }, async (b) => {
    const page = await b.open(panelUrl(info, { mode: "temp", health: "codex-ready", url: `${info.pages}/plain-d` }));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 680, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.bringToFront");
    const q = (js) => page.eval(js);
    const ok = await until(() => q(`document.getElementById("result").textContent.includes("Codex says") && !document.body.classList.contains("busy")`), 20000);
    check("old temp mode: the default mode (Codex Dip) ran as a normal Dip", ok);
    check("old temp mode: only Codex Dip is pressed and the stored mode key is gone", (await q(`[...document.querySelectorAll("#buttons button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.mode).join()`)) === "codex-dip" && (await q(`localStorage.getItem("dipdive-dev:mode")`)) === null);
  });
} finally {
  stopHarness(harness);
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
