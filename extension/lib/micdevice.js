// Which microphone dictation uses, and switching it. Chrome's speech recognition listens to the computer's default
// input unless it is handed an audio track (SpeechRecognition.start(track)); picking a microphone in the mic button's
// right-click popup stores its name in chrome.storage.local, which stays on this computer, and each recording then
// opens that microphone. "System default" stores nothing. A chosen microphone that is not connected shows a warning
// and dictation falls back to the default input.

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

// { inputs: [{ id, label }], defaultName, none, named } or null when this browser cannot list devices. Names are ""
// until the microphone is allowed for this extension (named false).
export async function listMics(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") return null;
  let all;
  try { all = (await mediaDevices.enumerateDevices()).filter((d) => d && d.kind === "audioinput"); } catch { return null; }
  if (!all.length) return { inputs: [], defaultName: "", none: true, named: false };
  const real = all.filter((d) => !SPECIAL.has(d.deviceId));
  const def = all.find((d) => d.deviceId === "default") || real[0] || all[0];
  const inputs = (real.length ? real : all).map((d) => ({ id: d.deviceId, label: displayName(d.label) }));
  return { inputs, defaultName: displayName(def.label), none: false, named: inputs.some((d) => d.label) };
}

// The input dictation uses: { use: {id,label} | null (the default input), missing: the chosen one is not connected }.
export function resolveMic(list, preferred) {
  if (!preferred || !list || !list.named) return { use: null, missing: false };
  const hit = list.inputs.find((d) => sameMic(d.label, preferred));
  return hit ? { use: hit, missing: false } : { use: null, missing: true };
}

// The warning line under the question box, "" when there is nothing to say.
export function micWarning(list, preferred) {
  if (!preferred || !list) return "";
  if (list.none) return `No microphone found. ${preferred} may have dropped out: unplug it and plug it back in.`;
  if (!resolveMic(list, preferred).missing) return "";
  const fallback = list.defaultName ? ` Dictation is using ${list.defaultName} instead.` : "";
  return `${preferred} is not connected.${fallback} Unplug it and plug it back in.`;
}

// What the right-click popup shows: a line when there is nothing to pick, otherwise one row per choice.
export function micInfo(list, preferred) {
  if (!list) return { line: "Chrome cannot list microphones here.", rows: [] };
  if (list.none) return { line: "No microphone found.", rows: [] };
  if (!list.named) return { line: "Chrome shows the microphones' names once the microphone is allowed. Click the mic once, then right-click it again.", rows: [] };
  const { use, missing } = resolveMic(list, preferred);
  const rows = [{ id: "", label: `System default${list.defaultName ? ` (${list.defaultName})` : ""}`, chosen: !preferred }];
  for (const d of list.inputs) rows.push({ id: d.id, label: d.label || "Unnamed microphone", chosen: !!use && use.id === d.id });
  if (missing) rows.push({ id: "", label: `${preferred} (not connected)`, chosen: true, missing: true, value: preferred });
  return { line: "", rows };
}
