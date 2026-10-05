// The pin button ("Summarize this page") in the REAL extension, a REAL side panel and REAL tabs, in a throwaway Chrome, against
// the dev harness companion (fake model binaries, no real model call).
//   node tests/chrome/panel-pin.mjs
// Part A, the real manifest (tabs is an optional permission, not granted): in the side panel Chrome hides the address of the
// active web tab (chrome.tabs.query gives a tab without a url), and a click on the pin makes the panel call
// chrome.permissions.request({ permissions: ["tabs"] }), which Chrome answers with its native prompt (still waiting: a script cannot
// click it), while nothing is sent to the companion and no slot is written.
// Part B, a patched copy that already holds "tabs" (what Allow does; the click on Allow is the only step a script cannot make):
// the same click asks (Chrome answers true at once, no prompt, when the permission is held), reads the real active tab, writes the
// window's slot, and the companion summarizes THAT page; a chrome:// page and about:blank give the short message and change nothing.
// The page tab is on 127.0.0.1 and the extension's host access is only for localhost, so the address is visible through "tabs"
// alone, never through host access.
// Prints one JSON report and exits 1 if any check failed. Everything it starts is removed on exit.
import fs from "node:fs";
import path from "node:path";
import { Page, withBrowser, TMP } from "./chrome-run.mjs";
import { REPO, sleep, startHarness, stopHarness, until } from "./harness-run.mjs";

const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };
const SHORT = "This page cannot be summarized. Open a web page (an http or https address) and try again.";

// A copy of the extension. `patch(manifest)` changes the manifest; test, docs and node_modules are left out.
function extCopy(dir, name, patch) {
  const dst = path.join(dir, name);
  fs.cpSync(path.join(REPO, "extension"), dst, { recursive: true, filter: (s) => !/\/(test|docs|node_modules)(\/|$)/.test(s) });
  const m = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"));
  patch(m);
  fs.writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(m));
  return fs.realpathSync(dst);
}

// One throwaway Chrome: an extension page (to seed storage and open the side panel from), a web tab on `pageUrl`, the side panel.
async function session(b, { base, token, pageUrl, mode }, fn) {
  const id = b.ids[0];
  const origin = `chrome-extension://${id}`;
  const targets = async () => (await b.send("Target.getTargets")).targetInfos;
  const attachTo = async (t) => {
    const { sessionId } = await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    return new Page(b, t.targetId, sessionId);
  };
  const ext = await b.open(`${origin}/options.html`);
  await ext.send("Page.bringToFront");
  await sleep(500);
  const winId = await ext.eval("chrome.windows.getCurrent().then((w) => w.id)");
  await ext.eval(`chrome.storage.local.set({ base: ${JSON.stringify(base)}, token: ${JSON.stringify(token)}, mode: ${JSON.stringify(mode)} })`);
  const web = await b.open(pageUrl);  // a new foreground tab in the same window: the active tab
  await web.send("Page.bringToFront");
  await sleep(500);
  const before = new Set((await targets()).map((t) => t.targetId));
  await ext.eval(`chrome.sidePanel.open({ windowId: ${winId} }).then(() => "ok")`, { userGesture: true });
  const spTarget = await until(async () => (await targets()).find((t) => !before.has(t.targetId) && t.url.startsWith(origin + "/panel.html")), 8000, 150);
  check("side panel opened by chrome.sidePanel.open", !!spTarget);
  if (!spTarget) return;
  const panel = await attachTo(spTarget);
  await until(() => panel.eval(`document.getElementById("pin") !== null`), 8000, 150);
  await fn({ b, ext, web, panel, winId, origin, targets, attachTo });
}

// A real mouse click inside the side panel (a trusted gesture), falling back to the DevTools user-gesture flag.
async function clickPin(panel) {
  const r = await panel.eval(`(() => { const r = document.getElementById("pin").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await panel.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
}

let harness = null;
const src = fs.mkdtempSync(path.join(TMP, "dipdive-pinsrc-"));
try {
  fs.writeFileSync(path.join(src, "TEMP_README.md"), `# Temporary folder\n\nPurpose: extension copies for tests/chrome/panel-pin.mjs\nMade by: T1 Dip Dive chat, ${new Date().toISOString().slice(0, 10)}\nNeeded until: the run ends (it deletes this folder)\nCostly to recreate: no.\n`);
  harness = await startHarness(8800 + (process.pid % 90), { delay: "0.3" });
  const { front, token, pages } = harness.info;
  const frontPort = new URL(front).port;
  const pageUrl = `${pages}/pin-a`;                 // http://127.0.0.1:<port>/pin-a
  const localhostBase = `http://localhost:${frontPort}/c`;
  const q = (p, js) => p.eval(js);
  report.chrome = (await import("node:child_process")).execFileSync(process.env.DIPDIVE_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--version"], { encoding: "utf8" }).trim();

  // ---------------- Part A: the real manifest ----------------
  const realExt = extCopy(src, "real", () => {});
  await withBrowser({ extensions: [realExt], headless: false, purpose: "pin part A (real manifest)", args: ["--window-position=-3000,-3000", "--window-size=900,900"] }, async (b) => {
    await session(b, { base: localhostBase, token, pageUrl, mode: "claude-dip" }, async ({ ext, web, panel, winId }) => {
      const manifest = await q(panel, `chrome.runtime.getManifest()`);
      check("the installed manifest asks for tabs only as an optional permission", JSON.stringify(manifest.optional_permissions) === '["tabs"]' && !(manifest.permissions || []).includes("tabs") && !manifest.host_permissions, { permissions: manifest.permissions, optional: manifest.optional_permissions });
      check("the tabs permission is not held", (await q(panel, `chrome.permissions.contains({ permissions: ["tabs"] })`)) === false);
      const tab = await q(panel, `chrome.tabs.query({ active: true, windowId: ${winId} }).then((t) => JSON.stringify({ n: t.length, hasUrl: t[0] && t[0].url !== undefined, url: t[0] && t[0].url }))`);
      const seen = JSON.parse(tab);
      check("without the permission the side panel cannot read the active web tab's address (this is why the permission is needed)", seen.n === 1 && seen.hasUrl === false, seen);
      check("the active tab really is the web page (the page itself can say so)", (await q(web, `location.href`)) === pageUrl && (await q(web, `document.title`)).includes("pin-a"));
      // log what the panel really asks Chrome, calling the real API underneath
      await q(panel, `(() => { const real = chrome.permissions.request.bind(chrome.permissions); window.__asks = []; chrome.permissions.request = (p) => { const e = { p, t: Date.now(), done: false, v: null }; window.__asks.push(e); const pr = real(p); pr.then((v) => { e.done = true; e.v = v; }, (er) => { e.done = true; e.v = String(er); }); return pr; }; return true; })()`);
      await clickPin(panel);
      const asked = await until(() => q(panel, `window.__asks.length > 0`), 4000, 100);
      check("a click on the pin made the panel call chrome.permissions.request", !!asked);
      const ask = await q(panel, `JSON.stringify(window.__asks[0] || null)`);
      check("the request is exactly { permissions: [\"tabs\"] }, no origins", ask && JSON.stringify(JSON.parse(ask).p) === '{"permissions":["tabs"]}', ask);
      await sleep(3000);
      const after = JSON.parse(await q(panel, `JSON.stringify(window.__asks[0])`));
      check("Chrome did not answer: its native prompt is waiting for the person (nothing in the page can click it)", after.done === false, after);
      check("meanwhile nothing was sent and no slot was written", (await q(ext, `chrome.storage.local.get(null).then((s) => Object.keys(s).filter((k) => k.startsWith("slot:")).length)`)) === 0 && (await q(panel, `document.getElementById("result").textContent === "" && document.getElementById("error").hidden`)));
    });
  });

  // ---------------- Part B: a copy that already holds "tabs" ----------------
  const heldExt = extCopy(src, "held", (m) => {
    delete m.optional_host_permissions;
    delete m.optional_permissions;
    m.permissions = [...m.permissions, "tabs"];
    m.host_permissions = ["http://localhost/*"];  // the companion is reached as localhost; the page tab (127.0.0.1) is NOT covered by it
  });
  await withBrowser({ extensions: [heldExt], headless: false, purpose: "pin part B (tabs held)", args: ["--window-position=-3000,-3000", "--window-size=900,900"] }, async (b) => {
    await session(b, { base: localhostBase, token, pageUrl, mode: "claude-dive" }, async ({ ext, web, panel, winId }) => {
      const sees = JSON.parse(await q(panel, `chrome.tabs.query({ active: true, windowId: ${winId} }).then((t) => JSON.stringify({ url: t[0] && t[0].url }))`));
      check("with tabs held the side panel reads the active web tab's address", sees.url === pageUrl, sees);
      check("the page tab is not covered by host access (so it is tabs, not a host grant, that shows the address)", !(await q(panel, `chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] })`)));
      await q(panel, `(() => { const real = chrome.permissions.request.bind(chrome.permissions); window.__asks = []; chrome.permissions.request = (p) => { const e = { p, t: Date.now(), done: false, v: null }; window.__asks.push(e); const pr = real(p); pr.then((v) => { e.done = true; e.v = v; e.ms = Date.now() - e.t; }); return pr; }; return true; })()`);
      const slotOf = async () => (await q(ext, `chrome.storage.local.get("slot:${winId}").then((s) => JSON.stringify(s["slot:${winId}"] || null))`));
      check("no slot before the click", (await slotOf()) === "null");
      const pressedBefore = await q(panel, `[...document.querySelectorAll("#buttons button[aria-pressed=true]")].map((x) => x.dataset.mode).join()`);
      check("the selected mode is pressed (Claude Dive) and the pin is not a mode button", pressedBefore === "claude-dive" && (await q(panel, `!document.getElementById("pin").hasAttribute("aria-pressed") && document.getElementById("pin").dataset.mode === undefined`)));
      await clickPin(panel);
      const gotSummary = await until(() => q(panel, `document.getElementById("result").textContent.includes("crater") && !document.body.classList.contains("busy")`), 25000, 200);
      check("the click summarized the page in the active tab with the selected mode (the companion's fake Claude answer appeared)", !!gotSummary);
      const ask = JSON.parse(await q(panel, `JSON.stringify(window.__asks[0] || null)`));
      check("Chrome answered the permission request true at once, with no prompt, because tabs was held", ask && ask.done === true && ask.v === true && ask.ms < 1500, ask);
      const slot = JSON.parse(await slotOf());
      check("the window's slot holds the tab's real address, a requestId, this window, the mode and the job", slot && slot.url === pageUrl && typeof slot.requestId === "string" && slot.requestId.length > 8 && slot.windowId === winId && slot.mode === "claude-dive" && slot.consumed === true && !!slot.jobId, slot);
      check("the panel shows that address as the source", (await q(panel, `document.getElementById("urlinput").value`)) === pageUrl);
      check("the pressed button is still Claude Dive; the pin never took the pressed look", (await q(panel, `[...document.querySelectorAll("#buttons button[aria-pressed=true]")].map((x) => x.dataset.mode).join()`)) === "claude-dive" && (await q(panel, `document.getElementById("pin").getAttribute("aria-pressed")`)) === null);
      check("it is in the history like a right-click would be (the save box is shown and ticked)", await until(() => q(panel, `!document.getElementById("saveline").hidden && document.getElementById("savehist").checked`), 6000, 200));
      const hist = await (await fetch(`${front}/c/history?limit=5`, { headers: { Authorization: `Bearer ${token}` } })).json();
      check("and the companion's history log has that page's entry", JSON.stringify(hist).includes("pin-a"), (hist.entries || []).map((e) => e.url));
      const storedMode = await q(ext, `chrome.storage.local.get("mode").then((s) => s.mode)`);
      check("the stored mode is unchanged by the pin", storedMode === "claude-dive");

      // a chrome:// page in the active tab
      for (const target of ["chrome://version/", "about:blank"]) {
        await q(panel, `window.__asks.length = 0`);
        const nav = await b.send("Target.createTarget", { url: target });  // a new foreground tab showing a non-web page
        await sleep(700);
        const slotBefore = await slotOf();
        await clickPin(panel);
        const msg = await until(() => q(panel, `document.getElementById("error").hidden ? "" : document.getElementById("error").textContent`), 6000, 150);
        check(`${target} in the active tab gives the short message`, msg === SHORT, msg);
        check(`${target}: nothing was submitted, the slot is unchanged and the summary on screen stays`, (await slotOf()) === slotBefore && (await q(panel, `document.getElementById("result").textContent.includes("crater")`)));
        await b.send("Target.closeTarget", { targetId: nav.targetId });
        await sleep(300);
      }
      // back on the web page: it works again and the message goes away
      await web.send("Page.bringToFront");
      await sleep(500);
      await clickPin(panel);
      const again = await until(() => q(panel, `document.getElementById("error").hidden && document.getElementById("result").textContent.includes("crater") && !document.body.classList.contains("busy")`), 25000, 200);
      check("back on a web page the pin works again and the message is gone", !!again);
    });
  });
} catch (e) {
  report.fatal = String((e && e.stack) || e);
  process.exitCode = 1;
} finally {
  stopHarness(harness);
  fs.rmSync(src, { recursive: true, force: true });
  if (report.checks.some((c) => !c.ok)) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 1));
}
