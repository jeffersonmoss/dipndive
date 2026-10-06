import test from "node:test";
import assert from "node:assert/strict";
import { registerWatchedRecorder, WATCHED_ALARM_PREFIX, WATCH_DELAY_MS, youtubeVideoId } from "../lib/watched.js";

function mockChrome({ enabled = true, granted = true } = {}) {
  const handlers = { updated: [], activated: [], removed: [], alarm: [], changed: [] };
  const local = { base: "http://127.0.0.1:8765", token: "t".repeat(40), ...(enabled ? {} : { recordWatchedVideos: false }) };
  const session = {};
  const tabs = new Map();
  const alarms = new Map();
  const chrome = {
    permissions: { contains: async () => granted },
    storage: {
      local: { get: async (keys) => keys == null ? { ...local } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, local[k]])) },
      session: { get: async (key) => ({ [key]: session[key] }), set: async (o) => Object.assign(session, o) },
      onChanged: { addListener: (f) => handlers.changed.push(f) },
    },
    tabs: {
      onUpdated: { addListener: (f) => handlers.updated.push(f) },
      onActivated: { addListener: (f) => handlers.activated.push(f) },
      onRemoved: { addListener: (f) => handlers.removed.push(f) },
      get: async (id) => { if (!tabs.has(id)) throw new Error("closed"); return tabs.get(id); },
      query: async () => [...tabs.values()],
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      clear: (name) => alarms.delete(name),
      onAlarm: { addListener: (f) => handlers.alarm.push(f) },
    },
  };
  return { chrome, handlers, local, session, tabs, alarms };
}

const A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const B = "https://www.youtube.com/shorts/9bZkp7q19f0";

function harness(opts = {}) {
  const m = mockChrome(opts), calls = [];
  let now = 10_000;
  const rec = registerWatchedRecorder(m.chrome, { now: () => now, fetchImpl: async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return { status: 202, json: async () => ({ queued: true }) };
  } });
  return { ...m, rec, calls, now: (v) => { now = v; } };
}

test("YouTube watch, resolved short links, shorts, and youtu.be ids are recognized", () => {
  assert.equal(youtubeVideoId(A), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId(B), "9bZkp7q19f0");
  assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=4"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://youtube.com/playlist?list=x"), null);
});

test("staying on a video for 30 seconds reports exactly once", async () => {
  const h = harness();
  h.tabs.set(4, { id: 4, url: A, incognito: false });
  await h.rec.observe(h.tabs.get(4));
  assert.equal(h.alarms.get(`${WATCHED_ALARM_PREFIX}4`).when, 10_000 + WATCH_DELAY_MS);
  h.now(40_000);
  await h.rec.onAlarm({ name: `${WATCHED_ALARM_PREFIX}4` });
  await h.rec.onAlarm({ name: `${WATCHED_ALARM_PREFIX}4` });
  assert.deepEqual(h.calls.map((x) => x[1]), [{ url: A }]);
});

test("leaving before 30 seconds reports nothing", async () => {
  const h = harness();
  h.tabs.set(1, { id: 1, url: A, incognito: false });
  await h.rec.observe(h.tabs.get(1));
  h.tabs.set(1, { id: 1, url: "https://example.com/", incognito: false });
  await h.rec.observe(h.tabs.get(1));
  h.now(50_000);
  await h.rec.onAlarm({ name: `${WATCHED_ALARM_PREFIX}1` });
  assert.equal(h.calls.length, 0);
});

test("navigating to another video restarts the 30-second watch", async () => {
  const h = harness();
  h.tabs.set(3, { id: 3, url: A, incognito: false });
  await h.rec.observe(h.tabs.get(3));
  h.now(25_000);
  h.tabs.set(3, { id: 3, url: B, incognito: false });
  await h.rec.observe(h.tabs.get(3));
  assert.equal(h.alarms.get(`${WATCHED_ALARM_PREFIX}3`).when, 55_000);
  h.now(40_000);
  await h.rec.onAlarm({ name: `${WATCHED_ALARM_PREFIX}3` });
  assert.equal(h.calls.length, 0);
  h.now(55_000);
  await h.rec.onAlarm({ name: `${WATCHED_ALARM_PREFIX}3` });
  assert.deepEqual(h.calls.map((x) => x[1]), [{ url: B }]);
});

test("incognito tabs and the disabled setting are ignored", async () => {
  const h = harness();
  h.tabs.set(2, { id: 2, url: A, incognito: true });
  await h.rec.observe(h.tabs.get(2));
  assert.equal(Object.keys(h.session.watchedPending || {}).length, 0);
  h.local.recordWatchedVideos = false;
  h.tabs.set(5, { id: 5, url: A, incognito: false });
  await h.rec.observe(h.tabs.get(5));
  assert.equal(Object.keys(h.session.watchedPending || {}).length, 0);
  assert.equal(h.calls.length, 0);
});

test("a worker restart keeps the pending visit and due time in storage.session", async () => {
  const h = harness();
  h.tabs.set(8, { id: 8, url: A, incognito: false });
  await h.rec.observe(h.tabs.get(8));
  const saved = h.session.watchedPending["8"];
  assert.equal(saved.due, 40_000);
  const restarted = registerWatchedRecorder(h.chrome, { now: () => 40_000, fetchImpl: async (_url, init) => {
    h.calls.push([_url, JSON.parse(init.body)]);
    return { status: 202, json: async () => ({ queued: true }) };
  } });
  await new Promise((r) => setImmediate(r)); // let startup restore alarms and reconcile tabs
  assert.equal(h.alarms.get(`${WATCHED_ALARM_PREFIX}8`).when, 40_000);
  await restarted.onAlarm({ name: `${WATCHED_ALARM_PREFIX}8` });
  assert.deepEqual(h.calls.map((x) => x[1]), [{ url: A }]);
});
