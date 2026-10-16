import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const html = () => read("panel.html");
const css = () => read("panel.css");
const js = () => read("panel.js");
// the ids of the elements inside one container, in document order
const idsIn = (markup) => [...markup.matchAll(/\bid="(\w+)"/g)].map((m) => m[1]);
const between = (s, open, close) => { const a = s.indexOf(open); return s.slice(a, s.indexOf(close, a)); };

test("two fixed rows close the summary card: the YouTube row, then the Saved row, inside #result inside the scrolling #page", () => {
  const h = html();
  const pageEnd = h.indexOf('</div>\n  <section id="ask"');
  const resultStart = h.indexOf('<main id="result">'), resultEnd = h.indexOf("</main>");
  assert.ok(resultStart > 0 && resultEnd > resultStart);
  const card = h.slice(resultStart, resultEnd);
  assert.ok(resultEnd < pageEnd, "the card is inside #page, so the rows scroll with the summary");
  assert.ok(h.indexOf('id="page"') < resultStart);
  // the summary text first, then the rows at its end
  assert.deepEqual(idsIn(card).slice(0, 5), ["result", "resulttext", "hist", "ytrow", "watched"]);
  assert.ok(card.indexOf('id="resulttext"') < card.indexOf('id="hist"'));
  assert.ok(card.indexOf('id="ytrow"') < card.indexOf('id="saverow"'), "the YouTube row is above the Saved row");
  assert.equal((card.match(/class="hrow"/g) || []).length, 2, "exactly two rows");
  // only the question bar is docked outside #page
  for (const id of ["hist", "ytrow", "saverow", "watched", "like", "dislike", "savehist", "options", "status"]) assert.ok(h.indexOf(`id="${id}"`) < pageEnd, `${id} scrolls with the page`);
  for (const id of ["askform", "mic", "askinput", "historylink", "askgo"]) assert.ok(h.indexOf(`id="${id}"`) > pageEnd, `${id} stays docked`);
  assert.ok(!/<footer|class="links"|id="youtubeactions"|id="clipline"/.test(h), "the old footer and icon-button row are gone");
  const ids = idsIn(h);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("Row A: YouTube logo, bold History:, a Watched checkbox, a thumbs-up and a thumbs-down button", () => {
  const row = between(html(), '<div id="ytrow"', '<div id="saverow"');
  const order = [...row.matchAll(/<svg class="yt"|<b>History:<\/b>|id="watched"|id="like"|id="dislike"/g)].map((m) => m[0]);
  assert.deepEqual(order, ['<svg class="yt"', "<b>History:</b>", 'id="watched"', 'id="like"', 'id="dislike"']);
  assert.match(row, /<svg class="yt" viewBox="0 0 28 20"[^>]*><rect width="28" height="20" rx="5\.5" fill="#FF0000"\/><path d="M11 5\.5v9l8-4\.5z" fill="#fff"\/><\/svg>/, "a small inline red rounded rectangle with a white play triangle");
  assert.match(row, /<input id="watched" type="checkbox"><span id="watchedlabel">Watched<\/span>/);
  assert.match(row, /<button id="like" class="thumb" type="button" aria-pressed="false" aria-label="Like"/);
  assert.match(row, /<button id="dislike" class="thumb" type="button" aria-pressed="false" aria-label="Dislike"/);
  assert.match(row, /<div id="ytrow" class="hrow" hidden>/, "hidden until a YouTube source is on screen");
  for (const gone of ["subscribe", "Subscribe", "data-youtube-action", "watchThrough", "Add to history"]) assert.ok(!html().includes(gone), `no ${gone}`);
});

test("Row B: Dip'n'Dive icon, bold History:, the Saved checkbox, then at the far right the status and the Settings gear", () => {
  const row = between(html(), '<div id="saverow"', "</main>");
  const order = [...row.matchAll(/src="icons\/48\.png"|<b>History:<\/b>|id="savehist"|class="spacer"|id="status"|id="options"/g)].map((m) => m[0]);
  assert.deepEqual(order, ['src="icons/48.png"', "<b>History:</b>", 'id="savehist"', 'class="spacer"', 'id="status"', 'id="options"']);
  assert.match(row, /<span id="savelabel">Saved<\/span>/);
  assert.match(row, /<button id="options" class="iconbtn" type="button" aria-label="Settings" title="Settings">/);
  assert.ok(fs.existsSync(new URL("../icons/48.png", import.meta.url)));
  // the faint outline: four 0.6 px drop-shadows, dark in light mode and white in dark mode
  const c = css();
  assert.match(c, /--fav-outline: rgba\(0, 0, 0, \.45\);/);
  assert.match(c, /@media \(prefers-color-scheme: dark\) \{[\s\S]*--fav-outline: rgba\(255, 255, 255, \.5\);/);
  const rule = c.match(/\.hrow img\.fav \{([^}]*)\}/)[1];
  assert.equal((rule.match(/drop-shadow\((-?0|-?0\.6px) (-?0|-?0\.6px) 0 var\(--fav-outline\)\)/g) || []).length, 4);
  assert.equal((rule.match(/0\.6px/g) || []).length, 4);
});

test("the rows are permanently two lines (flex, wrapping only when very narrow); no row is ever hidden by width", () => {
  const c = css();
  assert.match(c, /#hist \{[^}]*display: flex; flex-direction: column/);
  assert.match(c, /\.hrow \{[^}]*display: flex; align-items: center; flex-wrap: wrap/);
  assert.match(c, /\.hrow \.spacer \{ flex: 1 1 0; \}/, "the status and gear are pushed to the far right");
  assert.ok(!/@media[^{]*max-width[^{]*\{[^}]*\.hrow[^}]*display: none/.test(c));
});

test("thumbs look like YouTube's: outlined when off, filled when on, a busy look while the hidden window works", () => {
  const c = css();
  assert.match(c, /\.thumb\[aria-pressed="true"\] svg path \{ fill: currentColor; \}/);
  assert.match(c, /\.thumb\[data-state="working"\] \{[^}]*animation/);
  const h = html();
  assert.equal((h.match(/class="thumb"[\s\S]*?<path d="M7 10v11H3V10h4Z[^"]*" fill="none" stroke="currentColor"/g) || []).length, 2, "both thumbs are stroked outlines until pressed");
  assert.match(h, /id="dislike"[^>]*><svg[^>]*style="transform: rotate\(180deg\)"/, "the thumbs-down is the thumbs-up turned over");
});

test("panel.js: the YouTube row only for YouTube sources outside Incognito; the status line shows nothing when a Dip is done", () => {
  const j = js();
  assert.match(j, /historyRow\.setSource\(s\.source \? s\.source\.url : null, panelIncognito\);/);
  assert.match(j, /\$\("ytrow"\)\.hidden = !v\.visible;/);
  assert.match(j, /\$\("status"\)\.textContent = rowStatus\(s\);/);
  assert.match(j, /\$\("resulttext"\)\.innerHTML = shown \? renderMarkdown\(shown\) : ""/, "the summary goes in its own element, so rendering it never wipes the rows");
  assert.match(j, /\$\("watched"\)\.addEventListener\("change", \(\) => \{ void historyRow\.toggleWatched\(\$\("watched"\)\.checked\); \}\);/);
  assert.match(j, /\$\("like"\)\.addEventListener\("click", \(\) => \{ void historyRow\.toggleThumb\("like"\); \}\);/);
  assert.match(j, /\$\("dislike"\)\.addEventListener\("click", \(\) => \{ void historyRow\.toggleThumb\("dislike"\); \}\);/);
  assert.match(j, /requestAccess: \(\) => chrome\.permissions\.request\(\{ origins: \["https:\/\/www\.youtube\.com\/\*"\] \}\)/);
  assert.match(j, /historyRow\.onStorageChange\(c, a\)/);
  const ids = new Set(idsIn(html()));
  for (const id of [...j.matchAll(/\$\("(\w+)"\)/g)].map((m) => m[1])) assert.ok(ids.has(id), `panel.js uses #${id}, which panel.html lacks`);
});

test("the clipboard feature is gone from the extension: no row, no setting, no sending code, no tests, no helper module", () => {
  const h = html(), o = read("options.html");
  for (const gone of ["Send to clipboard", "clipbutton", "clipstatus", "clipline", "data-machine", "Thing 2", "iMac", "Win"]) assert.ok(!h.includes(gone), `panel.html: ${gone}`);
  assert.ok(!/id="computer"|This computer is/.test(o));
  assert.ok(!/clip/i.test(css().replace(/clip: rect/, "")), "no clipboard CSS");
  assert.ok(!/clipboard/i.test(js().replace(/navigator\.clipboard\.writeText\(payload\.fullText\)/, "").replace(/on your clipboard/g, "")), "panel.js has no clipboard code but the hand-off fallback");
  for (const f of ["lib/controller.js", "options.js", "options.html", "panel.html"]) assert.ok(!/clipboard|CLIPBOARD|computerName/.test(read(f)), f);
  assert.ok(!fs.existsSync(new URL("../lib/clipboard-view.js", import.meta.url)));
  assert.ok(!fs.existsSync(new URL("./clipboard.test.mjs", import.meta.url)));
  // the hand-off arrows keep their fallback
  assert.match(read("panel.js"), /await navigator\.clipboard\.writeText\(payload\.fullText\)/);
  assert.match(read("lib/handoff-sites.js"), /navigator\.clipboard\.writeText\(text\)/);
  const m = JSON.parse(read("manifest.json"));
  assert.ok(m.permissions.includes("clipboardWrite"), "kept for the hand-off arrows' fallback copy");
});

test("light mode: the five big buttons and the hourglass and send buttons are white; dark mode keeps them black", () => {
  const c = css();
  const root = c.match(/:root \{([^}]*)\}/)[1];
  const dark = c.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/)[1];
  assert.match(root, /--mode-bg: #ffffff;/);
  assert.match(root, /--mode-border: #c9c5bc;/);
  assert.match(root, /--mode-ledge: #b9b5ab;/);
  assert.match(root, /--on-mode: #111111;/, "icons on the white bottom-bar buttons are dark");
  assert.match(dark, /--mode-bg: #000000;/);
  assert.match(dark, /--on-mode: #ffffff;/);
  assert.match(c, /button\.mode \{[^}]*background: var\(--mode-bg\)/);
  assert.match(c, /\.rowbtn \{[^}]*background: var\(--mode-bg\); color: var\(--on-mode\)/);
  // the pressed state is a light radial gradient in light mode that keeps the provider rim and the glow
  assert.match(root, /--mode-pressed-bg: radial-gradient\(circle at 50% 58%, #ffffff 0, #f1efea 72%\)/);
  const pressed = c.match(/button\.mode\[aria-pressed="true"\] \{([^}]*)\}/)[1];
  assert.match(pressed, /border-color: var\(--rim\)/);
  assert.match(pressed, /var\(--glow\)/);
  assert.match(pressed, /background: var\(--mode-pressed-bg\)/);
  // the pin has a rim that shows on white
  assert.match(root, /--action-rim: #9a958a;/);
  // the Speak button stays solid white with a dark icon in both modes
  assert.match(c, /#mic \{[^}]*background: #ffffff; color: #111111/);
  // nothing outside the token blocks forces the buttons black again
  assert.ok(!/button\.mode[^{]*\{[^}]*background: #000/.test(c));
});

test("the white pin has a black outline, so it shows on the white buttons", () => {
  const svg = js().match(/const PIN_ICON = '(<svg[^']*<\/svg>)'/)[1];
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /stroke="#000"/);
  assert.match(svg, /stroke-width="1\.3"/);
  assert.match(svg, /paint-order="stroke"/);
});

// A small PNG reader for the outlined arrows (8-bit RGBA, not interlaced, as Pillow writes them).
function readPng(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("ascii", 1, 4), "PNG");
  let p = 8, w = 0, h = 0, type, depth, color; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    if (t === "IDAT") idat.push(data);
    p += 12 + len;
  }
  return { w, h, depth, color, idat: Buffer.concat(idat) };
}

test("outlined hand-off arrows exist for left and right at 36 and 72 px, are used in both modes, and the generator makes them", async () => {
  for (const dir of ["left", "right"]) for (const size of [36, 72]) {
    const file = new URL(`../icons/handoff/handoff-${dir}-outline-${size}.png`, import.meta.url);
    assert.ok(fs.existsSync(file), `${dir} ${size}`);
    const png = readPng(file);
    assert.equal(png.w, size); assert.equal(png.h, size);
    assert.equal(png.color, 6, "RGBA, transparent around the arrow");
  }
  const j = js();
  assert.match(j, /handoff-\$\{id\}-outline-36\.png/);
  assert.match(j, /handoff-\$\{id\}-outline-72\.png 2x/);
  assert.ok(!/handoff-\$\{id\}-light|handoff-\$\{id\}-ink/.test(j), "one outlined arrow in both modes");
  const tool = fs.readFileSync(new URL("../../tools/handoff_icons.py", import.meta.url), "utf8");
  assert.match(tool, /outline/);
  assert.match(tool, /OUTLINE_PX = \{36: 1\.0, 72: 1\.5\}/, "a 1 to 2 px black outline");
  assert.match(tool, /"right", ImageOps\.mirror/, "the right arrow is the mirrored left one");
});

test("Settings page: one YouTube section with the transcripts checkbox only; no computer, default picker, Premium or speed", () => {
  const o = read("options.html");
  assert.equal((o.match(/<h2>/g) || []).length, 3, "Hand-off destinations, YouTube, History");
  assert.deepEqual([...o.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]), ["Hand-off destinations", "YouTube", "History"]);
  assert.ok(!/Watched videos/.test(o), "the old Watched videos section is merged");
  assert.match(o, /<h2>YouTube<\/h2>\s*<label style="font-weight:400"><input id="recordWatched" type="checkbox"[^>]*>Save transcripts of videos I watch<\/label>/);
  assert.match(o, /<small>A video's transcript goes into your monthly transcripts file when you stay on it for 2 minutes, or when a background watch finishes\. Shorts, live streams and incognito tabs are skipped\.<\/small>/);
  assert.match(o, /<p id="watchedAccess" hidden>[\s\S]*<button id="watchedAllow" type="button">Allow tab access<\/button><\/p>/);
  for (const gone of ["This computer is", "After a Dip, by default", "youtubePremium", "Premium", "youtubeSpeed", "Playback speed", "youtubeAfterDip", "id=\"computer\""]) assert.ok(!o.includes(gone), `no ${gone}`);
  const oj = read("options.js");
  for (const gone of ["youtubePremium", "youtubeAfterDip", "youtubePlaybackSpeed", "computerName", "youtubeSpeed", "$(\"computer\")"]) assert.ok(!oj.includes(gone), `options.js: no ${gone}`);
});

test("Settings page: the transcripts checkbox still saves the setting and asks for tab access inside the click", async () => {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: false, disabled: false, checked: false, value: "", textContent: "", handlers: {}, addEventListener(t, f) { this.handlers[t] = f; }, focus() {} });
  const store = { base: "http://c.test", token: "t".repeat(40), recordWatchedVideos: true };
  const asked = [];
  let granted = false;
  const saved = { document: globalThis.document, chrome: globalThis.chrome };
  globalThis.document = { getElementById: (id) => el(id), addEventListener() {} };
  globalThis.chrome = {
    storage: { local: { get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, store[x]])), set: async (o) => Object.assign(store, o), remove: async () => {} } },
    permissions: { contains: async () => granted, request: async (p) => { asked.push(p); granted = true; return true; } },
  };
  try {
    await import(`../options.js?run=${Math.random()}`);
    assert.equal(els.recordWatched.checked, true, "on by default / as stored");
    assert.equal(els.watchedAccess.hidden, false, "says so while tab access is missing");
    els.recordWatched.checked = false;
    await els.recordWatched.handlers.change();
    assert.equal(store.recordWatchedVideos, false);
    assert.equal(els.watchedAccess.hidden, true);
    assert.deepEqual(asked, []);
    granted = false;
    els.recordWatched.checked = true;
    await els.recordWatched.handlers.change();
    assert.equal(store.recordWatchedVideos, true);
    assert.deepEqual(asked, [{ permissions: ["tabs"] }], "the tabs permission is asked for when it is turned on");
    assert.equal(els.watchedAccess.hidden, true, "and the prompt goes away once it is held");
    for (const id of ["youtubePremium", "youtubeSpeed", "youtubeAfterDip", "computer"]) assert.equal(id in els, false, `options.js never touches #${id}`);
  } finally { Object.assign(globalThis, saved); }
});

test("older installs' settings for the removed features are forgotten when the worker starts", async () => {
  const { registerBackground } = await import("../lib/background-core.js");
  const removed = [];
  const noop = { addListener: () => {} };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async (k) => { removed.push(k); } }, session: { get: async () => ({}), set: async () => {} }, onChanged: noop },
    runtime: { onMessage: noop, onInstalled: noop, onStartup: noop, getURL: (p) => p, sendMessage: () => {}, lastError: null },
    permissions: { contains: async () => false }, tabs: { onUpdated: noop, onActivated: noop, onRemoved: noop, query: async () => [] },
    contextMenus: { onClicked: noop, create: () => {}, update: () => {} }, sidePanel: { setPanelBehavior: () => {}, open: () => {} },
    windows: { create: async () => ({}), remove: async () => {}, onRemoved: noop }, alarms: { onAlarm: noop, create: () => {}, clear: () => {} },
    scripting: { executeScript: async () => [] },
  };
  registerBackground(chrome);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(removed.flat().sort(), ["clipboardMachines", "computerName", "youtubeAfterDip", "youtubePlaybackSpeed", "youtubePremium"]);
});
