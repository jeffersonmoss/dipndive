import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HANDOFF_SITES, buildHandoffText, fillHandoffComposer, handoffEnabled, injectionSite, validateHandoffUrl } from "../lib/handoff-sites.js";

test("five equal hand-off and Dip squares have the requested accessible labels and order", () => {
  const panel = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../panel.css", import.meta.url), "utf8");
  const labels = ["Continue in Claude", "Claude Dip", "Summarize this page", "Codex Dip", "Continue in ChatGPT"];
  assert.deepEqual(labels, ["Continue in Claude", "Claude Dip", "Summarize this page", "Codex Dip", "Continue in ChatGPT"]);
  assert.match(panel, /addHandoff\("claude", "Continue in Claude"\)/);
  assert.match(panel, /addHandoff\("chatgpt", "Continue in ChatGPT"\)/);
  assert.match(panel, /aria-label", label/);
  assert.match(panel, /b\.title = label/);
  assert.match(css, /grid-template-columns: repeat\(5, var\(--u\)\)/);
  assert.match(css, /button\.mode\s*\{[^}]*aspect-ratio: 1/);
  assert.match(panel, /handoff-\$\{id\}-outline-36\.png/);  // the outlined arrow (white, black outline) in both color schemes
});

test("handoff arrows enable only for a finished visible Dip result", () => {
  const done = { result: "A result", busy: false, jobState: "done", jobId: "job-1", source: { url: "https://example.test" } };
  assert.equal(handoffEnabled(done), true);
  for (const patch of [
    { result: null }, { result: "A result", busy: true }, { result: "A result", jobState: "summarizing" },
    { result: "A result", jobId: null }, { result: "A result", source: null },
  ]) assert.equal(handoffEnabled({ ...done, ...patch }), false);
});

test("handoff text carries title, link, markdown and a separate source block; source failure is explicit", () => {
  const full = buildHandoffText({ title: "Example", url: "https://example.test/a", result: "## Result", sourceText: "Complete article" });
  assert.match(full.visibleText, /Example[\s\S]*https:\/\/example\.test\/a[\s\S]*## Result[\s\S]*full transcript or article text is attached/i);
  assert.equal(full.sourceText, "--- Full source text ---\n\nComplete article");
  assert.ok(full.fullText.indexOf(full.visibleText) < full.fullText.indexOf(full.sourceText));
  const partial = buildHandoffText({ title: "Example", url: "https://example.test/a", result: "## Result", sourceText: "" });
  assert.match(partial.visibleText, /could not be fetched/i);
  assert.equal(partial.sourceText, "");
  assert.equal(partial.fullText, partial.visibleText);
});

test("Options accepts HTTPS URLs on only the fixed Claude and ChatGPT hosts", () => {
  for (const site of Object.keys(HANDOFF_SITES)) assert.equal(validateHandoffUrl(HANDOFF_SITES[site].defaultUrl, site).ok, true);
  for (const [value, site] of [["http://claude.ai/x", "claude"], ["https://claude.ai:8443/x", "claude"], ["https://evil.test/x", "claude"], ["https://sub.claude.ai/x", "claude"], ["https://chatgpt.com.evil.test/x", "chatgpt"], ["https://user@chatgpt.com/x", "chatgpt"], ["not a URL", "chatgpt"]]) {
    assert.equal(validateHandoffUrl(value, site).ok, false, value);
  }
  const html = fs.readFileSync(new URL("../options.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../options.js", import.meta.url), "utf8");
  assert.match(html, /id="handoffClaude"/);
  assert.match(html, /id="handoffChatgpt"/);
  assert.match(js, /validateHandoffUrl\(\$\("handoffClaude"\)\.value, "claude"\)/);
  assert.match(js, /validateHandoffUrl\(\$\("handoffChatgpt"\)\.value, "chatgpt"\)/);
});

function fakePage({ editors = [], sendButtons = [], attachment = false, failInsert = false, clipboardError = false } = {}) {
  const page = { notices: [], copied: null, selected: null };
  const body = { appendChild(node) { node.parentNode = body; body.children.push(node); }, children: [] };
  const doc = {
    body,
    querySelectorAll(selector) { return selector.includes("contenteditable") || selector.includes("chat-input") ? editors : selector.includes("aria-label") ? sendButtons : []; },
    querySelector(selector) { return attachment && selector.includes("attachment") ? {} : null; },
    getElementById(id) { return body.children.find((n) => n.id === id) || null; },
    createElement(tag) { return { tagName: tag, style: {}, value: "", select() { page.selected = this; }, remove() { body.children = body.children.filter((n) => n !== this); }, textContent: "" }; },
    execCommand(command, _ui, text) {
      if (command === "copy") { page.copied = page.selected?.value; return true; }
      if (command === "insertText" && !failInsert) { editors.find((e) => e.offsetParent !== null)?.append(text); return true; }
      return false;
    },
  };
  const nav = { clipboard: { async writeText(text) { if (clipboardError) throw new Error("denied"); page.copied = text; } } };
  const old = { document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), DataTransfer: globalThis.DataTransfer, ClipboardEvent: globalThis.ClipboardEvent };
  class DT { constructor() { this.data = {}; } setData(k, v) { this.data[k] = v; } }
  class CE { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } }
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });
  globalThis.DataTransfer = DT;
  globalThis.ClipboardEvent = CE;
  return { page, restore() {
    if (old.document === undefined) delete globalThis.document; else Object.defineProperty(globalThis, "document", { configurable: true, value: old.document });
    if (old.navigator) Object.defineProperty(globalThis, "navigator", old.navigator); else delete globalThis.navigator;
    if (old.DataTransfer === undefined) delete globalThis.DataTransfer; else globalThis.DataTransfer = old.DataTransfer;
    if (old.ClipboardEvent === undefined) delete globalThis.ClipboardEvent; else globalThis.ClipboardEvent = old.ClipboardEvent;
  } };
}

const editor = (visible = true) => ({ offsetParent: visible ? {} : null, isContentEditable: true, textContent: "", innerText: "", focus() {}, dispatchEvent(event) { this.pasted = event.clipboardData.data["text/plain"]; return true; }, append(text) { this.textContent += text; this.innerText = this.textContent; } });
const payload = { visibleText: "Title\n\nhttps://source.test\n\n## Result", sourceText: "--- Full source text ---\n\nLong source", fullText: "Title\n\nhttps://source.test\n\n## Result\n\n--- Full source text ---\n\nLong source" };

test("Claude filler pastes source and leaves visible text focused without clicking Send", async () => {
  const e = editor();
  let sends = 0;
  const page = fakePage({ editors: [e], sendButtons: [{ offsetParent: {}, disabled: false, click() { sends++; } }], attachment: true });
  try {
    const result = await fillHandoffComposer(payload, { ...injectionSite("claude"), pasteWaitMs: 0, pollMs: 0, findTimeoutMs: 0, attachment: "attachment" });
    assert.deepEqual(result, { ok: true, sent: false });
    assert.equal(e.pasted, payload.sourceText);
    assert.equal(e.textContent, payload.visibleText);
    assert.equal(sends, 0);
  } finally { page.restore(); }
});

test("ChatGPT skips the hidden first editor and clicks Send once when enabled", async () => {
  const hidden = editor(false), shown = editor(true);
  let sends = 0;
  const send = { offsetParent: {}, disabled: true, click() { sends++; } };
  const page = fakePage({ editors: [hidden, shown], sendButtons: [send], attachment: true });
  const enable = setTimeout(() => { send.disabled = false; }, 5);
  try {
    const result = await fillHandoffComposer(payload, { ...injectionSite("chatgpt"), pasteWaitMs: 0, pollMs: 1, sendTimeoutMs: 100, findTimeoutMs: 0, attachment: "attachment" });
    assert.deepEqual(result, { ok: true, sent: true });
    assert.equal(hidden.textContent, "");
    assert.equal(shown.pasted, payload.sourceText);
    assert.equal(sends, 1);
  } finally { clearTimeout(enable); page.restore(); }
});

test("filler fallback copies the entire handoff and displays the notice when no editor appears", async () => {
  const page = fakePage({});
  try {
    const result = await fillHandoffComposer(payload, { ...injectionSite("claude"), findTimeoutMs: 0, pollMs: 0, pasteWaitMs: 0, noticeMs: 1, attachment: "attachment" });
    assert.equal(result.ok, false);
    assert.equal(page.page.copied, payload.fullText);
    assert.match(globalThis.document.body.children[0].textContent, /couldn't fill the message box/);
  } finally { page.restore(); }
});

test("filler fallback copies the full text when the paste or visible insertion does not register", async () => {
  const e = editor();
  const page = fakePage({ editors: [e], failInsert: true, attachment: false });
  try {
    const result = await fillHandoffComposer(payload, { ...injectionSite("claude"), findTimeoutMs: 0, pollMs: 0, pasteWaitMs: 0, noticeMs: 1 });
    assert.equal(result.ok, false);
    assert.equal(page.page.copied, payload.fullText);
  } finally { page.restore(); }
});
