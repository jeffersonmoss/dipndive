// Shared by the plain-page Chrome scripts (panel-plain.mjs, screenshots.mjs): start the dev harness (a real companion with
// faked model binaries, local article pages, a static and proxy front) and stop it again. No real model is ever called.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* the page may still be loading: look again */ }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// Resolves { proc, info: { front, token, pages } }. The harness deletes its own temp folder when it gets SIGTERM.
export async function startHarness(port, { delay = "0.3" } = {}) {
  const proc = spawn(path.join(REPO, ".venv/bin/python"), ["-m", "tests.dev_harness", String(port)], {
    cwd: REPO, detached: true, env: { ...process.env, DIPDIVE_FAKE_DELAY: delay }, stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const info = await new Promise((resolve, reject) => {
      let buf = "";
      proc.stdout.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
      proc.on("exit", () => reject(new Error("harness exited")));
      setTimeout(() => reject(new Error("harness did not start")), 15000);
    });
    return { proc, info };
  } catch (e) {
    stopHarness({ proc });
    throw e;
  }
}

export function stopHarness(h) {
  if (!h) return;
  try { process.kill(-h.proc.pid, "SIGTERM"); } catch { /* already gone */ }
}

// A panel page for the dev shim (lib/shim.js): the companion is reached through the harness front's /c proxy.
export function panelUrl(info, params) {
  const q = new URLSearchParams({ base: `${info.front}/c`, token: info.token, ...params });
  return `${info.front}/ext/panel.html?${q}`;
}
