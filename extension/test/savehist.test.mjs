import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("no box state for Temp chat, an unfinished job, or a summary without a log entry; and no request", async () => {
  const t = rig({ slot: slot(), mode: "temp" });
  await done(t);
  assert.equal(t.state.last.saved, null);
  assert.equal(await t.c.setSaved(false), false);
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
  for (const r of [t, busy, nolog]) assert.deepEqual(saves(r), []);
});

test("a refusal or an unreachable companion puts the box back; a gone entry hides it", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await done(r);
  r.server.saveStatus = 503;
  assert.equal(await r.c.setSaved(false), false);
  assert.equal(r.state.last.saved, true, "back to ticked");
  assert.match(r.state.last.status, /could not be changed/);
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
  await r.c.selectMode("claude-dive");  // another summary replaces it before the answer arrives
  r.holds.shift()();
  assert.equal(await p, false);
  assert.equal(r.state.last.mode, "claude-dive");
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
  assert.deepEqual(res, { ok: true, status: 200, clearGeneration: 1 });
  assert.deepEqual(seen, [1]);
  assert.equal(shared.clearGen, 1);
  assert.deepEqual(Object.keys(shared).filter((k) => k.startsWith("slot:")), []);
  assert.equal(A.state.last.result, null, "the open panel forgot its summary");
  assert.match(A.state.last.status, /cleared in another window or on the Options page/);
});

// The real options.js against a stubbed page: Clear history needs a second, explicit click.
async function optionsPage() {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: false, disabled: false, value: "", textContent: "", className: "", handlers: {}, focused: 0,
    addEventListener(t, f) { this.handlers[t] = f; }, focus() { this.focused++; } });
  for (const id of ["base", "token", "save", "msg", "clear", "clearconfirm", "clearyes", "clearno", "clearmsg"]) el(id);
  els.clearconfirm.hidden = true;
  const store = { base: "http://c.test", token: "t".repeat(40), "slot:1": { url: "https://v.test/" } };
  const fetches = [];
  const saved = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const doc = { handlers: {}, getElementById: (id) => el(id), addEventListener(t, f) { this.handlers[t] = f; } };
  globalThis.document = doc;
  globalThis.chrome = { storage: { local: {
    get: async (k) => (k === null ? { ...store } : Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, store[x]]))),
    set: async (o) => Object.assign(store, o),
    remove: async (ks) => { for (const k of [].concat(ks)) delete store[k]; },
  } }, permissions: { request: async () => true } };
  globalThis.fetch = async (url, init) => { fetches.push({ url, method: init.method }); return { status: 200, json: async () => ({ clear_generation: 4 }) }; };
  await import(`../options.js?run=${Math.random()}`);
  return { els, store, fetches, doc, restore: () => Object.assign(globalThis, saved) };
}

test("Options page: Clear history asks first; Cancel sends nothing; Yes clears", async () => {
  const p = await optionsPage();
  try {
    assert.equal(p.els.base.value, "http://c.test");
    p.els.clear.handlers.click();
    assert.equal(p.els.clearconfirm.hidden, false, "the confirmation appears");
    assert.equal(p.els.clear.hidden, true);
    assert.equal(p.fetches.length, 0, "nothing is cleared by the first click");
    p.els.clearno.handlers.click();
    assert.equal(p.els.clearconfirm.hidden, true);
    assert.equal(p.els.clear.hidden, false);
    assert.equal(p.fetches.length, 0, "Cancel sends nothing");
    p.els.clear.handlers.click();
    p.doc.handlers.keydown({ key: "Escape" });
    assert.equal(p.els.clearconfirm.hidden, true, "Escape cancels too");
    p.els.clear.handlers.click();
    await p.els.clearyes.handlers.click();
    assert.deepEqual(p.fetches, [{ url: "http://c.test/clear", method: "POST" }]);
    assert.equal(p.store.clearGen, 4);
    assert.ok(!("slot:1" in p.store));
    assert.match(p.els.clearmsg.textContent, /History cleared/);
    assert.equal(p.els.clearconfirm.hidden, true);
  } finally {
    p.restore();
  }
});

test("markup: the Settings gear is an icon button with an accessible name and a 40px or larger target", () => {
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const gear = html.match(/<button id="options"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(gear, "the gear is a button");
  assert.match(gear[0], /aria-label="Settings"/);
  assert.match(gear[1], /<svg[^>]*aria-hidden="true"[\s\S]*<path[^>]*fill-rule="evenodd"/, "an inline SVG silhouette");
  assert.ok(!/Options/.test(gear[1]), "no visible text");
  const rule = css.match(/\.iconbtn \{([^}]*)\}/)[1];
  assert.ok(Number(rule.match(/width: (\d+)px/)[1]) >= 40 && Number(rule.match(/height: (\d+)px/)[1]) >= 40, rule);
  assert.match(html, /<label id="saveline" class="savebox" hidden><input id="savehist" type="checkbox" checked><span id="savelabel">Save this Dip to history<\/span><\/label>/);
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /\$\("savehist"\)\.addEventListener\("change", \(\) => ctl\.setSaved\(\$\("savehist"\)\.checked\)\)/);
  assert.match(js, /Save this \$\{s\.mode\.endsWith\("-dive"\) \? "Dive" : "Dip"\} to history/);
  assert.match(js, /const show = s\.configured && s\.mode !== "temp" && !!s\.result && typeof s\.saved === "boolean";/);
  const opts = fs.readFileSync(new URL("../options.html", import.meta.url), "utf8");
  assert.match(opts, /<button id="clear"[^>]*>Clear history<\/button>/);
  assert.match(opts, /<div id="clearconfirm"[^>]*hidden>/);
});

test("the waterline: one gentle shape, the same in the panel and the Options and microphone pages", () => {
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const pages = fs.readFileSync(new URL("../pages.css", import.meta.url), "utf8");
  const wave = (t) => t.match(/--wave: (url\("data:[^;]*\));/)[1];
  assert.equal(wave(pages), wave(css));
  const d = decodeURIComponent(wave(css)).match(/d='([^']*)'/)[1];
  const nums = d.replace(/V9 H0 Z$/, "").match(/-?\d+(\.\d+)?/g).map(Number);
  const ys = nums.filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 6, "nearly flat: under 6 units of 360 from crest to trough");
  assert.ok(Math.max(...ys) - Math.min(...ys) > 2, "but not a ruler line");
  assert.match(decodeURIComponent(wave(css)), /viewBox='0 0 360 9'/);
  assert.match(css, /--wave-h: 9px;/);
  for (const h of ["options.html", "mic.html"]) assert.match(fs.readFileSync(new URL(`../${h}`, import.meta.url), "utf8"), /<link rel="stylesheet" href="pages\.css">/);
});

test("night mode is designed: the air, water, line and deep bar all have their own dark values in every page", () => {
  for (const f of ["panel.css", "pages.css"]) {
    const css = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));
    for (const t of ["--air", "--water-top", "--water-deep", "--surface", "--fg", "--strong"]) assert.match(dark, new RegExp(`${t}: #`), `${f} ${t}`);
    assert.ok(!/--claude-pale:|--codex-pale:|--on-pale:/.test(dark.slice(0, dark.indexOf("* { box-sizing"))), `${f}: the Dip squares stay pale`);
  }
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

test("contrast: every mode button's labels reach 4.5:1 in both themes, at full opacity", () => {
  // review finding: Codex Dive's white label on the blue was 4.43:1, and the small top line was dimmed to .82
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const root = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("* { box-sizing"));
  const tok = (block, name) => { const m = block.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6})`)); return m && m[1]; };
  const pairs = [["claude", "on-claude"], ["claude-pale", "on-pale"], ["temp", "on-temp"], ["codex-pale", "on-pale"], ["codex", "on-codex"]];
  for (const [theme, block] of [["light", root], ["dark", dark]]) {
    for (const [bg, fg] of pairs) {
      const b = tok(block, bg) || tok(root, bg), f = tok(block, fg) || tok(root, fg);
      assert.ok(contrast(b, f) >= 4.5, `${theme} ${bg}/${fg}: ${contrast(b, f).toFixed(2)}`);
    }
  }
  assert.ok(!/button\.mode span:first-child \{[^}]*opacity/.test(css), "the small label is not dimmed");
});

test("Options page: focus returns to Clear history after the confirmation, and Escape works anywhere while it is open", async () => {
  const p = await optionsPage();
  try {
    p.els.clear.handlers.click();
    assert.equal(p.els.clearno.focused, 1, "Cancel has the focus while the question is open");
    p.doc.handlers.keydown({ key: "Escape" });
    assert.equal(p.els.clearconfirm.hidden, true, "Escape on the page closes it");
    const before = p.els.clear.focused;
    p.els.clear.handlers.click();
    await p.els.clearyes.handlers.click();
    assert.equal(p.els.clear.hidden, false);
    assert.ok(p.els.clear.focused > before, "focus is back on Clear history");
    p.doc.handlers.keydown({ key: "Escape" });  // closed: nothing happens
    assert.equal(p.els.clearconfirm.hidden, true);
  } finally {
    p.restore();
  }
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
