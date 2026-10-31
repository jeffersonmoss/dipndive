import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { creatorVideosUrl, creatorView } from "../lib/urls.js";
import { rig, slot } from "./rig.mjs";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const HANDLE = "https://www.youtube.com/@TEDx";
const UC = "https://www.youtube.com/channel/UCsT0YIqwnpJCM-mx7-gSA4Q";

test("creatorVideosUrl: a YouTube @handle or /channel/UC address gets /videos, a trailing slash stripped first", () => {
  assert.equal(creatorVideosUrl(HANDLE), `${HANDLE}/videos`);
  assert.equal(creatorVideosUrl(`${HANDLE}/`), `${HANDLE}/videos`);
  assert.equal(creatorVideosUrl(UC), `${UC}/videos`);
  assert.equal(creatorVideosUrl(`${UC}/`), `${UC}/videos`);
});

test("creatorVideosUrl: anything else is not a link", () => {
  for (const bad of [null, undefined, 5, "", "not a url", "http://www.youtube.com/@x", "https://youtube.com/@x", "https://m.youtube.com/@x",
    "https://www.youtube.com.evil.test/@x", "https://evil.test/@x", "https://www.youtube.com/user/old", "https://www.youtube.com/@x/videos",
    "https://www.youtube.com/channel/abc", "https://www.youtube.com/@x?a=1", "https://www.youtube.com/@x#h", "javascript:alert(1)",
    "https://user:pw@www.youtube.com/@x", "https://www.youtube.com:8443/@x", "https://www.youtube.com/"]) {
    assert.equal(creatorVideosUrl(bad), null, String(bad));
  }
});

test("creatorView: a link with the name, plain text without a good address, hidden without a name", () => {
  assert.deepEqual(creatorView({ channel: "TEDx Talks", channelUrl: HANDLE }), { name: "TEDx Talks", href: `${HANDLE}/videos` });
  assert.deepEqual(creatorView({ channel: "The Daily Test", channelUrl: null }), { name: "The Daily Test", href: null }, "an article's site name is plain text");
  assert.deepEqual(creatorView({ channel: "X", channelUrl: "https://evil.test/@x" }), { name: "X", href: null });
  assert.deepEqual(creatorView({ channel: "  ", channelUrl: HANDLE }), { name: "", href: null }, "no name: hidden, even with an address");
  assert.deepEqual(creatorView({ channel: null, channelUrl: null }), { name: "", href: null });
  assert.deepEqual(creatorView({}), { name: "", href: null });
});

test("the controller carries channel and channel_url from the job JSON, and clears them with the title on a new source", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  r.server.creator = { channel: "TEDx Talks", channel_url: HANDLE };
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.channel, "TEDx Talks");
  assert.equal(r.state.last.channelUrl, HANDLE);
  r.server.creator = { channel: "Old Cache" };   // the next job's source was cached without a channel_url
  r.server.hold = (path) => path === "/jobs";     // the new job is on its way: the view was reset first
  const p = r.c.selectMode("codex-dip");
  await Promise.resolve();
  assert.equal(r.state.last.title, null);
  assert.equal(r.state.last.channel, null);
  assert.equal(r.state.last.channelUrl, null);
  r.server.hold = null;
  void p;
});

test("an article job shows its site name and no address; a source cached without a channel_url keeps the channel only", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  r.server.creator = { channel: "Old Cache" };
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.channel, "Old Cache");
  assert.equal(r.state.last.channelUrl, null);
  assert.deepEqual(creatorView(r.state.last), { name: "Old Cache", href: null });
});

test("a job without any creator leaves the line empty", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  await r.c.init(1); await r.tick();
  assert.equal(r.state.last.channel, null);
  assert.equal(creatorView(r.state.last).name, "");
});

test("panel.html: #creator sits directly under the #title link inside the header and starts hidden", () => {
  const h = read("panel.html");
  assert.match(h, /<a id="title" href="#" target="_blank" rel="noopener noreferrer" hidden><\/a>\s*<div id="creator" hidden><\/div>\s*<\/header>/);
});

test("panel.css: 13px, weight 500, the foreground color (black in light mode, white in dark), underline only on hover", () => {
  const c = read("panel.css");
  const rule = c.match(/header #creator \{([^}]*)\}/)[1];
  assert.match(rule, /font-size: 13px;/);
  assert.match(rule, /font-weight: 500;/);
  assert.match(rule, /color: var\(--fg\);/);
  assert.match(rule, /margin-top: \d+px;/, "a small top margin");
  assert.ok(!/padding-left|margin-left|text-indent/.test(rule), "same left alignment as the title");
  assert.match(c.match(/header #creator a \{([^}]*)\}/)[1], /color: var\(--fg\); text-decoration: none;/);
  assert.match(c, /header #creator a:hover \{ text-decoration: underline; \}/);
  assert.match(c, /--fg: #1c1b19;/, "--fg is near-black in light mode");
  assert.match(c, /@media \(prefers-color-scheme: dark\) \{[\s\S]*--fg: #ecebe7;/, "and near-white in dark mode");
});

test("panel.js: the creator is drawn with textContent and a link carrying noopener noreferrer in a new tab, never innerHTML", () => {
  const js = read("panel.js");
  const fn = js.match(/function renderCreator\(s\) \{([\s\S]*?)\n\}/)[1];
  assert.match(fn, /creatorView\(s\)/);
  assert.match(fn, /a\.target = "_blank";/);
  assert.match(fn, /a\.rel = "noopener noreferrer";/);
  assert.match(fn, /a\.textContent = name;/);
  assert.ok(!/innerHTML/.test(fn), "the name is never parsed as HTML");
  assert.match(js, /renderCreator\(s\);/, "render() calls it");
});

test("manifest version is 1.3.1", () => {
  assert.equal(JSON.parse(read("manifest.json")).version, "1.3.1");
});
