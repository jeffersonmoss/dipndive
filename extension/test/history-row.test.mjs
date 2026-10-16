import test from "node:test";
import assert from "node:assert/strict";
import { HistoryRow, rowStatus, rowsVisible } from "../lib/history-row.js";
import { VIDEO_STATES_KEY } from "../lib/video-state.js";

const URL_A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const ID_A = "dQw4w9WgXcQ";
const URL_B = "https://youtu.be/9bZkp7q19f0";
const ID_B = "9bZkp7q19f0";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function rowRig({ stored = {}, access = true, respond = {} } = {}) {
  const sent = [], views = [], order = [], timers = [];
  let now = 100_000;
  const store = { [VIDEO_STATES_KEY]: stored };
  const row = new HistoryRow({
    send: async (m) => { order.push(m.type); sent.push(m); const r = respond[m.type] ?? respond[m.action]; return typeof r === "function" ? r(m) : r ?? { ok: true }; },
    storage: { get: async (k) => ({ [k]: store[k] }) },
    requestAccess: async () => { order.push("permission"); return access; },
    windowId: () => 4,
    now: () => now,
    setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    onChange: (v) => views.push(v),
  });
  return { row, sent, views, order, timers, store, get last() { return views.at(-1); }, setNow: (n) => { now = n; }, get now() { return now; } };
}
const openVideo = async (r, url = URL_A, incognito = false) => { r.row.setSource(url, incognito); await settle(); };
const change = (r, id, state) => { r.store[VIDEO_STATES_KEY] = { ...r.store[VIDEO_STATES_KEY], [id]: state }; r.row.onStorageChange({ [VIDEO_STATES_KEY]: { newValue: r.store[VIDEO_STATES_KEY] } }, "local"); };

test("the YouTube row is for YouTube sources only, and never in Incognito", async () => {
  const r = rowRig();
  await openVideo(r);
  assert.equal(r.last.visible, true);
  await openVideo(r, "https://example.com/article");
  assert.equal(r.last.visible, false);
  await openVideo(r, "https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.equal(r.last.visible, false);
  await openVideo(r, URL_A);
  r.row.setSource(URL_A, true);
  assert.equal(r.last.visible, false, "Incognito");
  r.row.setSource(null);
  assert.equal(r.last.visible, false);
});

test("a fresh video starts with Watched unticked, both thumbs off", async () => {
  const r = rowRig();
  await openVideo(r);
  const v = r.last;
  assert.deepEqual([v.watched.checked, v.watched.disabled, v.watched.label], [false, false, "Watched"]);
  assert.deepEqual([v.like.pressed, v.dislike.pressed], [false, false]);
  assert.deepEqual([v.like.busy, v.dislike.busy, v.like.disabled], [false, false, false]);
  assert.equal(v.notice, "");
});

test("reopening a Dip of a video shows its remembered state: finished, partial, liked, disliked", async () => {
  const r = rowRig({ stored: {
    [ID_A]: { watch: { status: "partial", percent: 37 }, like: true, dislike: false, ts: 1 },
    [ID_B]: { watch: { status: "watched" }, like: false, dislike: true, ts: 2 },
  } });
  await openVideo(r, URL_A);
  assert.deepEqual([r.last.watched.checked, r.last.watched.disabled, r.last.watched.label], [true, true, "Watched (37%)"]);
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [true, false]);
  await openVideo(r, URL_B);
  assert.deepEqual([r.last.watched.checked, r.last.watched.disabled, r.last.watched.label], [true, true, "Watched"]);
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [false, true]);
  await openVideo(r, "https://www.youtube.com/watch?v=zzzzzzzzzzz");
  assert.deepEqual([r.last.watched.checked, r.last.watched.label, r.last.like.pressed, r.last.dislike.pressed], [false, "Watched", false, false], "an unknown video gets the defaults");
});

test("thumbs: the permission is asked first, the button shows busy while it works, then it is filled; clicking again undoes", async () => {
  let release;
  const r = rowRig({ respond: { like: () => new Promise((res) => { release = () => res({ ok: true, like: true, dislike: false }); }), unlike: { ok: true, like: false, dislike: false } } });
  await openVideo(r);
  const p = r.row.toggleThumb("like");
  await settle();
  assert.deepEqual(r.order, ["permission", "youtube-action"], "permission is the first thing awaited, inside the click");
  assert.equal(r.sent[0].action, "like");
  assert.equal(r.sent[0].url, URL_A);
  assert.equal(r.sent[0].panelWindowId, 4);
  assert.equal(r.last.like.busy, true, "busy while the hidden window works");
  assert.equal(r.last.like.disabled && r.last.dislike.disabled, true, "both thumbs wait");
  assert.equal(r.last.like.pressed, false, "not filled until it worked");
  await r.row.toggleThumb("dislike");              // ignored while busy
  assert.equal(r.sent.length, 1);
  release(); await p;
  assert.deepEqual([r.last.like.pressed, r.last.like.busy, r.last.like.disabled], [true, false, false]);
  await r.row.toggleThumb("like");
  assert.equal(r.sent.at(-1).action, "unlike");
  assert.equal(r.last.like.pressed, false);
});

test("thumbs are mutually exclusive: turning one on turns the other off, and each toggles off again", async () => {
  const r = rowRig({ respond: {
    like: { ok: true, like: true, dislike: false }, dislike: { ok: true, like: false, dislike: true },
    unlike: { ok: true, like: false, dislike: false }, undislike: { ok: true, like: false, dislike: false },
  } });
  await openVideo(r);
  await r.row.toggleThumb("like");
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [true, false]);
  await r.row.toggleThumb("dislike");
  assert.equal(r.sent.at(-1).action, "dislike");
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [false, true]);
  await r.row.toggleThumb("like");
  assert.equal(r.sent.at(-1).action, "like");
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [true, false]);
  await r.row.toggleThumb("like");
  assert.equal(r.sent.at(-1).action, "unlike");
  await r.row.toggleThumb("dislike");
  await r.row.toggleThumb("dislike");
  assert.equal(r.sent.at(-1).action, "undislike");
  assert.deepEqual([r.last.like.pressed, r.last.dislike.pressed], [false, false]);
});

test("a failed thumb goes back and shows the reason as its tooltip and in the notice line; a declined permission sends nothing", async () => {
  const r = rowRig({ respond: { dislike: { ok: false, reason: "YouTube is signed out" } } });
  await openVideo(r);
  await r.row.toggleThumb("dislike");
  assert.equal(r.last.dislike.pressed, false);
  assert.equal(r.last.dislike.busy, false);
  assert.equal(r.last.dislike.title, "YouTube is signed out");
  assert.equal(r.last.notice, "YouTube is signed out");
  assert.equal(r.last.like.title, "Like this video", "the other thumb is untouched");
  const declined = rowRig({ access: false });
  await openVideo(declined);
  await declined.row.toggleThumb("like");
  assert.equal(declined.sent.length, 0);
  assert.match(declined.last.notice, /permission was declined/);
  assert.equal(declined.last.like.pressed, false);
  const thrown = rowRig({ respond: { like: () => { throw new Error("worker unreachable"); } } });
  await openVideo(thrown);
  await thrown.row.toggleThumb("like");
  assert.equal(thrown.last.like.pressed, false);
  assert.match(thrown.last.notice, /worker unreachable/);
});

test("a thumb answer for a video that is no longer on screen does not touch the new one", async () => {
  let release;
  const r = rowRig({ respond: { like: () => new Promise((res) => { release = () => res({ ok: true, like: true, dislike: false }); }) } });
  await openVideo(r, URL_A);
  const p = r.row.toggleThumb("like");
  await settle();
  await openVideo(r, URL_B);
  release(); await p;
  assert.deepEqual([r.last.like.pressed, r.last.like.busy], [false, false]);
});

test("Watched: tick asks for permission first, starts the countdown, and the label counts down each second", async () => {
  const endsAt = 100_000 + 30_000;
  const r = rowRig({ respond: { "youtube-watch-start": { ok: true, watch: { status: "countdown", endsAt } } } });
  await openVideo(r);
  await r.row.toggleWatched(true);
  assert.deepEqual(r.order, ["permission", "youtube-watch-start"]);
  assert.equal(r.sent[0].url, URL_A);
  assert.deepEqual([r.last.watched.checked, r.last.watched.disabled, r.last.watched.label], [true, false, "Watch (30s)"]);
  assert.equal(r.timers.at(-1).ms, 1000, "a one-second timer re-draws it");
  r.setNow(100_000 + 1000); r.timers.at(-1).f();
  assert.equal(r.last.watched.label, "Watch (29s)");
  r.setNow(100_000 + 29_500); r.timers.at(-1).f();
  assert.equal(r.last.watched.label, "Watch (1s)");
  // the worker's storage write moves it on: queued, then playing, then finished
  change(r, ID_A, { watch: { status: "queued" } });
  assert.equal(r.last.watched.label, "Watch (queued)");
  assert.equal(r.last.watched.checked, true);
  const before = r.timers.length;
  change(r, ID_A, { watch: { status: "watching", percent: 12 } });
  assert.deepEqual([r.last.watched.label, r.last.watched.checked, r.last.watched.disabled], ["Watching", true, false]);
  assert.match(r.last.watched.title, /12%/);
  assert.equal(r.timers.length, before, "no countdown timer once the countdown is over");
  change(r, ID_A, { watch: { status: "watched" } });
  assert.deepEqual([r.last.watched.label, r.last.watched.checked, r.last.watched.disabled], ["Watched", true, true]);
});

test("Watched: unticking during the countdown, while queued, or while playing sends the untick; the box follows what the worker stores", async () => {
  for (const status of ["countdown", "queued", "watching"]) {
    const after = status === "watching" ? { status: "partial", percent: 37 } : { status: "idle" };
    const r = rowRig({ stored: { [ID_A]: { watch: { status, endsAt: 130_000, percent: 37 } } }, respond: { "youtube-watch-untick": { ok: true, watch: after } } });
    await openVideo(r);
    assert.equal(r.last.watched.checked, true, status);
    await r.row.toggleWatched(false);
    assert.equal(r.sent.at(-1).type, "youtube-watch-untick", status);
    assert.equal(r.order.includes("permission"), false, "unticking asks for nothing");
    if (status === "watching") assert.deepEqual([r.last.watched.checked, r.last.watched.disabled, r.last.watched.label], [true, true, "Watched (37%)"]);
    else assert.deepEqual([r.last.watched.checked, r.last.watched.disabled, r.last.watched.label], [false, false, "Watched"]);
  }
});

test("Watched: a finished or partial watch is locked; ticking or unticking sends nothing", async () => {
  for (const watch of [{ status: "watched" }, { status: "partial", percent: 50 }]) {
    const r = rowRig({ stored: { [ID_A]: { watch } } });
    await openVideo(r);
    assert.equal(r.last.watched.disabled, true);
    await r.row.toggleWatched(false);
    await r.row.toggleWatched(true);
    assert.equal(r.sent.length, 0);
    assert.equal(r.last.watched.checked, true);
  }
});

test("Watched: if the permission is declined or the watch cannot start, the box stays unticked and says why", async () => {
  const declined = rowRig({ access: false });
  await openVideo(declined);
  await declined.row.toggleWatched(true);
  assert.equal(declined.sent.length, 0);
  assert.equal(declined.last.watched.checked, false);
  assert.match(declined.last.notice, /declined/);
  const refused = rowRig({ respond: { "youtube-watch-start": { ok: false, reason: "YouTube access permission is required" } } });
  await openVideo(refused);
  await refused.row.toggleWatched(true);
  assert.equal(refused.last.watched.checked, false);
  assert.equal(refused.last.watched.title, "YouTube access permission is required");
  assert.equal(refused.last.notice, "YouTube access permission is required");
});

test("Watched: a watch that could not start playing (the worker's note) shows the reason and the box is unticked again", async () => {
  const r = rowRig({ respond: { "youtube-watch-start": { ok: true, watch: { status: "countdown", endsAt: 130_000 } } } });
  await openVideo(r);
  await r.row.toggleWatched(true);
  change(r, ID_A, { watch: { status: "idle", reason: "Chrome would not start playback in a hidden window" } });
  r.row.onProgress({ type: "youtube-watch-progress", videoId: ID_A, status: "failed", reason: "Chrome would not start playback in a hidden window" });
  assert.equal(r.last.watched.checked, false);
  assert.equal(r.last.notice, "Chrome would not start playback in a hidden window");
  assert.match(r.last.watched.title, /would not start playback/);
  const other = r.views.length;
  r.row.onProgress({ type: "youtube-watch-progress", videoId: ID_B, status: "failed", reason: "x" });
  assert.equal(r.views.length, other, "another video's note is ignored");
});

test("another video's state changes do not touch this one, and each video keeps its own state while switching", async () => {
  const r = rowRig();
  await openVideo(r, URL_A);
  change(r, ID_B, { watch: { status: "watched" }, like: true });
  assert.equal(r.last.watched.checked, false);
  assert.equal(r.last.like.pressed, false);
  change(r, ID_A, { watch: { status: "watching", percent: 3 }, dislike: true });
  await openVideo(r, URL_B);
  assert.deepEqual([r.last.watched.label, r.last.like.pressed], ["Watched", true]);
  await openVideo(r, URL_A);
  assert.deepEqual([r.last.watched.label, r.last.dislike.pressed], ["Watching", true]);
  r.row.onStorageChange({ [VIDEO_STATES_KEY]: { newValue: {} } }, "sync");  // other storage areas are ignored
  assert.equal(r.last.watched.label, "Watching");
});

test("status text beside the gear: only while a Dip is in progress, empty when done (so Done. never shows)", () => {
  assert.equal(rowStatus({ busy: true, status: "Queued..." }), "Queued...");
  assert.equal(rowStatus({ busy: true, status: "Summarizing..." }), "Summarizing...");
  assert.equal(rowStatus({ busy: false, status: "Done." }), "");
  assert.equal(rowStatus({ busy: false, status: "Saved to history." }), "");
  assert.equal(rowStatus({ busy: false, status: "Removed from history." }), "");
  assert.equal(rowStatus({ busy: false, status: "" }), "");
  assert.match(rowStatus({ busy: false, status: "Cannot reach the companion, so it is not known whether the history log changed. Click the box to try again." }), /Cannot reach/, "a problem with the Saved box is still said");
});

test("the rows are there whenever there is a source, a message, or no set-up yet (so the gear stays reachable)", () => {
  assert.equal(rowsVisible({ configured: true, source: null, busy: false, status: "" }), false);
  assert.equal(rowsVisible({ configured: true, source: { url: URL_A }, busy: false, status: "Done." }), true);
  assert.equal(rowsVisible({ configured: false, source: null, busy: false, status: "Set the companion URL and token in the extension options." }), true);
  assert.equal(rowsVisible({ configured: true, source: null, busy: true, status: "Submitting..." }), true);
});
