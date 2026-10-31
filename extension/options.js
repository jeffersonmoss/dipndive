import { ApiError, request } from "./lib/api.js";
import { installShim } from "./lib/shim.js";
import { HANDOFF_SITES, validateHandoffUrl } from "./lib/handoff-sites.js";

installShim();  // inert inside the extension; lets the page run as a plain page against the dev harness
const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };

const st = await chrome.storage.local.get(["base", "token", HANDOFF_SITES.claude.urlKey, HANDOFF_SITES.chatgpt.urlKey]);
$("base").value = st.base || "";
$("token").value = st.token || "";
$("handoffClaude").value = st[HANDOFF_SITES.claude.urlKey] || HANDOFF_SITES.claude.defaultUrl;
$("handoffChatgpt").value = st[HANDOFF_SITES.chatgpt.urlKey] || HANDOFF_SITES.chatgpt.defaultUrl;
const watchedSetting = await chrome.storage.local.get("recordWatchedVideos");
$("recordWatched").checked = watchedSetting.recordWatchedVideos !== false;
// The recorder only runs with the optional "tabs" permission, which the background never requests itself; ask for it
// here, inside a click, and say so while it is missing so recording is never silently idle.
const tabsGranted = async () => { try { return !!(await chrome.permissions.contains({ permissions: ["tabs"] })); } catch { return false; } };
const showWatchedAccess = async () => { $("watchedAccess").hidden = !$("recordWatched").checked || await tabsGranted(); };
const askTabs = async () => { try { await chrome.permissions.request({ permissions: ["tabs"] }); } catch {} await showWatchedAccess(); };
$("recordWatched").addEventListener("change", async () => {
  await chrome.storage.local.set({ recordWatchedVideos: $("recordWatched").checked });
  if ($("recordWatched").checked && !(await tabsGranted())) await askTabs(); else await showWatchedAccess();
});
$("watchedAllow").addEventListener("click", askTabs);
await showWatchedAccess();

$("save").addEventListener("click", async () => {
  const claudeUrl = validateHandoffUrl($("handoffClaude").value, "claude");
  if (!claudeUrl.ok) { say(`Claude project URL: ${claudeUrl.error}`); return; }
  const chatgptUrl = validateHandoffUrl($("handoffChatgpt").value, "chatgpt");
  if (!chatgptUrl.ok) { say(`ChatGPT project URL: ${chatgptUrl.error}`); return; }
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
  await chrome.storage.local.set({ base, token, [HANDOFF_SITES.claude.urlKey]: claudeUrl.value, [HANDOFF_SITES.chatgpt.urlKey]: chatgptUrl.value });
  say("Saved. Testing...");
  try {
    const r = await request((...a) => fetch(...a), { base, token }, "GET", "/health", null, 10000);
    if (r.status === 401) say("Saved, but the companion rejected the token.");
    else if (r.status === 200) say("Saved. The companion answered.");
    else say(`Saved, but the companion returned HTTP ${r.status}.`);
  } catch (e) {
    say(`Saved, but: ${e.message}`);
  }
});
