"""Durable summary log: one Markdown entry per successful Dip or Dive result, appended to a file Jefferson can read.

Location: DIPDIVE_LOG_PATH, default ~/Public/Dip'n'Dive Log.md. The file is never touched by POST /clear.
Entries are appended under a thread lock and an advisory file lock, written with a single os.write on an O_APPEND
descriptor, so two jobs finishing together leave two intact entries. Callers must treat any exception as non-fatal.
"""
import fcntl
import os
import re
import threading
import time

DEFAULT_PATH = "~/Public/Dip'n'Dive Log.md"
HEADING = "# Dip'n'Dive Log\n\n"
LABELS = {"claude-dip": "Claude Dip", "claude-dive": "Claude Dive", "codex-dip": "Codex Dip", "codex-dive": "Codex Dive"}
LOGGED_MODES = tuple(LABELS)

_thread_lock = threading.Lock()
_RULE = re.compile(r"^ {0,3}(?:-[ \t]*){3,}$")             # a thematic break or setext underline made of hyphens
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def log_path() -> str:
    return os.path.expanduser(os.environ.get("DIPDIVE_LOG_PATH") or DEFAULT_PATH)


def is_writable(path: str = None) -> bool:
    """True when an append would plausibly work: the file is writable, or it is missing and its nearest existing
    parent directory is writable. Touches nothing."""
    p = path or log_path()
    try:
        if os.path.exists(p):
            return os.path.isfile(p) and os.access(p, os.W_OK)
        d = os.path.dirname(os.path.abspath(p))
        while d and not os.path.exists(d):
            d = os.path.dirname(d)
        return os.path.isdir(d) and os.access(d, os.W_OK | os.X_OK)
    except OSError:
        return False


def _one_line(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _md_url(url: str) -> str:
    """URL for the destination of a Markdown link: angle-bracket form with the characters that end it percent-encoded."""
    u = _one_line(url).replace("<", "%3C").replace(">", "%3E").replace("\\", "%5C")
    return "<" + u + ">"


def _body(summary: str) -> str:
    """The summary exactly as shown, except what would break the entry: a hyphen-only rule line is escaped with a
    backslash (so it cannot read as the separator) and a code fence left open is closed."""
    lines = (summary or "").replace("\r\n", "\n").replace("\r", "\n").rstrip().split("\n")
    out, fence = [], None
    for ln in lines:
        m = _FENCE.match(ln)
        if m:
            f = m.group(1)
            if fence is None:
                fence = f
            elif f[0] == fence[0] and len(f) >= len(fence) and ln.strip() == f:
                fence = None
        elif fence is None and _RULE.match(ln):
            ln = re.sub(r"-", r"\\-", ln, count=1)
        out.append(ln)
    if fence is not None:
        out.append(fence)
    return "\n".join(out)


def format_entry(title: str, mode: str, url: str, summary: str, when: float = None, channel: str = None) -> str:
    t = _one_line(title) or _one_line(url) or "Untitled"
    t = t.lstrip("#").strip() or t  # a leading # would nest the heading level
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(when if when is not None else time.time()))
    label = LABELS.get(mode, mode)
    shown = _one_line(url).replace("[", "%5B").replace("]", "%5D")
    ch = _one_line(channel if isinstance(channel, str) else "")
    chline = f"Channel: {ch}\n\n" if ch else ""
    return f"## {t}\n\n{chline}{stamp} | {label} | [{shown}]({_md_url(url)})\n\n{_body(summary)}\n\n---\n\n"


def append(title: str, mode: str, url: str, summary: str, path: str = None, channel: str = None) -> str:
    """Append one entry (creating the file with a heading if missing). Returns the path. Raises OSError on failure."""
    p = path or log_path()
    entry = format_entry(title, mode, url, summary, channel=channel).encode("utf-8", "replace")
    with _thread_lock:
        d = os.path.dirname(os.path.abspath(p))
        os.makedirs(d, exist_ok=True)
        fd = os.open(p, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError:
                pass  # a filesystem without flock (some network mounts): the thread lock still serializes this process
            size = os.fstat(fd).st_size
            if size == 0:
                prefix = HEADING.encode()
            else:
                tail = os.pread(fd, 2, max(0, size - 2))
                prefix = b"" if tail.endswith(b"\n\n") else (b"\n" if tail.endswith(b"\n") else b"\n\n")
            data = prefix + entry
            while data:
                n = os.write(fd, data)
                data = data[n:]
            os.fsync(fd)
        finally:
            os.close(fd)  # closing releases the flock
    return p
