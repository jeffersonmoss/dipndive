import { request } from "./lib/api.js";

const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };

const st = await chrome.storage.local.get(["base", "token"]);
$("base").value = st.base || "";
$("token").value = st.token || "";

$("save").addEventListener("click", async () => {
  let base = $("base").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  let u;
  try { u = new URL(base); } catch { say("That is not a valid URL."); return; }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) { say("Use an https:// address (or http://127.0.0.1 for testing)."); return; }
  if (token.length < 32) { say("The token looks too short."); return; }
  if (local) {
    // optional_host_permissions: asked for here, inside the click, so the user gesture is valid.
    const ok = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    if (!ok) { say("Permission to reach that address was declined."); return; }
  }
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
