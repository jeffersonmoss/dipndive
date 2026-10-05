// The four mode buttons in display order, left to right (Dive and Dip of Claude, then Dip and Dive of Codex): the water
// gets deeper toward both edges. The panel puts the "Summarize this page" pin button, which is an action and not a mode,
// in the center slot between the two pairs. The panel builds its buttons in this order, so the Tab order is the same.
export const MODES = [
  { id: "claude-dive", label: "Claude Dive", top: "Claude", bottom: "Dive" },
  { id: "claude-dip", label: "Claude Dip", top: "Claude", bottom: "Dip" },
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
