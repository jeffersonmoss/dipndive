import { request } from "./api.js";

export const WATCH_DELAY_MS = 30_000;
export const WATCHED_ALARM_PREFIX = "dipdive-watched:";
const STATE_KEY = "watchedPending";

export function youtubeVideoId(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = u.pathname.split("/").filter(Boolean)[0] || "";
    else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
      else id = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function registerWatchedRecorder(chrome, { fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  if (!chrome.storage?.session || !chrome.permissions || !chrome.tabs) return null;
  const alarmName = (tabId) => `${WATCHED_ALARM_PREFIX}${tabId}`;
  const hasPermission = async () => {
    try { return !!(await chrome.permissions.contains({ permissions: ["tabs"] })); }
    catch { return false; }
  };
  const read = async () => (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || {};
  const write = async (state) => chrome.storage.session.set({ [STATE_KEY]: state });
  const clearTab = async (tabId, state) => {
    delete state[String(tabId)];
    if (chrome.alarms) chrome.alarms.clear(alarmName(tabId));
    await write(state);
  };

  async function enabled() {
    const opts = await chrome.storage.local.get("recordWatchedVideos");
    return opts.recordWatchedVideos !== false;
  }

  async function observe(tab) {
    if (!tab || tab.id == null) return;
    const state = await read(), key = String(tab.id);
    if (tab.incognito || !await hasPermission() || !await enabled()) {
      await clearTab(tab.id, state);
      return;
    }
    const videoId = youtubeVideoId(tab.url || "");
    if (!videoId) {
      if (state[key]) await clearTab(tab.id, state);
      return;
    }
    const current = state[key];
    if (current && current.videoId === videoId) return; // Same video page; don't restart on title/status changes.
    const entry = { videoId, url: tab.url, started: now(), due: now() + WATCH_DELAY_MS, reported: false };
    state[key] = entry;
    await write(state);
    if (chrome.alarms) chrome.alarms.create(alarmName(tab.id), { when: entry.due });
  }

  async function send(tabId, entry) {
    const cfg = await chrome.storage.local.get(["base", "token"]);
    if (!cfg.base || !cfg.token) return;
    try { await request(fetchImpl, cfg, "POST", "/watched", { url: entry.url }); }
    catch { /* The visit is reported once; a later visit can report again. */ }
  }

  async function onAlarm(alarm) {
    if (!alarm?.name?.startsWith(WATCHED_ALARM_PREFIX)) return;
    const tabId = Number(alarm.name.slice(WATCHED_ALARM_PREFIX.length));
    if (!Number.isInteger(tabId) || !await hasPermission() || !await enabled()) return;
    const state = await read(), entry = state[String(tabId)];
    if (!entry || entry.reported) return;
    if (now() < entry.due) {
      if (chrome.alarms) chrome.alarms.create(alarmName(tabId), { when: entry.due });
      return;
    }
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { await clearTab(tabId, state); return; }
    if (!tab || tab.incognito || youtubeVideoId(tab.url || "") !== entry.videoId) {
      await clearTab(tabId, state);
      return;
    }
    entry.reported = true;
    state[String(tabId)] = entry;
    await write(state); // persist before POST so a worker restart cannot duplicate the visit
    await send(tabId, entry);
  }

  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || tab?.url) void observe({ ...tab, id: tabId });
  });
  chrome.tabs?.onActivated?.addListener(async ({ tabId }) => {
    if (!await hasPermission()) return;
    try { await observe(await chrome.tabs.get(tabId)); } catch { /* tab closed before lookup */ }
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => { void read().then((state) => clearTab(tabId, state)); });
  chrome.alarms?.onAlarm?.addListener((alarm) => { void onAlarm(alarm); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.recordWatchedVideos) return;
    if (changes.recordWatchedVideos.newValue === false) {
      void read().then(async (state) => {
        for (const id of Object.keys(state)) if (chrome.alarms) chrome.alarms.clear(alarmName(Number(id)));
        await write({});
      });
    } else if (changes.recordWatchedVideos.newValue === true) {
      void (async () => {
        if (!await hasPermission()) return;
        try { for (const tab of await chrome.tabs.query({})) await observe(tab); } catch { /* tabs changed mid-query */ }
      })();
    }
  });

  // session storage survives service-worker restarts; restore alarms and reconcile current pages.
  void (async () => {
    const state = await read();
    if (!await hasPermission() || !await enabled()) {
      await write({});
      return;
    }
    for (const [id, entry] of Object.entries(state)) {
      if (!entry.reported && chrome.alarms) chrome.alarms.create(alarmName(Number(id)), { when: entry.due });
    }
    try {
      for (const tab of await chrome.tabs.query({})) await observe(tab);
    } catch { /* no permission or API unavailable */ }
  })();

  return { observe, onAlarm };
}
