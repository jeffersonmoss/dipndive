import test from "node:test";
import assert from "node:assert/strict";
import { askEntry } from "../lib/cardask.js";
import { entryHtml, matches, searchText } from "../lib/history.js";

const ID = "a".repeat(32);
const entry = (o = {}) => ({ url: "https://www.youtube.com/watch?v=x", mode: "claude-dive", job_id: ID, summary: "The summary.",
  qa: [{ q: "first?", a: "first answer" }], ...o });

function companion(states) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const json = init.method === "POST" ? { job_id: "j1" } : states.shift();
    return { status: 200, headers: { get: () => "application/json" }, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, fetch };
}
const deps = (c, o = {}) => ({ fetch: c.fetch, cfg: { base: "http://127.0.0.1:9", token: "t".repeat(40) }, uuid: () => "u1", wait: async () => {}, ...o });

test("a card question is asked against the entry, with its earlier Q&A and summary, and returns the answer", async () => {
  const c = companion([{ state: "fetching" }, { state: "done", result_markdown: "the answer" }]);
  const labels = [];
  const r = await askEntry(deps(c, { onLabel: (t) => labels.push(t) }), entry(), "  what  next? ");
  assert.deepEqual(r, { q: "what next?", a: "the answer" });
  const post = c.calls[0];
  assert.equal(post.method, "POST");
  assert.match(post.url, /\/jobs$/);
  assert.deepEqual(post.body, { url: "https://www.youtube.com/watch?v=x", mode: "claude-ask", requestId: "u1", question: "what next?",
    history: [{ q: "first?", a: "first answer" }], summary: "The summary.", entry: ID, force: false });
  assert.ok(labels.includes("Fetching the source..."));
});

test("a Codex entry asks Codex, or Claude when Codex is unavailable; errors come back in plain words", async () => {
  let c = companion([{ state: "done", result_markdown: "x" }]);
  await askEntry(deps(c), entry({ mode: "codex-dip" }), "q");
  assert.equal(c.calls[0].body.mode, "codex-ask");
  c = companion([{ state: "done", result_markdown: "x" }]);
  await askEntry(deps(c, { codexOk: false }), entry({ mode: "codex-dip" }), "q");
  assert.equal(c.calls[0].body.mode, "claude-ask");
  c = companion([{ state: "error", error_code: "timeout" }]);
  assert.deepEqual(await askEntry(deps(c), entry(), "q"), { error: "The summary took too long and was stopped." });
  assert.deepEqual(await askEntry(deps(c), entry(), "   "), { error: "Type or say a question first." });
  assert.ok((await askEntry(deps(c), entry({ job_id: null }), "q")).error);
});

test("History cards show their kept Q&A safely, and search finds words in questions and answers", () => {
  const e = entry({ title: "T", qa: [{ q: "<b>why</b>?", a: "Because **zebras**." }] });
  const h = entryHtml(e);
  assert.match(h, /<div class="hthread"><div class="turn"><div class="q">&lt;b&gt;why&lt;\/b&gt;\?<\/div><div class="a">/);
  assert.match(h, /<strong>zebras<\/strong>/);
  assert.ok(matches(searchText(e), "zebras"));
  assert.ok(matches(searchText(e), "why"));
  assert.ok(entryHtml(entry({ qa: undefined })).includes('<div class="hthread"></div>'));
});
