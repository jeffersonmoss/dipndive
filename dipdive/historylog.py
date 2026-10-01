"""Durable summary log: one Markdown entry per successful Dip or Dive result, appended to a file Jefferson can read.

Location: DIPDIVE_LOG_PATH, default ~/Public/Dip'n'Dive Log.md. The file is never touched by POST /clear.
Entries are appended under a thread lock and an advisory file lock, written with a single os.write on an O_APPEND
descriptor, so two jobs finishing together leave two intact entries. Callers must treat any exception as non-fatal.
"""
import errno
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


# ---------- reading (GET /history) ----------
MAX_READ = 32 * 1024 * 1024    # a log larger than this is read from its tail only
PAGE_DEFAULT, PAGE_MAX = 20, 100
_META = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \| (.+?) \| \[[^\]]*\]\(<(.*)>\)\s*$")
_ESCAPED_RULE = re.compile(r"^( {0,3})\\(-[ \t]*-[ \t]*-(?:[ \t]*-)*[ \t]*)$")
_IDS = {v: k for k, v in LABELS.items()}


class LogUnreadable(Exception):
    """The log exists but cannot be read (permissions, a directory in its place, an I/O error)."""


def _blocks(text: str):
    """Split the log into entry blocks on separator lines (`---` alone), ignoring any inside a code fence."""
    block, fence = [], None
    for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        m = _FENCE.match(ln)
        if m:
            f = m.group(1)
            if fence is None:
                fence = f
            elif f[0] == fence[0] and len(f) >= len(fence) and ln.strip() == f:
                fence = None
        elif fence is None and ln.strip() == "---" and ln == ln.lstrip():
            yield block
            block = []
            continue
        block.append(ln)
    yield block


def _entry(lines):
    """One block to a dict, or None when it does not look like an entry (hand-edited or damaged text is skipped)."""
    i = 0
    while i < len(lines) and (not lines[i].strip() or re.match(r"^# ", lines[i])):
        i += 1  # blank lines and the file heading
    if i >= len(lines) or not lines[i].startswith("## "):
        return None
    title = lines[i][3:].strip()
    i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1
    channel = ""
    if i < len(lines) and lines[i].startswith("Channel: "):
        channel = lines[i][9:].strip()
        i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
    m = _META.match(lines[i]) if i < len(lines) else None
    if not m:
        return None
    day, hm, label, url = m.groups()
    url = url.replace("%3C", "<").replace("%3E", ">").replace("%5C", "\\")
    body, fence = [], None
    for ln in lines[i + 1:]:
        f = _FENCE.match(ln)
        if f:
            g = f.group(1)
            if fence is None:
                fence = g
            elif g[0] == fence[0] and len(g) >= len(fence) and ln.strip() == g:
                fence = None
        elif fence is None:
            e = _ESCAPED_RULE.match(ln)
            if e:
                ln = e.group(1) + e.group(2)  # undo the backslash that append() added
        body.append(ln)
    return {"title": title or url or "Untitled", "channel": channel, "date": day, "time": hm,
            "mode": _IDS.get(label, label), "mode_label": label, "url": url, "summary": "\n".join(body).strip()}


def read_entries(path: str = None) -> list:
    """All entries in file order (oldest first). A missing file is an empty log; a damaged block is skipped."""
    p = path or log_path()
    try:
        with open(p, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size > MAX_READ:
                f.seek(size - MAX_READ)
            raw = f.read(MAX_READ)
            tail_only = size > MAX_READ
    except FileNotFoundError:
        return []
    except OSError as e:
        raise LogUnreadable(errno.errorcode.get(e.errno, "OSError")) from e
    text = raw.decode("utf-8", "replace")
    out = []
    for n, b in enumerate(_blocks(text)):
        if n == 0 and tail_only:
            continue  # starts mid-entry
        e = _entry(b)
        if e:
            out.append(e)
    return out


def read_page(before=None, limit: int = PAGE_DEFAULT, path: str = None) -> dict:
    """One page, newest first. `before` is the position (0 = oldest) the page must stay under; omitted, it starts at the
    newest entry. Positions do not move when new entries are appended, so a reader who pages down while a job finishes
    neither repeats nor skips an entry. `next_before` is the cursor for the next page, None at the end."""
    es = read_entries(path)
    total = len(es)
    top = total if before is None else max(0, min(before, total))
    lo = max(0, top - limit)
    page = [dict(es[i], index=i) for i in range(top - 1, lo - 1, -1)]
    return {"entries": page, "total": total, "limit": limit, "next_before": lo if lo > 0 else None}
