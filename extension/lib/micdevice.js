// Which microphone Chrome's dictation is using, and a warning when it is not the one he marked as his.
// Chrome's speech recognition listens to the computer's default input; enumerateDevices names it (the "default" entry)
// once the microphone is allowed for this extension. The marked microphone is kept in chrome.storage.local, which stays
// on this computer, so marking the USB microphone on one machine changes nothing on the others.

export const MIC_DEVICE = Object.freeze({ preferredKey: "preferredMic" });

const SPECIAL = new Set(["default", "communications"]);

// "Default - Microphone (2- USB Audio Device)" -> "Microphone (2- USB Audio Device)"
export function displayName(label) {
  return String(label || "").replace(/^(Default|Communications)\s+-\s+/i, "").trim();
}

// For comparing: case, spacing and Windows' "2- " re-plug number do not count.
export function sameMic(a, b) {
  const norm = (s) => displayName(s).toLowerCase().replace(/\(\d+-\s*/g, "(").replace(/\s+/g, " ").trim();
  return !!a && !!b && norm(a) === norm(b);
}

// { name, none } for the input dictation uses; name is "" when Chrome hides names (microphone not allowed yet).
// null when this browser cannot list devices.
export async function currentMic(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") return null;
  let list;
  try { list = (await mediaDevices.enumerateDevices()).filter((d) => d && d.kind === "audioinput"); } catch { return null; }
  if (!list.length) return { name: "", none: true };
  const def = list.find((d) => d.deviceId === "default") || list.find((d) => !SPECIAL.has(d.deviceId)) || list[0];
  return { name: displayName(def.label), none: false };
}

// The warning line under the question box, "" when there is nothing to say.
export function micWarning(current, preferred) {
  if (!preferred || !current) return "";
  if (current.none) return `No microphone found. ${preferred} may have dropped out: unplug it and plug it back in.`;
  if (!current.name || sameMic(current.name, preferred)) return "";
  return `Dictation is using ${current.name}, not ${preferred}. Unplug ${preferred} and plug it back in.`;
}

// What the right-click popup on the mic button shows.
export function micInfo(current, preferred) {
  const out = { line: "", mine: false, canMark: false, canForget: !!preferred, preferred: preferred || "" };
  if (!current) out.line = "Chrome cannot list microphones here.";
  else if (current.none) out.line = "No microphone found.";
  else if (!current.name) out.line = "Chrome shows the microphone's name once the microphone is allowed. Click the mic once, then right-click it again.";
  else {
    out.line = current.name;
    out.mine = sameMic(current.name, preferred);
    out.canMark = !out.mine;
  }
  return out;
}
