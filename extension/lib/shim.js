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
    // The pin button's two calls. ?tab=<address> is the "active tab" (window.__devTab can change it later; an empty one means
    // no tab), ?perm=denied answers the tabs permission request with false. window.__permAsks counts the requests.
    tabs: { create: ({ url }) => { window.__lastTab = url; }, query: async () => (window.__devTab ? [{ id: 1, url: window.__devTab }] : []) },
    permissions: { request: async () => { window.__permAsks = (window.__permAsks || 0) + 1; return q.get("perm") !== "denied"; } },
    __dev: true,
  };
  if (q.get("base")) localStorage.setItem(PREFIX + "base", JSON.stringify(q.get("base")));
  if (q.get("token")) localStorage.setItem(PREFIX + "token", JSON.stringify(q.get("token")));
  window.__devTab = q.get("tab") || "";
  if (q.get("health")) window.__devHealth = q.get("health");
  if (q.get("mode")) localStorage.setItem(PREFIX + "mode", JSON.stringify(q.get("mode")));
  // ?mic=granted|prompt|denied|none and optional &say=words: a scripted SpeechRecognition and a fake permission state,
  // so the microphone flow can be tried in a plain browser tab. window.__devMicGrant() simulates Allow in the setup tab.
  if (q.get("mic")) {
    const kind = q.get("mic");
    const words = (q.get("say") || "Okay, what is the deal with the chocolate?").split(" ");
    const perm = { state: kind === "none" ? "granted" : kind, onchange: null };
    window.__devMicGrant = () => { perm.state = "granted"; if (perm.onchange) perm.onchange(); };
    class MockSR {
      constructor() { this.shown = 0; }
      start() { setTimeout(() => { if (this.onstart) this.onstart(); if (this.onaudiostart) this.onaudiostart(); this.talk(); }, 80); }
      talk() { this.iv = setInterval(() => { this.shown = Math.min(this.shown + 1, words.length); this.emit(false); if (this.shown === words.length) clearInterval(this.iv); }, 450); }
      emit(final) { if (this.onresult) this.onresult({ results: [Object.assign([{ transcript: words.slice(0, this.shown).join(" ") }], { isFinal: final })] }); }
      stop() { clearInterval(this.iv); setTimeout(() => { if (this.shown) this.emit(true); if (this.onend) this.onend(); }, 100); }
      abort() { clearInterval(this.iv); if (this.onend) this.onend(); }
    }
    window.__devSpeech = kind === "none" ? { SpeechRecognition: null, permissions: null }
      : { SpeechRecognition: MockSR, permissions: { query: async () => perm } };
  }
  if (q.get("url")) {
    const w = Number(q.get("win") || 1);
    localStorage.setItem(PREFIX + `slot:${w}`, JSON.stringify({
      url: q.get("url"), requestId: q.get("rid") || crypto.randomUUID(), windowId: w, ts: Date.now(), consumed: false }));
  }
  return true;
}
