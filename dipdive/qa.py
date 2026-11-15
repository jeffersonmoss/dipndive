"""Questions and answers kept with a history-log entry, so the panel's back button and the History page can show them.

One small JSON file per entry, named by the entry's job id (the `dipdive-job` marker in the log), in the companion's
support folder under qa/. Each turn records the ask job that answered it, so a turn is never stored twice. Clear history
does not touch these files, like the log itself. Writes go to a temp file renamed over the old one, under one lock.
"""
import json
import os
import re
import threading
import time

_ID = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.Lock()
MAX_TURNS = 200


def valid_id(entry) -> bool:
    return isinstance(entry, str) and bool(_ID.match(entry))


def _path(qa_dir: str, entry: str) -> str:
    return os.path.join(qa_dir, entry + ".json")


def read(qa_dir: str, entry: str) -> list:
    """The entry's turns, oldest first: [{"q", "a", "mode", "when", "ask_job"}]. [] when there are none or the id is bad."""
    if not valid_id(entry):
        return []
    try:
        with open(_path(qa_dir, entry), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return []
    turns = d.get("turns") if isinstance(d, dict) else None
    return [t for t in turns if isinstance(t, dict) and isinstance(t.get("q"), str) and isinstance(t.get("a"), str)] if isinstance(turns, list) else []


def record(qa_dir: str, entry: str, question: str, answer: str, mode: str, ask_job: str, when: float = None) -> bool:
    """Add one turn to the entry (idempotent per ask job). Returns True when it was added. Raises OSError on a failed write."""
    if not valid_id(entry) or not isinstance(question, str) or not isinstance(answer, str) or not question.strip():
        return False
    with _lock:
        turns = read(qa_dir, entry)
        if ask_job and any(t.get("ask_job") == ask_job for t in turns):
            return False
        turns.append({"q": question, "a": answer, "mode": mode, "when": when if when is not None else time.time(), "ask_job": ask_job})
        turns = turns[-MAX_TURNS:]
        os.makedirs(qa_dir, exist_ok=True)
        p = _path(qa_dir, entry)
        tmp = f"{p}.{os.getpid()}-{threading.get_ident()}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"entry": entry, "turns": turns}, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return True
