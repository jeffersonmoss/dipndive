import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pickUrl, knownVideo } from "../lib/urls.js";
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
  assert.deepEqual(MODES.map((m) => m.id), ["claude-dip", "claude-dive", "temp", "codex-dip", "codex-dive"]);
  assert.equal(DEFAULT_MODE, "codex-dip");
  assert.equal(menuLabel("codex-dip"), "Dip and Dive: Codex Dip");
  assert.ok(!menuLabel("temp").includes("&"));
  assert.equal(apiMode("temp"), "source");
  assert.equal(apiMode("claude-dive"), "claude-dive");
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
