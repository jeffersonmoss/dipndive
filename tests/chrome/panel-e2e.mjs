// The real extension in a real (throwaway) Chrome, against the dev harness companion with faked model binaries.
//   node tests/chrome/panel-e2e.mjs
// Checks, in the actual side panel: the panel reaches the companion, the question box shows, a missing microphone grant
// is detected and offered as Enable microphone, the button opens mic.html in a tab, mic.html asks and reports back,
// the panel notices the grant, and the mic button really listens with webkitSpeechRecognition (the room's own audio is
// what it hears, so what was said is never printed, only whether something was recognized).
// Uses Browser.grantPermissions / setPermission as the stand-in for a person clicking Allow or Block (headless
// CDP cannot click Chrome's prompt). Prints one JSON report. Everything it starts is removed on exit.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Page, withBrowser, TMP } from "./chrome-run.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

async function until(fn, ms = 10000, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* the page may still be loading: look again */ }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

async function startHarness(port) {
  const proc = spawn(path.join(REPO, ".venv/bin/python"), ["-m", "tests.dev_harness", String(port)], {
    cwd: REPO, detached: true, env: { ...process.env, DIPDIVE_FAKE_DELAY: "0.4" }, stdio: ["ignore", "pipe", "ignore"],
  });
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    proc.on("exit", () => reject(new Error("harness exited")));
    setTimeout(() => reject(new Error("harness did not start")), 15000);
  });
  return { proc, info };
}

function stopHarness(h) {
  if (!h) return;
  try { process.kill(-h.proc.pid, "SIGTERM"); } catch { /* gone */ }
}

// A patched copy of the extension: host access for http://127.0.0.1 granted up front (the real one asks through the
// options page, which a script cannot click), nothing else changed.
function patchedCopy(dir) {
  const dst = path.join(dir, "ext");
  fs.cpSync(path.join(REPO, "extension"), dst, { recursive: true, filter: (s) => !/\/(test|docs|node_modules)(\/|$)/.test(s) });
  const m = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"));
  delete m.optional_host_permissions;
  m.host_permissions = ["http://127.0.0.1/*"];
  fs.writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(m));
  return fs.realpathSync(dst);
}

const src = fs.mkdtempSync(path.join(TMP, "dipdive-probesrc-"));
let harness = null;
try {
  fs.writeFileSync(path.join(src, "TEMP_README.md"), `# Temporary folder\n\nPurpose: patched extension copy for tests/chrome/panel-e2e.mjs\nMade by: T1 Dip Dive chat, ${new Date().toISOString().slice(0, 10)}\nNeeded until: the run ends\nCostly to recreate: no.\n`);
  harness = await startHarness(8800 + (process.pid % 150));
  const { front, token, pages } = harness.info;
  const ext = patchedCopy(src);
  await withBrowser({
    extensions: [ext], headless: false, purpose: "panel e2e",
    args: ["--window-position=-3000,-3000", "--window-size=900,900", "--use-fake-device-for-media-stream"],
  }, async (b) => {
    const id = b.ids[0];
    const origin = `chrome-extension://${id}`;
    const targets = async () => (await b.send("Target.getTargets")).targetInfos;
    const attachTo = async (t) => {
      const { sessionId } = await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      return new Page(b, t.targetId, sessionId);
    };

    // 1. an ordinary extension page to seed storage and to open the side panel from (needs a user gesture)
    const tab = await b.open(`${origin}/options.html`);
    await tab.send("Page.bringToFront");
    await sleep(500);
    const winId = await tab.eval("chrome.windows.getCurrent().then((w) => w.id)");
    await tab.eval(`chrome.storage.local.set({ base: ${JSON.stringify(front + "/c")}, token: ${JSON.stringify(token)}, mode: "claude-dip",
      ["slot:${winId}"]: { url: ${JSON.stringify(pages + "/a")}, requestId: "e2e-slot", windowId: ${winId}, ts: Date.now(), consumed: false } })`);
    const before = new Set((await targets()).map((t) => t.targetId));
    await tab.eval(`chrome.sidePanel.open({ windowId: ${winId} }).then(() => "ok")`, { userGesture: true });
    const spTarget = await until(async () => (await targets()).find((t) => !before.has(t.targetId) && t.url.startsWith(origin + "/panel.html")), 8000);
    check("side panel opened by chrome.sidePanel.open", !!spTarget);
    if (!spTarget) return;
    const panel = await attachTo(spTarget);
    const q = (js) => panel.eval(js);

    // 2. companion reached from the real extension context, Dip shown, question box visible
    const gotSummary = await until(() => q(`document.getElementById("result").textContent.includes("crater")`), 20000);
    check("panel reached the companion and showed the Dip summary", gotSummary);
    check("question box is shown below the result", await q(`!document.getElementById("ask").hidden && document.getElementById("result").compareDocumentPosition(document.getElementById("askform")) & Node.DOCUMENT_POSITION_FOLLOWING`));

    // 3. microphone not granted yet: detected up front, Enable microphone offered
    const perm0 = await q(`navigator.permissions.query({ name: "microphone" }).then((s) => s.state)`);
    const offered = await until(() => q(`!document.getElementById("micsetup").hidden`), 4000);
    report.permissionBeforeGrant = perm0;
    check("missing microphone permission detected and Enable microphone offered", perm0 === "prompt" && offered, { state: perm0, message: await q(`document.getElementById("micmsg").textContent`) });
    await q(`document.getElementById("mic").click()`);
    await sleep(300);
    check("clicking the mic without permission starts no recording and keeps the offer", await q(`document.getElementById("mic").dataset.state === "idle" && !document.getElementById("micsetup").hidden`));

    // 4. Enable microphone opens mic.html in a normal tab
    const beforeTabs = new Set((await targets()).map((t) => t.targetId));
    await q(`document.getElementById("micsetup").click()`);
    const micTarget = await until(async () => (await targets()).find((t) => !beforeTabs.has(t.targetId) && t.url.startsWith(origin + "/mic.html")), 6000);
    check("Enable microphone opened mic.html in a normal tab", !!micTarget && micTarget.type === "page");
    if (!micTarget) return;
    const mic = await attachTo(micTarget);
    await mic.send("Page.bringToFront");
    await sleep(600);
    check("the tab is waiting for Chrome's prompt (no grant yet)", /Allow/.test(await mic.eval(`document.getElementById("msg").textContent`)));

    // 5. blocked: message and the settings button
    await b.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied", origin });
    await mic.send("Page.reload"); await sleep(1200);
    const denied = await mic.eval(`({ msg: document.getElementById("msg").textContent, settings: !document.getElementById("settings").hidden, retry: !document.getElementById("retry").hidden })`);
    check("blocked microphone: mic.html explains and offers Chrome's setting", /blocked/.test(denied.msg) && denied.settings && denied.retry, denied.msg);
    await sleep(300);
    check("the panel shows the blocked wording after the change", /blocked/.test(await q(`document.getElementById("micmsg").textContent`)) || /Microphone is off/.test(await q(`document.getElementById("micmsg").textContent`)), await q(`document.getElementById("micmsg").textContent`));

    // 6. Allow (stand-in): mic.html succeeds, switches the mic off again, the panel notices without being clicked
    await b.send("Browser.grantPermissions", { origin, permissions: ["audioCapture"] });
    await mic.send("Page.reload"); await sleep(300); await mic.send("Page.bringToFront");
    const ok = await until(() => mic.eval(`document.getElementById("msg").className === "ok"`), 20000);  // the first getUserMedia can take a while to start the audio stack
    const okText = await mic.eval(`document.getElementById("msg").textContent`);
    check("mic.html: getUserMedia succeeded and it says to go back to the panel", ok && /go back to the Dip'n'Dive panel/.test(okText), okText);
    check("mic.html offers Close this tab", await mic.eval(`!document.getElementById("close").hidden`));
    const noted = await until(() => q(`document.getElementById("micsetup").hidden && /Microphone is on/.test(document.getElementById("micmsg").textContent)`), 6000);
    check("the panel noticed the grant by itself and dropped the Enable microphone button", noted, await q(`document.getElementById("micmsg").textContent`));
    check("granting did not start recording", await q(`document.getElementById("mic").dataset.state === "idle"`));
    await mic.eval(`document.getElementById("close").click()`);
    const closed = await until(async () => !(await targets()).some((t) => t.targetId === micTarget.targetId), 4000);
    check("Close this tab closed the tab", closed);

    // 7. the real recognizer: click to start, click to stop
    await q(`document.getElementById("mic").click()`);
    const listening = await until(() => q(`document.getElementById("mic").dataset.state === "listening"`), 6000);
    check("mic click: red listening state with Stop label", listening && await q(`document.getElementById("mic").dataset.state === "listening" && document.getElementById("miclabel").textContent === "Stop"`));
    const layout1 = await q(`JSON.stringify(document.getElementById("mic").getBoundingClientRect())`);
    // The summary above the question box changing size while recording (a Dip finishing, a button pressed again) must not
    // move the mic button: the second click has to land where the first one did.
    await q(`document.querySelector('button.mode[data-mode="claude-dip"]').click()`);
    const rects = new Set(), heights = new Set();
    for (let i = 0; i < 12; i++) {
      rects.add(await q(`JSON.stringify(document.getElementById("mic").getBoundingClientRect())`));
      heights.add(await q(`document.getElementById("result").offsetHeight`));
      await sleep(250);
    }
    check("the mic button stays put while the summary above it empties and refills during a recording", rects.size === 1 && heights.size >= 2 && rects.has(layout1), { rects: rects.size, resultHeights: [...heights] });
    check("recording went on through the re-run", await q(`document.getElementById("mic").dataset.state === "listening"`));
    await sleep(1500);  // the whole recording must stay under Chrome's 8 s no-speech limit in a quiet room
    const layout2 = await q(`JSON.stringify(document.getElementById("mic").getBoundingClientRect())`);
    check("the mic button does not move while listening", layout1 === layout2);
    const words = await q(`document.getElementById("askinput").value.split(/\\s+/).filter(Boolean).length`);
    report.liveWordsInBox = words;
    await q(`document.getElementById("mic").click()`);
    const idle = await until(() => q(`document.getElementById("mic").dataset.state === "idle"`), 10000);
    check("second click: back to idle", idle);
    await sleep(2500);
    const outcome = await q(`({ turns: document.querySelectorAll("#thread .turn").length, msg: document.getElementById("micmsg").textContent, err: document.getElementById("askerror").textContent, pending: !!document.querySelector("#thread .a.pending") })`);
    report.afterStop = { turns: outcome.turns, message: outcome.msg, error: outcome.err, pending: outcome.pending };
    check("after stop: either the recognized words were sent and answered, or one line says nothing was heard",
      outcome.turns === 1 || /did not hear/.test(outcome.msg) || outcome.pending, report.afterStop);
  });
} catch (e) {
  report.fatal = String(e && e.stack || e);
  process.exitCode = 1;
} finally {
  stopHarness(harness);
  fs.rmSync(src, { recursive: true, force: true });
  if (report.checks.some((c) => !c.ok)) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 1));
}
