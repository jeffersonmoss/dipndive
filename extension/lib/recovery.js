// A repair launch has no companion configuration/token and accepts no arbitrary command.
export const RECOVERY_HOST = "com.jeffersonmoss.dipdive_recovery";
export const isMac = (platform) => /mac/i.test(platform || "");
export function repairAvailable(s, platform) {
  return isMac(platform) && !!(s?.source?.url && s.error && !s.result && !s.busy);
}
export function recoveryContext(s, version, token = "") {
  const scrub = (value, max) => {
    let text = String(value || "").slice(0, max);
    if (token) text = text.split(token).join("[redacted]");
    return text.replace(/bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]");
  };
  let url = "";
  try {
    const parsed = new URL(s?.source?.url || "");
    if (["http:", "https:"].includes(parsed.protocol)) {
      parsed.username = parsed.password = parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|key|auth|pass|secret|session|signature/i.test(key)) parsed.searchParams.delete(key);
      }
      url = scrub(parsed.href, 4096);
    }
  } catch { /* invalid source URL is not repair context */ }
  return { url, error: scrub(s?.error, 2000), mode: scrub(s?.mode, 64),
    jobId: scrub(s?.jobId, 128), version: scrub(version, 32) };
}
export async function launchRecovery(chrome, action, provider, context) {
  // Must be the first awaited call in the button's own gesture.
  const allowed = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
  if (!allowed) return { ok: false, message: "Recovery needs permission to open the installed Mac helper. Click again and choose Allow." };
  try {
    return await chrome.runtime.sendNativeMessage(RECOVERY_HOST, { action, ...(provider ? { provider } : {}), context });
  } catch {
    return { ok: false, message: "The Mac recovery helper is unavailable. Install recovery-helper/install_mac.py on this Mac, then try again." };
  }
}
