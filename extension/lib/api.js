// Companion HTTP client. Every request has an AbortController deadline (5 s by default).
export class ApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // "timeout" | "network" | "config"
    this.status = status;
  }
}

export async function request(fetchImpl, cfg, method, path, body, timeoutMs = 5000) {
  if (!cfg || !cfg.base || !cfg.token) throw new ApiError("config", "Companion URL and token are not set.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(cfg.base.replace(/\/+$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: "no-store",
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json: json || {} };
  } catch (e) {
    if (e && e.name === "AbortError") throw new ApiError("timeout", "The companion did not answer within 5 seconds.");
    throw new ApiError("network", "Cannot reach the companion.");
  } finally {
    clearTimeout(timer);
  }
}
