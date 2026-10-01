"""Durable summary log: one Markdown entry per successful Dip or Dive result, appended to a file Jefferson can read.

Location: DIPDIVE_LOG_PATH, default ~/Public/Dip'n'Dive Log.md. The file is never touched by POST /clear.
Entries are appended under a thread lock and an advisory file lock, written with a single os.write on an O_APPEND
descriptor, so two jobs finishing together leave two intact entries. Callers must treat any exception as non-fatal.

Each entry carries the id of the job that made it in an HTML comment right under its date line
(`<!-- dipdive-job: <id> -->`), invisible when the Markdown is rendered. The panel's "Save this Dip to history" checkbox
uses it: remove_entry() cuts that entry out of the log into a small store of removed entries, restore_entry() puts it
back where it was.
"""
import errno
import fcntl
import json
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
_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
_JOB_MARK = re.compile(r"^<!-- dipdive-job: ([0-9a-f]{32}) -->[ \t]*$")


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


def format_entry(title: str, mode: str, url: str, summary: str, when: float = None, channel: str = None,
                 job_id: str = None) -> str:
    t = _one_line(title) or _one_line(url) or "Untitled"
    t = t.lstrip("#").strip() or t  # a leading # would nest the heading level
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(when if when is not None else time.time()))
    label = LABELS.get(mode, mode)
    shown = _one_line(url).replace("[", "%5B").replace("]", "%5D")
    ch = _one_line(channel if isinstance(channel, str) else "")
    chline = f"Channel: {ch}\n\n" if ch else ""
    # the job id rides in an HTML comment right under the date line: invisible in rendered Markdown
    mark = f"\n<!-- dipdive-job: {job_id} -->" if isinstance(job_id, str) and _JOB_ID.match(job_id) else ""
    return f"## {t}\n\n{chline}{stamp} | {label} | [{shown}]({_md_url(url)}){mark}\n\n{_body(summary)}\n\n---\n\n"


def append(title: str, mode: str, url: str, summary: str, path: str = None, channel: str = None, job_id: str = None) -> str:
    """Append one entry (creating the file with a heading if missing). Returns the path. Raises OSError on failure."""
    p = path or log_path()
    entry = format_entry(title, mode, url, summary, channel=channel, job_id=job_id).encode("utf-8", "replace")
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
    i += 1
    jm = _JOB_MARK.match(lines[i]) if i < len(lines) else None
    job_id = jm.group(1) if jm else ""
    if jm:
        i += 1
    body, fence = [], None
    for ln in lines[i:]:
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
            "mode": _IDS.get(label, label), "mode_label": label, "url": url, "summary": "\n".join(body).strip(), "job_id": job_id}


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


# ---------- removing and restoring one entry (the panel's "Save this Dip to history" checkbox) ----------
class NoSuchEntry(Exception):
    """No entry with that job id is in the log or in the store of removed entries."""


def _segments(text: str):
    """Split the log into consecutive pieces that join back to exactly `text`. Every piece but the last ends with a
    separator line (`---` alone, outside a code fence) and the blank lines after it. Returns a list of
    (prefix, entry, job_id): `entry` is the text from the piece's `## ` heading on, `prefix` what comes before it (the
    file heading, blank lines), and job_id is "" when the piece is not an entry or has no id."""
    pieces, cur, fence = [], [], None
    lines = text.splitlines(keepends=True)
    k = 0
    while k < len(lines):
        ln = lines[k]
        bare = ln.rstrip("\r\n")
        cur.append(ln)
        k += 1
        m = _FENCE.match(bare)
        if m:
            f = m.group(1)
            if fence is None:
                fence = f
            elif f[0] == fence[0] and len(f) >= len(fence) and bare.strip() == f:
                fence = None
        elif fence is None and bare.strip() == "---" and bare == bare.lstrip():
            while k < len(lines) and not lines[k].strip():
                cur.append(lines[k])
                k += 1
            pieces.append("".join(cur))
            cur = []
    pieces.append("".join(cur))
    out = []
    for piece in pieces:
        pl = piece.splitlines(keepends=True)
        start = 0
        while start < len(pl) and (not pl[start].strip() or re.match(r"^# ", pl[start])):
            start += 1
        prefix, entry = "".join(pl[:start]), "".join(pl[start:])
        e = _entry([x.rstrip("\r\n") for x in pl]) if entry.startswith("## ") else None
        out.append((prefix, entry, e["job_id"] if e else ""))
    return out


def _trash_path(trash_dir: str, job_id: str) -> str:
    return os.path.join(trash_dir, job_id + ".json")


def is_saved(job_id: str, trash_dir: str) -> bool:
    """False while the entry of `job_id` sits in the store of removed entries. Only a stat: cheap enough for every poll."""
    return not os.path.exists(_trash_path(trash_dir, job_id))


def _locked_rewrite(p: str, change):
    """Read the whole log, apply change(text) -> new text or None (no write), and replace the file atomically
    (temp file in the same folder, fsync, rename, the old mode kept), all under the thread lock and the advisory file
    lock. A missing log reads as "". Raises LogUnreadable when it cannot be read and OSError when it cannot be written."""
    with _thread_lock:
        try:
            fd = os.open(p, os.O_RDONLY)
        except FileNotFoundError:
            fd = None
        except OSError as e:
            raise LogUnreadable(errno.errorcode.get(e.errno, "OSError")) from e
        try:
            if fd is not None:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                except OSError:
                    pass
                try:
                    chunks = []
                    while True:
                        b = os.read(fd, 1 << 20)
                        if not b:
                            break
                        chunks.append(b)
                except OSError as e:
                    raise LogUnreadable(errno.errorcode.get(e.errno, "OSError")) from e
                text = b"".join(chunks).decode("utf-8", "surrogateescape")
                mode = os.fstat(fd).st_mode & 0o7777
            else:
                text, mode = "", 0o644
            new = change(text)
            if new is None:
                return
            d = os.path.dirname(os.path.abspath(p))
            os.makedirs(d, exist_ok=True)
            tmp = os.path.join(d, f".dipdive-log-{os.getpid()}-{threading.get_ident()}.tmp")
            try:
                wfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
                try:
                    data = new.encode("utf-8", "surrogateescape")
                    while data:
                        n = os.write(wfd, data)
                        data = data[n:]
                    os.fsync(wfd)
                finally:
                    os.close(wfd)
                os.replace(tmp, p)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        finally:
            if fd is not None:
                os.close(fd)  # releases the flock


def _atomic_json(path: str, obj):
    tmp = f"{path}.{os.getpid()}-{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def remove_entry(job_id: str, trash_dir: str, path: str = None) -> bool:
    """Cut the entry of `job_id` out of the log and keep it in trash_dir so restore_entry() can put it back. Idempotent:
    an entry that is already removed stays removed. Returns False (the entry is not saved). Raises NoSuchEntry when the
    id is in neither place, LogUnreadable or OSError when the log cannot be read or written. The removed text is stored
    before the log is rewritten, so a crash in between leaves the entry in both places, never in neither."""
    if not _JOB_ID.match(job_id or ""):
        raise NoSuchEntry(job_id)
    p = path or log_path()
    tp = _trash_path(trash_dir, job_id)
    found = []

    def change(text):
        segs = _segments(text)
        for n, (prefix, entry, jid) in enumerate(segs):
            if jid == job_id:
                nxt = next((s[2] for s in segs[n + 1:] if s[2]), None)
                os.makedirs(trash_dir, exist_ok=True)
                _atomic_json(tp, {"entry": entry, "next": nxt, "removed": time.time()})
                found.append(True)
                return "".join(pr + (en if m != n else "") for m, (pr, en, _) in enumerate(segs))
        return None
    _locked_rewrite(p, change)
    if found or os.path.exists(tp):
        return False
    raise NoSuchEntry(job_id)


def restore_entry(job_id: str, trash_dir: str, path: str = None) -> bool:
    """Put a removed entry back where it was: before the entry that followed it when it was removed, or at the bottom
    when that one is gone too. Idempotent: an entry that is in the log already stays as it is. Returns True (saved).
    Raises NoSuchEntry when the id is in neither place, LogUnreadable or OSError on a read or write failure."""
    if not _JOB_ID.match(job_id or ""):
        raise NoSuchEntry(job_id)
    p = path or log_path()
    tp = _trash_path(trash_dir, job_id)
    try:
        with open(tp, encoding="utf-8") as f:
            kept = json.load(f)
        entry, nxt = kept["entry"], kept.get("next")
        if not isinstance(entry, str) or not entry.startswith("## "):
            raise ValueError("damaged")
    except FileNotFoundError:
        kept = None
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise NoSuchEntry(job_id) from e
    present = []

    def change(text):
        segs = _segments(text)
        if any(jid == job_id for _, _, jid in segs):
            present.append(True)  # already back (a crash after the log was written, or a second click)
            return None
        if kept is None:
            return None
        if nxt:
            for n, (prefix, en, jid) in enumerate(segs):
                if jid == nxt:
                    return "".join(pr + (entry if m == n else "") + e2 for m, (pr, e2, _) in enumerate(segs))
        if not text:
            return HEADING + entry
        sep = "" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
        return text + sep + entry
    _locked_rewrite(p, change)
    if kept is None and not present:
        raise NoSuchEntry(job_id)
    if kept is not None:
        try:
            os.unlink(tp)
        except FileNotFoundError:
            pass
    return True
