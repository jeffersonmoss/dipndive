// The History button and the History tab (history.html), and the status line's "Save this Dip to history" box, as plain
// pages (lib/shim.js) against the dev harness's REAL companion (fake model binaries, a seeded temp history log), in a
// throwaway headless Chrome. Mouse only: every step is a click (and typing in the search box).
//   node tests/chrome/panel-history.mjs            (screenshots: tests/chrome/screenshots.mjs)
// Prints one JSON report and exits 1 if any check failed. Everything it starts is removed on exit.
import { withBrowser } from "./chrome-run.mjs";
import { panelUrl, startHarness, stopHarness, until } from "./harness-run.mjs";

const SEEDED = 145;          // more than one page of 100: the History tab must follow the pages to the end
const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

let harness = null;
try {
  process.env.DIPDIVE_HARNESS_HISTORY = String(SEEDED);
  harness = await startHarness(8700 + (process.pid % 90));
  const info = harness.info;
  const api = async (method, path) => (await fetch(`${info.front}/c${path}`, { method, headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined })).json();
  const logged = async () => (await api("GET", "/history?limit=1")).total;
  await withBrowser({ purpose: "panel-history checks (History tab and save box)", args: ["--hide-scrollbars"] }, async (b) => {
    const page = await b.open(panelUrl(info, { mode: "claude-dip", url: `${info.pages}/hist-a`, health: "codex-ready" }));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 2, mobile: false });
    await page.send("Page.bringToFront");
    const q = (js) => page.eval(js);
    check("the Dip appeared", await until(() => q(`document.getElementById("result").textContent.includes("crater") && !document.getElementById("saveline").hidden`), 20000));

    // 1. the bottom row and the status line
    const row = await q(`[...document.querySelectorAll("#askrow button, #askrow input")].map((e) => e.getAttribute("aria-label") || e.textContent.trim())`);
    check("bottom row reads History, question, Speak, Ask", JSON.stringify(row) === JSON.stringify(["History", "Your question", "Speak", "Ask"]), row);
    check("the bottom row's buttons are 36 px or taller", await q(`[...document.querySelectorAll("#askrow button")].every((b) => { const r = b.getBoundingClientRect(); return r.width >= 36 && r.height >= 36; })`));
    const foot = await q(`[...document.querySelectorAll("footer .links > *")].filter((e) => !e.hidden).map((e) => e.getAttribute("aria-label") || e.textContent.trim())`);
    check("status line has Save this Dip to history and Settings", JSON.stringify(foot) === JSON.stringify(["Save this Dip to history", "Settings"]), foot);
    check("no Clear history and no in-panel history view", await q(`!document.getElementById("clear") && !document.getElementById("historyview") && !document.body.textContent.includes("Clear history")`));
    check("the gear is at least 28 px square", await q(`(() => { const r = document.getElementById("options").getBoundingClientRect(); return r.width >= 28 && r.height >= 28; })()`));
    const names = await q(`[...document.querySelectorAll("#buttons button")].map((b) => [b.textContent.trim(), b.title, !!b.querySelector("img, svg")])`);
    check("mode buttons: a logo each, named and titled Claude Dive ... Codex Dive", JSON.stringify(names) === JSON.stringify(["Claude Dive", "Claude Dip", "Temp chat", "Codex Dip", "Codex Dive"].map((n) => [n, n, true])), names);
    check("every mode logo loaded", await q(`[...document.querySelectorAll("#buttons img")].every((i) => i.complete && i.naturalWidth > 0)`));

    // 2. the History button opens the History tab (the dev shim records the URL it would open)
    await q(`document.getElementById("historylink").click()`);
    check("History opens history.html in a tab", await until(() => q(`(window.__lastTab || "").endsWith("/history.html")`), 5000), await q(`window.__lastTab`));

    // 3. untick "Save this Dip to history": the entry leaves the real log; tick it again: it is back
    const before = await logged();
    await q(`document.getElementById("savehist").click()`);
    check("unticked: the companion confirms", await until(() => q(`!document.getElementById("savehist").checked && !document.getElementById("savehist").disabled && document.getElementById("status").textContent === "Removed from history."`), 10000));
    check("the entry is gone from the log", (await logged()) === before - 1, [before, await logged()]);
    await q(`document.getElementById("savehist").click()`);
    check("ticked again: restored", await until(() => q(`document.getElementById("savehist").checked && document.getElementById("status").textContent === "Saved to history."`), 10000));
    check("the entry is back", (await logged()) === before);
    await q(`document.querySelector('button.mode[data-mode="temp"]').click()`);
    check("Temp chat: no save box", await until(() => q(`document.getElementById("saveline").hidden && !document.getElementById("copy").hidden`), 15000));

    // 4. the History tab: every entry (more than one page), newest first, then a live search
    const hp = await b.open(`${info.front}/ext/history.html?${new URLSearchParams({ base: `${info.front}/c`, token: info.token })}`);
    await hp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    const h = (js) => hp.eval(js);
    const total = await logged();
    check("the whole log is loaded", await until(() => h(`document.body.dataset.loaded === "yes" && document.querySelectorAll("#list .hentry").length === ${total}`), 15000), [total, await h(`document.querySelectorAll("#list .hentry").length`)]);
    check("newest first: the Dip just made is at the top", (await h(`document.querySelector("#list .htitle").textContent`)) === "Page /hist-a");
    check("the count says how many", (await h(`document.getElementById("count").textContent`)) === `${total} entries, newest first`);
    check("raw HTML in a summary stays text, no image is made", await h(`document.querySelectorAll("#list img").length === 0 && document.getElementById("list").textContent.includes("<img src=x onerror=alert(1)>")`));
    await h(`(() => { const s = document.getElementById("search"); s.value = "NUMBER 14 channel"; s.dispatchEvent(new Event("input")); return true; })()`);
    const shown = await h(`[...document.querySelectorAll("#list .hentry")].filter((e) => !e.hidden).map((e) => e.querySelector(".htitle").textContent.match(/number (\\d+)/)[1])`);
    // "number 14" matches 14 and 140 to 144; "channel" is in every seeded entry's text except those with no channel (i % 3 == 0)
    const expect = [144, 143, 142, 141, 140, 14].filter((i) => i % 3 !== 0).map(String);
    check("search: every word, any case, title, channel and summary", JSON.stringify(shown) === JSON.stringify(expect), shown);
    check("the count follows the search", (await h(`document.getElementById("count").textContent`)) === `${expect.length} of ${total} entries match`);
    await h(`(() => { const s = document.getElementById("search"); s.value = ""; s.dispatchEvent(new Event("input")); return true; })()`);
    check("clearing the search shows everything again", (await h(`[...document.querySelectorAll("#list .hentry")].filter((e) => !e.hidden).length`)) === total);

    // 5. a refused token: a plain message, no crash
    const bad = await b.open(`${info.front}/ext/history.html?${new URLSearchParams({ base: `${info.front}/c`, token: "x".repeat(40) })}`);
    check("a refused token shows a plain message", await until(() => bad.eval(`document.body.dataset.loaded === "error" && /token/.test(document.getElementById("error").textContent)`), 10000));
  });
} finally {
  stopHarness(harness);
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
