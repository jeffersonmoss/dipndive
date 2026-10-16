import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerYoutubeActions, youtubeActionVisible, youtubePageStep, YOUTUBE_ACTIONS } from "../lib/youtube-actions.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function harness({ permission = true, premium = true, speed = 2, choice = "leave", scripted = [], timings = {}, failScript = false } = {}) {
  const session = {}, local = { base: "https://companion.test", token: "t".repeat(40), youtubePremium: premium, youtubePlaybackSpeed: speed, youtubeAfterDip: choice };
  const log = [], handlers = [], posts = [];
  let now = 0, nextScript = 0;
  const chrome = {
    storage: {
      session: { get: async (k) => ({ [k]: session[k] }), set: async (v) => Object.assign(session, v) },
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in local).map((k) => [k, local[k]])),
        set: async (values) => Object.assign(local, values),
      },
    },
    permissions: { contains: async () => permission },
    runtime: { onMessage: { addListener: (fn) => handlers.push(fn) }, sendMessage: () => {}, lastError: null },
    windows: { create: async (opts) => { log.push(["create", opts]); return { id: 9, tabs: [{ id: 19 }] }; }, remove: async (id) => log.push(["close", id]), onRemoved: { addListener: () => {} } },
    tabs: { update: async (id, patch) => { log.push(["update", id, patch]); }, remove: async () => {} },
    scripting: { executeScript: async ({ func }) => {
      if (failScript) throw new Error("injection failed");
      log.push(["execute"]);
      if (func !== youtubePageStep) return [{ result: null }];
      const result = scripted[Math.min(nextScript++, scripted.length - 1)];
      return [{ result: typeof result === "function" ? result() : result }];
    } },
  };
  const actions = registerYoutubeActions(chrome, {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    uuid: () => "action-1",
    timings: { ...YOUTUBE_ACTIONS.timings, intervalMs: 1, startupTimeoutMs: 2, historyPlaybackMs: 3, actionTimeoutMs: 5, completionSlackMs: 3, ...timings },
    fetchImpl: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { status: 202, json: async () => ({ queued: true }) }; },
  });
  return { chrome, actions, session, local, log, posts, handlers, setNow: (n) => { now = n; } };
}

test("YouTube action row visibility uses the watched module video-id parser", () => {
  assert.equal(youtubeActionVisible(VIDEO_URL), true);
  assert.equal(youtubeActionVisible("https://www.youtube.com/shorts/dQw4w9WgXcQ"), false);
  assert.equal(youtubeActionVisible("https://example.com/watch?v=dQw4w9WgXcQ"), false);
  const panelHtml = readFileSync(new URL("../panel.html", import.meta.url), "utf8");
  const panelJs = readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  assert.match(panelHtml, /id="youtubeactions"[^>]*hidden/);
  assert.match(panelJs, /const showYoutube = !panelIncognito && !!s\.source && youtubeActionVisible\(s\.source\.url\)/);
  for (const action of ["like", "subscribe", "history", "watchThrough"]) assert.match(panelHtml, new RegExp(`data-youtube-action="${action}"`));
});

test("Like and Subscribe never undo existing choices and pause the player", () => {
  const calls = [];
  const player = { mute: () => calls.push("mute"), pauseVideo: () => calls.push("pause") };
  const alreadyLiked = { disabled: false, dataset: {}, getAttribute: () => "true", click: () => calls.push("like") };
  globalThis.document = { querySelector: (s) => s === "#movie_player" ? player : s === "#avatar-btn" ? {} : null, querySelectorAll: (s) => s === YOUTUBE_ACTIONS.selectors.like[0] ? [alreadyLiked] : [] };
  assert.deepEqual(youtubePageStep("like", { selectors: YOUTUBE_ACTIONS.selectors }), { done: true, already: true });
  const alreadySubscribed = { disabled: false, dataset: {}, getAttribute: (name) => name === "aria-label" ? "Subscribed" : null, textContent: "Subscribed", click: () => calls.push("subscribe") };
  globalThis.document.querySelectorAll = (s) => s === YOUTUBE_ACTIONS.selectors.subscribe[0] ? [alreadySubscribed] : [];
  assert.deepEqual(youtubePageStep("subscribe", { selectors: YOUTUBE_ACTIONS.selectors }), { done: true, already: true });
  assert.equal(calls.includes("like"), false);
  assert.equal(calls.includes("subscribe"), false);
  assert.ok(calls.includes("pause"));
  delete globalThis.document;
});

test("Like clicks only the positive action and confirms aria-pressed", () => {
  let liked = false, clicks = 0;
  const button = { disabled: false, dataset: {}, getAttribute: () => String(liked), click: () => { clicks++; liked = true; } };
  globalThis.document = { querySelector: (s) => s === "#avatar-btn" ? {} : null, querySelectorAll: (s) => s === YOUTUBE_ACTIONS.selectors.like[0] ? [button] : [] };
  assert.equal(youtubePageStep("like", { selectors: YOUTUBE_ACTIONS.selectors }).working, true);
  assert.equal(youtubePageStep("like", { selectors: YOUTUBE_ACTIONS.selectors }).done, true);
  assert.equal(clicks, 1);
  delete globalThis.document;
});

test("playback mutes before play and sets HTML5 fallback muted", () => {
  const order = [];
  const video = { muted: false, paused: true, currentTime: 0, duration: 90, dataset: {}, play: () => { order.push("video-play"); return Promise.resolve(); }, pause() {} };
  const player = { mute: () => order.push("mute"), getCurrentTime: () => 0, getDuration: () => 90, getPlayerState: () => 2, setPlaybackRate: () => order.push("speed"), playVideo: () => order.push("play") };
  globalThis.document = { querySelector: (s) => s === "#movie_player" ? player : s === "video" ? video : s === "#avatar-btn" ? {} : null, querySelectorAll: () => [] };
  youtubePageStep("history", { selectors: YOUTUBE_ACTIONS.selectors, speed: 1, historyPlaybackMs: 30_000 });
  assert.equal(order[0], "mute");
  assert.ok(order.indexOf("mute") < order.indexOf("play"));
  assert.equal(video.muted, true);
  delete globalThis.document;
});

test("Premium gates Watch through and automatic defaults do not request permission", async () => {
  const h = harness({ premium: false });
  assert.match((await h.actions.run({ url: VIDEO_URL, action: "watchThrough" })).reason, /YouTube Premium/);
  assert.equal(h.log.some(([name]) => name === "create"), false);
  const noPermission = harness({ choice: "history", permission: false });
  let answer;
  await noPermission.actions.handle({ type: "youtube-action-default", jobId: "job-1", url: VIDEO_URL }, {}, (value) => { answer = value; });
  assert.match(answer.notice, /click any YouTube action button once/i);
  assert.equal(noPermission.log.some(([name]) => name === "create"), false);
});

test("a granted permission runs the configured default once after the Dip", async () => {
  const h = harness({ choice: "history", scripted: [{ done: true }] });
  let answer;
  await h.actions.handle({ type: "youtube-action-default", jobId: "job-2", url: VIDEO_URL }, { tab: { windowId: 4 } }, (value) => { answer = value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer.started, true);
  assert.ok(h.log.some(([name]) => name === "create"));
  assert.deepEqual(h.log.at(-1), ["close", 9]);
  const duplicate = harness({ choice: "history", scripted: [{ done: true }] });
  duplicate.session.youtubeActionAutoJobs = ["job-2"];
  let duplicateAnswer;
  await duplicate.actions.handle({ type: "youtube-action-default", jobId: "job-2", url: VIDEO_URL }, {}, (value) => { duplicateAnswer = value; });
  assert.equal(duplicateAnswer.skipped, true);
  assert.equal(duplicate.log.some(([name]) => name === "create"), false);
});

test("window is muted before injection and closes after success and injection failure", async () => {
  const success = harness({ scripted: [{ done: true }] });
  assert.equal((await success.actions.run({ url: VIDEO_URL, action: "like", panelWindowId: 4 })).ok, true);
  const muteIndex = success.log.findIndex(([name, , props]) => name === "update" && props?.muted);
  const createIndex = success.log.findIndex(([name]) => name === "create");
  const executeIndex = success.log.findIndex(([name]) => name === "execute");
  assert.ok(createIndex < muteIndex);
  assert.ok(muteIndex < executeIndex);
  assert.deepEqual(success.log.at(-1), ["close", 9]);
  const failed = harness({ failScript: true });
  assert.match((await failed.actions.run({ url: VIDEO_URL, action: "like" })).reason, /injection failed/);
  assert.deepEqual(failed.log.at(-1), ["close", 9]);
});

test("worker startup closes an action window recovered from persistent state after storage.session was cleared", async () => {
  const h = harness();
  h.local.youtubeActionWindowsRecovery = { "9": { windowId: 9, tabId: 19, panelWindowId: 4, actionId: "stale" } };
  await h.actions.cleanStale();
  assert.ok(h.log.some(([name, id]) => name === "close" && id === 9));
  assert.deepEqual(h.local.youtubeActionWindowsRecovery, {});
});

test("playback that does not advance closes the minimized window with the stated reason", async () => {
  const h = harness({ scripted: [{ working: true, currentTime: 0 }, { working: true, currentTime: 0 }, { working: true, currentTime: 0 }] });
  const result = await h.actions.run({ url: VIDEO_URL, action: "history" });
  assert.match(result.reason, /Chrome would not start playback in a hidden window/);
  assert.deepEqual(h.log.at(-1), ["close", 9]);
});

test("cancel and timeout both close the action window", async () => {
  const cancel = harness({ scripted: [() => { cancel.actions.active.get("cancel-me").cancelled = true; return { working: true }; }] });
  assert.equal((await cancel.actions.run({ url: VIDEO_URL, action: "history", actionId: "cancel-me" })).cancelled, true);
  assert.deepEqual(cancel.log.at(-1), ["close", 9]);
  const timeout = harness({ scripted: [{ working: true }] });
  const timed = await timeout.actions.run({ url: VIDEO_URL, action: "like" });
  assert.match(timed.reason, /timed out/);
  assert.deepEqual(timeout.log.at(-1), ["close", 9]);
});

test("POST /watched occurs once only after Watch through completes", async () => {
  const h = harness({ scripted: [{ working: true, currentTime: 0, duration: 2 }, { done: true, currentTime: 2, duration: 2 }] });
  const result = await h.actions.run({ url: VIDEO_URL, action: "watchThrough", speed: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(h.posts.map(([, body]) => body), [{ url: VIDEO_URL }]);
  assert.deepEqual(h.log.at(-1), ["close", 9]);
});

