import { youtubeVideoId } from "./watched.js";
import { request } from "./api.js";
import { VIDEO_STATES_KEY, MAX_VIDEO_STATES, capVideoStates, normalizeVideoState } from "./video-state.js";

export const THUMB_ACTIONS = Object.freeze(["like", "unlike", "dislike", "undislike"]);

export const YOUTUBE_ACTIONS = Object.freeze({
  hostPermission: "https://www.youtube.com/*",
  sessionWindowsKey: "youtubeActionWindows",
  sessionTabsKey: "youtubeActionTabs",
  persistentWindowsKey: "youtubeActionWindowsRecovery",
  selectors: Object.freeze({
    player: "#movie_player", video: "video",
    avatar: "#avatar-btn",
    like: ["like-button-view-model button"],
    dislike: ["dislike-button-view-model button"],
    // YouTube's segmented control holds both thumbs: the first button is Like, the second is Dislike.
    segmented: "segmented-like-dislike-button-view-model button",
  }),
  timings: Object.freeze({ intervalMs: 1000, countdownMs: 30_000, startupTimeoutMs: 20_000, actionTimeoutMs: 30_000, completionSlackMs: 5 * 60 * 1000, endToleranceSeconds: 2, advanceEpsilonSeconds: 0.05 }),
});

export function youtubeActionVisible(url) { return !!youtubeVideoId(url); }

// This function is serialized into YouTube. Keep it self-contained; all selectors and timing policy live above.
// Returns { working }, { done, already? } or { error, early? }; `early` means the page may simply not have drawn the
// element yet, so the caller may try again until its startup time is up.
export function youtubePageStep(action, config) {
  const sel = config.selectors;
  const player = document.querySelector(sel.player);
  const video = document.querySelector(sel.video);
  // Silence comes from the browser-level tab mute set before YouTube loads. The player's own mute is never used: YouTube
  // remembers it, and his normal YouTube would then start muted.
  const state = () => {
    try { if (typeof player?.getPlayerState === "function") return player.getPlayerState(); } catch {}
    return video?.ended ? 0 : video && !video.paused ? 1 : 2;
  };
  const time = () => {
    try { const n = player?.getCurrentTime?.(); if (Number.isFinite(n)) return n; } catch {}
    return Number(video?.currentTime) || 0;
  };
  const duration = () => {
    try { const n = player?.getDuration?.(); if (Number.isFinite(n) && n > 0) return n; } catch {}
    return Number(video?.duration) || 0;
  };
  const pause = () => { try { player?.pauseVideo?.(); } catch {} try { video?.pause?.(); } catch {} };
  const play = (speed) => {
    try { player?.setPlaybackRate?.(speed); } catch {}
    try { if (typeof player?.playVideo === "function") player.playVideo(); else video?.play?.(); } catch {}
    try { if (video) { video.playbackRate = speed; const p = video.play?.(); p?.catch?.(() => {}); } } catch {}
  };
  // The fastest rate the player offers (2 if it will not say) and the lowest quality it offers. Failures are ignored.
  const fastest = () => {
    let rates = [];
    try { rates = player?.getAvailablePlaybackRates?.() || []; } catch {}
    const nums = Array.isArray(rates) ? rates.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    return nums.length ? Math.max(...nums) : 2;
  };
  const lowQuality = () => {
    try {
      const levels = player?.getAvailableQualityLevels?.();
      if (!Array.isArray(levels) || !levels.length) return;
      const order = ["tiny", "small", "medium", "large", "hd720", "hd1080", "hd1440", "hd2160", "highres"];
      const lowest = order.find((q) => levels.includes(q)) || [...levels].reverse().find((q) => q !== "auto");
      if (!lowest) return;
      if (player.getPlaybackQuality?.() === lowest) return;
      try { player.setPlaybackQualityRange?.(lowest, lowest); } catch {}
      try { player.setPlaybackQuality?.(lowest); } catch {}
    } catch { /* quality is a nicety, never a reason to stop */ }
  };

  const thumb = ["like", "unlike", "dislike", "undislike"].includes(action);
  if (thumb) pause();  // a thumb click must never leave the video playing
  if (!document.querySelector(sel.avatar)) return { error: "YouTube is signed out", early: true };

  if (thumb) {
    const kind = action.endsWith("dislike") ? "dislike" : "like";
    const wantPressed = action === "like" || action === "dislike";
    const enabled = (el) => el && !el.disabled;
    const all = (s) => [...document.querySelectorAll(s)].filter(enabled);
    const direct = sel[kind].flatMap(all)[0];
    const button = direct || all(sel.segmented)[kind === "like" ? 0 : 1] || null;
    if (!button) return { error: `${kind === "like" ? "Like" : "Dislike"} button was not found`, early: true };
    const pressed = () => button.getAttribute("aria-pressed") === "true";
    globalThis.__dipdiveClickedActions ||= {};
    const clicked = globalThis.__dipdiveClickedActions[action] === true;
    if (pressed() === wantPressed) return clicked ? { done: true } : { done: true, already: true };
    // Toggle only toward the requested state, and only once; then wait for the page to show it.
    if (!clicked) { globalThis.__dipdiveClickedActions[action] = true; button.click(); }
    return { working: true };
  }

  if (action === "watch") {
    if (!video && !player) return { error: "YouTube player was not found", early: true };
    const speed = fastest();
    lowQuality();
    play(speed);
    // An ad is not a reason to stop: the watch goes on (the tab is muted). Its clock is the ad's, so the video's time and
    // length are not reported meanwhile.
    if (player?.classList?.contains?.("ad-showing")) return { working: true, ad: true, rate: speed };
    const t = time(), d = duration();
    if (d > 0 && (state() === 0 || t >= d - config.endToleranceSeconds)) return { done: true, currentTime: t, duration: d, rate: speed };
    return { working: true, currentTime: t, duration: d || null, rate: speed };
  }
  return { error: "Unknown YouTube action" };
}

const pauseFor = (ms, sleep) => sleep(ms);
const sessionGet = async (chrome, key, fallback) => ((await chrome.storage.session.get(key))[key] ?? fallback);
const percentOf = (t, d) => d > 0 && Number.isFinite(t) ? Math.max(0, Math.min(99, Math.round((t / d) * 100))) : 0;

export function registerYoutubeActions(chrome, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), uuid = () => crypto.randomUUID(), onProgress = null, timings = YOUTUBE_ACTIONS.timings } = {}) {
  if (!chrome.storage?.session || !chrome.runtime?.onMessage) return null;
  const active = new Map();        // thumb actions in flight, by action id
  const countdowns = new Map();    // video id -> the watch counting down
  const queue = [];                // watches waiting for the one background window, first in first out
  let current = null;              // the watch that has the window
  const sendProgress = (payload) => {
    try { onProgress?.(payload); } catch {}
    try { chrome.runtime.sendMessage({ type: "youtube-watch-progress", ...payload }, () => void chrome.runtime.lastError); } catch {}
  };

  // ---------- the hidden window (minimized, unfocused, muted before YouTube loads) ----------
  const writeTrack = async (windowId, tabId, panelWindowId, actionId) => {
    const recovery = await chrome.storage.local.get(YOUTUBE_ACTIONS.persistentWindowsKey);
    const persisted = recovery[YOUTUBE_ACTIONS.persistentWindowsKey] || {};
    persisted[String(windowId)] = { windowId, tabId, panelWindowId, actionId };
    await chrome.storage.local.set({ [YOUTUBE_ACTIONS.persistentWindowsKey]: persisted });
    const windows = await sessionGet(chrome, YOUTUBE_ACTIONS.sessionWindowsKey, {});
    windows[String(windowId)] = { windowId, tabId, panelWindowId, actionId };
    await chrome.storage.session.set({ [YOUTUBE_ACTIONS.sessionWindowsKey]: windows });
    const tabs = new Set(await sessionGet(chrome, YOUTUBE_ACTIONS.sessionTabsKey, [])); tabs.add(tabId);
    await chrome.storage.session.set({ [YOUTUBE_ACTIONS.sessionTabsKey]: [...tabs] });
  };
  const untrack = async (windowId, tabId) => {
    const windows = await sessionGet(chrome, YOUTUBE_ACTIONS.sessionWindowsKey, {}); delete windows[String(windowId)];
    const tabs = new Set(await sessionGet(chrome, YOUTUBE_ACTIONS.sessionTabsKey, [])); tabs.delete(tabId);
    await chrome.storage.session.set({ [YOUTUBE_ACTIONS.sessionWindowsKey]: windows, [YOUTUBE_ACTIONS.sessionTabsKey]: [...tabs] });
    const recovery = await chrome.storage.local.get(YOUTUBE_ACTIONS.persistentWindowsKey);
    const persisted = recovery[YOUTUBE_ACTIONS.persistentWindowsKey] || {}; delete persisted[String(windowId)];
    await chrome.storage.local.set({ [YOUTUBE_ACTIONS.persistentWindowsKey]: persisted });
  };
  const closeTracked = async (entry) => {
    try { if (entry.windowId != null) await chrome.windows.remove(entry.windowId); } catch {}
    if (entry.tabId != null) await untrack(entry.windowId, entry.tabId);
  };
  const permissionGranted = async () => { try { return !!await chrome.permissions.contains({ origins: [YOUTUBE_ACTIONS.hostPermission] }); } catch { return false; } };

  // ---------- per-video memory (chrome.storage.local, newest 500 videos) ----------
  let stateChain = Promise.resolve();
  const readAll = async () => ((await chrome.storage.local.get(VIDEO_STATES_KEY))[VIDEO_STATES_KEY]) || {};
  const getVideoState = async (videoId) => normalizeVideoState((await readAll())[videoId]);
  // Every change goes through one chain so two quick changes cannot overwrite each other.
  function mutate(videoId, fn) {
    const op = stateChain.then(async () => {
      const all = await readAll();
      const next = fn(normalizeVideoState(all[videoId]));
      all[videoId] = { ...next, ts: now() };
      await chrome.storage.local.set({ [VIDEO_STATES_KEY]: capVideoStates(all, MAX_VIDEO_STATES) });
      return next;
    });
    stateChain = op.catch(() => {});
    return op;
  }
  const setWatch = (videoId, watch) => mutate(videoId, (s) => ({ ...s, watch }));

  async function cleanStale() {
    const windows = await sessionGet(chrome, YOUTUBE_ACTIONS.sessionWindowsKey, {});
    const recovery = await chrome.storage.local.get(YOUTUBE_ACTIONS.persistentWindowsKey);
    const entries = { ...windows, ...(recovery[YOUTUBE_ACTIONS.persistentWindowsKey] || {}) };
    for (const entry of Object.values(entries)) await closeTracked(entry);
  }
  // When the worker starts, nothing is running (Chrome restarted or the worker was reloaded): a watch that was cut off is
  // recorded as partial with the percent it had reached, a countdown or a place in the queue is dropped, and no watch is
  // restarted by itself.
  async function reconcileCutOff() {
    const all = await readAll();
    for (const [videoId, raw] of Object.entries(all)) {
      const s = normalizeVideoState(raw);
      if (s.watch.status === "watching") await setWatch(videoId, { status: "partial", percent: s.watch.percent ?? 0 });
      else if (s.watch.status === "countdown" || s.watch.status === "queued") await setWatch(videoId, { status: "idle" });
    }
  }
  const startupCleanup = (async () => { await cleanStale(); await reconcileCutOff(); })().catch(() => {});

  async function postWatched(url) {
    const cfg = await chrome.storage.local.get(["base", "token", "recordWatchedVideos"]);
    if (cfg.recordWatchedVideos === false) return;  // the Settings checkbox "Save transcripts of videos I watch" is off
    if (cfg.base && cfg.token) await request(fetchImpl, cfg, "POST", "/watched", { url });
  }

  // ---------- one run in the hidden window ----------
  // `task`: { url, action, panelWindowId, actionId, stop (watch only), onPercent (watch only) }.
  // Resolves { ok, already?, finished?, percent?, reason?, cancelled? }. The window is always closed.
  async function run(task) {
    const { url, action, panelWindowId, incognito = false, actionId = uuid() } = task;
    const videoId = youtubeVideoId(url);
    if (incognito) return { ok: false, reason: "YouTube actions are unavailable in Incognito" };
    if (!videoId) return { ok: false, reason: "This is not a YouTube video" };
    const watching = action === "watch";
    const started = now();
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    let createdWindow, tabId;
    let lastTime = null, advancing = false, duration = 0, rate = 1;
    const partial = () => percentOf(lastTime, duration);
    try {
      // Open a blank tab, mute it, and only then load YouTube, so nothing can ever be audible.
      createdWindow = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false });
      tabId = createdWindow.tabs?.[0]?.id;
      if (tabId == null) throw new Error("Chrome did not return the YouTube tab");
      await writeTrack(createdWindow.id, tabId, panelWindowId, actionId);
      await chrome.tabs.update(tabId, { muted: true });
      await chrome.tabs.update(tabId, { url: watchUrl, muted: true });
      let deadline = watching ? null : started + timings.actionTimeoutMs;
      while (true) {
        if (task.stop) return { ok: true, stopped: true, percent: partial() };
        let response;
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: youtubePageStep, args: [action, { endToleranceSeconds: timings.endToleranceSeconds, selectors: YOUTUBE_ACTIONS.selectors }] });
        response = results?.[0]?.result;
        const elapsed = now() - started;
        if (response?.error) {
          if (response.early && elapsed < timings.startupTimeoutMs) { await pauseFor(timings.intervalMs, sleep); continue; }
          throw new Error(response.error);
        }
        if (response?.done) return { ok: true, already: !!response.already, finished: true, percent: 100 };
        if (watching) {
          if (response?.ad) advancing = true;  // an ad is playing: playback did start
          const t = Number(response?.currentTime);
          if (Number.isFinite(t)) {
            if (lastTime !== null && t > lastTime + timings.advanceEpsilonSeconds) advancing = true;
            lastTime = t;
          }
          if (Number.isFinite(response?.duration) && response.duration > 0) duration = response.duration;
          if (Number.isFinite(response?.rate) && response.rate > 0) rate = response.rate;
          if (!advancing && elapsed >= timings.startupTimeoutMs) throw new Error("Chrome would not start playback in a hidden window");
          if (duration > 0) {
            deadline = started + (duration * 1000) / rate + timings.completionSlackMs;
            task.onPercent?.(partial());
          } else if (!response?.ad && elapsed >= timings.startupTimeoutMs) throw new Error("Video duration is unavailable");  // (an ad has its own clock)
        }
        if (deadline && now() >= deadline) throw new Error(watching ? "Watching timed out" : "YouTube action timed out");
        await pauseFor(timings.intervalMs, sleep);
      }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error), advanced: advancing, percent: partial() };
    } finally {
      if (createdWindow) await closeTracked({ windowId: createdWindow.id, tabId });
    }
  }

  // ---------- thumbs ----------
  const thumbEffect = { like: { like: true, dislike: false }, unlike: { like: false }, dislike: { like: false, dislike: true }, undislike: { dislike: false } };
  async function thumb({ url, action, panelWindowId, actionId = uuid() }) {
    const videoId = youtubeVideoId(url);
    const task = { url, action, panelWindowId, actionId };
    active.set(actionId, task);
    let result;
    try { result = await run(task); } finally { active.delete(actionId); }
    if (!result.ok) return result;
    const state = await mutate(videoId, (s) => ({ ...s, ...thumbEffect[action] }));
    return { ok: true, already: !!result.already, like: state.like, dislike: state.dislike };
  }

  // ---------- Watched: countdown, one background watch at a time, first in first out ----------
  const keepAlive = async () => { try { await chrome.storage.session.get("youtubeKeepAlive"); } catch {} };  // an extension call resets the worker's idle timer

  async function runWatch(entry) {
    const { videoId, url } = entry;
    await setWatch(videoId, { status: "watching", percent: 0 });
    let lastPercent = 0;
    entry.onPercent = (p) => { if (p !== lastPercent) { lastPercent = p; void setWatch(videoId, { status: "watching", percent: p }); } };
    let result;
    try { result = await run(entry); }
    catch (e) { result = { ok: false, reason: String(e?.message || e), advanced: false, percent: 0 }; }
    if (result.finished) {
      await setWatch(videoId, { status: "watched" });
      try { await postWatched(url); } catch { /* the watch finished; the recorder's own retry is not involved here */ }
      sendProgress({ videoId, status: "finished" });
    } else if (result.stopped || (!result.ok && result.advanced)) {
      // Unticked while playing, or cut off after it had started: it keeps how much was played.
      const percent = Math.min(99, result.percent ?? 0);
      await setWatch(videoId, { status: "partial", percent });
      sendProgress({ videoId, status: result.stopped ? "stopped" : "failed", reason: result.reason, percent });
    } else {
      const reason = result.reason || "The watch could not run";
      await mutate(videoId, (s) => ({ ...s, watch: { status: "idle", reason } }));
      sendProgress({ videoId, status: "failed", reason });
    }
  }
  function launch(entry) {
    current = entry;
    void runWatch(entry).catch(() => {}).finally(() => {
      current = null;
      const next = queue.shift();
      if (next) launch(next);
    });
  }
  async function runCountdown(entry) {
    while (!entry.cancelled && now() < entry.endsAt) {
      await pauseFor(Math.max(1, Math.min(timings.intervalMs, entry.endsAt - now())), sleep);
      await keepAlive();
    }
    if (entry.cancelled || countdowns.get(entry.videoId) !== entry) return;
    countdowns.delete(entry.videoId);
    if (current) {
      queue.push(entry);
      await setWatch(entry.videoId, { status: "queued" });
    } else {
      launch(entry);
    }
  }
  async function startWatch({ url, panelWindowId }) {
    const videoId = youtubeVideoId(url);
    const known = await getVideoState(videoId);
    if (known.watch.status !== "idle" || countdowns.has(videoId) || queue.some((e) => e.videoId === videoId) || current?.videoId === videoId) return { ok: true, watch: known.watch };
    const entry = { videoId, url, action: "watch", panelWindowId, actionId: uuid(), cancelled: false, stop: false, endsAt: now() + timings.countdownMs };
    countdowns.set(videoId, entry);
    const state = await setWatch(videoId, { status: "countdown", endsAt: entry.endsAt });
    void runCountdown(entry);
    return { ok: true, watch: state.watch };
  }
  async function untickWatch({ url }) {
    const videoId = youtubeVideoId(url);
    const counting = countdowns.get(videoId);
    if (counting) { counting.cancelled = true; countdowns.delete(videoId); const s = await setWatch(videoId, { status: "idle" }); return { ok: true, watch: s.watch }; }
    const at = queue.findIndex((e) => e.videoId === videoId);
    if (at >= 0) { queue.splice(at, 1); const s = await setWatch(videoId, { status: "idle" }); return { ok: true, watch: s.watch }; }
    if (current?.videoId === videoId) { current.stop = true; return { ok: true, watch: { status: "watching" } }; }
    // Stored as running but nothing here is running it: put the stored state right.
    const known = await getVideoState(videoId);
    if (known.watch.status === "countdown" || known.watch.status === "queued") { const s = await setWatch(videoId, { status: "idle" }); return { ok: true, watch: s.watch }; }
    if (known.watch.status === "watching") { const s = await setWatch(videoId, { status: "partial", percent: known.watch.percent ?? 0 }); return { ok: true, watch: s.watch }; }
    return { ok: true, watch: known.watch };  // finished and partial ones are locked
  }

  // ---------- messages from the panel ----------
  const TYPES = ["youtube-action", "youtube-watch-start", "youtube-watch-untick"];
  async function handle(message, sender, sendResponse) {
    if (!message || !TYPES.includes(message.type)) return false;
    if (sender?.tab?.incognito || message.incognito) { sendResponse({ ok: false, reason: "YouTube actions are unavailable in Incognito" }); return true; }
    await startupCleanup;
    if (!youtubeVideoId(message.url)) { sendResponse({ ok: false, reason: "This is not a YouTube video" }); return true; }
    const panelWindowId = sender?.tab?.windowId ?? message.panelWindowId;
    try {
      if (message.type === "youtube-watch-untick") { sendResponse(await untickWatch(message)); return true; }
      if (!await permissionGranted()) { sendResponse({ ok: false, reason: "YouTube access permission is required" }); return true; }
      if (message.type === "youtube-watch-start") { sendResponse(await startWatch({ ...message, panelWindowId })); return true; }
      if (!THUMB_ACTIONS.includes(message.action)) { sendResponse({ ok: false, reason: "Unknown YouTube action" }); return true; }
      sendResponse(await thumb({ ...message, panelWindowId }));
    } catch (error) {
      sendResponse({ ok: false, reason: String(error?.message || error) });
    }
    return true;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !TYPES.includes(message.type)) return false;
    void handle(message, sender, sendResponse);
    return true;
  });
  return { run, handle, cleanStale, reconcileCutOff, active, countdowns, queue, startWatch, untickWatch, getVideoState, get current() { return current; } };
}
