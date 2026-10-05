import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rig, slot } from "./rig.mjs";
import { renderClipboardRow } from "../lib/clipboard-view.js";

const initialized = async (options = {}) => {
  const r = rig({ slot: slot(), mode: "claude-dip", ...options });
  await r.c.init(1);
  await r.tick();
  return r;
};

test("clipboard row is below the save row and has four checked machine boxes", () => {
  const html = fs.readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="saveline"') < html.indexOf('id="clipline"'));
  assert.match(html, /Send to clipboard/);
  for (const name of ["Thing 2", "Thing 1", "iMac", "Win"]) assert.match(html, new RegExp("<span>" + name + "<\\/span>"));
  assert.equal((html.match(/data-machine="[^"]+" checked/g) || []).length, 4);
});

test("all machines default checked and the changed set persists", async () => {
  const r = await initialized();
  assert.deepEqual(r.state.last.clipboardMachines, ["thing-2", "thing-1", "imac", "win"]);
  await r.c.setClipboardMachines(["thing-1", "win"]);
  assert.deepEqual(r.store.clipboardMachines, ["thing-1", "win"]);
  assert.deepEqual(r.state.last.clipboardMachines, ["thing-1", "win"]);
});

test("rendered row reflects its saved checks and disables its button without a source", () => {
  const button = {}, status = {}, inputs = ["thing-2", "thing-1", "imac", "win"].map((machine) => ({ dataset: { machine } }));
  renderClipboardRow({ button, status, inputs }, { source: null, clipboardStatus: "", clipboardMachines: ["thing-1", "win"] });
  assert.equal(button.disabled, true);
  assert.deepEqual(inputs.map((x) => x.checked), [false, true, false, true]);
  renderClipboardRow({ button, status, inputs }, { source: { url: "https://example.com" }, clipboardStatus: "Sent to Win", clipboardMachines: ["win"] });
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, "Sent to Win");
  renderClipboardRow({ button, status, inputs }, { source: { url: "https://example.com" }, clipboardStatus: "Sending...", clipboardSending: true, clipboardMachines: ["win"] });
  assert.equal(button.disabled, true);
});

test("no source means sending is disabled and does nothing", async () => {
  const r = rig();
  await r.c.init(1);
  assert.equal(await r.c.sendToClipboard(async () => assert.fail("no local write")), false);
  assert.deepEqual(r.log.fetches.filter((f) => f.path === "/clipboard"), []);
});

test("local target gets the exact source URL and mailbox receives only other checked machines", async () => {
  const r = await initialized({ shared: { base: "http://c.test", token: "t".repeat(40), computerName: "thing-1", "slot:1": slot() } });
  const writes = [];
  const realFetch = r.c.d.fetch;
  r.c.d.fetch = async (url, init) => {
    if (url.endsWith("/clipboard")) {
      r.log.fetches.push({ path: "/clipboard", method: "POST", body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { status: 202, json: async () => ({ queued: ["thing-2", "imac", "win"] }) };
    }
    return realFetch(url, init);
  };
  assert.equal(await r.c.sendToClipboard(async (url) => writes.push(url)), true);
  assert.deepEqual(writes, ["https://v.test/watch"]);
  const post = r.log.fetches.find((f) => f.path === "/clipboard");
  assert.equal(post.auth, "Bearer " + "t".repeat(40));
  assert.deepEqual(post.body, { url: "https://v.test/watch", machines: ["thing-2", "imac", "win"] });
  assert.equal(r.state.last.clipboardStatus, "Queued for Thing 2, iMac, Win (expires in 15 min). Sent to Thing 1");
});

test("when this computer is not set, every selected machine is posted to the mailbox", async () => {
  const r = await initialized();
  let body;
  r.c.d.fetch = async (_url, init) => { body = JSON.parse(init.body); return { status: 202, json: async () => ({}) }; };
  assert.equal(await r.c.sendToClipboard(async () => assert.fail("unset computers always use the mailbox")), true);
  assert.deepEqual(body, { url: "https://v.test/watch", machines: ["thing-2", "thing-1", "imac", "win"] });
});

test("local clipboard failure falls back to the mailbox", async () => {
  const r = await initialized({ shared: { base: "http://c.test", token: "t".repeat(40), computerName: "thing-2", "slot:1": slot() } });
  let body;
  r.c.d.fetch = async (_url, init) => { body = JSON.parse(init.body); return { status: 202, json: async () => ({}) }; };
  assert.equal(await r.c.sendToClipboard(async () => { throw new Error("denied"); }), true);
  assert.deepEqual(body.machines, ["thing-2", "thing-1", "imac", "win"]);
  assert.equal(r.state.last.clipboardStatus, "Queued for Thing 2, Thing 1, iMac, Win (expires in 15 min)");
});

test("no checked machines, long URLs, and unauthorized tokens have clear statuses", async () => {
  const r = await initialized();
  await r.c.setClipboardMachines([]);
  assert.equal(await r.c.sendToClipboard(async () => assert.fail("nothing selected")), false);
  assert.equal(r.state.last.clipboardStatus, "Pick at least one computer.");
  await r.c.setClipboardMachines(["win"]);
  r.c.s.source = { url: "https://example.com/" + "x".repeat(2050) };
  assert.equal(await r.c.sendToClipboard(async () => assert.fail("URL is too long")), false);
  assert.match(r.state.last.clipboardStatus, /maximum 2048 characters/);
  r.c.s.source = { url: "https://v.test/watch" };
  r.c.d.fetch = async () => ({ status: 401, json: async () => ({}) });
  assert.equal(await r.c.sendToClipboard(async () => {}), false);
  assert.match(r.state.last.clipboardStatus, /token was rejected/);
});

test("clipboard sending disables the action and prevents duplicate mailbox posts", async () => {
  const r = await initialized();
  let release;
  let posts = 0;
  r.c.d.fetch = async () => { posts++; return new Promise((resolve) => { release = () => resolve({ status: 202, json: async () => ({}) }); }); };
  const first = r.c.sendToClipboard(async () => {});
  assert.equal(r.state.last.clipboardSending, true);
  assert.equal(await r.c.sendToClipboard(async () => {}), false);
  assert.equal(posts, 1);
  release();
  assert.equal(await first, true);
  assert.equal(r.state.last.clipboardSending, false);
});

test("clipboard status clears when the source changes or the view resets", async () => {
  const r = await initialized();
  r.c.emit({ clipboardStatus: "old result" });
  await r.c.onSlot(slot({ url: "https://other.test/page", requestId: "new-request" }));
  assert.equal(r.state.last.clipboardStatus, "");
  r.c.emit({ clipboardStatus: "old result" });
  r.c.resetView();
  assert.equal(r.state.last.clipboardStatus, "");
});

test("unconfigured computer queues every checked target and the Options setting persists", async () => {
  const html = fs.readFileSync(new URL("../options.html", import.meta.url), "utf8");
  assert.ok(html.includes('<label for="computer">This computer is</label>'));
  assert.ok(html.includes('<option value="">Not set</option>'));
  const old = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const els = {};
  const getEl = (id) => els[id] ||= { value: "", hidden: false, disabled: false, handlers: {}, addEventListener(k, f) { this.handlers[k] = f; }, focus() {} };
  const store = { base: "http://c.test", token: "t".repeat(40) };
  globalThis.document = { getElementById: getEl, addEventListener() {} };
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]])),
    set: async (x) => Object.assign(store, x), remove: async () => {},
  } }, permissions: { request: async () => true } };
  globalThis.fetch = async () => ({ status: 200, json: async () => ({}) });
  try {
    await import("../options.js?clipboard-setting=" + Math.random());
    assert.equal(els.computer.value, "");
    els.computer.value = "thing-2";
    await els.computer.handlers.change();
    assert.equal(store.computerName, "thing-2");
  } finally { Object.assign(globalThis, old); }
});
