// The History link of the panel, as a plain page (lib/shim.js) against the dev harness's REAL companion (fake model
// binaries, a seeded temp history log), in a throwaway headless Chrome. Mouse only: every step is a click.
// Also the footer's "Save this Dip to history" box against the real companion log (untick removes, tick restores).
//   node tests/chrome/panel-history.mjs            (screenshots: tests/chrome/screenshots.mjs)
// Prints one JSON report and exits 1 if any check failed. Everything it starts is removed on exit.
import { withBrowser } from "./chrome-run.mjs";
import { panelUrl, startHarness, stopHarness, until } from "./harness-run.mjs";

const SEEDED = 45;
const TOTAL = SEEDED + 1;   // the Dip the panel opens with is logged too
const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

let harness = null;
try {
  process.env.DIPDIVE_HARNESS_HISTORY = String(SEEDED);
  harness = await startHarness(8700 + (process.pid % 90));
  const info = harness.info;
  await withBrowser({ purpose: "panel-history checks (History link and view)", args: ["--hide-scrollbars"] }, async (b) => {
    const page = await b.open(panelUrl(info, { mode: "claude-dip", url: `${info.pages}/hist-a`, health: "codex-ready" }));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 680, deviceScaleFactor: 2, mobile: false });
    await page.send("Page.bringToFront");
    const q = (js) => page.eval(js);
    const count = () => q(`document.querySelectorAll("#historylist .hentry").length`);
    check("the Dip appeared", await until(() => q(`document.getElementById("result").textContent.includes("crater")`), 20000));

    // 1. the button, in the footer between the save box and the Settings gear; Clear history is not in the panel
    const foot = await q(`[...document.querySelectorAll("footer .links > *")].filter((e) => !e.hidden).map((e) => e.getAttribute("aria-label") || e.textContent.trim())`);
    check("footer reads Save this Dip to history, History, Settings", JSON.stringify(foot) === JSON.stringify(["Save this Dip to history", "History", "Settings"]), foot);
    check("no Clear history in the panel", await q(`!document.getElementById("clear") && !document.body.textContent.includes("Clear history")`));
    check("the gear is at least 40 px square", await q(`(() => { const r = document.getElementById("options").getBoundingClientRect(); return r.width >= 40 && r.height >= 40; })()`));
    check("the History view is closed to begin with", await q(`document.getElementById("historyview").hidden && !document.body.classList.contains("history-open")`));
    await q(`document.getElementById("page").scrollTop = 0`);

    // 2. open it with a click
    await q(`document.getElementById("historylink").click()`);
    check("the first page of 20 appears", await until(async () => (await count()) === 20, 10000), await count());
    check("the view replaces the summary and the question box", await q(`!document.getElementById("historyview").hidden && getComputedStyle(document.getElementById("page")).display === "none" && getComputedStyle(document.getElementById("ask")).display === "none"`));
    const first = await q(`(() => { const e = document.querySelector("#historylist .hentry"); const a = e.querySelector("a.htitle"); return { title: a.textContent, href: a.href, target: a.target, rel: a.rel, meta: e.querySelector(".hmeta").textContent, summary: e.querySelector(".hsummary").textContent, imgs: e.querySelectorAll("img").length }; })()`);
    check("the newest entry is the Dip just made; link opens a new tab", first.title === "Page /hist-a" && first.target === "_blank" && /noopener/.test(first.rel) && first.href === `${info.pages}/hist-a`, first);
    const seeded = await q(`(() => { const e = [...document.querySelectorAll("#historylist .hentry")][1]; const a = e.querySelector("a.htitle"); return { title: a.textContent, href: a.href, meta: e.querySelector(".hmeta").textContent, summary: e.querySelector(".hsummary").textContent, imgs: e.querySelectorAll("img").length, strong: e.querySelectorAll("strong").length, links: e.querySelectorAll(".hsummary a[target=_blank]").length }; })()`);
    check("an older entry: title, date and time with mode, rendered summary, raw HTML inert", seeded.title.startsWith("Seeded video number 44:") && /^\d{4}-\d\d-\d\d \d\d:\d\d . (Claude|Codex) (Dip|Dive)$/.test(seeded.meta) && seeded.strong === 1 && seeded.links === 1 && seeded.summary.includes("<img") && seeded.imgs === 0, seeded);
    check("status says 20 of the total", (await q(`document.getElementById("historystatus").textContent`)) === `Showing 20 of ${TOTAL}`);
    check("Show older is visible", await q(`!document.getElementById("historymore").hidden`));
    check("the list scrolls inside the panel (not the page)", await q(`(() => { const v = document.getElementById("historyview"); return v.scrollHeight > v.clientHeight && getComputedStyle(v).overflowY === "auto" && document.documentElement.scrollHeight <= window.innerHeight; })()`));
    const bar = await q(`(() => { const v = document.getElementById("historyview"); v.scrollTop = 600; const r = document.getElementById("historyback").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })()`);
    check("Back stays reachable while the list is scrolled (sticky bar, 30 px or taller)", bar[0] >= 0 && bar[0] < 40 && bar[1] >= 30, bar);
    await q(`document.getElementById("historyview").scrollTop = 0`);
    // 3. Show older, twice
    await q(`document.getElementById("historymore").click()`);
    check("Show older adds the next 20", await until(async () => (await count()) === 40, 10000), await count());
    await q(`document.getElementById("historymore").click()`);
    check("and then the last 6; the button goes away", (await until(async () => (await count()) === TOTAL, 10000)) && (await q(`document.getElementById("historymore").hidden`)));
    const titles = await q(`[...document.querySelectorAll("#historylist .htitle")].slice(1).map((a) => a.textContent.match(/number (\\d+)/)[1])`);
    check("every entry once, newest to oldest", titles.length === SEEDED && titles.every((t, i) => Number(t) === SEEDED - 1 - i), titles.slice(0, 5));

    // 4. Back
    await q(`document.getElementById("historyback").click()`);
    check("Back shows the summary and the question box again", await q(`document.getElementById("historyview").hidden && getComputedStyle(document.getElementById("page")).display !== "none" && !document.getElementById("ask").hidden && getComputedStyle(document.getElementById("ask")).display !== "none" && document.getElementById("result").textContent.includes("crater")`));

    // 5. a new summary is in the log when History is opened again
    await q(`document.querySelector('button.mode[data-mode="claude-dive"]').click()`);
    await until(() => q(`document.getElementById("status").textContent === "" && !document.body.classList.contains("busy") && document.getElementById("result").textContent.includes("crater")`), 20000);
    await q(`document.getElementById("historylink").click()`);
    check("opening again starts from the newest and has the new entry first", await until(async () => (await q(`document.querySelector("#historylist .htitle")?.textContent`)) === "Page /hist-a", 10000) &&
      (await q(`document.getElementById("historystatus").textContent`)) === `Showing 20 of ${TOTAL + 1}`, await q(`document.querySelector("#historylist .htitle")?.textContent`));
    await q(`document.getElementById("historyback").click()`);

    // 5b. untick "Save this Dive to history": the Dive's entry leaves the log; tick it again: it is back
    const total = () => q(`document.getElementById("historystatus").textContent`);
    check("the box names the Dive and is ticked", await until(() => q(`!document.getElementById("saveline").hidden && document.getElementById("savelabel").textContent === "Save this Dive to history" && document.getElementById("savehist").checked`), 10000));
    await q(`document.getElementById("savehist").click()`);
    check("unticked: the companion confirms", await until(() => q(`!document.getElementById("savehist").checked && !document.getElementById("savehist").disabled && document.getElementById("status").textContent === "Removed from history."`), 10000));
    await q(`document.getElementById("historylink").click()`);
    check("the Dive's entry is gone from History", await until(async () => (await total()) === `Showing 20 of ${TOTAL}`, 10000), await total());
    await q(`document.getElementById("historyback").click()`);
    await q(`document.getElementById("savehist").click()`);
    check("ticked again: restored", await until(() => q(`document.getElementById("savehist").checked && document.getElementById("status").textContent === "Saved to history."`), 10000));
    await q(`document.getElementById("historylink").click()`);
    check("the Dive's entry is back, newest first", await until(async () => (await total()) === `Showing 20 of ${TOTAL + 1}` && (await q(`document.querySelector("#historylist .hmeta")?.textContent`)).endsWith("Claude Dive"), 10000), await total());
    await q(`document.getElementById("historyback").click()`);
    await q(`document.querySelector('button.mode[data-mode="temp"]').click()`);
    check("Temp chat: no save box", await until(() => q(`document.getElementById("saveline").hidden && !document.getElementById("copy").hidden`), 15000));

    // 6. a wrong token: a plain message with Try again, no crash
    await page.eval(`localStorage.setItem("dipdive-dev:token", JSON.stringify("x".repeat(40)))`);
    await page.send("Page.navigate", { url: panelUrl(info, { mode: "claude-dip", url: `${info.pages}/hist-a`, health: "codex-ready", token: "x".repeat(40) }) });
    await until(() => q(`!!document.getElementById("historylink") && document.readyState === "complete"`), 10000);
    await q(`document.getElementById("historylink").click()`);
    check("a refused token shows a message and Try again", await until(() => q(`!document.getElementById("historyerror").hidden && /token/.test(document.getElementById("historyerror").textContent) && document.getElementById("historymore").textContent === "Try again"`), 10000), await q(`document.getElementById("historyerror").textContent`));
  });
} finally {
  stopHarness(harness);
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
