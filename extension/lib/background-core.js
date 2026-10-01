// Service worker logic with chrome injected, so it can be unit-tested (plan 3.1.3 and 3.1.4).
import { DEFAULT_MODE, menuLabel, normalizeMode } from "./modes.js";
import { pickUrl } from "./urls.js";

export const MENU_ID = "dipdive-run";
export const slotKey = (windowId) => `slot:${windowId}`;

export const MAX_SLOTS = 20;

// Keep only the newest MAX_SLOTS per-window slots (window ids change after a restart, so old ones pile up).
export async function pruneSlots(storage, keep = MAX_SLOTS) {
  const all = await storage.get(null);
  const slots = Object.entries(all).filter(([k]) => k.startsWith("slot:")).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  const drop = slots.slice(keep).map(([k]) => k);
  if (drop.length) await storage.remove(drop);
}

export function registerBackground(chrome, uuid = () => crypto.randomUUID()) {
  const swallow = () => void chrome.runtime.lastError;

  async function currentMode() {
    const { mode } = await chrome.storage.local.get("mode");
    return normalizeMode(mode ?? DEFAULT_MODE);
  }

  async function setLabel() {
    const title = menuLabel(await currentMode());
    chrome.contextMenus.update(MENU_ID, { title }, swallow);
  }

  // Created once, at install or update. Creating the same id again throws, so startup and mode changes only update.
  // Clicking the toolbar icon opens the side panel (also reaches the restored slot).
  if (chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }, swallow);

  chrome.runtime.onInstalled.addListener(async () => {
    const title = menuLabel(await currentMode());
    chrome.contextMenus.create({ id: MENU_ID, title, contexts: ["link", "video", "page"] }, swallow);
  });
  chrome.runtime.onStartup.addListener(() => { setLabel(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.mode) setLabel();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    // Nothing may be awaited before this call: Chrome only honors the user gesture synchronously.
    const windowId = tab && tab.windowId;
    if (windowId === undefined) return;
    chrome.sidePanel.open({ windowId }, swallow);
    const url = pickUrl(info);
    if (!url) return;
    const slot = { url, requestId: uuid(), windowId, ts: Date.now(), consumed: false };
    chrome.storage.local.set({ [slotKey(windowId)]: slot }).then(() => pruneSlots(chrome.storage.local));
  });
  return { setLabel };
}
