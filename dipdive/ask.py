"""Question support for POST /jobs (modes claude-ask and codex-ask): validation, history cap, cache key.

The panel sends the questions and answers it has shown for this source. Both sides cap the history with the same
rules (the companion's result is authoritative, so the cache key never depends on what the client trimmed)."""
import hashlib
import json

ASK_MODES = ("claude-ask", "codex-ask")
MAX_QUESTION_CHARS = 2000       # a spoken question is short; this only stops abuse
MAX_HISTORY_INPUT = 100         # turns accepted in a request before the cap is applied
MAX_HISTORY_TURNS = 6           # newest turns kept
HISTORY_CHAR_BUDGET = 8000      # total characters of questions and answers kept, newest first
MAX_TURN_Q = 500                # one earlier question is cut to this
MAX_TURN_A = 3000               # one earlier answer is cut to this


class AskError(ValueError):
    """Bad question or history: the server answers 400."""


def clean_question(q: str) -> str:
    return " ".join(q.split())


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 3].rstrip() + "..."


def cap_history(history) -> list:
    """Newest MAX_HISTORY_TURNS turns, each turn clipped, then as many newest turns as fit the character budget."""
    turns = []
    for t in history[-MAX_HISTORY_TURNS:]:
        q, a = _clip(clean_question(t["q"]), MAX_TURN_Q), _clip(t["a"].strip(), MAX_TURN_A)
        if q and a:
            turns.append({"q": q, "a": a})
    out, used = [], 0
    for t in reversed(turns):
        n = len(t["q"]) + len(t["a"])
        if used + n > HISTORY_CHAR_BUDGET:
            break
        out.append(t)
        used += n
    out.reverse()
    return out


def prepare(mode, question, history):
    """Returns (question, capped_history, key) for an ask mode, (None, None, None) for any other mode.
    Raises AskError for a missing or malformed question or history."""
    if mode not in ASK_MODES:
        if question is not None or history is not None:
            raise AskError("question and history are only valid for the ask modes")
        return None, None, None
    if not isinstance(question, str) or not clean_question(question):
        raise AskError("an ask mode needs a non-empty question")
    q = clean_question(question)
    if len(q) > MAX_QUESTION_CHARS:
        raise AskError(f"question is over {MAX_QUESTION_CHARS} characters")
    if history is None:
        history = []
    if not isinstance(history, list) or len(history) > MAX_HISTORY_INPUT:
        raise AskError(f"history must be a list of at most {MAX_HISTORY_INPUT} turns")
    for t in history:
        if not isinstance(t, dict) or not isinstance(t.get("q"), str) or not isinstance(t.get("a"), str):
            raise AskError('each history turn must be {"q": string, "a": string}')
    capped = cap_history(history)
    return q, capped, ask_key(q, capped)


def ask_key(question: str, capped_history: list) -> str:
    """Hash of the question and the history that actually reaches the model; part of every ask cache key."""
    blob = json.dumps({"q": question, "h": capped_history}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()
