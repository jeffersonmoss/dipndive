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

// A fake navigator.permissions: query() always hands back the same PermissionStatus object.
export function makePermissions(state = "granted") {
  const status = { state, onchange: null };
  return { query: async () => status, status, set(s) { status.state = s; if (status.onchange) status.onchange(); } };
}

export function rig({ cfg = { base: "http://c.test", token: "t".repeat(40) }, mode, slot, jobs = {}, shared, health, speech, permissions } = {}) {
  const store = shared || { ...cfg, ...(mode ? { mode } : {}), ...(slot ? { [slotKey(1)]: slot } : {}) };
  const log = { fetches: [], tabs: [], clip: [], order: [] };
  const timers = [];
  const vtimers = [];
  const state = { last: null };
  const holds = []; // pending fetch resolvers for race tests
  let jobSeq = 0;
  const server = { jobs, clearGen: 0, hold: null, fail: null, sources: {}, health: health || { state: "starting" }, conflictOnce: false };
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
        const id = `job${++jobSeq}`;
        if (server.postStatus) return respond(server.postStatus, { error_code: server.postError || "bad_request", error_message: null });
        server.jobs[id] = { state: "queued", mode: body.mode, url: body.url, polls: 0, question: body.question, history: body.history };
        return respond(202, { job_id: id, clear_generation: server.clearGen });
      }
      if (init.method === "POST" && path === "/clear") { server.clearGen++; return respond(200, { clear_generation: server.clearGen }); }
      let m;
      if ((m = path.match(/^\/jobs\/(.+)$/))) {
        const j = server.jobs[m[1]];
        if (!j) return respond(404, { error_code: "no_such_job" });
        j.polls++;
        const done = j.polls >= 2;
        return respond(200, { job_id: m[1], state: done ? (j.fail ? "error" : "done") : "summarizing", title: "A Title", url: j.url, mode: j.mode,
          result_markdown: done && !j.fail ? (j.mode.endsWith("-ask") ? `Answer to: ${j.question} [${(j.history || []).length} earlier]` : `Summary for ${j.mode}`) : null, error_code: done && j.fail ? j.fail : null, error_message: null, clear_generation: server.clearGen });
      }
      if ((m = path.match(/^\/source\?job=(.+)$/))) return respond(200, { title: "A Title", url: "https://v.test/x", text: server.sourceText || "source body", clear_generation: server.clearGen });
      return respond(404, {});
    };
    if (server.hold && server.hold(path, body)) {
      return new Promise((res) => holds.push(() => res(go())));
    }
    return go();
  };
  const c = new Controller({
    storage: { get: async (keys) => keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
               set: async (o) => { Object.assign(store, o); },
               remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; } },
    fetch: fetchImpl,
    clipboard: { writeText: async (t) => { if (server.clipFail) throw new Error("denied"); log.order.push("clip"); log.clip.push(t); } },
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
  const tick = async () => { const f = timers.shift(); if (f) await f(); };
  return { c, store, log, server, state, tick, timers, holds, vtimers, speech, permissions };
}
export const slot = (extra = {}) => ({ url: "https://v.test/watch", requestId: "slot-req-1", windowId: 1, ts: 1, consumed: false, ...extra });

