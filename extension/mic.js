// One-time microphone permission for the side panel. Side panels cannot show Chrome's permission prompt, so this
// normal tab asks (getUserMedia), then stops the tracks at once and tells the user to go back to the panel.
const $ = (id) => document.getElementById(id);
const say = (text, cls = "") => { $("msg").textContent = text; $("msg").className = cls; };

async function permissionState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch { return null; }
}

async function ask() {
  $("retry").hidden = $("settings").hidden = $("close").hidden = true;
  say("Chrome should now ask to use your microphone. Click Allow (not \"Allow this time\").");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());  // switch the microphone straight back off
    say("Microphone enabled. Close this tab and go back to the Dip'n'Dive panel, then click the mic.", "ok");
    $("close").hidden = false;
    try { chrome.runtime.sendMessage({ type: "dipdive-mic-granted" }).catch(() => {}); } catch { /* the panel also notices by itself */ }
    return;
  } catch (e) {
    const state = await permissionState();
    if (e && e.name === "NotFoundError") {
      say("No microphone was found. Connect one, then try again.", "bad");
    } else if (state === "denied") {
      say("Chrome has blocked the microphone for Dip'n'Dive. Open the setting below and change Microphone to Allow, then try again.", "bad");
      $("settings").hidden = false;
    } else {
      say("The prompt was closed without an answer. Click Try again, then click Allow.", "bad");
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
