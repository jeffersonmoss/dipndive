import { youtubeVideoId } from "./watched.js";
import { request } from "./api.js";

export const YOUTUBE_ACTIONS = Object.freeze({
  hostPermission: "https://www.youtube.com/*",
  sessionWindowsKey: "youtubeActionWindows",
  sessionTabsKey: "youtubeActionTabs",
  persistentWindowsKey: "youtubeActionWindowsRecovery",
  autoJobsKey: "youtubeActionAutoJobs",
  selectors: Object.freeze({
    player: "#movie_player", video: "video",
    avatar: "#avatar-btn",
    like: ["like-button-view-model button", "segmented-like-dislike-button-view-model button"],
    subscribe: ["#subscribe-button button", "ytd-subscribe-button-renderer button", "yt-subscribe-button-view-model button"],
    owner: ["ytd-video-owner-renderer a[href]", "#owner a[href]"],
  }),
  timings: Object.freeze({ intervalMs: 1000, startupTimeoutMs: 20_000, ownerLinkTimeoutMs: 15_000, historyPlaybackMs: 30_000, actionTimeoutMs: 30_000, completionSlackMs: 5 * 60 * 1000, endToleranceSeconds: 2, advanceEpsilonSeconds: 0.05 }),
});

export function youtubeActionVisible(url) { return !!youtubeVideoId(url); }

// This function is serialized into YouTube. Keep it self-contained; all selectors and timing policy live above.
export function youtubePageStep(action, config) {
  const sel = config.selectors;
  const player = document.querySelector(sel.player);
  const video = document.querySelector(sel.video);
  // Silence comes from the browser-level tab mute set before YouTube loads. The player's own mute is not used: YouTube
  // remembers it, and his normal YouTube would then start muted.
  const mute = () => {};
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
    mute();
    try { player?.setPlaybackRate?.(speed); } catch {}
    try { if (typeof player?.playVideo === "function") player.playVideo(); else video?.play?.(); } catch {}
    try { if (video) { video.playbackRate = speed; const p = video.play?.(); p?.catch?.(() => {}); } } catch {}
    mute();
  };
  if (action === "like" || action === "subscribe") pause();
  // Premium Lite still shows ads on music videos: never let one play unseen.
  if ((action === "history" || action === "watchThrough") && player?.classList?.contains?.("ad-showing")) {
    pause();
    return { error: "An ad started (Premium Lite shows ads on music videos), so playback was stopped" };
  }
  const signedIn = !!document.querySelector(sel.avatar);
  if (!signedIn) return { error: "YouTube is signed out" };
  const find = (selectors) => selectors.flatMap((s) => [...document.querySelectorAll(s)]).find((el) => el && !el.disabled) || null;
  if (action === "like") {
    const button = find(sel.like);
    if (!button) return { error: "Like button was not found" };
    if (button.getAttribute("aria-pressed") === "true") return { done: true, already: true };
    globalThis.__dipdiveClickedActions ||= {};
    if (!globalThis.__dipdiveClickedActions.like) { globalThis.__dipdiveClickedActions.like = true; button.click(); return { working: true }; }
    return button.getAttribute("aria-pressed") === "true" ? { done: true } : { working: true };
  }
  if (action === "subscribe") {
    const button = find(sel.subscribe);
    if (!button) return { error: "Subscribe button was not found" };
    const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
    if (/subscribed|unsubscribe/i.test(label)) return { done: true, already: true };
    globalThis.__dipdiveClickedActions ||= {};
    if (!globalThis.__dipdiveClickedActions.subscribe) { globalThis.__dipdiveClickedActions.subscribe = true; button.click(); return { working: true }; }
    const after = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
    return /subscribed|unsubscribe/i.test(after) ? { done: true } : { working: true };
  }
  if (!video && !player) return { error: "YouTube player was not found" };
  if (action === "history" || action === "watchThrough") {
    if (action === "watchThrough") {
      const d = duration();
      if (d > 0) {
        const t = time();
        if (state() === 0 || t >= d - config.endToleranceSeconds) return { done: true, currentTime: t, duration: d };
        play(config.speed);
        return { working: true, currentTime: t, duration: d };
      }
    }
    const t = time();
    if (!video?.dataset.dipdiveStarted && !player?.dataset?.dipdiveStarted) {
      if (video) video.dataset.dipdiveStarted = String(t);
      try { if (player) player.dataset.dipdiveStarted = String(t); } catch {}
      play(action === "history" ? 1 : config.speed);
      return { working: true, currentTime: t };
    }
    const start = Number(video?.dataset.dipdiveStarted ?? player?.dataset?.dipdiveStarted) || 0;
    if (action === "history" && t - start >= config.historyPlaybackMs / 1000) { pause(); return { done: true, currentTime: t }; }
    if (action === "watchThrough") {
      const d = duration();
      if (d > 0 && (state() === 0 || t >= d - config.endToleranceSeconds)) { pause(); return { done: true, currentTime: t, duration: d }; }
    }
    play(action === "history" ? 1 : config.speed);
    const d = duration();
    return { working: true, currentTime: t, duration: d || null };
  }
  return { error: "Unknown YouTube action" };
}

// Self-contained injection used while waiting for the watch page to expose its channel link.
export function youtubeOwnerLinkStep(selectors) {
  const player = document.querySelector(selectors.player), video = document.querySelector(selectors.video);
  try { video?.pause?.(); } catch {}
  try { player?.pauseVideo?.(); } catch {}
  const a = selectors.owner.map((s) => document.querySelector(s)).find(Boolean);
  return a?.href || null;
}

const pauseFor = (ms, sleep) => sleep(ms);
const sessionGet = async (chrome, key, fallback) => ((await chrome.storage.session.get(key))[key] ?? fallback);

export function registerYoutubeActions(chrome, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), uuid = () => crypto.randomUUID(), onProgress = null, timings = YOUTUBE_ACTIONS.timings } = {}) {
  if (!chrome.storage?.session || !chrome.runtime?.onMessage) return null;
  const active = new Map();
  const sendProgress = (payload) => {
    try { onProgress?.(payload); } catch {}
    try { chrome.runtime.sendMessage({ type: "youtube-action-progress", ...payload }, () => void chrome.runtime.lastError); } catch {}
  };
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
  async function cleanStale() {
    const windows = await sessionGet(chrome, YOUTUBE_ACTIONS.sessionWindowsKey, {});
    const recovery = await chrome.storage.local.get(YOUTUBE_ACTIONS.persistentWindowsKey);
    const entries = { ...windows, ...(recovery[YOUTUBE_ACTIONS.persistentWindowsKey] || {}) };
    for (const entry of Object.values(entries)) await closeTracked(entry);
  }
  const startupCleanup = cleanStale().catch(() => {});
  chrome.windows?.onRemoved?.addListener((panelWindowId) => {
    void (async () => {
      const windows = await sessionGet(chrome, YOUTUBE_ACTIONS.sessionWindowsKey, {});
      await Promise.all(Object.values(windows).filter((entry) => entry.panelWindowId === panelWindowId).map(closeTracked));
    })();
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || changes.youtubePremium?.newValue !== false) return;
    for (const task of active.values()) if (task.action === "watchThrough") task.cancelled = true;
  });

  async function postWatched(url) {
    const cfg = await chrome.storage.local.get(["base", "token"]);
    if (cfg.base && cfg.token) await request(fetchImpl, cfg, "POST", "/watched", { url });
  }

  async function run({ url, action, panelWindowId, incognito = false, speed = 2, actionId = uuid() }) {
    const videoId = youtubeVideoId(url);
    if (incognito) return { ok: false, reason: "YouTube actions are unavailable in Incognito" };
    if (!videoId) return { ok: false, reason: "This is not a YouTube video" };
    if (action === "watchThrough") {
      const prefs = await chrome.storage.local.get(["youtubePremium", "youtubePlaybackSpeed"]);
      if (!prefs.youtubePremium) return { ok: false, reason: "Turn on 'I have YouTube Premium' in Settings" };
      speed = [1, 1.5, 2].includes(prefs.youtubePlaybackSpeed) ? prefs.youtubePlaybackSpeed : speed;
    }
    const activeTask = { cancelled: false, actionId, action };
    active.set(actionId, activeTask);
    let createdWindow;
    let tabId;
    const started = now();
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    let lastTime = null, playbackStart = null, advancing = false, duration = 0, onChannel = false;
    try {
      // Open a blank tab, mute it, and only then load YouTube, so nothing can ever be audible.
      createdWindow = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false });
      tabId = createdWindow.tabs?.[0]?.id;
      if (tabId == null) throw new Error("Chrome did not return the YouTube tab");
      await writeTrack(createdWindow.id, tabId, panelWindowId, actionId);
      await chrome.tabs.update(tabId, { muted: true });
      await chrome.tabs.update(tabId, { url: watchUrl, muted: true });
      if (action === "subscribe") {
        const ownerDeadline = now() + timings.ownerLinkTimeoutMs;
        while (now() <= ownerDeadline && !activeTask.cancelled) {
          try {
            const found = await chrome.scripting.executeScript({ target: { tabId }, func: youtubeOwnerLinkStep, args: [YOUTUBE_ACTIONS.selectors] });
            const ownerUrl = found?.[0]?.result;
            if (ownerUrl) {
              const parsed = new URL(ownerUrl);
              if (parsed.protocol === "https:" && /(^|\.)youtube\.com$/i.test(parsed.hostname)) {
                onChannel = true;
                await chrome.tabs.update(tabId, { url: `https://www.youtube.com${parsed.pathname}`, muted: true });
                break;
              }
            }
          } catch { /* the watch page may still be loading */ }
          await pauseFor(timings.intervalMs, sleep);
        }
      }
      if (activeTask.cancelled) return { ok: false, cancelled: true, reason: "Canceled" };
      const maxDeadline = action === "watchThrough" ? null : started + (action === "history" ? timings.historyPlaybackMs + timings.startupTimeoutMs : timings.actionTimeoutMs);
      let watchDeadline = null;
      while (true) {
        if (activeTask.cancelled) return { ok: false, cancelled: true, reason: "Canceled" };
        const args = [{ speed, historyPlaybackMs: timings.historyPlaybackMs, endToleranceSeconds: timings.endToleranceSeconds }, action];
        let response;
        try {
          const results = await chrome.scripting.executeScript({ target: { tabId }, func: youtubePageStep, args: [action, { ...args[0], selectors: YOUTUBE_ACTIONS.selectors }] });
          response = results?.[0]?.result;
        } catch (e) {
          if (onChannel) { onChannel = false; await chrome.tabs.update(tabId, { url: watchUrl, muted: true }); await pauseFor(timings.intervalMs, sleep); continue; }
          throw e;
        }
        if (response?.error) {
          if (onChannel && action === "subscribe") {
            onChannel = false;
            await chrome.tabs.update(tabId, { url: watchUrl, muted: true });
            await pauseFor(timings.intervalMs, sleep);
            continue;
          }
          throw new Error(response.error);
        }
        if (response?.done) {
          if (action === "watchThrough") await postWatched(url);
          return { ok: true, already: !!response.already, percent: 100 };
        }
        const t = Number(response?.currentTime);
        if (Number.isFinite(t)) {
          if (playbackStart === null) playbackStart = t;
          if (lastTime !== null && t > lastTime + timings.advanceEpsilonSeconds) advancing = true;
          lastTime = t;
        }
        if (Number.isFinite(response?.duration) && response.duration > 0) duration = response.duration;
        const elapsed = now() - started;
        if ((action === "history" || action === "watchThrough") && !advancing && elapsed >= timings.startupTimeoutMs) {
          throw new Error("Chrome would not start playback in a hidden window");
        }
        if (action === "watchThrough" && elapsed >= timings.startupTimeoutMs && duration <= 0) throw new Error("Video duration is unavailable");
        if (action === "watchThrough" && duration > 0) {
          watchDeadline ??= started + duration * 1000 / speed + timings.completionSlackMs;
          if (now() >= watchDeadline) throw new Error("Watch through timed out");
          sendProgress({ actionId, action, status: "working", videoId, percent: Math.min(99, Math.floor((t / duration) * 100)) });
        } else if (action === "history" && elapsed >= timings.historyPlaybackMs + timings.startupTimeoutMs) {
          throw new Error("Playback did not reach 30 seconds");
        }
        if (action !== "history" && action !== "watchThrough" && maxDeadline && now() >= maxDeadline) throw new Error("YouTube action timed out");
        if (action === "history" && advancing && lastTime - playbackStart >= timings.historyPlaybackMs / 1000) return { ok: true };
        if (maxDeadline && now() >= maxDeadline) throw new Error("YouTube action timed out");
        if (elapsed >= timings.startupTimeoutMs && (action === "history" || action === "watchThrough") && !advancing) throw new Error("Chrome would not start playback in a hidden window");
        await pauseFor(timings.intervalMs, sleep);
      }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    } finally {
      active.delete(actionId);
      if (createdWindow) await closeTracked({ windowId: createdWindow.id, tabId });
      sendProgress({ actionId, action, videoId, status: "finished" });
    }
  }


  async function handle(message, sender, sendResponse) {
    if (!message || !["youtube-action", "youtube-action-cancel", "youtube-action-default"].includes(message.type)) return false;
    if (sender?.tab?.incognito || message.incognito) { sendResponse({ ok: false, reason: "YouTube actions are unavailable in Incognito" }); return true; }
    if (message.type === "youtube-action-cancel") {
      const task = active.get(message.actionId); if (task) task.cancelled = true;
      sendResponse({ ok: !!task }); return true;
    }
    await startupCleanup;
    if (!youtubeVideoId(message.url)) { sendResponse({ ok: false, reason: "This is not a YouTube video" }); return true; }
    const isDefault = message.type === "youtube-action-default";
    if (isDefault) {
      const completed = new Set(await sessionGet(chrome, YOUTUBE_ACTIONS.autoJobsKey, []));
      if (completed.has(message.jobId)) { sendResponse({ ok: true, skipped: true }); return true; }
      completed.add(message.jobId);
      await chrome.storage.session.set({ [YOUTUBE_ACTIONS.autoJobsKey]: [...completed] });
      const prefs = await chrome.storage.local.get(["youtubeAfterDip", "youtubePremium", "youtubePlaybackSpeed"]);
      const choice = prefs.youtubeAfterDip || "leave";
      if (choice === "leave") { sendResponse({ ok: true, skipped: true }); return true; }
      if (choice === "watchThrough" && !prefs.youtubePremium) { sendResponse({ ok: true, skipped: true }); return true; }
      message.action = choice;
      message.speed = prefs.youtubePlaybackSpeed;
      if (!await permissionGranted()) { sendResponse({ ok: false, notice: "Click any YouTube action button once to allow YouTube access." }); return true; }
    } else if (!await permissionGranted()) { sendResponse({ ok: false, reason: "YouTube access permission is required" }); return true; }
    const actionId = message.actionId || uuid();
    const panelWindowId = sender?.tab?.windowId ?? message.panelWindowId;
    sendResponse({ ok: true, actionId, started: true });
    sendProgress({ actionId, action: message.action, status: "working", videoId: youtubeVideoId(message.url) });
    void run({ ...message, actionId, panelWindowId }).then((result) => sendProgress({ actionId, action: message.action, videoId: youtubeVideoId(message.url), status: result.ok ? "done" : result.cancelled ? "cancelled" : "failed", ...result }));
    return true;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !["youtube-action", "youtube-action-cancel", "youtube-action-default"].includes(message.type)) return false;
    void handle(message, sender, sendResponse);
    return true;
  });
  return { run, handle, cleanStale, active };
}
