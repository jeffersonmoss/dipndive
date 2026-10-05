// Throwaway Chrome driver for manual checks (never Jefferson's Chrome or profile).
// Starts a separate Chrome with a temp profile, loads an unpacked extension over the CDP pipe
// (Extensions.loadUnpacked), and gives a tiny CDP client. Cleans up its process group and temp folder on
// success, failure, SIGINT and SIGTERM, and sweeps stale folders of crashed earlier runs at startup.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PREFIX = "dipdive-chrome-";
// Chrome's Extensions.loadUnpacked refuses paths under the per-user /var/folders temp dir ("File path cannot be
// resolved", seen on Chrome 154, macOS), so scratch folders for these runs live in /tmp.
export const TMP = process.env.DIPDIVE_CHROME_TMP || "/tmp";
const CHROME = process.env.DIPDIVE_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function sweepStale() {
  for (const n of fs.readdirSync(TMP)) {
    if (!n.startsWith(PREFIX)) continue;
    const d = path.join(TMP, n);
    try {
      const pid = Number(fs.readFileSync(path.join(d, "pid"), "utf8"));
      if (pid && alive(pid)) continue; // still in use by a live run
    } catch { /* no pid file: leftover */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
}

export class Browser {
  constructor() { this.dir = null; this.proc = null; this.id = 0; this.pending = new Map(); this.events = []; this.buf = ""; this.listeners = []; }

  async start({ extensions = [], headless = true, args = [], purpose = "chrome probe", needed = "until the run ends (it deletes this folder)" } = {}) {
    sweepStale();
    this.dir = fs.mkdtempSync(path.join(TMP, PREFIX));
    fs.writeFileSync(path.join(this.dir, "TEMP_README.md"),
      `# Temporary folder\n\nPurpose: ${purpose} (throwaway Chrome profile and files)\nMade by: T1 Dip Dive chat on this Mac, ${new Date().toISOString().slice(0, 10)}\n` +
      `Needed until: ${needed}\nCostly to recreate: no.\n`);
    const flags = ["--user-data-dir=" + path.join(this.dir, "profile"), "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--password-store=basic", "--use-mock-keychain",
      // DIPDIVE_CHROME_NO_SANDBOX=1 for a shell that is itself inside a macOS sandbox (Chrome's own seatbelt cannot nest and
      // it exits at start); the profile is a throwaway one and only local test pages and the extension are loaded.
      ...(process.env.DIPDIVE_CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
      ...(headless ? ["--headless=new"] : []), ...args, "about:blank"];
    this.proc = spawn(CHROME, flags, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    fs.writeFileSync(path.join(this.dir, "pid"), String(this.proc.pid));
    this.proc.on("exit", () => { for (const [, p] of this.pending) p.reject(new Error("chrome exited")); });
    const readFrom = this.proc.stdio[4];
    readFrom.on("data", (c) => {
      this.buf += c.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(`${msg.error.message} ${msg.error.data || ""}`)) : p.resolve(msg.result);
        } else { this.events.push(msg); this.listeners.forEach((l) => l(msg)); }
      }
    });
    this.proc.stdio[4].on("error", () => {});
    this.proc.stdio[3].on("error", () => {});
    this.ids = [];
    for (const e of extensions) { try { this.ids.push((await this.send("Extensions.loadUnpacked", { path: e })).id); } catch (err) { throw new Error(`loadUnpacked(${e}): ${err.message}`); } }
    return this;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const m = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(m + "\0");
    });
  }

  on(fn) { this.listeners.push(fn); }

  async open(url) {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return new Page(this, targetId, sessionId);
  }

  async stop() {
    const group = this.proc && this.proc.pid ? -this.proc.pid : null;
    try {
      if (group) {
        // Chrome's helper processes outlive the main one for a moment and keep writing the profile, so wait for
        // the whole process group, not only the main pid.
        for (const [sig, wait] of [["SIGTERM", 5000], ["SIGKILL", 3000]]) {
          if (!alive(group)) break;
          try { process.kill(group, sig); } catch { /* already gone */ }
          const end = Date.now() + wait;
          while (alive(group) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
        }
      }
    } finally {
      if (this.dir) {
        for (let i = 0; i < 10; i++) {
          fs.rmSync(this.dir, { recursive: true, force: true });
          if (!fs.existsSync(this.dir)) break;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }
}

export class Page {
  constructor(b, targetId, sessionId) { this.b = b; this.targetId = targetId; this.sid = sessionId; }
  send(method, params) { return this.b.send(method, params, this.sid); }
  async eval(expr, { userGesture = false } = {}) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// Run fn(browser) with guaranteed cleanup, also on Ctrl-C and SIGTERM.
export async function withBrowser(opts, fn) {
  const b = new Browser();
  const bail = async () => { await b.stop(); process.exit(130); };
  process.once("SIGINT", bail); process.once("SIGTERM", bail);
  try {
    await b.start(opts);
    return await fn(b);
  } finally {
    process.off("SIGINT", bail); process.off("SIGTERM", bail);
    await b.stop();
  }
}

export function sh(cmd, args) { return execFileSync(cmd, args, { encoding: "utf8" }); }
