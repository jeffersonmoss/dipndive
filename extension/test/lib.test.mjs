import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pickUrl, knownVideo, normalizeTyped } from "../lib/urls.js";
import { renderMarkdown } from "../lib/markdown.js";
import { MODES, DEFAULT_MODE, menuLabel, apiMode } from "../lib/modes.js";

test("url precedence: linkUrl, then known-video srcUrl, then frameUrl, then pageUrl", () => {
  const base = { pageUrl: "https://a.test/page", frameUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ", srcUrl: "blob:https://www.youtube.com/xyz" };
  assert.equal(pickUrl({ ...base, linkUrl: "https://b.test/x" }), "https://b.test/x");
  assert.equal(pickUrl(base), base.frameUrl, "blob: srcUrl ignored; known video embed frame wins");
  assert.equal(pickUrl({ pageUrl: "https://a.test/article", frameUrl: "https://disqus.com/embed/comments/?x=1" }), "https://a.test/article", "non-video frames fall through to the page");
  assert.equal(pickUrl({ pageUrl: "https://a.test/article", frameUrl: "https://googleads.g.doubleclick.net/pagead/x" }), "https://a.test/article");
  assert.equal(pickUrl({ ...base, srcUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(pickUrl({ pageUrl: "https://a.test/page" }), "https://a.test/page");
  assert.equal(pickUrl({ pageUrl: "chrome://newtab", linkUrl: "javascript:alert(1)" }), null);
  assert.equal(pickUrl({ srcUrl: "https://cdn.test/video.mp4", pageUrl: "https://a.test/p" }), "https://a.test/p", "non-YouTube srcUrl not trusted");
});

test("knownVideo", () => {
  for (const u of ["https://youtu.be/dQw4w9WgXcQ?t=5", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]) assert.ok(knownVideo(u), u);
  for (const u of ["https://www.youtube.com/playlist?list=PL1", "https://evil.test/watch?v=dQw4w9WgXcQ", "blob:https://www.youtube.com/x"]) assert.ok(!knownVideo(u), u);
});

test("markdown: html is inert, images are never rendered, only http(s) links", () => {
  const h = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script> ![pic](https://e.test/a.png) [bad](javascript:alert(1)) [ok](https://e.test/a?b=1&c=2)');
  assert.ok(!/<img|<script/i.test(h));
  assert.ok(h.includes("&lt;img") && h.includes("&lt;script&gt;"));
  assert.ok(h.includes("[image: pic]"));
  assert.ok(!h.includes('href="javascript'));
  assert.match(h, /<a href="https:\/\/e\.test\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.ok(!/<a [^>]*onerror/.test(h));
});

test("markdown: structure", () => {
  const h = renderMarkdown("# T\n\nFirst **bold** and *it* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n```\n<b>raw</b>\n```");
  assert.ok(h.includes("<h1>T</h1>") && h.includes("<strong>bold</strong>") && h.includes("<em>it</em>") && h.includes("<code>code</code>"));
  assert.ok(h.includes("<ul>") && h.includes("<ol>") && h.includes("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>"));
});

test("markdown: attribute breakout in a link is escaped", () => {
  const h = renderMarkdown('[x](https://e.test/"onmouseover="alert(1))');
  assert.ok(!/onmouseover="/.test(h.replace(/&quot;/g, "")) || !/ onmouseover=/.test(h));
});

test("modes: order, default, menu label uses 'and', temp is source-only", () => {
  assert.deepEqual(MODES.map((m) => m.id), ["claude-dive", "claude-dip", "temp", "codex-dip", "codex-dive"]);
  assert.deepEqual(MODES.map((m) => m.label), ["Claude Dive", "Claude Dip", "Temp chat", "Codex Dip", "Codex Dive"],
    "left to right: the shallowest immersion in the center, deeper toward both edges");
  assert.equal(DEFAULT_MODE, "codex-dip");
  assert.equal(menuLabel("codex-dip"), "Dip'n'Dive");
  assert.ok(!menuLabel("temp").includes("&"));
  assert.equal(apiMode("temp"), "source");
  assert.equal(apiMode("claude-dive"), "claude-dive");
});

test("the five buttons are built in MODES order and nothing reorders them, so the Tab order is the visual order", () => {
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const h = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  // one loop over MODES creates each button and appends it, in that order
  assert.match(js, /for \(const m of MODES\) \{\n[\s\S]*?document\.createElement\("button"\)[\s\S]*?\$\("buttons"\)\.appendChild\(b\);[\s\S]*?\n\}/);
  assert.ok(!/tabindex/i.test(h) && !/tabindex/i.test(js), "no tabindex anywhere: focus follows document order");
  assert.ok(!/<button[^>]*class="mode/.test(h), "the buttons are not also written by hand in the markup");
  assert.match(css, /#buttons \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  // no style that places a button anywhere but its natural cell
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => /#buttons|button\.(mode|claude-|codex-|temp)/.test(m[1])).map((m) => m[2]).join(";");
  assert.ok(rules.length > 500, "the button rules were found");
  for (const re of [/(?<![-\w])order\s*:/, /grid-(column|row|area)/, /row-reverse|column-reverse/, /(?<![-\w])direction\s*:/, /grid-auto-flow\s*:[^;]*dense/]) {
    assert.ok(!re.test(rules), `a rule reorders the buttons: ${re}`);
  }
});

test("manifest: exact permissions, fixed key, no content scripts, no broad hosts", () => {
  const m = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url)));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["clipboardWrite", "contextMenus", "sidePanel", "storage"]);
  assert.ok(m.key && m.key.length > 300);
  assert.equal(m.content_scripts, undefined);
  assert.ok(!JSON.stringify(m).includes("<all_urls>"));
  assert.equal(m.host_permissions, undefined, "no always-on host access");
  assert.deepEqual(m.optional_host_permissions, ["https://*.ts.net/*", "http://127.0.0.1/*", "http://localhost/*"]);
  assert.equal(m.minimum_chrome_version, "116");
  assert.equal(m.side_panel.default_path, "panel.html");
});

test("no CDN or remote code anywhere in the extension", () => {
  const dir = new URL("../", import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { if (n === "test" || n === "node_modules") continue; const p = d + "/" + n; fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  for (const f of files.filter((f) => /\.(js|html|css)$/.test(f))) {
    const t = fs.readFileSync(f, "utf8");
    assert.ok(!/<script[^>]+src=["']https?:/i.test(t), f);
    assert.ok(!/@import\s+url\(["']?https?:|import\(["']https?:|from ["']https?:/i.test(t), f);
    assert.ok(!/\beval\(|new Function\(/.test(t), f);
  }
});

test("markdown: code inside link text and raw NUL characters do not leak placeholders", () => {
  const h = renderMarkdown("[`code`](http://a.com) and \u00000\u0000 and \u00009\u0000 [x](https://b.test)");
  assert.ok(h.includes('<a href="http://a.com/" target="_blank" rel="noopener noreferrer"><code>code</code></a>'), h);
  assert.ok(!h.includes("\u0000") && !h.includes("undefined"), h);
  assert.equal((h.match(/b\.test/g) || []).length, 1, "no replayed stash entries");
});

test("options page validates https on .ts.net or the localhost dev case, and requests the exact origin", () => {
  const t = fs.readFileSync(new URL("../options.js", import.meta.url), "utf8");
  assert.ok(t.includes('.endsWith(".ts.net")'));
  assert.ok(t.includes("chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] })"));
});

test("dark mode keeps the Dip squares pale", () => {
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const dark = css.slice(css.indexOf("prefers-color-scheme: dark"), css.indexOf("* { box-sizing"));
  assert.ok(!/--claude-pale:/.test(dark) && !/--codex-pale:/.test(dark), "pale tints are not overridden in dark mode");
  assert.ok(!/--on-pale:/.test(dark), "text on pale stays dark");
});

test("typed links: trimmed, bare hosts get https, junk and non-http refused", () => {
  assert.equal(normalizeTyped("  https://youtu.be/dQw4w9WgXcQ?t=5  "), "https://youtu.be/dQw4w9WgXcQ?t=5");
  assert.equal(normalizeTyped("example.com/post?a=1"), "https://example.com/post?a=1");
  assert.equal(normalizeTyped("<https://example.com/x>"), "https://example.com/x");
  assert.equal(normalizeTyped("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
  for (const bad of ["", "   ", "hello world", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.test/a", "chrome://extensions", "justoneword"]) assert.equal(normalizeTyped(bad), null, bad);
});

test("panel has the URL field (placeholder, Go button, form submit) and the manifest adds no clipboardRead", () => {
  const h = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  assert.match(h, /<form id="urlform"/);
  assert.match(h, /id="urlinput"[^>]*placeholder="Paste a link"/);
  assert.match(h, /<button id="go" type="submit">Go<\/button>/);
  assert.ok(h.indexOf('id="urlform"') < h.indexOf('id="buttons"'), "field is above the five buttons");
  const m = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url)));
  assert.ok(!m.permissions.includes("clipboardRead"));
});

test("panel has the question box below the result, a mic button next to it, and the Enable microphone button", () => {
  const h = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  assert.ok(h.indexOf('id="result"') < h.indexOf('id="askform"'), "box is below the result");
  assert.match(h, /<form id="askform"/);
  assert.match(h, /id="askinput"[^>]*placeholder="Ask a question"/);
  assert.ok(h.indexOf('id="askinput"') < h.indexOf('id="mic"'), "mic is next to the box");
  assert.match(h, /<button id="mic" type="button" data-state="idle"/);
  assert.match(h, /<button id="micsetup" type="button" hidden>Enable microphone<\/button>/);
  assert.match(h, /<button id="askgo" type="submit">Ask<\/button>/);
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  assert.match(css, /#mic\[data-state="listening"\]/, "recording has its own visual state");
});

test("the question controls are docked below the scrolling page, with every message above them, so nothing can move the mic button", () => {
  const h = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  // #ask is a sibling after #page, not inside it, and the result, thread and footer are all inside #page
  const pageEnd = h.indexOf("</div>\n  <section id=\"ask\"");
  assert.ok(pageEnd > 0, "the docked bar follows the closing tag of #page");
  for (const id of ["result", "thread", "error", "status"]) assert.ok(h.indexOf(`id="${id}"`) < pageEnd, `${id} scrolls inside #page`);
  for (const id of ["askform", "mic", "askinput", "micmsg", "micsetup", "askerror"]) assert.ok(h.indexOf(`id="${id}"`) > pageEnd, `${id} is in the docked bar`);
  // messages grow upward from the controls (the bar is anchored at the bottom), never below them
  for (const id of ["micmsg", "micsetup", "askerror"]) assert.ok(h.indexOf(`id="${id}"`) < h.indexOf('id="askform"'), `${id} is above the controls`);
  assert.match(css, /body \{[^}]*height: 100vh; overflow: hidden/);
  assert.match(css, /#page \{[^}]*flex: 1; min-height: 0; overflow-y: auto/);
  assert.match(css, /#ask \{ flex: none;/);
  assert.match(css, /#mic \{[^}]*width: 92px/, "the mic button keeps its width whatever its label says");
});

test("mic button accessibility: its name is its visible label, no changing aria-label, and the recording colour has AA contrast in both themes", () => {
  const h = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  assert.ok(!/<button id="mic"[^>]*aria-(label|pressed)/.test(h));
  assert.ok(!/mic\.setAttribute\("aria-/.test(js), "the label changes with the state, so no aria-pressed or aria-label rides along");
  assert.ok(!/#mic\[aria-pressed/.test(css));
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const light = css.match(/--rec: (#[0-9a-f]{6});/)[1];
  const dark = css.match(/--rec: (#[0-9a-f]{6}); --rec-edge: #8f150c; --q-bg: #34322e/)[1];
  assert.ok(contrast("#ffffff", light) >= 4.5, `light ${contrast("#ffffff", light)}`);
  assert.ok(contrast("#ffffff", dark) >= 4.5, `dark ${contrast("#ffffff", dark)}`);
});

test("the panel stops listening when it is hidden or closed", () => {
  const js = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(js, /visibilitychange", \(\) => \{ if \(document\.hidden\) ctl\.pauseMic\(\); else ctl\.refreshMic\(\); \}\)/);
  assert.match(js, /"pagehide", \(\) => ctl\.pauseMic\(\)/);
});

test("no CSS font shorthand ends in the keyword inherit (that makes the whole declaration invalid and drops it)", () => {
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  assert.ok(!/font:\s*[^;]*\binherit\s*;/.test(css.replace(/font:\s*inherit\s*;/g, "")));
});

test("microphone setup page: one-time getUserMedia in a normal tab, tracks stopped at once, back to the panel", () => {
  const h = fs.readFileSync(new URL("../mic.html", import.meta.url), "utf8");
  const j = fs.readFileSync(new URL("../mic.js", import.meta.url), "utf8");
  assert.match(h, /src="mic\.js"/);
  assert.match(j, /getUserMedia\(\{ audio: true \}\)/);
  assert.ok(j.indexOf("getUserMedia") < j.indexOf("t.stop()"), "the tracks are stopped after the grant");
  assert.match(j, /go back to the Dip'n'Dive panel/);
  assert.match(j, /chrome:\/\/settings\/content\/siteDetails/, "blocked case points at the Chrome setting");
  assert.match(h, /Allow while visiting the site<\/b> \(not "Allow this time"\)/);
  const p = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(p, /getURL\("mic\.html"\)/);
});

test("the microphone needs no extra manifest permission", () => {
  const m = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url)));
  assert.ok(!m.permissions.includes("audioCapture"));
  assert.ok(!m.permissions.includes("offscreen"), "no offscreen document: recognition runs in the panel itself");
});
