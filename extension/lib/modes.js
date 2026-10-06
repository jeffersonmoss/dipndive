// The two mode buttons in display order, left to right: Claude, then Codex. The panel puts the "Summarize this page" pin
// button, which is an action and not a mode, in the center slot between them. Every summary is a Dip; "diving" happens in
// the question box. The companion still accepts the dive modes, but the panel never sends them. The panel builds its
// buttons in this order, so the Tab order is the same.
export const MODES = [
  { id: "claude-dip", label: "Claude Dip", logo: "claude-dive" },
  { id: "codex-dip", label: "Codex Dip", logo: "codex-dive" },
];
export const DEFAULT_MODE = "codex-dip";
export const MODE_IDS = MODES.map((m) => m.id);

// Modes an older install may have stored, and the Dip each one becomes.
const RETIRED_DIVES = { "claude-dive": "claude-dip", "codex-dive": "codex-dip" };

// The current mode id for a stored value, or null when it is neither a current mode nor a retired dive.
export function migrateMode(id) {
  if (MODE_IDS.includes(id)) return id;
  return Object.prototype.hasOwnProperty.call(RETIRED_DIVES, id) ? RETIRED_DIVES[id] : null;
}

export function normalizeMode(id) {
  return migrateMode(id) || DEFAULT_MODE;
}

export function modeLabel(id) {
  return MODES.find((m) => m.id === normalizeMode(id)).label;
}

export function saveHistoryLabel(resultMode) {
  return typeof resultMode === "string" && resultMode.endsWith("-dive")
    ? "Save this summary to history"
    : "Save this Dip to history";
}

// The word "and", not "&": a single "&" becomes a keyboard-mnemonic marker in Windows menus.
export function menuLabel(id) {
  return "Dip'n'Dive";
}
