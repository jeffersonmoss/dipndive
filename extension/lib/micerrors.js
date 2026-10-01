// What a failed microphone request means and what to tell the person. Pure, so both the Enable microphone page
// (mic.js) and the tests use it.

// Chrome shows three choices for the microphone. The one that keeps the answer is "Allow while visiting the site";
// "Allow this time" forgets it as soon as the tab closes, which would send the person round the loop again.
export const ALLOW_BUTTON = "Allow while visiting the site";

// The computer itself, not Chrome, is refusing: macOS Privacy and Security, or the Windows privacy switches.
export const SYSTEM_BLOCK_HELP =
  "Your computer is blocking the microphone for Chrome. On a Mac: System Settings, Privacy and Security, Microphone, " +
  "turn on Google Chrome, then quit and reopen Chrome. On Windows: Settings, Privacy and security, Microphone, " +
  "turn on Microphone access and Let desktop apps access your microphone.";

export const BUSY_HELP =
  "Chrome could not start the microphone. Another app may be using it, or it may have been unplugged. " +
  "Close other apps that use the microphone, or unplug it and plug it in again, then try again.";

// name and message come from the getUserMedia rejection, state from permissions.query ("granted", "prompt", "denied", or null).
// Returns "no-device" | "chrome-blocked" | "system-blocked" | "busy" | "dismissed".
export function classifyMicError(name, message, state) {
  const msg = String(message || "");
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  if (state === "denied") return "chrome-blocked";
  // Chrome reports a macOS or Windows privacy block as NotAllowedError "Permission denied by system" while Chrome's own
  // permission for the page stays granted.
  if (name === "NotAllowedError" && (state === "granted" || /by system/i.test(msg))) return "system-blocked";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  return "dismissed";
}
