import { ApiError, request } from "./lib/api.js";
import { clearCompanion } from "./lib/clear.js";
import { installShim } from "./lib/shim.js";

installShim();  // inert inside the extension; lets the page run as a plain page against the dev harness
const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };

const st = await chrome.storage.local.get(["base", "token"]);
$("base").value = st.base || "";
$("token").value = st.token || "";
const computer = await chrome.storage.local.get("computerName");
$("computer").value = ["thing-1", "thing-2", "imac", "win"].includes(computer.computerName) ? computer.computerName : "";
$("computer").addEventListener("change", () => chrome.storage.local.set({ computerName: $("computer").value }));

$("save").addEventListener("click", async () => {
  let base = $("base").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  let u;
  try { u = new URL(base); } catch { say("That is not a valid URL."); return; }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  const tailnet = u.protocol === "https:" && u.hostname.toLowerCase().endsWith(".ts.net");
  if (!local && !tailnet) { say("Use the iMac's https://<name>.<tailnet>.ts.net address (or http://127.0.0.1 for testing)."); return; }
  if (token.length < 32) { say("The token looks too short."); return; }
  // Host access is optional: ask for exactly this origin, inside the click so the user gesture is valid.
  const ok = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  if (!ok) { say("Permission to reach that address was declined."); return; }
  await chrome.storage.local.set({ base, token });
  say("Saved. Testing...");
  try {
    const r = await request((...a) => fetch(...a), { base, token }, "GET", "/health", null, 5000);
    if (r.status === 401) say("Saved, but the companion rejected the token.");
    else if (r.status === 200) say("Saved. The companion answered.");
    else say(`Saved, but the companion returned HTTP ${r.status}.`);
  } catch (e) {
    say(`Saved, but: ${e.message}`);
  }
});

// ---------- Clear history, with a confirmation step ----------
const storage = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o), remove: (k) => chrome.storage.local.remove(k) };
const clearSay = (t, cls = "") => { $("clearmsg").textContent = t; $("clearmsg").className = `msg ${cls}`.trim(); };
const showConfirm = (on) => {
  $("clearconfirm").hidden = !on;
  $("clear").hidden = on;
  if (on) $("clearno").focus(); else $("clear").focus();
};
$("clear").addEventListener("click", () => { clearSay(""); showConfirm(true); });
$("clearno").addEventListener("click", () => showConfirm(false));
// Escape cancels while the question is open, wherever the focus is
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("clearconfirm").hidden && !$("clearyes").disabled) showConfirm(false); });
$("clearyes").addEventListener("click", async () => {
  $("clearyes").disabled = $("clearno").disabled = true;
  clearSay("Clearing...");
  try {
    const st = await chrome.storage.local.get(["base", "token"]);
    const res = await clearCompanion({ fetch: (...a) => fetch(...a), cfg: { base: st.base, token: st.token }, storage });
    if (res.ok && res.localError) clearSay(`History cleared. Could not reset this browser's panel state: ${res.localError}. Open side panels may still show old summaries until they are closed and reopened.`, "bad");
    else if (res.ok) clearSay("History cleared. Open side panels have started fresh; the history log file is kept.", "ok");
    else if (res.status === 401) clearSay("Not cleared: the companion did not accept the token.", "bad");
    else clearSay(`Not cleared: the companion returned HTTP ${res.status}.`, "bad");
  } catch (e) {
    clearSay(e instanceof ApiError && e.kind === "config" ? "Not cleared: set the companion URL and token first." : "Not cleared: cannot reach the companion. Is the iMac on and connected to Tailscale?", "bad");
  } finally {
    $("clearyes").disabled = $("clearno").disabled = false;
    showConfirm(false);  // closes the question and gives the focus back to Clear history
  }
});
