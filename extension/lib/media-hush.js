// Quiet the rest of the browser while the mic is listening, the way a phone does: pause every playing video and audio
// element in other tabs, and mute a tab only where pausing is impossible (no site access, a chrome:// page, Web Audio).
// When listening ends, resume exactly what was paused and unmute exactly what was muted, nothing else.
//
// The service worker does the work and keeps the list in session storage, so the tabs come back even if the panel is
// closed mid-dictation: the panel holds a port open while listening, and a dropped port means "restore".

export const MEDIA_HUSH = Object.freeze({
  port: "dipdive-media",
  restoreMessage: "dipdive-media-restore",
  sessionKey: "mediaHush",
  askedKey: "mediaAccessAsked",   // the one-time "all sites" request was shown (granted or not, it is not shown again)
  origins: Object.freeze(["<all_urls>"]),
  keepAliveMs: 20_000,            // a message on the port keeps the worker awake through a long dictation
});

// Serialized into each frame (isolated world, which keeps its globals between calls). Self-contained.
export function pausePageMedia() {
  const list = (globalThis.__dipdiveHushed = globalThis.__dipdiveHushed || []);
  let n = 0;
  for (const m of document.querySelectorAll("video, audio")) {
    if (m.paused || m.ended) continue;
    try { m.pause(); list.push(m); n++; } catch { /* a player that refuses is left alone; the tab gets muted instead */ }
  }
  return n;
}

export function resumePageMedia() {
  const list = globalThis.__dipdiveHushed || [];
  globalThis.__dipdiveHushed = [];
  let n = 0;
  for (const m of list) {
    if (!m.isConnected || !m.paused) continue;   // removed, or the user already pressed play
    try { m.play()?.catch?.(() => {}); n++; } catch { /* ignore */ }
  }
  return n;
}

const frameSum = (results) => (results || []).reduce((t, r) => t + (Number(r && r.result) || 0), 0);

export function registerMediaHush(chrome) {
  if (!chrome.runtime?.onConnect || !chrome.tabs?.query || !chrome.storage?.session) return null;
  const store = chrome.storage.session;
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn).catch(() => {}));

  const load = async () => ({ paused: [], muted: [], ...((await store.get(MEDIA_HUSH.sessionKey))[MEDIA_HUSH.sessionKey] || {}) });
  const save = (s) => store.set({ [MEDIA_HUSH.sessionKey]: s });

  async function hush() {
    const s = await load();
    const tabs = await chrome.tabs.query({ audible: true });
    for (const tab of tabs) {
      const id = tab.id;
      // Already silent (his own mute, or the Watched countdown's tab), or already handled in this dictation.
      if (id === undefined || tab.mutedInfo?.muted || s.paused.includes(id) || s.muted.includes(id)) continue;
      let paused = 0;
      try {
        paused = frameSum(await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: pausePageMedia }));
      } catch { /* no access to this site, or a page extensions cannot touch */ }
      if (paused > 0) { s.paused.push(id); continue; }
      try { await chrome.tabs.update(id, { muted: true }); s.muted.push(id); } catch { /* tab closed meanwhile */ }
    }
    await save(s);
  }

  async function restore() {
    const s = await load();
    if (!s.paused.length && !s.muted.length) return;
    await save({ paused: [], muted: [] });
    for (const id of s.paused) {
      try { await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: resumePageMedia }); } catch { /* closed */ }
    }
    for (const id of s.muted) {
      try {
        const tab = await chrome.tabs.get(id);
        // Only undo our own mute: if he muted it himself meanwhile, Chrome names no extension and it stays muted.
        if (tab.mutedInfo?.muted && tab.mutedInfo.extensionId === chrome.runtime.id) await chrome.tabs.update(id, { muted: false });
      } catch { /* closed */ }
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== MEDIA_HUSH.port) return;
    let done = false;
    port.onMessage.addListener((m) => {
      if (m?.type === "hush") serial(hush);
      else if (m?.type === "restore") { done = true; serial(restore); }
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!done) serial(restore); });
  });
  chrome.runtime.onMessage?.addListener((m, _sender, sendResponse) => {
    if (m?.type !== MEDIA_HUSH.restoreMessage) return false;
    serial(restore).then(() => sendResponse({ ok: true }));
    return true;
  });
  return { hush: () => serial(hush), restore: () => serial(restore) };
}

// The panel's side: { askAccess, hush, restore }, none of which ever throws.
export function createMediaClient(chrome, { setEvery = setInterval, clearEvery = clearInterval } = {}) {
  let asked = true;   // until storage says otherwise, never risk asking twice
  let port = null, ping = null, hushed = false;
  try { chrome.storage.local.get(MEDIA_HUSH.askedKey).then((r) => { asked = !!r[MEDIA_HUSH.askedKey]; }, () => {}); } catch { /* no storage */ }

  const connect = () => {
    try {
      const p = chrome.runtime.connect({ name: MEDIA_HUSH.port });
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== p) return;
        port = null;
        // The worker restarted while still listening: reconnect, so a later panel close is still noticed.
        if (hushed) { port = connect(); try { port?.postMessage({ type: "watch" }); } catch { /* gone */ } }
      });
      return p;
    } catch { return null; }
  };

  return {
    // Called first inside the mic click (Chrome only shows the prompt during a user gesture). Shown once ever; an earlier
    // grant makes Chrome answer at once with no prompt. Declining leaves the mute fallback.
    async askAccess() {
      if (asked) return;
      asked = true;
      try { chrome.storage.local.set({ [MEDIA_HUSH.askedKey]: true })?.catch?.(() => {}); } catch { /* no storage */ }
      try { await chrome.permissions.request({ origins: [...MEDIA_HUSH.origins] }); } catch { /* declined or unsupported */ }
    },
    hush() {
      if (hushed) return;
      hushed = true;
      port = port || connect();
      try { port?.postMessage({ type: "hush" }); } catch { /* the restore message below still cleans up */ }
      ping = setEvery(() => { try { port?.postMessage({ type: "ping" }); } catch { /* reconnects on disconnect */ } }, MEDIA_HUSH.keepAliveMs);
    },
    restore() {
      if (!hushed) return;
      hushed = false;
      if (ping !== null) { clearEvery(ping); ping = null; }
      const p = port;
      port = null;
      let sent = false;
      try { if (p) { p.postMessage({ type: "restore" }); sent = true; } } catch { /* port already dead */ }
      try { p?.disconnect(); } catch { /* gone */ }
      if (!sent) { try { chrome.runtime.sendMessage({ type: MEDIA_HUSH.restoreMessage })?.catch?.(() => {}); } catch { /* no worker */ } }
    },
  };
}
