"""Question support for POST /jobs (modes claude-ask and codex-ask): validation, history cap, cache key.

The panel sends the questions and answers it has shown for this source, and the Dip or Dive text on screen. Both
sides cap them with the same rules (the companion's result is authoritative, so the cache key never depends on what
the client trimmed). Every limit is applied to the normalized text (NFKC, invisible characters removed, lone
surrogates replaced), which is what reaches the model, so a limit really bounds the prompt."""
import hashlib
import json
import re

from .prompts import normalize

ASK_MODES = ("claude-ask", "codex-ask")
MAX_QUESTION_CHARS = 2000       # a spoken question is short; this only stops abuse
MAX_HISTORY_INPUT = 100         # turns accepted in a request before the cap is applied
MAX_HISTORY_TURNS = 6           # newest turns kept
HISTORY_CHAR_BUDGET = 8000      # total characters of questions and answers kept, newest first
MAX_TURN_Q = 500                # one earlier question is cut to this
MAX_TURN_A = 3000               # one earlier answer is cut to this
MAX_SUMMARY = 4000              # the Dip or Dive text on screen, cut to this (the start is kept)

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


class AskError(ValueError):
    """Bad question, history or summary: the server answers 400."""


def clean_text(s: str) -> str:
    """Lone surrogates (a JSON \\ud83d with no partner) become U+FFFD so the text can be encoded, then the
    normalization that neutralize applies later."""
    return normalize(_LONE_SURROGATE.sub("\ufffd", s))


def clean_question(q: str) -> str:
    return " ".join(clean_text(q).split())


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 3].rstrip() + "..."


def cap_history(history) -> list:
    """Newest MAX_HISTORY_TURNS turns, each turn clipped, then as many newest turns as fit the character budget."""
    turns = []
    for t in history[-MAX_HISTORY_TURNS:]:
        q, a = _clip(clean_question(t["q"]), MAX_TURN_Q), _clip(clean_text(t["a"]).strip(), MAX_TURN_A)
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


def cap_summary(summary) -> str:
    """The summary text the user was shown ("" when there is none), cut to MAX_SUMMARY characters."""
    return _clip(clean_text(summary).strip(), MAX_SUMMARY) if summary else ""


def prepare(mode, question, history, summary=None):
    """Returns (question, capped_history, summary, key) for an ask mode, (None, None, None, None) for any other mode.
    Raises AskError for a missing or malformed question, history or summary."""
    if mode not in ASK_MODES:
        if question is not None or history is not None or summary is not None:
            raise AskError("question, history and summary are only valid for the ask modes")
        return None, None, None, None
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
    if summary is not None and not isinstance(summary, str):
        raise AskError("summary must be a string")
    capped = cap_history(history)
    shown = cap_summary(summary)
    return q, capped, shown, ask_key(q, capped, shown)


def ask_key(question: str, capped_history: list, summary: str = "") -> str:
    """Hash of the question, the history and the summary that actually reach the model; part of every ask cache key."""
    blob = json.dumps({"q": question, "h": capped_history, "s": summary}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()
