// Clear history, shared by the Options page and the panel controller. The companion forgets every job, cached source and
// result (POST /clear; the durable history log file is deliberately left alone), and this browser forgets which pages
// were looked at (every per-window slot key). The new clear generation is written to storage as `clearGen`, which is how
// every open side panel learns that its summary and question thread belong to history that is gone.
import { request } from "./api.js";

// Returns { ok, status, clearGeneration }. Throws ApiError when the companion cannot be reached or is not configured.
// `onGeneration(n)` runs before anything is written to storage, so a panel that cleared can adopt the new generation
// before its own storage listener hears it (and does not take its own clear for one made elsewhere).
export async function clearCompanion({ fetch, cfg, storage, onGeneration }) {
  const r = await request(fetch, cfg, "POST", "/clear", {}, 5000);
  const cg = r.json && typeof r.json.clear_generation === "number" ? r.json.clear_generation : null;
  if (cg !== null && onGeneration) onGeneration(cg);
  if (r.status === 200) {
    const all = await storage.get(null);
    await storage.remove(Object.keys(all).filter((k) => k.startsWith("slot:")));
    if (cg !== null) await storage.set({ clearGen: cg });
  }
  return { ok: r.status === 200, status: r.status, clearGeneration: cg };
}
