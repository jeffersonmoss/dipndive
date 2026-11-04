import test from "node:test";
import assert from "node:assert/strict";
import { MEDIA_HUSH, createMediaClient, pausePageMedia, registerMediaHush, resumePageMedia } from "../lib/media-hush.js";
import { MIC } from "../lib/voice.js";
import { makePermissions, makeSpeech, rig, slot } from "./rig.mjs";

const flush = () => new Promise((r) => setTimeout(r, 5));
const EXT = "dipdive-ext-id";

// Fake tabs: pausable (the page script pauses this many elements), blocked (no site access: executeScript throws),
// muted (already muted, by him or by the Watched countdown).
function makeWorker(tabs) {
  const session = {};
  const log = { scripts: [], updates: [] };
  const L = { connect: [], message: [] };
  const chrome = {
    runtime: { id: EXT, lastError: undefined, onConnect: { addListener: (f) => L.connect.push(f) }, onMessage: { addListener: (f) => L.message.push(f) } },
    storage: { session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => { Object.assign(session, o); } } },
    tabs: {
      query: async (q) => tabs.filter((t) => !q.audible || t.audible),
      get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return t; },
      update: async (id, o) => {
        log.updates.push([id, o]);
        const t = tabs.find((x) => x.id === id);
        if ("muted" in o) t.mutedInfo = o.muted ? { muted: true, reason: "extension", extensionId: EXT } : { muted: false };
      },
    },
    scripting: {
      executeScript: async ({ target, func }) => {
        const t = tabs.find((x) => x.id === target.tabId);
        log.scripts.push([target.tabId, func.name, target.allFrames]);
        if (!t || t.blocked) throw new Error("Cannot access contents of the page");
        return [{ result: func === pausePageMedia ? (t.pausable ?? 0) : 0 }, { result: 0 }];
      },
    },
  };
  const api = registerMediaHush(chrome);
  // A panel port: returns { send(msg), drop() } driving the worker's listeners.
  const port = () => {
    const ls = { msg: [], gone: [] };
    const p = { name: MEDIA_HUSH.port, onMessage: { addListener: (f) => ls.msg.push(f) }, onDisconnect: { addListener: (f) => ls.gone.push(f) } };
    for (const f of L.connect) f(p);
    return { send: (m) => ls.msg.forEach((f) => f(m)), drop: () => ls.gone.forEach((f) => f()) };
  };
  return { chrome, api, log, session, port, L };
}

const tabsFixture = () => [
  { id: 1, audible: true, pausable: 1, mutedInfo: { muted: false } },                 // YouTube with access: paused
  { id: 2, audible: true, blocked: true, mutedInfo: { muted: false } },               // no access: muted instead
  { id: 3, audible: true, pausable: 0, mutedInfo: { muted: false } },                 // Web Audio, nothing to pause: muted
  { id: 4, audible: true, pausable: 1, mutedInfo: { muted: true, reason: "user" } }, // already muted: left alone
  { id: 5, audible: false, pausable: 1, mutedInfo: { muted: false } },                // silent: left alone
];

test("hush pauses what it can, mutes what it cannot, and skips silent or already-muted tabs", async () => {
  const tabs = tabsFixture();
  const w = makeWorker(tabs);
  await w.api.hush();
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey], { paused: [1], muted: [2, 3] });
  assert.deepEqual(w.log.updates, [[2, { muted: true }], [3, { muted: true }]]);
  assert.ok(w.log.scripts.every(([, , all]) => all === true), "every frame, so embedded players pause too");
  assert.ok(!w.log.scripts.some(([id]) => id === 4 || id === 5));
});

test("restore resumes the paused tab and unmutes only tabs this extension muted", async () => {
  const tabs = tabsFixture();
  const w = makeWorker(tabs);
  await w.api.hush();
  tabs[2].mutedInfo = { muted: true, reason: "user" };  // he muted tab 3 himself during dictation: it stays muted
  w.log.updates.length = 0; w.log.scripts.length = 0;
  await w.api.restore();
  assert.deepEqual(w.log.scripts, [[1, "resumePageMedia", true]]);
  assert.deepEqual(w.log.updates, [[2, { muted: false }]]);
  assert.equal(tabs[3].mutedInfo.muted, true, "his own mute is untouched");
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey], { paused: [], muted: [] });
  w.log.updates.length = 0;
  await w.api.restore();
  assert.deepEqual(w.log.updates, [], "a second restore does nothing");
});

test("a second hush in the same dictation does not pause or mute a tab twice", async () => {
  const w = makeWorker(tabsFixture());
  await w.api.hush();
  await w.api.hush();
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey], { paused: [1], muted: [2, 3] });
});

test("the panel closing mid-dictation (port dropped) restores; an explicit restore then drop does not restore twice", async () => {
  const w = makeWorker(tabsFixture());
  const p = w.port();
  p.send({ type: "hush" }); await flush();
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey].muted, [2, 3]);
  p.drop(); await flush();
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey], { paused: [], muted: [] });
  const q = w.port();
  q.send({ type: "hush" }); await flush();
  w.log.updates.length = 0;
  q.send({ type: "restore" }); q.drop(); await flush();
  assert.deepEqual(w.log.updates.filter(([, o]) => o.muted === false).map(([id]) => id), [2, 3], "each muted tab unmuted once");
});

test("the restore message (used when the port is dead) restores from session storage", async () => {
  const w = makeWorker(tabsFixture());
  await w.api.hush();
  let answer = null;
  const keep = w.L.message[0]({ type: MEDIA_HUSH.restoreMessage }, {}, (r) => { answer = r; });
  assert.equal(keep, true);
  await flush();
  assert.deepEqual(answer, { ok: true });
  assert.deepEqual(w.session[MEDIA_HUSH.sessionKey], { paused: [], muted: [] });
  assert.equal(w.L.message[0]({ type: "other" }, {}, () => {}), false);
});

test("page functions pause only playing elements and resume only those still paused and on the page", () => {
  const el = (paused, ended = false) => ({ paused, ended, isConnected: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  const playing = el(false), stopped = el(true), done = el(false, true), gone = el(false);
  globalThis.document = { querySelectorAll: () => [playing, stopped, done, gone] };
  try {
    delete globalThis.__dipdiveHushed;
    assert.equal(pausePageMedia(), 2);
    assert.equal(playing.paused && gone.paused, true);
    gone.isConnected = false;
    assert.equal(resumePageMedia(), 1);
    assert.equal(playing.paused, false);
    assert.equal(gone.paused, true);
    assert.equal(stopped.paused, true, "something he had paused stays paused");
    assert.equal(resumePageMedia(), 0, "nothing to resume twice");
  } finally { delete globalThis.document; delete globalThis.__dipdiveHushed; }
});

function makePanelChrome({ asked = false, connectThrows = false } = {}) {
  const log = { requests: [], posts: [], sent: [], sets: [], disconnects: 0 };
  let gone = null;
  const chrome = {
    runtime: {
      lastError: undefined,
      connect: () => {
        if (connectThrows) throw new Error("no worker");
        return { postMessage: (m) => { if (gone === "dead") throw new Error("disconnected port"); log.posts.push(m.type); },
                 disconnect: () => { log.disconnects++; }, onDisconnect: { addListener: () => {} } };
      },
      sendMessage: async (m) => { log.sent.push(m.type); return { ok: true }; },
    },
    storage: { local: { get: async () => (asked ? { [MEDIA_HUSH.askedKey]: true } : {}), set: async (o) => { log.sets.push(o); } } },
    permissions: { request: async (o) => { log.requests.push(o); return false; } },
  };
  return { chrome, log, kill: () => { gone = "dead"; } };
}
const timers = () => { const t = { live: 0 }; return { t, opts: { setEvery: () => { t.live++; return 1; }, clearEvery: () => { t.live--; } } }; };

test("panel client asks for all-sites access once ever, and not at all once storage says it asked", async () => {
  const a = makePanelChrome();
  const c = createMediaClient(a.chrome, timers().opts);
  await flush();
  await c.askAccess(); await c.askAccess();
  assert.deepEqual(a.log.requests, [{ origins: ["<all_urls>"] }]);
  assert.deepEqual(a.log.sets, [{ [MEDIA_HUSH.askedKey]: true }]);
  const b = makePanelChrome({ asked: true });
  const d = createMediaClient(b.chrome, timers().opts);
  await flush();
  await d.askAccess();
  assert.deepEqual(b.log.requests, []);
});

test("panel client: hush and restore are idempotent, keep the worker awake, and fall back to a message when the port died", async () => {
  const a = makePanelChrome();
  const { t, opts } = timers();
  const c = createMediaClient(a.chrome, opts);
  c.hush(); c.hush();
  assert.deepEqual(a.log.posts, ["hush"]);
  assert.equal(t.live, 1);
  c.restore(); c.restore();
  assert.deepEqual(a.log.posts, ["hush", "restore"]);
  assert.equal(t.live, 0);
  assert.equal(a.log.disconnects, 1);
  c.hush();
  a.kill();
  c.restore();
  assert.deepEqual(a.log.sent, [MEDIA_HUSH.restoreMessage]);
  const b = makePanelChrome({ connectThrows: true });
  const d = createMediaClient(b.chrome, timers().opts);
  assert.doesNotThrow(() => { d.hush(); d.restore(); });
  assert.deepEqual(b.log.sent, [MEDIA_HUSH.restoreMessage]);
});

function fakeMedia(order) {
  return { calls: [], async askAccess() { this.calls.push("ask"); order?.push("ask"); }, hush() { this.calls.push("hush"); }, restore() { this.calls.push("restore"); } };
}

test("controller: other tabs go quiet from the moment the mic starts and come back when it stops", async () => {
  const speech = makeSpeech();
  const media = fakeMedia();
  const r = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), media });
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  assert.deepEqual(media.calls, ["ask", "hush"], "the access prompt comes before listening starts");
  speech.last.fire("audiostart");
  speech.last.result([{ t: "hello", final: true }]);
  assert.deepEqual(media.calls, ["ask", "hush"], "no repeat while listening");
  await r.c.toggleMic();
  assert.equal(r.state.last.mic.state, MIC.STOPPING);
  assert.deepEqual(media.calls, ["ask", "hush"], "still quiet while the last words arrive");
  speech.last.fire("end");
  assert.equal(r.state.last.mic.state, MIC.IDLE);
  assert.deepEqual(media.calls, ["ask", "hush", "restore"]);
});

test("controller: a refused mic (no permission) never pauses anything; a throwing media object never blocks dictation", async () => {
  const media = fakeMedia();
  const r = rig({ slot: slot(), mode: "claude-dip", speech: makeSpeech(), permissions: makePermissions("prompt"), media });
  await r.c.init(1); await r.tick();
  await r.c.toggleMic();
  assert.ok(!media.calls.includes("hush") || media.calls.at(-1) === "restore");
  const speech = makeSpeech();
  const bad = { askAccess: async () => { throw new Error("x"); }, hush: () => { throw new Error("x"); }, restore: () => { throw new Error("x"); } };
  const r2 = rig({ slot: slot(), mode: "claude-dip", speech, permissions: makePermissions("granted"), media: bad });
  await r2.c.init(1); await r2.tick();
  await r2.c.toggleMic();
  speech.last.fire("audiostart");
  assert.equal(r2.state.last.mic.state, MIC.LISTENING);
});
