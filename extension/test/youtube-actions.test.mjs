import test from "node:test";
import assert from "node:assert/strict";
import { registerYoutubeActions, youtubeActionVisible, youtubePageStep, YOUTUBE_ACTIONS, THUMB_ACTIONS } from "../lib/youtube-actions.js";
import { VIDEO_STATES_KEY, MAX_VIDEO_STATES, capVideoStates, normalizeVideoState, watchView } from "../lib/video-state.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO_ID = "dQw4w9WgXcQ";
const OTHER_URL = "https://www.youtube.com/watch?v=9bZkp7q19f0";
const OTHER_ID = "9bZkp7q19f0";
const THIRD_URL = "https://www.youtube.com/watch?v=abcdefghijk";
const THIRD_ID = "abcdefghijk";
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// A fake Chrome for the service worker. Time is virtual. With `manual: true` every sleep waits until the test calls
// `tick()`, so the countdown, the queue and a watch in progress can be looked at between steps.
function harness({ permission = true, local: extraLocal = {}, timings = {}, manual = false, script = null, failScript = false } = {}) {
  const session = {};
  const local = { base: "https://companion.test", token: "t".repeat(40), ...extraLocal };
  const log = [], handlers = [], posts = [], sleepers = [], tabUrls = {}, scriptCalls = {}, sessionTabsSeen = [];
  const open = new Set();
  let now = 1000, nextWindow = 8, maxOpen = 0;
  const chrome = {
    storage: {
      session: { get: async (k) => ({ [k]: session[k] }), set: async (v) => Object.assign(session, v) },
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
        set: async (values) => Object.assign(local, structuredClone(values)),
      },
    },
    permissions: { contains: async () => permission },
    runtime: { onMessage: { addListener: (fn) => handlers.push(fn) }, sendMessage: () => {}, lastError: null },
    windows: {
      create: async (opts) => { const id = ++nextWindow; open.add(id); maxOpen = Math.max(maxOpen, open.size); log.push(["create", opts, id]); return { id, tabs: [{ id: id + 10 }] }; },
      remove: async (id) => { open.delete(id); log.push(["close", id]); },
      onRemoved: { addListener: () => {} },
    },
    tabs: { update: async (id, patch) => { log.push(["update", id, patch]); if (patch.url) tabUrls[id] = patch.url; }, remove: async () => {} },
    scripting: { executeScript: async ({ target, func, args }) => {
      if (failScript) throw new Error("injection failed");
      log.push(["execute", target.tabId]);
      sessionTabsSeen.push([...(session.youtubeActionTabs || [])]);
      if (func !== youtubePageStep) return [{ result: null }];
      const n = scriptCalls[target.tabId] = (scriptCalls[target.tabId] || 0) + 1;
      return [{ result: script({ tabId: target.tabId, n, action: args[0], url: tabUrls[target.tabId] }) }];
    } },
  };
  const sleep = (ms) => {
    if (!manual) { now += ms; return Promise.resolve(); }
    return new Promise((resolve) => sleepers.push({ ms, resolve }));
  };
  const actions = registerYoutubeActions(chrome, {
    now: () => now, sleep, uuid: (() => { let n = 0; return () => `action-${++n}`; })(),
    timings: { ...YOUTUBE_ACTIONS.timings, intervalMs: 1, countdownMs: 3, startupTimeoutMs: 4, actionTimeoutMs: 6, completionSlackMs: 3, ...timings },
    fetchImpl: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { status: 202, json: async () => ({ queued: true }) }; },
  });
  // one round of the manual clock: everything that is sleeping wakes up
  const tick = async (rounds = 1) => {
    for (let i = 0; i < rounds; i++) {
      await settle();
      const waiting = sleepers.splice(0);
      if (waiting.length) { now += Math.max(...waiting.map((s) => s.ms)); waiting.forEach((s) => s.resolve()); }
      await settle();
    }
  };
  const states = () => local[VIDEO_STATES_KEY] || {};
  const watchOf = (id = VIDEO_ID) => normalizeVideoState(states()[id]).watch;
  const opened = () => log.filter(([name]) => name === "create").length;
  const send = (message) => new Promise((resolve) => { actions.handle(message, {}, resolve); });
  return { chrome, actions, session, local, log, posts, handlers, tick, states, watchOf, opened, open, send, get maxOpen() { return maxOpen; }, sessionTabsSeen };
}

// A fake YouTube page for youtubePageStep (document is global while a test runs).
function fakePage({ signedIn = true, liked = false, disliked = false, segmented = false, rates, levels, quality, ad = false, playerState = 2, time = 0, duration = 100, noDislike = false } = {}) {
  const page = { liked, disliked, calls: [] };
  const button = (kind) => ({
    disabled: false,
    getAttribute: (n) => n === "aria-pressed" ? String(page[kind === "like" ? "liked" : "disliked"]) : null,
    click() {
      page.calls.push(`${kind}-click`);
      if (kind === "like") { page.liked = !page.liked; if (page.liked) page.disliked = false; }
      else { page.disliked = !page.disliked; if (page.disliked) page.liked = false; }
    },
  });
  const likeButton = button("like"), dislikeButton = button("dislike");
  const player = {
    classList: { contains: (c) => ad && c === "ad-showing" },
    mute: () => page.calls.push("mute"), unMute: () => page.calls.push("unmute"),
    getCurrentTime: () => time, getDuration: () => duration, getPlayerState: () => playerState,
    setPlaybackRate: (r) => page.calls.push(`rate:${r}`), playVideo: () => page.calls.push("play"), pauseVideo: () => page.calls.push("pause"),
    ...(rates ? { getAvailablePlaybackRates: () => rates } : {}),
    ...(levels ? { getAvailableQualityLevels: () => levels, setPlaybackQualityRange: (a, b) => page.calls.push(`range:${a}:${b}`), setPlaybackQuality: (q) => page.calls.push(`quality:${q}`), getPlaybackQuality: () => quality } : {}),
  };
  const video = { muted: false, paused: true, currentTime: time, duration, ended: false, playbackRate: 1, play: () => { page.calls.push("video-play"); return Promise.resolve(); }, pause: () => page.calls.push("video-pause") };
  const S = YOUTUBE_ACTIONS.selectors;
  globalThis.document = {
    querySelector: (s) => s === S.player ? player : s === S.video ? video : s === S.avatar && signedIn ? {} : null,
    querySelectorAll: (s) => {
      if (segmented) return s === S.segmented ? [likeButton, dislikeButton] : [];
      if (s === S.like[0]) return [likeButton];
      if (s === S.dislike[0]) return noDislike ? [] : [dislikeButton];
      return [];
    },
  };
  delete globalThis.__dipdiveClickedActions;
  return { page, player, video };
}
const done = () => { delete globalThis.document; delete globalThis.__dipdiveClickedActions; };
const step = (action, extra = {}) => youtubePageStep(action, { selectors: YOUTUBE_ACTIONS.selectors, endToleranceSeconds: 2, ...extra });
const clicks = (p) => p.page.calls.filter((c) => c.endsWith("click"));

// ---------- the page step: thumbs ----------

test("Like, Unlike, Dislike and Undislike toggle only toward the requested state, once, and pause the player", () => {
  try {
    const p = fakePage();
    assert.equal(step("like").working, true);
    assert.equal(step("like").done, true);              // the page now shows it pressed
    assert.deepEqual(clicks(p), ["like-click"], "one click");
    assert.ok(p.page.calls.includes("pause"), "the video is paused for a thumb");
    assert.equal(p.page.calls.includes("play"), false);
    // already liked: Like reports done and never clicks (it must not undo)
    done(); const liked = fakePage({ liked: true });
    assert.deepEqual(step("like"), { done: true, already: true });
    assert.deepEqual(clicks(liked), []);
    // Unlike clicks only when it is liked, Undislike only when disliked
    done(); const l2 = fakePage({ liked: true });
    assert.equal(step("unlike").working, true);
    assert.equal(step("unlike").done, true);
    assert.deepEqual(clicks(l2), ["like-click"]);
    done(); const n = fakePage({ liked: false });
    assert.deepEqual(step("unlike"), { done: true, already: true });
    assert.deepEqual(clicks(n), []);
    done(); const d = fakePage({ disliked: true });
    assert.equal(step("undislike").working, true);
    assert.equal(step("undislike").done, true);
    assert.deepEqual(clicks(d), ["dislike-click"]);
    done(); const dd = fakePage();
    assert.equal(step("dislike").working, true);
    assert.equal(step("dislike").done, true);
    assert.deepEqual(clicks(dd), ["dislike-click"]);
    done(); const already = fakePage({ disliked: true });
    assert.deepEqual(step("dislike"), { done: true, already: true });
    assert.deepEqual(clicks(already), []);
    done(); const none = fakePage();
    assert.deepEqual(step("undislike"), { done: true, already: true });
    assert.deepEqual(clicks(none), []);
  } finally { done(); }
});

test("Dislike finds the second button of the segmented control when there is no dislike view model; a missing button is an early error", () => {
  try {
    const p = fakePage({ segmented: true });
    assert.equal(step("dislike").working, true);
    assert.deepEqual(clicks(p), ["dislike-click"], "second button, not the first");
    done(); const l = fakePage({ segmented: true });
    step("like");
    assert.deepEqual(clicks(l), ["like-click"], "first button");
    done(); fakePage({ noDislike: true });
    assert.deepEqual(step("dislike"), { error: "Dislike button was not found", early: true });
    done(); fakePage({ signedIn: false });
    assert.deepEqual(step("like"), { error: "YouTube is signed out", early: true });
  } finally { done(); }
});

test("clicking Like on a disliked video leaves the page showing liked and not disliked", () => {
  try {
    const p = fakePage({ disliked: true });
    step("like"); step("like");
    assert.equal(p.page.liked, true);
    assert.equal(p.page.disliked, false);
  } finally { done(); }
});

// ---------- the page step: background watch ----------

test("watch plays at the fastest rate the player offers (fallback 2), at the lowest quality, and never touches the player's own mute", () => {
  try {
    const p = fakePage({ rates: [0.5, 1, 1.5, 2], levels: ["hd1080", "hd720", "large", "medium", "small", "tiny", "auto"] });
    const r = step("watch");
    assert.equal(r.working, true);
    assert.equal(r.rate, 2);
    assert.ok(p.page.calls.includes("rate:2") && p.page.calls.includes("play"));
    assert.ok(p.page.calls.includes("range:tiny:tiny") && p.page.calls.includes("quality:tiny"));
    assert.equal(p.page.calls.includes("mute") || p.page.calls.includes("unmute"), false, "tab-level mute only");
    assert.equal(p.video.muted, false);
    done(); const fast = fakePage({ rates: [0.25, 1, 2, 3, 4] });
    assert.equal(step("watch").rate, 4, "the maximum it offers, whatever it is");
    assert.ok(fast.page.calls.includes("rate:4"));
    done(); const bare = fakePage();   // no getAvailablePlaybackRates and no quality methods at all
    assert.equal(step("watch").rate, 2, "fallback 2");
    assert.ok(bare.page.calls.includes("rate:2"));
    done(); const odd = fakePage({ rates: [1, 2], levels: ["foo", "bar", "auto"] });
    step("watch");
    assert.ok(odd.page.calls.includes("quality:bar"), "an unknown ladder: the last non-auto level");
    done(); const mid = fakePage({ levels: ["hd720", "large", "auto"] });
    step("watch");
    assert.ok(mid.page.calls.includes("quality:large"));
    done(); const same = fakePage({ levels: ["large", "tiny", "auto"], quality: "tiny" });
    step("watch");
    assert.equal(same.page.calls.some((c) => c.startsWith("quality:") || c.startsWith("range:")), false, "already at the lowest");
  } finally { done(); }
});

test("a failing quality call is ignored and playback goes on", () => {
  try {
    const p = fakePage({ rates: [1, 2], levels: ["hd720", "tiny"] });
    p.player.setPlaybackQualityRange = () => { throw new Error("nope"); };
    p.player.setPlaybackQuality = () => { throw new Error("nope"); };
    assert.equal(step("watch").working, true);
    assert.ok(p.page.calls.includes("play"));
  } finally { done(); }
});

test("watch has no ad guard: an ad does not stop it, and the ad's clock is not mistaken for the video's", () => {
  try {
    const p = fakePage({ ad: true, playerState: 0, time: 30, duration: 30 });
    const r = step("watch");
    assert.equal(r.working, true);
    assert.equal(r.ad, true);
    assert.equal(r.error, undefined);
    assert.equal(r.done, undefined, "an ad that ended is not the video ending");
    assert.ok(p.page.calls.includes("play"), "playback is kept going");
    assert.equal(p.page.calls.includes("pause"), false);
    assert.equal(r.currentTime, undefined, "the ad's time is not the video's");
  } finally { done(); }
});

test("watch finishes when the player says ended, or within the tolerance of the end", () => {
  try {
    fakePage({ playerState: 0, time: 60, duration: 100 });
    assert.equal(step("watch").done, true);
    done(); fakePage({ playerState: 1, time: 99, duration: 100 });
    assert.equal(step("watch").done, true);
    done(); fakePage({ playerState: 1, time: 50, duration: 100 });
    assert.deepEqual({ ...step("watch") }, { working: true, currentTime: 50, duration: 100, rate: 2 });
  } finally { done(); }
});

// ---------- thumbs through the hidden window ----------

test("the actions are the four thumbs only: no Subscribe, no Add to history, no Watch through", async () => {
  assert.deepEqual([...THUMB_ACTIONS], ["like", "unlike", "dislike", "undislike"]);
  const h = harness({ script: () => ({ done: true }) });
  for (const gone of ["subscribe", "history", "watchThrough"]) {
    const r = await h.send({ type: "youtube-action", action: gone, url: VIDEO_URL });
    assert.match(r.reason, /Unknown YouTube action/);
  }
  assert.equal(h.opened(), 0);
  const src = YOUTUBE_ACTIONS.selectors;
  assert.equal("subscribe" in src, false);
});

test("a thumb runs in a minimized, unfocused window that is muted before YouTube loads, and is always closed", async () => {
  const h = harness({ script: ({ n }) => n === 1 ? { working: true } : { done: true } });
  const r = await h.actions.run({ url: VIDEO_URL, action: "like", panelWindowId: 4 });
  assert.equal(r.ok, true);
  const create = h.log.find(([name]) => name === "create");
  assert.equal(create[1].state, "minimized");
  assert.equal(create[1].focused, false);
  const created = h.log.findIndex(([name]) => name === "create");
  const muted = h.log.findIndex(([name, , props]) => name === "update" && props?.muted && !props.url);
  const loaded = h.log.findIndex(([name, , props]) => name === "update" && props?.url);
  const executed = h.log.findIndex(([name]) => name === "execute");
  assert.ok(created < muted && muted < loaded && loaded < executed, "create, mute, load, then inject");
  assert.equal(h.log[loaded][2].muted, true, "still muted on load");
  assert.deepEqual(h.log.at(-1), ["close", 9]);
  assert.equal(h.open.size, 0);
  const failed = harness({ failScript: true });
  assert.match((await failed.actions.run({ url: VIDEO_URL, action: "like" })).reason, /injection failed/);
  assert.deepEqual(failed.log.at(-1), ["close", 9], "closed after an injection failure too");
  const timeout = harness({ script: () => ({ working: true }) });
  assert.match((await timeout.actions.run({ url: VIDEO_URL, action: "dislike" })).reason, /timed out/);
  assert.deepEqual(timeout.log.at(-1), ["close", 9], "closed after a timeout");
});

test("a thumb whose button is not drawn yet is retried until the startup time is up, then reported", async () => {
  const h = harness({ script: ({ n }) => n < 3 ? { error: "Like button was not found", early: true } : { done: true } });
  assert.equal((await h.actions.run({ url: VIDEO_URL, action: "like" })).ok, true);
  const never = harness({ script: () => ({ error: "YouTube is signed out", early: true }) });
  assert.match((await never.actions.run({ url: VIDEO_URL, action: "like" })).reason, /signed out/);
  assert.deepEqual(never.log.at(-1), ["close", 9]);
});

test("thumb results are remembered per video, and like and dislike are mutually exclusive", async () => {
  const h = harness({ script: () => ({ done: true }) });
  const ask = (action, url = VIDEO_URL) => h.send({ type: "youtube-action", action, url });
  let r = await ask("like");
  assert.deepEqual([r.ok, r.like, r.dislike], [true, true, false]);
  r = await ask("dislike");
  assert.deepEqual([r.like, r.dislike], [false, true], "turning dislike on turns like off");
  r = await ask("like");
  assert.deepEqual([r.like, r.dislike], [true, false], "and the other way round");
  r = await ask("unlike");
  assert.deepEqual([r.like, r.dislike], [false, false]);
  await ask("dislike");
  r = await ask("undislike");
  assert.deepEqual([r.like, r.dislike], [false, false]);
  await ask("like", OTHER_URL);
  assert.equal(normalizeVideoState(h.states()[OTHER_ID]).like, true);
  assert.equal(normalizeVideoState(h.states()[VIDEO_ID]).like, false, "another video is untouched");
});

test("a failed thumb stores nothing and says why; incognito, a missing permission and a non-video refuse before any window opens", async () => {
  const h = harness({ failScript: true });
  let r = await h.send({ type: "youtube-action", action: "like", url: VIDEO_URL });
  assert.equal(r.ok, false);
  assert.match(r.reason, /injection failed/);
  assert.equal(h.states()[VIDEO_ID], undefined);
  const inc = harness({ script: () => ({ done: true }) });
  r = await inc.send({ type: "youtube-action", action: "like", url: VIDEO_URL, incognito: true });
  assert.match(r.reason, /Incognito/);
  r = await inc.send({ type: "youtube-action", action: "like", url: "https://example.com/watch?v=dQw4w9WgXcQ" });
  assert.match(r.reason, /not a YouTube video/);
  const noPerm = harness({ permission: false, script: () => ({ done: true }) });
  r = await noPerm.send({ type: "youtube-action", action: "like", url: VIDEO_URL });
  assert.match(r.reason, /permission/);
  r = await noPerm.send({ type: "youtube-watch-start", url: VIDEO_URL });
  assert.match(r.reason, /permission/);
  for (const x of [inc, noPerm]) assert.equal(x.opened(), 0);
});

// ---------- Watched: countdown, queue, background watch ----------

// A video that plays `perCall` seconds of a 100 second video per script call, at the player's 2x.
const playing = (perCall = 10, duration = 100) => ({ n }) => n * perCall >= duration ? { done: true, currentTime: duration, duration } : { working: true, currentTime: n * perCall, duration, rate: 2 };
const SLOW = { countdownMs: 2, startupTimeoutMs: 40, completionSlackMs: 100000 };

test("Watched: a tick counts down (nothing opens), then plays, then finishes, and only then POSTs /watched once", async () => {
  const h = harness({ manual: true, script: playing(), timings: { ...SLOW, countdownMs: 3 } });
  const r = await h.send({ type: "youtube-watch-start", url: VIDEO_URL, panelWindowId: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.watch.status, "countdown");
  assert.equal(typeof r.watch.endsAt, "number");
  assert.equal(h.watchOf().status, "countdown");
  await h.tick();
  assert.equal(h.watchOf().status, "countdown");
  assert.equal(h.opened(), 0, "nothing opens during the countdown");
  await h.tick(2);
  assert.equal(h.watchOf().status, "watching");
  assert.equal(h.opened(), 1);
  assert.deepEqual(h.posts, [], "no POST while it is still playing");
  const create = h.log.find(([name]) => name === "create");
  assert.equal(create[1].state, "minimized");
  assert.equal(create[1].focused, false);
  assert.ok(h.log.findIndex(([n, , p]) => n === "update" && p?.muted) < h.log.findIndex(([n]) => n === "execute"), "muted before it plays");
  await h.tick(14);
  assert.deepEqual(h.watchOf(), { status: "watched" });
  assert.deepEqual(h.posts, [["https://companion.test/watched", { url: VIDEO_URL }]], "exactly one POST, after it finished");
  assert.equal(h.log.at(-1)[0], "close");
  assert.equal(h.open.size, 0);
  assert.equal(h.actions.current, null);
  // a finished watch is locked: ticking or unticking afterwards changes nothing
  let again = await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  assert.equal(again.watch.status, "watched");
  again = await h.send({ type: "youtube-watch-untick", url: VIDEO_URL });
  assert.equal(again.watch.status, "watched");
  await h.tick(4);
  assert.equal(h.opened(), 1);
  assert.equal(h.posts.length, 1);
});

test("Watched: unticking during the countdown cancels, opens nothing, and returns to unticked", async () => {
  const h = harness({ manual: true, script: playing() });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick();
  const r = await h.send({ type: "youtube-watch-untick", url: VIDEO_URL });
  assert.equal(r.watch.status, "idle");
  assert.equal(h.watchOf().status, "idle");
  await h.tick(8);
  assert.equal(h.opened(), 0);
  assert.deepEqual(h.posts, []);
  assert.equal(h.watchOf().status, "idle");
  // ticking again gives a fresh countdown that the cancelled one cannot disturb
  const again = await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  assert.equal(again.watch.status, "countdown");
  await h.tick();
  assert.equal(h.opened(), 0);
});

test("Watched: with another background watch running the next ones wait in a first-in first-out queue, one window at a time", async () => {
  const h = harness({ manual: true, script: playing(10, 100), timings: SLOW });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(3);
  assert.equal(h.watchOf().status, "watching");
  await h.send({ type: "youtube-watch-start", url: OTHER_URL });
  await h.send({ type: "youtube-watch-start", url: THIRD_URL });
  await h.tick(3);                                   // their countdowns end while the first still has the window
  assert.equal(h.watchOf(OTHER_ID).status, "queued");
  assert.equal(h.watchOf(THIRD_ID).status, "queued");
  assert.deepEqual(h.actions.queue.map((e) => e.videoId), [OTHER_ID, THIRD_ID]);
  await h.tick(40);
  for (const id of [VIDEO_ID, OTHER_ID, THIRD_ID]) assert.equal(h.watchOf(id).status, "watched", id);
  assert.equal(h.maxOpen, 1, "never two background windows at once");
  assert.deepEqual(h.posts.map(([, body]) => body.url), [VIDEO_URL, OTHER_URL, THIRD_URL], "first in, first out");
});

test("Watched: unticking while queued cancels and returns to unticked, and the cancelled video never opens a window", async () => {
  // the first video never finishes, so the second has to wait
  const h = harness({ manual: true, script: ({ n }) => ({ working: true, currentTime: n, duration: 100, rate: 2 }), timings: SLOW });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(3);
  assert.equal(h.watchOf().status, "watching");
  await h.send({ type: "youtube-watch-start", url: OTHER_URL });
  await h.tick(3);
  assert.equal(h.watchOf(OTHER_ID).status, "queued");
  assert.equal(watchView(h.watchOf(OTHER_ID)).label, "Watch (queued)");
  const r = await h.send({ type: "youtube-watch-untick", url: OTHER_URL });
  assert.equal(r.watch.status, "idle");
  assert.equal(h.watchOf(OTHER_ID).status, "idle");
  assert.equal(h.actions.queue.length, 0);
  await h.send({ type: "youtube-watch-untick", url: VIDEO_URL });   // let the first end so nothing is left running
  await h.tick(4);
  assert.equal(h.open.size, 0);
  assert.equal(h.opened(), 1, "only the first video ever opened a window");
});

test("Watched: unticking while it plays stops it, closes the window and keeps the percent played, rounded; nothing is recorded", async () => {
  // 37.4 s of a 100 s video is 37%
  const h = harness({ manual: true, script: ({ n }) => ({ working: true, currentTime: n === 1 ? 5 : 37.4, duration: 100, rate: 2 }), timings: SLOW });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(3);
  assert.equal(h.watchOf().status, "watching");
  await h.tick(2);
  const r = await h.send({ type: "youtube-watch-untick", url: VIDEO_URL });
  assert.equal(r.ok, true);
  await h.tick(2);
  assert.deepEqual(h.watchOf(), { status: "partial", percent: 37 });
  assert.deepEqual(watchView(h.watchOf()), { checked: true, disabled: true, label: "Watched (37%)" });
  assert.equal(h.open.size, 0, "the window is closed");
  assert.deepEqual(h.posts, [], "a partial watch is not recorded");
  // locked: ticking or unticking afterwards does nothing
  const again = await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  assert.deepEqual(again.watch, { status: "partial", percent: 37 });
  await h.tick(5);
  assert.equal(h.opened(), 1);
});

test("Watched: when the running watch is stopped, the next one in the queue gets the window", async () => {
  const h = harness({ manual: true, timings: SLOW,
    script: ({ n, url }) => url.includes(VIDEO_ID) ? { working: true, currentTime: n, duration: 100, rate: 2 } : { done: true, currentTime: 100, duration: 100 } });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(3);
  await h.send({ type: "youtube-watch-start", url: OTHER_URL });
  await h.tick(3);
  assert.equal(h.watchOf(OTHER_ID).status, "queued");
  await h.send({ type: "youtube-watch-untick", url: VIDEO_URL });
  await h.tick(6);
  assert.equal(h.watchOf().status, "partial");
  assert.equal(h.watchOf(OTHER_ID).status, "watched", "the queue moved on");
  assert.equal(h.maxOpen, 1);
  assert.deepEqual(h.posts.map(([, body]) => body.url), [OTHER_URL], "only the finished one is recorded");
});

test("Watched: playback that does not start within the startup time stops, closes the window and goes back to unticked with the reason", async () => {
  const h = harness({ manual: true, script: () => ({ working: true, currentTime: 0, duration: 100, rate: 2 }), timings: { countdownMs: 2, startupTimeoutMs: 4 } });
  const progress = [];
  h.chrome.runtime.sendMessage = (m) => progress.push(m);
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(12);
  assert.equal(h.watchOf().status, "idle");
  assert.match(h.watchOf().reason, /Chrome would not start playback in a hidden window/);
  assert.equal(h.open.size, 0);
  assert.equal(h.log.filter(([name]) => name === "close").length, 1);
  assert.deepEqual(h.posts, []);
  assert.ok(progress.some((m) => m.type === "youtube-watch-progress" && m.status === "failed" && /would not start playback/.test(m.reason)));
  assert.equal(watchView(h.watchOf()).checked, false, "unticked");
});

test("Watched: no Premium gating and no ad guard; it starts with no Premium setting, and an ad that plays does not stop it", async () => {
  for (const extra of [{}, { youtubePremium: false }]) {
    const h = harness({ manual: true, local: extra, timings: SLOW,
      script: ({ n }) => n <= 3 ? { working: true, ad: true, rate: 2 } : n >= 8 ? { done: true, currentTime: 100, duration: 100 } : { working: true, currentTime: n * 10, duration: 100, rate: 2 } });
    await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
    await h.tick(16);
    assert.equal(h.watchOf().status, "watched");
    assert.equal(h.posts.length, 1);
  }
  const source = (await import("node:fs")).readFileSync(new URL("../lib/youtube-actions.js", import.meta.url), "utf8");
  assert.ok(!/youtubePremium|Premium|An ad started/.test(source.replace(/Premium Lite/g, "")), "no Premium check or ad stop left in the worker");
});

test("Watched: an ad at the very start counts as playback having started, not as 'Chrome would not start playback'", async () => {
  const h = harness({ manual: true, timings: { countdownMs: 2, startupTimeoutMs: 4, completionSlackMs: 100000 },
    script: ({ n }) => n < 8 ? { working: true, ad: true, rate: 2 } : { done: true, currentTime: 100, duration: 100 } });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(14);
  assert.equal(h.watchOf().status, "watched");
});

test("Watched: a finished watch is not recorded when 'Save transcripts of videos I watch' is off", async () => {
  const h = harness({ manual: true, local: { recordWatchedVideos: false }, script: () => ({ done: true, currentTime: 100, duration: 100 }), timings: { countdownMs: 2 } });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(6);
  assert.equal(h.watchOf().status, "watched");
  assert.deepEqual(h.posts, []);
});

test("Watched: the hidden window's tab is registered so the watched recorder ignores it, and unregistered when it closes", async () => {
  const h = harness({ manual: true, script: playing(50, 100), timings: SLOW });
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL });
  await h.tick(8);
  assert.ok(h.sessionTabsSeen.some((tabs) => tabs.includes(19)), "the action tab is in youtubeActionTabs while it runs");
  assert.deepEqual(h.session.youtubeActionTabs, []);
  assert.deepEqual(h.local.youtubeActionWindowsRecovery, {});
});

test("Watched: closing the panel's browser window does not stop a watch (the worker no longer listens for it)", async () => {
  const registered = [];
  const h = harness({ manual: true, script: playing(50, 100), timings: SLOW });
  const before = h.chrome.windows.onRemoved;
  assert.ok(before);
  const spy = harness({});
  spy.chrome.windows.onRemoved.addListener = (f) => registered.push(f);
  registerYoutubeActions(spy.chrome, {});
  assert.deepEqual(registered, [], "no window-removed listener");
  await h.send({ type: "youtube-watch-start", url: VIDEO_URL, panelWindowId: 4 });
  await h.tick(12);
  assert.equal(h.watchOf().status, "watched");
});

// ---------- Chrome restarting ----------

test("Chrome restart: a cut-off watch is recorded as partial with its percent, countdown and queue are dropped, nothing restarts", async () => {
  const h = harness({ script: () => ({ done: true }) });
  h.local[VIDEO_STATES_KEY] = {
    [VIDEO_ID]: { watch: { status: "watching", percent: 62 }, like: true, dislike: false, ts: 1 },
    [OTHER_ID]: { watch: { status: "queued" }, like: false, dislike: false, ts: 2 },
    [THIRD_ID]: { watch: { status: "countdown", endsAt: 5 }, like: false, dislike: true, ts: 3 },
    aaaaaaaaaaa: { watch: { status: "watched" }, like: false, dislike: false, ts: 4 },
  };
  await h.actions.reconcileCutOff();
  assert.deepEqual(h.watchOf(), { status: "partial", percent: 62 });
  assert.equal(h.watchOf(OTHER_ID).status, "idle");
  assert.equal(h.watchOf(THIRD_ID).status, "idle");
  assert.equal(h.watchOf("aaaaaaaaaaa").status, "watched");
  assert.equal(normalizeVideoState(h.states()[VIDEO_ID]).like, true, "thumbs are kept");
  assert.equal(normalizeVideoState(h.states()[THIRD_ID]).dislike, true);
  assert.equal(h.opened(), 0, "no automatic restart");
  assert.equal(h.posts.length, 0, "a partial watch is not recorded");
});

test("Chrome restart: worker startup does it by itself, after closing any window left behind", async () => {
  const session = {};
  const local = { [VIDEO_STATES_KEY]: { [VIDEO_ID]: { watch: { status: "watching", percent: 40 }, like: false, dislike: false, ts: 1 } }, youtubeActionWindowsRecovery: { 9: { windowId: 9, tabId: 19, panelWindowId: 4, actionId: "stale" } } };
  const closed = [];
  const chrome = {
    storage: { session: { get: async (k) => ({ [k]: session[k] }), set: async (v) => Object.assign(session, v) }, local: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in local).map((k) => [k, local[k]])), set: async (v) => Object.assign(local, v) } },
    permissions: { contains: async () => true }, runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} },
    windows: { create: async () => { throw new Error("must not open"); }, remove: async (id) => closed.push(id), onRemoved: { addListener: () => {} } }, tabs: { update: async () => {} }, scripting: { executeScript: async () => [] },
  };
  const actions = registerYoutubeActions(chrome, {});
  const answer = await new Promise((resolve) => { actions.handle({ type: "youtube-watch-untick", url: VIDEO_URL }, {}, resolve); });  // waits for the startup work
  assert.deepEqual(closed, [9]);
  assert.deepEqual(local[VIDEO_STATES_KEY][VIDEO_ID].watch, { status: "partial", percent: 40 });
  assert.deepEqual(answer.watch, { status: "partial", percent: 40 });
});

// ---------- per-video memory ----------

test("per-video memory: a video with nothing stored starts at the defaults; each video keeps its own state", async () => {
  const h = harness({ script: () => ({ done: true }) });
  const plain = async (id) => { const s = await h.actions.getVideoState(id); return { watch: s.watch, like: s.like, dislike: s.dislike }; };
  assert.deepEqual(await plain(VIDEO_ID), { watch: { status: "idle" }, like: false, dislike: false });
  await h.send({ type: "youtube-action", action: "like", url: VIDEO_URL });
  await h.send({ type: "youtube-action", action: "dislike", url: OTHER_URL });
  assert.deepEqual(await plain(VIDEO_ID), { watch: { status: "idle" }, like: true, dislike: false });
  assert.deepEqual(await plain(OTHER_ID), { watch: { status: "idle" }, like: false, dislike: true });
  assert.deepEqual(await plain("zzzzzzzzzzz"), { watch: { status: "idle" }, like: false, dislike: false });
});

test("per-video memory is capped at the newest 500 videos", async () => {
  const many = {};
  for (let i = 0; i < MAX_VIDEO_STATES + 20; i++) many[`v${i}`] = { watch: { status: "idle" }, like: true, dislike: false, ts: i };
  const capped = capVideoStates(many);
  assert.equal(Object.keys(capped).length, MAX_VIDEO_STATES);
  assert.ok(capped[`v${MAX_VIDEO_STATES + 19}`], "the newest stay");
  assert.equal(capped.v0, undefined, "the oldest go");
  const h = harness({ script: () => ({ done: true }), local: { [VIDEO_STATES_KEY]: many } });
  await h.send({ type: "youtube-action", action: "like", url: VIDEO_URL });
  assert.equal(Object.keys(h.states()).length, MAX_VIDEO_STATES);
  assert.ok(h.states()[VIDEO_ID], "the video just changed is kept");
  assert.equal(h.states().v0, undefined);
});

test("stored video state is untrusted: unknown shapes fall back to the defaults, and like and dislike cannot both be on", () => {
  assert.deepEqual(normalizeVideoState(null), { watch: { status: "idle" }, like: false, dislike: false });
  assert.deepEqual(normalizeVideoState({ watch: { status: "bogus" }, like: "yes" }), { watch: { status: "idle" }, like: false, dislike: false });
  assert.equal(normalizeVideoState({ like: true, dislike: true }).dislike, false);
  assert.deepEqual(normalizeVideoState({ watch: { status: "partial", percent: 250 } }).watch, { status: "partial", percent: 100 });
});

test("the label and lock for every Watched state", () => {
  assert.deepEqual(watchView({ status: "idle" }, 0), { checked: false, disabled: false, label: "Watched" });
  assert.deepEqual(watchView({ status: "countdown", endsAt: 30_000 }, 0), { checked: true, disabled: false, label: "Watch (30s)" });
  assert.equal(watchView({ status: "countdown", endsAt: 30_000 }, 1000).label, "Watch (29s)");
  assert.equal(watchView({ status: "countdown", endsAt: 30_000 }, 29_001).label, "Watch (1s)");
  assert.equal(watchView({ status: "countdown", endsAt: 30_000 }, 31_000).label, "Watch (0s)");
  assert.deepEqual(watchView({ status: "queued" }), { checked: true, disabled: false, label: "Watch (queued)" });
  assert.deepEqual(watchView({ status: "watching", percent: 5 }), { checked: true, disabled: false, label: "Watching" });
  assert.deepEqual(watchView({ status: "watched" }), { checked: true, disabled: true, label: "Watched" });
  assert.deepEqual(watchView({ status: "partial", percent: 37 }), { checked: true, disabled: true, label: "Watched (37%)" });
});

test("YouTube action visibility uses the watched module video-id parser", () => {
  assert.equal(youtubeActionVisible(VIDEO_URL), true);
  assert.equal(youtubeActionVisible("https://www.youtube.com/shorts/dQw4w9WgXcQ"), false);
  assert.equal(youtubeActionVisible("https://example.com/watch?v=dQw4w9WgXcQ"), false);
});
