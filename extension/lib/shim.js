// Development shim: lets panel.html run as a plain web page (no chrome.* APIs) against a local companion.
// Settings come from the query string (?base=...&token=...&url=...&win=1) and storage is localStorage.
// Never active inside the real extension, where chrome.storage exists.
export function installShim() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return false;
  const q = new URLSearchParams(location.search);
  const PREFIX = "dipdive-dev:";
  const read = (k) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)); } catch { return undefined; } };
  const listeners = [];
  const local = {
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(PREFIX + k);
    },
    async get(keys) {
      if (keys === null) {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = read(k.slice(PREFIX.length));
        }
        return out;
      }
      const arr = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
      const out = {};
      for (const k of arr) { const v = read(k); if (v !== null && v !== undefined) out[k] = v; }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: read(k), newValue: v };
        localStorage.setItem(PREFIX + k, JSON.stringify(v));
      }
      listeners.forEach((l) => l(changes, "local"));
    },
  };
  window.chrome = {
    storage: { local, onChanged: { addListener: (l) => listeners.push(l) } },
    windows: { getCurrent: async () => ({ id: Number(q.get("win") || 1) }) },
    tabs: { create: ({ url }) => { window.__lastTab = url; } },
    __dev: true,
  };
  if (q.get("base")) localStorage.setItem(PREFIX + "base", JSON.stringify(q.get("base")));
  if (q.get("token")) localStorage.setItem(PREFIX + "token", JSON.stringify(q.get("token")));
  if (q.get("health")) window.__devHealth = q.get("health");
  if (q.get("mode")) localStorage.setItem(PREFIX + "mode", JSON.stringify(q.get("mode")));
  if (q.get("url")) {
    const w = Number(q.get("win") || 1);
    localStorage.setItem(PREFIX + `slot:${w}`, JSON.stringify({
      url: q.get("url"), requestId: q.get("rid") || crypto.randomUUID(), windowId: w, ts: Date.now(), consumed: false }));
  }
  return true;
}
