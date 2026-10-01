import test from "node:test";
import assert from "node:assert/strict";
import { registerBackground, slotKey, MENU_ID } from "../lib/background-core.js";

function mockChrome(mode) {
  const calls = [];
  const store = mode ? { mode } : {};
  const L = { installed: [], startup: [], changed: [], clicked: [] };
  const chrome = {
    runtime: { lastError: undefined, onInstalled: { addListener: (f) => L.installed.push(f) }, onStartup: { addListener: (f) => L.startup.push(f) } },
    storage: {
      local: { get: async (k) => (k === null ? { ...store } : { ...store }), set: (o) => { calls.push(["set", o]); Object.assign(store, o); return Promise.resolve(); },
               remove: async (keys) => { for (const k of keys) delete store[k]; } },
      onChanged: { addListener: (f) => L.changed.push(f) },
    },
    contextMenus: { create: (o, cb) => { calls.push(["create", o]); cb && cb(); }, update: (id, o, cb) => { calls.push(["update", id, o]); cb && cb(); }, onClicked: { addListener: (f) => L.clicked.push(f) } },
    sidePanel: { open: (o, cb) => { calls.push(["open", o]); cb && cb(); }, setPanelBehavior: (o, cb) => { calls.push(["behavior", o]); cb && cb(); } },
  };
  return { chrome, calls, L, store };
}

test("menu is created once in onInstalled with the current mode label; startup and changes only update", async () => {
  const m = mockChrome("claude-dive");
  registerBackground(m.chrome);
  await m.L.installed[0]();
  const creates = m.calls.filter((c) => c[0] === "create");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0][1], { id: MENU_ID, title: "Dip and Dive: Claude Dive", contexts: ["link", "video", "page"] });
  m.L.startup[0]();
  m.L.changed[0]({ mode: { newValue: "temp" } }, "local");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.calls.filter((c) => c[0] === "create").length, 1);
  assert.ok(m.calls.some((c) => c[0] === "update" && c[2].title === "Dip and Dive: Claude Dive"));
  m.L.changed[0]({ other: {} }, "local");
  m.L.changed[0]({ mode: {} }, "sync"); // other areas ignored
});

test("initial default label is Codex Dip", async () => {
  const m = mockChrome();
  registerBackground(m.chrome);
  await m.L.installed[0]();
  assert.equal(m.calls.find((c) => c[0] === "create")[1].title, "Dip and Dive: Codex Dip");
});

test("click: sidePanel.open is the first call, synchronous, then a per-window slot with a requestId", () => {
  const m = mockChrome();
  let n = 0;
  registerBackground(m.chrome, () => `req-${++n}`);
  m.calls.length = 0; // drop the registration-time setPanelBehavior call
  m.L.clicked[0]({ linkUrl: "https://a.test/x", pageUrl: "https://p.test" }, { windowId: 7 });
  assert.equal(m.calls[0][0], "open");
  assert.deepEqual(m.calls[0][1], { windowId: 7 });
  assert.equal(m.calls[1][0], "set");
  const slot = m.calls[1][1][slotKey(7)];
  assert.equal(slot.url, "https://a.test/x");
  assert.equal(slot.requestId, "req-1");
  assert.equal(slot.windowId, 7);
  assert.equal(slot.consumed, false);
  m.L.clicked[0]({ pageUrl: "https://other.test" }, { windowId: 9 });
  assert.ok(m.store[slotKey(9)] && m.store[slotKey(7)].url === "https://a.test/x", "windows are independent");
});

test("click with no usable url still opens the panel but writes no slot", () => {
  const m = mockChrome();
  registerBackground(m.chrome);
  m.calls.length = 0;
  m.L.clicked[0]({ pageUrl: "chrome://extensions" }, { windowId: 1 });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0][0], "open");
});

test("the toolbar icon opens the side panel", () => {
  const m = mockChrome();
  registerBackground(m.chrome);
  assert.deepEqual(m.calls.find((c) => c[0] === "behavior")[1], { openPanelOnActionClick: true });
});

test("slots are capped at the newest 20 after a click", async () => {
  const m = mockChrome();
  for (let i = 0; i < 25; i++) m.store[`slot:${i + 100}`] = { ts: i };
  registerBackground(m.chrome);
  m.L.clicked[0]({ pageUrl: "https://a.test/" }, { windowId: 7 });
  await new Promise((r) => setTimeout(r, 20));
  const keys = Object.keys(m.store).filter((k) => k.startsWith("slot:"));
  assert.equal(keys.length, 20);
  assert.ok(keys.includes("slot:7") && !keys.includes("slot:100"));
});
