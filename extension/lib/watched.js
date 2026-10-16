import { request } from "./api.js";

export const WATCH_DELAY_MS = 120_000;
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
      else if (/^\/(?:shorts|live)(?:\/|$)/.test(u.pathname)) return null;
      else id = u.pathname.match(/^\/(?:embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function registerWatchedRecorder(chrome, { fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  if (!chrome.storage?.session || !chrome.permissions || !chrome.tabs) return null;
  const alarmName = (tabId) => `${WATCHED_ALARM_PREFIX}${tabId}`;
  let stateTail = Promise.resolve();
  const mutateState = (fn) => {
    const operation = stateTail.then(async () => {
      const state = await read();
      return fn(state);
    });
    stateTail = operation.catch(() => {});
    return operation;
  };
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
    try {
      const actionTabs = (await chrome.storage.session.get("youtubeActionTabs")).youtubeActionTabs || [];
      const recovery = (await chrome.storage.local.get("youtubeActionWindowsRecovery")).youtubeActionWindowsRecovery || {};
      const recoveryTabs = Object.values(recovery).map((entry) => entry.tabId);
      if (actionTabs.includes(tab.id) || recoveryTabs.includes(tab.id)) {
        await mutateState(async (state) => { if (state[String(tab.id)]) await clearTab(tab.id, state); });
        return;
      }
    } catch { /* session storage may be unavailable during shutdown */ }
    if (tab.incognito || !await hasPermission() || !await enabled()) {
      await mutateState((state) => clearTab(tab.id, state));
      return;
    }
    const videoId = youtubeVideoId(tab.url || "");
    if (!videoId) {
      await mutateState(async (state) => { if (state[String(tab.id)]) await clearTab(tab.id, state); });
      return;
    }
    const entry = await mutateState(async (state) => {
      const key = String(tab.id), current = state[key];
      if (current && current.videoId === videoId) return null; // Same video page; don't restart on title/status changes.
      const fresh = { videoId, url: tab.url, started: now(), due: now() + WATCH_DELAY_MS, reported: false, tries: 0 };
      state[key] = fresh;
      await write(state);
      if (chrome.alarms) chrome.alarms.create(alarmName(tab.id), { when: fresh.due });
      return fresh;
    });
    if (!entry) return;
    await prefetch(entry);
  }

  async function send(entry) {
    const cfg = await chrome.storage.local.get(["base", "token"]);
    if (!cfg.base || !cfg.token) return { status: 0, retryable: true };
    try {
      const response = await request(fetchImpl, cfg, "POST", "/watched", { url: entry.url });
      return { status: response.status, retryable: response.status === 429 || response.status >= 500 };
    } catch { return { status: 0, retryable: true }; }
  }

  async function prefetch(entry) {
    const cfg = await chrome.storage.local.get(["base", "token"]);
    if (!cfg.base || !cfg.token) return;
    try { await request(fetchImpl, cfg, "POST", "/watched/prefetch", { url: entry.url }); }
    catch { /* Saving at the delay can still fetch captions if prefetch failed. */ }
  }

  async function onAlarm(alarm) {
    if (!alarm?.name?.startsWith(WATCHED_ALARM_PREFIX)) return;
    const tabId = Number(alarm.name.slice(WATCHED_ALARM_PREFIX.length));
    if (!Number.isInteger(tabId) || !await hasPermission() || !await enabled()) return;
    const entry = await mutateState(async (state) => {
      const current = state[String(tabId)];
      if (!current || current.reported) return null;
      if (now() < current.due) {
        if (chrome.alarms) chrome.alarms.create(alarmName(tabId), { when: current.due });
        return null;
      }
      current.reported = true; // claim the attempt before the POST to suppress duplicate alarms
      state[String(tabId)] = current;
      await write(state);
      return { ...current };
    });
    if (!entry) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch {
      // A closed tab only qualifies after the full delay; preserve it for a retry then.
      if (now() < entry.due) await mutateState((state) => clearTab(tabId, state));
      else tab = null;
    }
    if (tab && (tab.incognito || youtubeVideoId(tab.url || "") !== entry.videoId)) {
      await mutateState((state) => clearTab(tabId, state));
      return;
    }
    const result = await send(entry);
    if (result.status === 200 || result.status === 202) return;
    await mutateState(async (state) => {
      const current = state[String(tabId)];
      if (!current || current.videoId !== entry.videoId) return;
      if (result.retryable && (current.tries || 0) < 3) {
        const delays = [60_000, 300_000, 900_000];
        current.reported = false;
        current.tries = (current.tries || 0) + 1;
        current.due = now() + delays[current.tries - 1];
        state[String(tabId)] = current;
        await write(state);
        if (chrome.alarms) chrome.alarms.create(alarmName(tabId), { when: current.due });
      } else {
        await clearTab(tabId, state);
      }
    });
  }

  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || tab?.url) void observe({ ...tab, id: tabId });
  });
  chrome.tabs?.onActivated?.addListener(async ({ tabId }) => {
    if (!await hasPermission()) return;
    try { await observe(await chrome.tabs.get(tabId)); } catch { /* tab closed before lookup */ }
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    void mutateState(async (state) => {
      const entry = state[String(tabId)];
      if (entry && (entry.reported || now() >= entry.due)) return; // a qualified visit remains retryable
      await clearTab(tabId, state);
    });
  });
  chrome.alarms?.onAlarm?.addListener((alarm) => { void onAlarm(alarm); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "session" && changes.youtubeActionTabs) {
      const actionTabs = changes.youtubeActionTabs.newValue || [];
      void mutateState(async (state) => {
        for (const id of actionTabs) if (state[String(id)]) await clearTab(id, state);
      });
      return;
    }
    if (area !== "local" || !changes.recordWatchedVideos) return;
    if (changes.recordWatchedVideos.newValue === false) {
      void mutateState(async (state) => {
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
    if (!await hasPermission() || !await enabled()) {
      await mutateState(async () => write({}));
      return;
    }
    const state = await read();
    for (const [id, entry] of Object.entries(state)) {
      if (!entry.reported && chrome.alarms) chrome.alarms.create(alarmName(Number(id)), { when: entry.due });
    }
    try {
      for (const tab of await chrome.tabs.query({})) await observe(tab);
    } catch { /* no permission or API unavailable */ }
  })();

  return { observe, onAlarm };
}
