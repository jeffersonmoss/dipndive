// Clear history, shared by the Options page and the panel controller. The companion forgets every job, cached source and
// result (POST /clear; the durable history log file is deliberately left alone), and this browser forgets which pages
// were looked at (every per-window slot key). The new clear generation is written to storage as `clearGen`, which is how
// every open side panel learns that its summary and question thread belong to history that is gone.
import { request } from "./api.js";

// Returns { ok, status, clearGeneration, localError }. `ok` is only about the companion (it answered 200); `localError` is
// the message of a failure while this browser's own storage was being cleaned up AFTER that, or null. The companion's
// history is gone either way, so a storage failure must not be reported as "not cleared". Each storage step is tried even
// if the one before failed, because the new generation (`clearGen`) is how the other open panels learn of the clear.
// Throws ApiError when the companion cannot be reached or is not configured.
// `onGeneration(n)` runs before anything is written to storage, so a panel that cleared can adopt the new generation
// before its own storage listener hears it (and does not take its own clear for one made elsewhere).
export async function clearCompanion({ fetch, cfg, storage, onGeneration }) {
  const r = await request(fetch, cfg, "POST", "/clear", {}, 10000);
  const cg = r.json && typeof r.json.clear_generation === "number" ? r.json.clear_generation : null;
  if (cg !== null && onGeneration) onGeneration(cg);
  let localError = null;
  if (r.status === 200) {
    const note = (e) => { if (localError === null) localError = String((e && e.message) || e || "unknown error"); };
    try {
      const all = await storage.get(null);
      await storage.remove(Object.keys(all).filter((k) => k.startsWith("slot:")));
    } catch (e) { note(e); }
    try {
      if (cg !== null) await storage.set({ clearGen: cg });
    } catch (e) { note(e); }
  }
  return { ok: r.status === 200, status: r.status, clearGeneration: cg, localError };
}
