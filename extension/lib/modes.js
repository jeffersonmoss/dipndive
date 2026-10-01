// Five panel buttons in display order. "temp" is the Temp chat button (source-only job, no model call).
export const MODES = [
  { id: "claude-dip", label: "Claude Dip", top: "Claude", bottom: "Dip" },
  { id: "claude-dive", label: "Claude Dive", top: "Claude", bottom: "Dive" },
  { id: "temp", label: "Temp chat", top: "Temp", bottom: "chat" },
  { id: "codex-dip", label: "Codex Dip", top: "Codex", bottom: "Dip" },
  { id: "codex-dive", label: "Codex Dive", top: "Codex", bottom: "Dive" },
];
export const DEFAULT_MODE = "codex-dip";
export const MODE_IDS = MODES.map((m) => m.id);

export function normalizeMode(id) {
  return MODE_IDS.includes(id) ? id : DEFAULT_MODE;
}

export function modeLabel(id) {
  return MODES.find((m) => m.id === normalizeMode(id)).label;
}

// The word "and", not "&": a single "&" becomes a keyboard-mnemonic marker in Windows menus.
export function menuLabel(id) {
  return "Dip'n'Dive";
}

// What the companion's POST /jobs expects.
export function apiMode(id) {
  return id === "temp" ? "source" : id;
}

// Plan 3.5.3: the Dip instruction plus a wait-for-follow-ups line.
export const TEMP_PREFIX =
  "You are summarizing a source for someone who was curious about its title but does not want to watch or " +
  "read it. The source is below. Answer the question the title raises, directly, in at most four sentences. " +
  "Lead with the answer. No preamble, no 'this video discusses'. Always answer in English. " +
  "Then wait for my follow-up questions, answering them from the source.";

export const TEMP_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const TEMP_WARN_CHARS = 100000;
