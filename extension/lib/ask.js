// Question box helpers: history cap (same rules as dipdive/ask.py, which stays authoritative), provider choice.
export const ASK_LIMITS = Object.freeze({
  question: 2000,   // characters
  turns: 6,         // newest earlier turns sent along
  budget: 8000,     // characters of earlier questions and answers, newest first
  turnQ: 500,       // one earlier question is cut to this
  turnA: 3000,      // one earlier answer is cut to this
  summary: 4000,    // the Dip or Dive text on screen, sent along with a question (the start is kept)
});

// The same normalization the companion applies before it counts anything: lone surrogates become U+FFFD, then NFKC and
// removal of invisible characters (the list mirrors _ZERO_WIDTH in dipdive/prompts.py).
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function normalizeText(s) {
  s = String(s ?? "");
  s = typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(LONE, "\ufffd");
  return s.normalize("NFKC").replace(INVISIBLE, "");
}

// Length in characters (code points), the way the companion counts. A UTF-16 length would count an emoji twice.
export const charCount = (s) => Array.from(s).length;

export function cleanQuestion(q) {
  return normalizeText(q).split(/\s+/).filter(Boolean).join(" ");
}

// Cuts by code points, so a character outside the basic plane (an emoji, the bold letters in many YouTube titles) is
// never split into a lone surrogate, which the companion could not encode.
const clip = (s, n) => {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n - 3).join("").trimEnd() + "...";
};

export function capSummary(text, lim = ASK_LIMITS) {
  return text ? clip(normalizeText(text).trim(), lim.summary) : "";
}

// turns: [{q, a}] oldest first. Newest `turns` turns, each clipped, then as many newest turns as fit the budget.
export function capHistory(turns, lim = ASK_LIMITS) {
  const kept = [];
  for (const t of (turns || []).slice(-lim.turns)) {
    const q = clip(cleanQuestion(t.q), lim.turnQ);
    const a = clip(normalizeText(t.a).trim(), lim.turnA);
    if (q && a) kept.push({ q, a });
  }
  const out = [];
  let used = 0;
  for (const t of kept.reverse()) {
    const n = charCount(t.q) + charCount(t.a);
    if (used + n > lim.budget) break;
    out.push(t);
    used += n;
  }
  return out.reverse();
}

// The ask follows the pressed button: Claude buttons ask Claude, Codex buttons ask Codex. When /health says Codex is
// unavailable (codexOk === false), a Codex button asks Claude instead.
export function askProvider(mode, codexOk) {
  if (String(mode).startsWith("claude")) return "claude";
  return codexOk === false ? "claude" : "codex";
}
