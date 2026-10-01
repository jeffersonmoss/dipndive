// One-time microphone permission for the side panel. Side panels cannot show Chrome's permission prompt, so this
// normal tab asks (getUserMedia), then stops the tracks at once and tells the user to go back to the panel.
import { ALLOW_BUTTON, BUSY_HELP, SYSTEM_BLOCK_HELP, classifyMicError } from "./lib/micerrors.js";

const $ = (id) => document.getElementById(id);
const say = (text, cls = "") => { $("msg").textContent = text; $("msg").className = cls; };

async function permissionState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch { return null; }
}

async function ask() {
  $("retry").hidden = $("settings").hidden = $("close").hidden = true;
  say(`Chrome should now ask to use your microphone. Click "${ALLOW_BUTTON}" (not "Allow this time").`);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());  // switch the microphone straight back off
    say("Microphone enabled. Close this tab and go back to the Dip'n'Dive panel, then click the mic.", "ok");
    $("close").hidden = false;
    try { chrome.runtime.sendMessage({ type: "dipdive-mic-granted" }).catch(() => {}); } catch { /* the panel also notices by itself */ }
    return;
  } catch (e) {
    const kind = classifyMicError(e && e.name, e && e.message, await permissionState());
    if (kind === "no-device") {
      say("No microphone was found. Connect one, then try again.", "bad");
    } else if (kind === "chrome-blocked") {
      say("Chrome has blocked the microphone for Dip'n'Dive. Open the setting below and change Microphone to Allow, then try again.", "bad");
      $("settings").hidden = false;
    } else if (kind === "system-blocked") {
      say(`${SYSTEM_BLOCK_HELP} Then click Try again.`, "bad");
    } else if (kind === "busy") {
      say(BUSY_HELP, "bad");
    } else {
      say(`The prompt was closed without an answer. Click Try again, then click "${ALLOW_BUTTON}".`, "bad");
    }
    $("retry").hidden = false;
  }
}

$("retry").addEventListener("click", ask);
$("settings").addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}` });
});
$("close").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id); else window.close();
});
ask();
