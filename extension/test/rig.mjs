import { Controller } from "../lib/controller.js";
import { slotKey } from "../lib/background-core.js";

// A fake companion plus fake chrome pieces. Timers are manual so polling is deterministic.
// A scripted SpeechRecognition. Tests drive it by hand: rec.fire("audiostart"), rec.result([...]), rec.finish(text).
export function makeSpeech() {
  const recs = [];
  class MockSpeechRecognition {
    constructor() { this.calls = []; this.throwOnStart = null; recs.push(this); }
    start() { this.calls.push("start"); if (this.throwOnStart) throw this.throwOnStart; }
    stop() { this.calls.push("stop"); }
    abort() { this.calls.push("abort"); }
    fire(name, ev = {}) { const h = this["on" + name]; if (h) h(ev); }
    // results: [{ t: "text", final: true|false }, ...], the whole list for this recording, like Chrome's e.results
    result(results) {
      this.fire("result", { resultIndex: 0, results: results.map((r) => Object.assign([{ transcript: r.t }], { isFinal: !!r.final })) });
    }
    finish(results) { if (results) this.result(results); this.fire("end"); }
  }
  return { SR: MockSpeechRecognition, recs, get last() { return recs[recs.length - 1]; } };
}

// A fake navigator.permissions. Like Chrome, query() hands back a NEW PermissionStatus object every time, and every
// object that was handed out follows the permission and gets the change event.
export function makePermissions(state = "granted") {
  let current = state;
  const all = [];
  return {
    query: async () => { const st = { state: current, onchange: null }; all.push(st); return st; },
    all,
    get liveHandlers() { return all.filter((st) => st.onchange).length; },
    set(s) { current = s; for (const st of [...all]) { st.state = s; if (st.onchange) st.onchange(); } },
  };
}

// Two panels can share one fake companion (`server`) and one storage (`shared`); with a `bus` array every storage write is
// delivered to every controller on it (the writer included), the way chrome.storage.onChanged reaches every window.
export function rig({ cfg = { base: "http://c.test", token: "t".repeat(40) }, mode, slot, jobs = {}, shared, health, speech, permissions, server: sharedServer, bus, tab, tabsGrant } = {}) {
  const store = shared || { ...cfg, ...(mode ? { mode } : {}), ...(slot ? { [slotKey(1)]: slot } : {}) };
  const log = { fetches: [], tabs: [], order: [], tabAsks: 0, tabQueries: [] };
  const timers = [];
  const vtimers = [];
  const state = { last: null };
  const holds = []; // pending fetch resolvers for race tests
  const server = sharedServer || { jobs, requests: {}, clearGen: 0, hold: null, fail: null, sources: {}, health: health || { state: "starting" }, conflictOnce: false, seq: 0 };
  const fetchImpl = async (url, init) => {
    const path = url.replace("http://c.test", "");
    const body = init.body ? JSON.parse(init.body) : null;
    log.fetches.push({ method: init.method, path, body, auth: init.headers.Authorization });
    if (server.fail) throw server.fail;
    const respond = (status, json) => ({ status, json: async () => json });
    const go = () => {
      if (path === "/health") return respond(200, server.health);
      if (init.method === "POST" && path === "/jobs") {
        if (server.conflictOnce) { server.conflictOnce = false; return respond(409, { error_code: "request_id_conflict" }); }
        // The companion's rule (dipdive/service.py submit): a generation older than the current one is refused, no job made.
        // Off unless a test turns it on, so the older tests keep exercising the fallback of an answer that carries a new one.
        if (server.staleCheck && typeof body.clearGeneration === "number" && body.clearGeneration < server.clearGen) {
          return respond(409, { error_code: "stale_clear_generation", error_message: "history was cleared since this client last synced", clear_generation: server.clearGen });
        }
        server.requests ||= {};
        const previous = server.requests[body.requestId];
        if (previous) {
          if (previous.url !== body.url || previous.mode !== body.mode) return respond(409, { error_code: "request_id_conflict" });
          return respond(200, { job_id: previous.jobId, clear_generation: server.clearGen });
        }
        const id = `job${++server.seq}`;
        if (server.postStatus) return respond(server.postStatus, { error_code: server.postError || "bad_request", error_message: null });
        server.jobs[id] = { state: "queued", mode: body.mode, url: body.url, polls: 0, question: body.question, history: body.history,
          logged: !server.noLog && /-(dip|dive)$/.test(body.mode), saved: true, ...(server.creator || {}) };
        server.requests[body.requestId] = { url: body.url, mode: body.mode, jobId: id };
        return respond(202, { job_id: id, clear_generation: server.clearGen });
      }
      if (init.method === "POST" && path === "/clear") { server.clearGen++; return respond(200, { clear_generation: server.clearGen }); }
      let m;
      // the "Save this Dip to history" checkbox (dipdive/service.py set_saved): idempotent, per job id
      if (init.method === "POST" && (m = path.match(/^\/history\/([^/]+)\/(remove|restore)$/))) {
        if (server.saveStatus) return respond(server.saveStatus, { error_code: server.saveError || "log_unwritable" });
        if (server.staleCheck && typeof body.clearGeneration === "number" && body.clearGeneration < server.clearGen) {
          return respond(409, { error_code: "stale_clear_generation", clear_generation: server.clearGen });
        }
        const j = server.jobs[decodeURIComponent(m[1])];
        if (!j || !j.logged) return respond(404, { error_code: j ? "not_logged" : "no_such_entry" });
        if (j.saved !== (m[2] === "restore")) server.rev = (server.rev || 0) + 1;
        j.saved = m[2] === "restore";
        if (server.loseSaveResponse) { server.loseSaveResponse--; throw new TypeError("Failed to fetch"); }  // done, answer lost
        if (server.errorAfterSave) { const st = server.errorAfterSave; server.errorAfterSave = 0; return respond(st, { error_code: "log_unwritable" }); }
        return respond(200, { job_id: m[1], saved: j.saved, clear_generation: server.clearGen, history_rev: server.rev || 0 });
      }
      if ((m = path.match(/^\/jobs\/(.+)$/))) {
        const j = server.jobs[m[1]];
        if (!j) return respond(404, { error_code: "no_such_job", clear_generation: server.clearGen });
        j.polls++;
        const done = j.polls >= 2;
        return respond(200, { job_id: m[1], state: done ? (j.fail ? "error" : "done") : "summarizing", title: "A Title", url: j.url, mode: j.mode,
          result_markdown: done && !j.fail ? (j.mode.endsWith("-ask") ? `Answer to: ${j.question} [${(j.history || []).length} earlier]` : `Summary for ${j.mode}`) : null, error_code: done && j.fail ? j.fail : null, error_message: null, clear_generation: server.clearGen,
          history_saved: done && !j.fail && j.logged ? j.saved : null, history_rev: server.rev || 0,
          ...(j.channel ? { channel: j.channel } : {}), ...(j.channel_url ? { channel_url: j.channel_url } : {}) });
      }
      if ((m = path.match(/^\/source\?job=(.+)$/))) return respond(200, { title: "A Title", url: "https://v.test/x", text: server.sourceText || "source body", clear_generation: server.clearGen });
      return respond(404, {});
    };
    // freeze: the answer is made now (with the state of this moment) but delivered only when the test releases it
    if (server.freeze && server.freeze(path, body)) {
      const res = go();
      return new Promise((resolve) => holds.push(() => resolve(res)));
    }
    if (server.hold && server.hold(path, body)) {
      return new Promise((res) => holds.push(() => res(go())));
    }
    return go();
  };
  const c = new Controller({
    storage: { get: async (keys) => keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
               set: async (o) => {
                 const ch = {}; for (const [k, v] of Object.entries(o)) ch[k] = { oldValue: store[k], newValue: v };
                 Object.assign(store, o);
                 for (const x of bus || []) x.onStorageChange(ch, "local");
               },
               remove: async (keys) => {
                 const ch = {};
                 for (const k of (Array.isArray(keys) ? keys : [keys])) { if (k in store) ch[k] = { oldValue: store[k] }; delete store[k]; }
                 for (const x of bus || []) x.onStorageChange(ch, "local");
               } },
    fetch: fetchImpl,
    // The pin button's two calls. `tabsGrant` false: the person refuses the permission prompt (it is asked on every click until
    // granted, like Chrome); `tab`: the active tab ({ url } like chrome.tabs.query's first result), null for no tab. A tab's url
    // is only visible once the permission is held, as in Chrome.
    tabs: {
      requestAccess: async () => { log.order.push("ask"); log.tabAsks++; if (tabsGrant === false) return false; if (typeof tabsGrant === "function") return tabsGrant(); return true; },
      activeTab: async (w) => { log.order.push("query"); log.tabQueries.push(w); return tab === undefined ? { id: 1, url: "https://v.test/page" } : tab; },
    },
    openTab: (u) => { log.order.push("tab"); log.tabs.push(u); },
    uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(),
    setTimer: (f) => { timers.push(f); return timers.length; },
    clearTimer: () => {},
    onState: (s) => { state.last = s; },
    speech: speech ? speech.SR : null,
    permissions: permissions || null,
    micSetupUrl: "chrome-extension://test/mic.html",
    setVoiceTimer: (f, ms) => { vtimers.push({ f, ms }); return vtimers.length; },
    clearVoiceTimer: (id) => { if (vtimers[id - 1]) vtimers[id - 1].cleared = true; },
  });
  if (bus) bus.push(c);
  const tick = async () => { const f = timers.shift(); if (f) await f(); };
  return { c, store, log, server, state, tick, timers, holds, vtimers, speech, permissions };
}
export const slot = (extra = {}) => ({ url: "https://v.test/watch", requestId: "slot-req-1", windowId: 1, ts: 1, consumed: false, ...extra });
