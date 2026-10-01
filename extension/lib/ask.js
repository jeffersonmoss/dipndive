// Question box helpers: history cap (same rules as dipdive/ask.py, which stays authoritative), provider choice.
export const ASK_LIMITS = Object.freeze({
  question: 2000,   // characters
  turns: 6,         // newest earlier turns sent along
  budget: 8000,     // characters of earlier questions and answers, newest first
  turnQ: 500,       // one earlier question is cut to this
  turnA: 3000,      // one earlier answer is cut to this
});

export function cleanQuestion(q) {
  return String(q ?? "").split(/\s+/).filter(Boolean).join(" ");
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...");

// turns: [{q, a}] oldest first. Newest `turns` turns, each clipped, then as many newest turns as fit the budget.
export function capHistory(turns, lim = ASK_LIMITS) {
  const kept = [];
  for (const t of (turns || []).slice(-lim.turns)) {
    const q = clip(cleanQuestion(t.q), lim.turnQ);
    const a = clip(String(t.a ?? "").trim(), lim.turnA);
    if (q && a) kept.push({ q, a });
  }
  const out = [];
  let used = 0;
  for (const t of kept.reverse()) {
    const n = t.q.length + t.a.length;
    if (used + n > lim.budget) break;
    out.push(t);
    used += n;
  }
  return out.reverse();
}

// The ask follows the pressed button: Claude buttons ask Claude, Codex buttons ask Codex. Temp chat has no model of
// its own, so it asks Codex unless /health says Codex is unavailable (codexOk === false), then Claude.
export function askProvider(mode, codexOk) {
  if (String(mode).startsWith("claude")) return "claude";
  return codexOk === false ? "claude" : "codex";
}
