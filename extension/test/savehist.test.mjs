import { MODES } from "../lib/modes.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { slotKey } from "../lib/background-core.js";
import { clearCompanion } from "../lib/clear.js";
import { rig, slot } from "./rig.mjs";

// The "Save this Dip to history" checkbox, Clear history on the Options page, the gear, and the Waterline styling rules.
const saves = (r) => r.log.fetches.filter((f) => f.method === "POST" && f.path.startsWith("/history/"));
const done = async (r) => { await r.c.init(1); await r.tick(); };

test("a finished Dip has a ticked save box; unticking removes its log entry and ticking restores it", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(r.state.last.saved, true);
  assert.equal(await r.c.setSaved(false), true);
  assert.deepEqual(saves(r).map((f) => f.path), ["/history/job1/remove"]);
  assert.equal(saves(r)[0].auth, `Bearer ${"t".repeat(40)}`);
  assert.equal(r.state.last.saved, false);
  assert.equal(r.server.jobs.job1.saved, false);
  assert.match(r.state.last.status, /Removed from history/);
  assert.equal(await r.c.setSaved(true), true);
  assert.equal(saves(r).at(-1).path, "/history/job1/restore");
  assert.equal(r.state.last.saved, true);
  assert.equal(r.server.jobs.job1.saved, true);
});

test("the box shows what the companion says after the panel is reopened", async () => {
  const jobs = { job7: { state: "done", mode: "claude-dive", url: "https://v.test/watch", polls: 5, logged: true, saved: false } };
  const r = rig({ slot: slot({ consumed: true, jobId: "job7", mode: "claude-dive" }), mode: "claude-dive", jobs });
  await r.c.init(1);
  assert.equal(r.state.last.result, "Summary for claude-dive");
  assert.equal(r.state.last.saved, false);
});

test("no box state for an unfinished job or a summary without a log entry; and no request", async () => {
  const busy = rig({ slot: slot(), mode: "claude-dip" });
  await busy.c.init(1);
  assert.equal(busy.state.last.result, null);
  assert.equal(busy.state.last.saved, null);
  assert.equal(await busy.c.setSaved(false), false);
  const nolog = rig({ slot: slot(), mode: "claude-dip" });
  nolog.server.noLog = true;
  await done(nolog);
  assert.equal(nolog.state.last.result, "Summary for claude-dip");
  assert.equal(nolog.state.last.saved, null);
  assert.equal(await nolog.c.setSaved(false), false);
  for (const r of [busy, nolog]) assert.deepEqual(saves(r), []);
});

test("a refusal or an unreachable companion puts the box back; a gone entry hides it", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.saveStatus = 503;
  assert.equal(await r.c.setSaved(false), false);
  assert.equal(r.log.fetches.at(-1).path, "/jobs/job1", "a server error is checked with the companion, not guessed");
  assert.equal(r.state.last.saved, true, "the log still has it, so the box is ticked again");
  assert.match(r.state.last.status, /was not changed/);
  r.server.saveStatus = 0;
  r.server.fail = new TypeError("Failed to fetch");
  assert.equal(await r.c.setSaved(false), false);
  assert.equal(r.state.last.savedUnknown, true, "unreachable: the outcome is unknown, not claimed either way");
  assert.match(r.state.last.status, /not known whether the history log changed/);
  assert.equal(r.state.last.savingSaved, false, "the box can be clicked again");
  r.server.fail = null;
  assert.equal(await r.c.setSaved(true), true, "a click retries");
  assert.equal(r.state.last.savedUnknown, false);
  r.server.saveStatus = 404;
  assert.equal(await r.c.setSaved(false), false);
  assert.equal(r.state.last.saved, null);
});

test("an answer for a summary that is no longer on screen is dropped", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.hold = (path) => path.startsWith("/history/");
  const p = r.c.setSaved(false);
  assert.equal(r.state.last.saved, false, "the box follows the click at once");
  assert.equal(r.state.last.savingSaved, true);
  await r.c.selectMode("codex-dip");  // another summary replaces it before the answer arrives
  r.holds.shift()();
  assert.equal(await p, false);
  assert.equal(r.state.last.mode, "codex-dip");
  assert.equal(r.state.last.saved, null);
  assert.equal(r.state.last.savingSaved, false);
});

test("Clear history from the Options page: /clear, every slot dropped, every open panel resets", async () => {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot(), "slot:9": slot({ requestId: "z", windowId: 9, ts: 5 }) };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  assert.equal(A.state.last.result, "Summary for claude-dip");
  const seen = [];
  const storage = {
    get: async (k) => (k === null ? { ...shared } : {}),
    set: async (o) => { const ch = {}; for (const [k, v] of Object.entries(o)) ch[k] = { newValue: v }; Object.assign(shared, o); for (const x of bus) x.onStorageChange(ch, "local"); },
    remove: async (keys) => { for (const k of keys) delete shared[k]; },
  };
  const res = await clearCompanion({ fetch: A.c.d.fetch, cfg: { base: shared.base, token: shared.token }, storage, onGeneration: (g) => seen.push(g) });
  assert.deepEqual(res, { ok: true, status: 200, clearGeneration: 1, localError: null });
  assert.deepEqual(seen, [1]);
  assert.equal(shared.clearGen, 1);
  assert.deepEqual(Object.keys(shared).filter((k) => k.startsWith("slot:")), []);
  assert.equal(A.state.last.result, null, "the open panel forgot its summary");
  assert.match(A.state.last.status, /cleared in another window or on the Options page/);
});

test("Settings page: no Clear history button (removed in 1.3; transcripts are kept for good)", () => {
  const o = fs.readFileSync(new URL("../options.html", import.meta.url), "utf8");
  const oj = fs.readFileSync(new URL("../options.js", import.meta.url), "utf8");
  for (const gone of ["Clear history", 'id="clear"', "clearconfirm", "clearyes", "clearmsg"]) assert.ok(!o.includes(gone), `options.html: ${gone}`);
  assert.ok(!/clearCompanion|\/clear/.test(oj), "options.js sends no /clear");
});

test("markup: the Settings gear is an icon button with an accessible name; the bottom row's icon buttons are easy to hit", () => {
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const gear = html.match(/<button id="options"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(gear, "the gear is a button");
  assert.match(gear[0], /aria-label="Settings"/);
  assert.match(gear[1], /<svg[^>]*aria-hidden="true"[\s\S]*<path[^>]*fill-rule="evenodd"/, "an inline SVG silhouette");
  assert.ok(!/Options/.test(gear[1]), "no visible text");
  const size = (sel) => { const r = css.match(new RegExp(`${sel} \\{([^}]*)\\}`))[1]; return [Number(r.match(/width: (\d+)px/)[1]), Number(r.match(/height: (\d+)px/)[1])]; };
  const [gw, gh] = size("\\.iconbtn");
  assert.ok(gw >= 28 && gh >= 28, "the gear is small but clickable");
  for (const sel of ["\\.rowbtn", "#mic"]) { const [w, h] = size(sel); assert.ok(w >= 36 && h >= 36, `${sel} ${w}x${h}`); }
  assert.match(html, /<label id="saveline" class="savebox check" hidden><input id="savehist" type="checkbox" checked><span id="savelabel">Summary saved<\/span><\/label>/);
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /\$\("savehist"\)\.addEventListener\("change", \(\) => ctl\.setSaved\(\$\("savehist"\)\.checked\)\)/);
  assert.match(js, /\$\("savelabel"\)\.textContent = s\.saved \? "Summary saved" : "Summary deleted";/, "the label follows the box: Summary saved when ticked, Summary deleted when unticked");
  assert.ok(!/Dive/.test(html.replace(/Dip'n'Dive|Dive in/g, "")), "no dive wording left in the panel markup");
  assert.match(js, /const show = s\.configured && !!s\.result && typeof s\.saved === "boolean";/);
});

test("layout: five equal square buttons and a compact bottom row (36 px controls, not 44)", () => {
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const mode = css.match(/button\.mode \{([^}]*)\}/)[1];
  assert.match(mode, /aspect-ratio: 1; min-height: 56px/);
  // five equal tracks share the row after accounting for the four gaps
  const row = css.match(/#buttons \{([^}]*)\}/)[1];
  assert.match(row, /--u: calc\(\(100% - 32px\) \/ 5\)/);
  const cols = row.match(/grid-template-columns: ([^;]*);/)[1];
  assert.equal(cols, "repeat(5, var(--u))");
  assert.match(css, /#askinput \{[^}]*height: 36px/);
  assert.match(css, /\.rowbtn \{[^}]*height: 36px/);
  assert.match(css, /#mic \{[^}]*height: 36px/);
});

test("colours: the mode, History and Ask buttons are white in light mode and black in dark mode (dark exactly as before), Speak is white in both; the new page and controls use the theme's tokens", () => {
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../history.css", import.meta.url), "utf8");
  const root = css.match(/:root \{([^}]*)\}/)[1];
  const dark = css.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/)[1];
  // light mode: white buttons on a light-grey border and ledge, dark icons
  assert.match(root, /--mode-bg: #ffffff; --mode-border: #c9c5bc; --mode-ledge: #b9b5ab; --on-mode: #111111;/);
  assert.match(root, /--mode-pressed-bg: radial-gradient\(circle at 50% 58%, #ffffff 0, #f1efea 72%\)/);
  // dark mode: black buttons, white icons, the same borders, ledge and pressed shading as before this change
  assert.match(dark, /--mode-bg: #000000; --mode-border: #34322e; --mode-ledge: #5a5750; --on-mode: #ffffff;/);
  assert.match(dark, /--mode-pressed-bg: radial-gradient\(circle at 50% 58%, #161616 0, #000 72%\)/);
  assert.match(dark, /--mode-pressed-inset: inset 0 4px 10px rgba\(0, 0, 0, \.9\), inset 0 0 0 1px rgba\(255, 255, 255, \.06\)/);
  assert.match(css, /button\.mode \{[^}]*background: var\(--mode-bg\); color: var\(--on-mode\)/);
  assert.match(css, /\.rowbtn \{[^}]*background: var\(--mode-bg\); color: var\(--on-mode\)/);
  // the hourglass and send buttons are the .rowbtn ones, and so is the mic, which has its own solid white rule after them
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  for (const id of ["historylink", "askgo"]) assert.match(html, new RegExp(`id="${id}" class="rowbtn"`));
  assert.match(css, /button\.mode\[aria-pressed="true"\] \{[^}]*background: var\(--mode-pressed-bg\)/);
  assert.match(css, /#mic \{[^}]*background: #ffffff; color: #111111/);
  // the pressed button is obvious on black: it sinks and gets a rim and glow in the provider's colour
  const pressed = css.match(/button\.mode\[aria-pressed="true"\] \{([^}]*)\}/)[1];
  assert.match(pressed, /transform: translateY\(3px\)/);
  assert.match(pressed, /border-color: var\(--rim\)/);
  assert.match(pressed, /var\(--glow\)/);
  for (const m of ["claude-dip", "codex-dip"]) assert.match(css, new RegExp(`button\\.${m} +\\{ --rim: #[0-9A-Fa-f]{6}; --glow:`));
  for (const [sheet, sel] of [[css, "\\.iconbtn"], [page, "\\.hentry"], [page, "#search"], [page, "header#top"]]) {
    const rule = sheet.match(new RegExp(`${sel} \\{([^}]*)\\}`))[1];
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), `${sel} uses tokens: ${rule}`);
  }
});

// A small PNG reader (8-bit RGBA, not interlaced: what tools/mode_icons.py writes), for measuring the logos.
function readPng(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); assert.equal(data[12], 0); }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return { w, h, px: out };
}

test("every logo in use is at full strength and stands out from its black button by at least 3:1", () => {
  const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const vsBlack = (rgb) => (lum(rgb) + 0.05) / 0.05;
  assert.deepEqual(MODES.map((m) => m.logo), ["claude-dive", "codex-dive"], "the existing full-strength logo files are used");
  for (const { logo: name } of MODES) {
    for (const size of [36, 72]) {
      const { w, h, px } = readPng(new URL(`../icons/modes/${name}-${size}.png`, import.meta.url));
      assert.equal(w, size); assert.equal(h, size);
      const shown = [];
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3] / 255;
        if (a > 0.25) shown.push(vsBlack([px[i] * a, px[i + 1] * a, px[i + 2] * a]));  // over the black button
      }
      shown.sort((x, y) => x - y);
      const median = shown[shown.length >> 1];
      assert.ok(shown.length > size * size * 0.1, `${name}-${size} has a visible mark`);
      assert.ok(median >= 3, `${name}-${size}: median ${median.toFixed(2)}:1 against black, needs 3`);
      // full strength means the body of the mark is opaque, not the half-transparent Dip variant (alpha about 148)
      const counts = new Map();
      for (let i = 3; i < px.length; i += 4) if (px[i] > 25) counts.set(px[i], (counts.get(px[i]) || 0) + 1);
      const [commonAlpha] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
      assert.ok(commonAlpha >= 250, `${name}-${size} is not washed out (most common alpha ${commonAlpha})`);
    }
  }
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.ok(!/temp/i.test(js.replace(/template/gi, "")), "no Temp chat leftovers in the panel");
  assert.match(js, /<span class="sr-only">\$\{m\.label\}<\/span>/, "each button keeps its name");
});

test("a lost answer after the companion made the change is reconciled from GET /jobs, not reverted", async () => {
  // review finding: the box went back to ticked and said "not changed" although the entry had been removed
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.loseSaveResponse = 1;
  const seen = [];
  const orig = r.c.d.onState;
  r.c.d.onState = (st) => { seen.push(st.status); orig(st); };
  assert.equal(await r.c.setSaved(false), true);
  assert.ok(seen.some((t) => /not known yet/.test(t)), "says the outcome is unknown while it checks");
  assert.equal(r.log.fetches.at(-1).path, "/jobs/job1", "asked the companion");
  assert.equal(r.state.last.saved, false);
  assert.equal(r.state.last.savedUnknown, false);
  assert.match(r.state.last.status, /Removed from history/);
});

test("other open panels follow a change: a storage broadcast, and a refresh on focus", async () => {
  // review finding: B stayed ticked after A removed the entry, and B's next click removed it again
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  const B = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  // window 2 shows the same job (the companion deduplicates the same link and mode onto one job)
  shared[slotKey(2)] = slot({ windowId: 2, requestId: "slot-req-2", consumed: true, jobId: A.state.last.jobId, mode: "claude-dip" });
  await B.c.init(2);
  assert.equal(A.state.last.jobId, B.state.last.jobId, "both show the same summary");
  assert.equal(B.state.last.saved, true);
  await A.c.setSaved(false);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(B.state.last.saved, false, "B heard the broadcast and asked again");
  assert.equal(await B.c.setSaved(true), true, "B's click restores, it does not remove again");
  assert.equal(server.jobs[A.state.last.jobId].saved, true);
  server.jobs[A.state.last.jobId].saved = false;   // changed elsewhere with no broadcast (another machine)
  assert.equal(await A.c.refreshSaved(), false, "on focus the panel asks again");
  assert.equal(A.state.last.saved, false);
});

test("a save change after Clear history on another machine is refused as stale and the panel resets", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.staleCheck = true;
  r.server.clearGen = 3;
  assert.equal(await r.c.setSaved(false), false);
  assert.equal(saves(r).at(-1).body.clearGeneration, 0, "the request carried the generation the panel knew");
  assert.equal(r.server.jobs.job1.saved, true, "nothing changed");
  assert.equal(r.state.last.result, null);
  assert.equal(r.state.last.error, "History was cleared on another machine.");
  assert.equal(r.c.clearGen, 3);
});


test("a reconciled lost answer is announced to the other panels like any change", async () => {
  // re-verification finding 10: A reconciled to false through GET, B stayed true
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  const B = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  shared[slotKey(2)] = slot({ windowId: 2, requestId: "slot-req-2", consumed: true, jobId: A.state.last.jobId, mode: "claude-dip" });
  await B.c.init(2);
  server.loseSaveResponse = 1;
  assert.equal(await A.c.setSaved(false), true);
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual([A.state.last.saved, B.state.last.saved, server.jobs[A.state.last.jobId].saved], [false, false, false]);
  assert.equal(shared.savedChange.saved, false);
});

test("a focus refresh that started before a local change cannot overwrite it", async () => {
  // re-verification finding 11a: a GET begun before the removal arrived after it and put the box back to ticked
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.hold = (path) => path === "/jobs/job1";
  const focus = r.c.refreshSaved();             // the focus GET is on its way (it will answer "true")
  r.server.hold = null;
  assert.equal(await r.c.setSaved(false), true);
  assert.equal(r.state.last.saved, false);
  r.holds.shift()();                            // the old answer arrives now
  assert.equal(await focus, null, "dropped");
  assert.equal(r.state.last.saved, false);
  assert.equal(r.server.jobs.job1.saved, false);
});

test("a focus refresh after Clear history on another machine resets the panel and adopts the generation", async () => {
  // re-verification finding 11b: the old summary, a ticked box and generation 0 stayed while the companion was at 1
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  assert.equal(r.state.last.saved, true);
  r.server.clearGen = 1;
  delete r.server.jobs.job1;                     // what Clear history does on the companion
  assert.equal(await r.c.refreshSaved(), null);
  assert.equal(r.c.clearGen, 1);
  assert.equal(r.state.last.result, null);
  assert.equal(r.state.last.saved, null, "no box");
  assert.equal(r.state.last.status, "History was cleared on another machine.");
});

test("a frozen GET from before a change made in another window cannot undo it (log revisions)", async () => {
  // third check, finding 11: B's GET answered "true" at revision 0, A removed (revision 1), B followed the broadcast to
  // false, then the old GET arrived and put B back to true
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  const B = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  const jid = A.state.last.jobId;
  shared[slotKey(2)] = slot({ windowId: 2, requestId: "slot-req-2", consumed: true, jobId: jid, mode: "claude-dip" });
  await B.c.init(2);
  server.freeze = (path) => path === `/jobs/${jid}` && !server.frozenOnce && (server.frozenOnce = true);
  const old = B.c.refreshSaved();                // B's focus GET: "true at revision 0", held back
  server.freeze = null;
  await A.c.setSaved(false);                     // revision 1, broadcast
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(B.state.last.saved, false);
  B.holds.shift()();
  assert.equal(await old, null, "the older answer is dropped");
  assert.equal(B.state.last.saved, false);
  assert.equal(server.jobs[jid].saved, false);
});

test("overlapping GETs: the older answer arriving last is dropped", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.freeze = (path) => path === "/jobs/job1" && !r.server.f1 && (r.server.f1 = true);
  const first = r.c.refreshSaved();              // answer made now: true, revision 0
  r.server.freeze = null;
  r.server.jobs.job1.saved = false; r.server.rev = 4;  // changed on another machine
  assert.equal(await r.c.refreshSaved(), false);
  r.holds.shift()();
  assert.equal(await first, null);
  assert.equal(r.state.last.saved, false);
});

test("a server error after the change was made is reconciled and announced, not reverted", async () => {
  // third check, finding 12: restore wrote the entry, then answered 503; the panel put the box back to unticked
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  const B = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  const jid = A.state.last.jobId;
  shared[slotKey(2)] = slot({ windowId: 2, requestId: "slot-req-2", consumed: true, jobId: jid, mode: "claude-dip" });
  await B.c.init(2);
  await A.c.setSaved(false);
  await new Promise((res) => setTimeout(res, 0));
  server.errorAfterSave = 503;
  assert.equal(await A.c.setSaved(true), true);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(A.log.fetches.at(-1).path, `/jobs/${jid}`, "asked the companion");
  assert.deepEqual([A.state.last.saved, B.state.last.saved, server.jobs[jid].saved], [true, true, true]);
  assert.match(A.state.last.status, /Saved to history/);
});

// ---------- review fixes: a delayed save answer vs a newer revision; Clear history reporting ----------

// Panels A and B show the same summary. A unticks it and its answer is held on the way (the companion has already made
// the change: revision 1). Meanwhile B ticks it again (revision 2) and tells A.
async function delayedRemoveVsRestore() {
  const shared = { base: "http://c.test", token: "t".repeat(40), mode: "claude-dip", [slotKey(1)]: slot() };
  const server = { jobs: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: { state: "starting" }, conflictOnce: false, seq: 0 };
  const bus = [];
  const A = rig({ shared, server, bus });
  const B = rig({ shared, server, bus });
  await A.c.init(1); await A.tick();
  const jid = A.state.last.jobId;
  shared[slotKey(2)] = slot({ windowId: 2, requestId: "slot-req-2", consumed: true, jobId: jid, mode: "claude-dip" });
  await B.c.init(2);
  server.freeze = (path) => path.startsWith("/history/") && !server.frozenOnce && (server.frozenOnce = true);
  const pa = A.c.setSaved(false);                      // the answer (saved false, revision 1) is held back
  await new Promise((res) => setTimeout(res, 0));
  server.freeze = null;
  assert.equal(await B.c.setSaved(true), true);        // B's restore: revision 2, announced to A
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(A.state.last.savingSaved, true, "A is still waiting for its own answer");
  assert.equal(server.jobs[jid].saved, true);
  assert.equal(server.rev, 2);
  return { A, B, server, pa, jid };
}

test("review 2: a delayed save answer does not override a newer revision heard meanwhile; A reconciles to what the log says", async () => {
  const { A, server, pa, jid } = await delayedRemoveVsRestore();
  A.holds.shift()();                                    // A's old answer arrives: saved false at revision 1
  assert.equal(await pa, false, "A's own change did not end as clicked");
  assert.equal(A.state.last.saved, true, "the log has it (revision 2), so the box is ticked");
  assert.ok(!/Removed from history/.test(A.state.last.status), A.state.last.status);
  assert.equal(A.state.last.savingSaved, false);
  assert.equal(A.state.last.savedUnknown, false);
  assert.equal(A.c.savedRev, 2);
  assert.equal(server.jobs[jid].saved, true);
});

test("review 2: when the newer revision cannot be resolved, the box is uncertain, never 'Removed from history.'", async () => {
  const { A, server, pa } = await delayedRemoveVsRestore();
  server.fail = new TypeError("Failed to fetch");       // the companion cannot be reached for the follow-up GETs
  A.holds.shift()();
  assert.equal(await pa, false);
  assert.equal(A.state.last.savedUnknown, true, "shown as indeterminate");
  assert.equal(A.state.last.savingSaved, false, "and the box can be clicked to try again");
  assert.ok(!/Removed from history/.test(A.state.last.status), A.state.last.status);
  assert.match(A.state.last.status, /could not confirm|Click the box/);
  server.fail = null;
  assert.equal(await A.c.setSaved(false), true, "a click retries");
  assert.equal(A.state.last.saved, false);
  assert.equal(A.state.last.savedUnknown, false);
});

test("review 2: a newer revision learned from a GET while the change is on its way is also kept; an older one is harmless", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.freeze = (path) => path.startsWith("/history/") && !r.server.f1 && (r.server.f1 = true);
  const p = r.c.setSaved(false);                        // answer (revision 1) held
  await new Promise((res) => setTimeout(res, 0));
  r.server.freeze = null;
  r.server.jobs.job1.saved = true; r.server.rev = 2;    // another machine restored it (no broadcast reaches this browser)
  assert.equal(await r.c.refreshSaved(), null, "a focus GET while saving applies nothing");
  assert.equal(r.state.last.savingSaved, true);
  r.holds.shift()();
  assert.equal(await p, false);
  assert.equal(r.state.last.saved, true);
  assert.ok(!/Removed from history/.test(r.state.last.status), r.state.last.status);
  // and with nothing newer heard, the answer is applied as before
  assert.equal(await r.c.setSaved(false), true);
  assert.equal(r.state.last.saved, false);
  assert.match(r.state.last.status, /Removed from history/);
});

test("review 3: Clear history reports a storage failure after the companion succeeded as a partial success, not 'not cleared'", async () => {
  const stored = { clearGen: 0, "slot:1": { url: "x" } };
  const storage = { get: async () => ({ ...stored }), remove: async () => { throw new Error("storage quota exceeded"); }, set: async (o) => Object.assign(stored, o) };
  const fetch = async () => ({ status: 200, json: async () => ({ clear_generation: 5 }) });
  const res = await clearCompanion({ fetch, cfg: { base: "http://c.test", token: "t".repeat(40) }, storage });
  assert.equal(res.ok, true, "the companion cleared");
  assert.equal(res.localError, "storage quota exceeded");
  assert.equal(stored.clearGen, 5, "the new generation is still written, so open panels learn of the clear");
  const setFails = { ...storage, remove: async () => {}, set: async () => { throw new Error("set failed"); } };
  assert.equal((await clearCompanion({ fetch, cfg: { base: "http://c.test", token: "t".repeat(40) }, storage: setFails })).localError, "set failed");
  const refused = await clearCompanion({ fetch: async () => ({ status: 401, json: async () => ({}) }), cfg: { base: "http://c.test", token: "t".repeat(40) }, storage });
  assert.deepEqual([refused.ok, refused.localError], [false, null]);
});

test("review 3: the panel's own Clear history says the same when its storage cleanup fails", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  const real = r.c.d.storage.remove;
  r.c.d.storage.remove = async () => { throw new Error("disk full"); };
  await r.c.clearHistory();
  r.c.d.storage.remove = real;
  assert.equal(r.state.last.status, "History cleared. Could not reset this browser's panel state: disk full");
  assert.equal(r.state.last.result, null, "the summary is gone: the companion cleared");
});
