"""Durable summary log: one Markdown entry per successful Dip or Dive result, appended to a file Jefferson can read.

Location: DIPDIVE_LOG_PATH, default ~/Public/Dip'n'Dive Log.md. The file is never touched by POST /clear.

Every writer (append, remove_entry, restore_entry, and the companion's Clear history around its own work) first takes
locked(): an in-process re-entrant lock, then an advisory flock on a stable sidecar file next to the log
(`.<log name>.lock`). The sidecar never changes inode, so a writer in another process cannot be left waiting on a log
file that a rewrite has since replaced. Appends are one os.write on an O_APPEND descriptor; rewrites go to a temp file
in the same folder and are renamed over the log. Callers of append must treat any exception as non-fatal.

Each entry carries the id of the job that made it in an HTML comment right under its date line
(`<!-- dipdive-job: <id> -->`), invisible when the Markdown is rendered. The panel's "Save this Dip to history" checkbox
uses it: remove_entry() cuts that entry out of the log into a small store of removed entries, restore_entry() puts it
back where it was. Each is one transaction under locked(), and a failed rewrite is rolled back, so saved_state() (read
from the log itself) always tells whether the entry is in the log.

Entries are found by their own metadata, not by separator formatting: an entry starts at a `## ` heading (outside a
code fence) followed by the date line, and ends at its first separator line or at the next entry, whichever comes first.
The text is split on "\n" only, as it is written.
"""
import contextlib
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

_thread_lock = threading.RLock()
_held = threading.local()
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
        elif fence is None and _JOB_MARK.match(ln):
            ln = "\\" + ln  # a quoted id marker must not read as an entry's own (Markdown shows it without the backslash)
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


@contextlib.contextmanager
def locked(path: str = None):
    """The log's write lock: the in-process lock, then an advisory flock on the sidecar `.<log name>.lock` next to the
    log. Re-entrant within a thread. When the sidecar cannot be opened (the folder is missing or read-only) only the
    in-process lock is held. Yields the sidecar descriptor or None."""
    p = path or log_path()
    with _thread_lock:
        depth = getattr(_held, "fds", None)
        if depth is None:
            depth = _held.fds = {}
        key = os.path.abspath(p)
        if key in depth:
            yield depth[key]
            return
        fd = None
        try:
            fd = os.open(_lock_path(p), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError:
                pass  # a filesystem without flock: the in-process lock still serializes this companion
        except OSError:
            fd = None
        depth[key] = fd
        try:
            yield fd
        finally:
            del depth[key]
            if fd is not None:
                os.close(fd)  # releases the flock


def _lock_path(p: str) -> str:
    d, n = os.path.split(os.path.abspath(p))
    return os.path.join(d, "." + n + ".lock")


def revision(path: str = None) -> int:
    """A number that changes whenever an entry is removed or restored (which moves the positions of the entries after
    it); appends do not change it. Kept in the sidecar lock file. 0 when there is none yet."""
    try:
        with open(_lock_path(path or log_path()), "rb") as f:
            raw = f.read(32).strip()
        return int(raw) if raw.isdigit() else 0
    except (OSError, ValueError):
        return 0


def _bump_revision(fd):
    if fd is None:
        return
    try:
        raw = os.pread(fd, 32, 0).strip()
        n = int(raw) + 1 if raw.isdigit() else 1
        os.pwrite(fd, b"%020d\n" % n, 0)  # fixed width: one write, never a half-written number
    except OSError:
        pass


def append(title: str, mode: str, url: str, summary: str, path: str = None, channel: str = None, job_id: str = None,
           when: float = None) -> str:
    """Append one entry (creating the file with a heading if missing). Returns the path. Raises OSError on failure."""
    p = path or log_path()
    entry = format_entry(title, mode, url, summary, when=when, channel=channel, job_id=job_id).encode("utf-8", "replace")
    os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
    with locked(p):
        fd = os.open(p, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)  # also honoured by an older companion that only locked the log itself
            except OSError:
                pass
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
            os.close(fd)
    return p


# ---------- parsing ----------
MAX_READ = 32 * 1024 * 1024    # a log larger than this is read from its tail only (GET /history)
PAGE_DEFAULT, PAGE_MAX = 20, 100
_META = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \| (.+?) \| \[[^\]]*\]\(<(.*)>\)\s*$")
_ESCAPED_RULE = re.compile(r"^( {0,3})\\(-[ \t]*-[ \t]*-(?:[ \t]*-)*[ \t]*)$")
_SEP = re.compile(r"^---[ \t]*$")  # every such line also matches _RULE, so the writer escapes it inside a summary
_IDS = {v: k for k, v in LABELS.items()}


class LogUnreadable(Exception):
    """The log exists but cannot be read (permissions, a directory in its place, an I/O error)."""


class NoSuchEntry(Exception):
    """No entry with that job id is in the log or in the store of removed entries."""


class AmbiguousEntry(Exception):
    """The entry's text cannot be told apart from a neighbour's (a hand edit removed a heading): nothing is changed."""


class HistoryChanged(Exception):
    """A page was asked for with a revision that is no longer current: entries were removed or restored since."""

    def __init__(self, current):
        super().__init__(current)
        self.current = current


def _lines(text: str) -> list:
    """Split on "\n" only, keeping it, so "".join(lines) == text (CR, U+2028 and other breaks stay inside a line)."""
    parts = text.split("\n")
    return [x + "\n" for x in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def _bare(line: str) -> str:
    return line[:-1].rstrip("\r") if line.endswith("\n") else line.rstrip("\r")


def _blank(b: str) -> bool:
    return not b.strip(" \t")


class _Ent:
    __slots__ = ("start", "body", "end", "body_end", "job_id", "stamp", "ambiguous")


def _scan(lines: list) -> list:
    """Find the entries: (start line, end line) spans with their job id, stamp and an ambiguity flag."""
    bares = [_bare(x) for x in lines]
    n = len(bares)
    fenced = [False] * n  # inside a code fence, or a fence line itself
    fence = None
    for i, b in enumerate(bares):
        m = _FENCE.match(b)
        if m:
            f = m.group(1)
            if fence is None:
                fence, fenced[i] = f, True
                continue
            if f[0] == fence[0] and len(f) >= len(fence) and b.strip() == f:
                fence, fenced[i] = None, True
                continue
        fenced[i] = fence is not None
    starts = []
    for i, b in enumerate(bares):
        if fenced[i] or not b.startswith("## "):
            continue
        j = i + 1
        while j < n and _blank(bares[j]) and not fenced[j]:
            j += 1
        if j < n and bares[j].startswith("Channel: ") and not fenced[j]:
            j += 1
            while j < n and _blank(bares[j]) and not fenced[j]:
                j += 1
        m = _META.match(bares[j]) if j < n and not fenced[j] else None
        if not m:
            continue
        e = _Ent()
        e.start, e.stamp = i, f"{m.group(1)} {m.group(2)}"
        k = j + 1
        jm = _JOB_MARK.match(bares[k]) if k < n else None
        e.job_id = jm.group(1) if jm else ""
        e.body = k + 1 if jm else k
        starts.append(e)
    for x, e in enumerate(starts):
        limit = starts[x + 1].start if x + 1 < len(starts) else n
        end = body_end = limit
        for q in range(e.body, limit):
            if not fenced[q] and _SEP.match(bares[q]):
                body_end, end = q, q + 1
                while end < limit and _blank(bares[end]):
                    end += 1
                break
        e.end, e.body_end = end, body_end
        # another entry's date line or id inside this one: a neighbour lost its heading; cutting would take it too
        e.ambiguous = any(not fenced[q] and (_META.match(bares[q]) or _JOB_MARK.match(bares[q])) for q in range(e.body, body_end))
    return starts


def _entry(lines):
    """One entry's lines (heading to body end, no separator) to a dict, or None when it does not look like an entry."""
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
            elif ln.startswith("\\") and _JOB_MARK.match(ln[1:]):
                ln = ln[1:]
        body.append(ln)
    return {"title": title or url or "Untitled", "channel": channel, "date": day, "time": hm,
            "mode": _IDS.get(label, label), "mode_label": label, "url": url, "summary": "\n".join(body).strip(), "job_id": job_id}


def _parse(text: str) -> list:
    lines = _lines(text)
    bares = [_bare(x) for x in lines]
    out = []
    for e in _scan(lines):
        d = _entry(bares[e.start:e.body_end])
        if d:
            out.append(d)
    return out


def _read_text(p: str, cap: int = None, errors: str = "surrogateescape"):
    """The log as text (None when missing) and whether only its tail was read. With the default errors, bytes that are
    not UTF-8 survive a rewrite unchanged; for display they are replaced (errors="replace")."""
    try:
        with open(p, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            tail_only = cap is not None and size > cap
            if tail_only:
                f.seek(size - cap)
            raw = f.read() if cap is None else f.read(cap)
    except FileNotFoundError:
        return None, False
    except OSError as e:
        raise LogUnreadable(errno.errorcode.get(e.errno, "OSError")) from e
    return raw.decode("utf-8", errors), tail_only


def read_entries(path: str = None) -> list:
    """All entries in file order (oldest first). A missing file is an empty log; text that is not an entry is skipped."""
    text, _ = _read_text(path or log_path(), MAX_READ, errors="replace")
    return _parse(text) if text else []


def read_page(before=None, limit: int = PAGE_DEFAULT, path: str = None, rev: int = None) -> dict:
    """One page, newest first. `before` is the position (0 = oldest) the page must stay under; omitted, it starts at the
    newest entry. Appends never move positions, so a reader who pages down while a job finishes neither repeats nor skips
    an entry. Removing or restoring an entry does move them, and changes `revision`: a request for a later page that
    carries an older `rev` raises HistoryChanged (the reader starts again from the newest). `next_before` is the cursor
    for the next page, None at the end."""
    p = path or log_path()
    for _ in range(3):  # a change between reading the revision and the entries: read again
        r0 = revision(p)
        if rev is not None and before is not None and rev != r0:
            raise HistoryChanged(r0)
        es = read_entries(p)
        if revision(p) == r0:
            break
    total = len(es)
    top = total if before is None else max(0, min(before, total))
    lo = max(0, top - limit)
    page = [dict(es[i], index=i) for i in range(top - 1, lo - 1, -1)]
    return {"entries": page, "total": total, "limit": limit, "next_before": lo if lo > 0 else None, "revision": r0}


# ---------- removing and restoring one entry (the panel's "Save this Dip to history" checkbox) ----------
_ids_cache = {}


def _log_ids(p: str) -> set:
    """The job ids of the entries in the log, cached on the file's identity, size and change time."""
    try:
        st = os.stat(p)
    except FileNotFoundError:
        return set()
    except OSError as e:
        raise LogUnreadable(errno.errorcode.get(e.errno, "OSError")) from e
    key = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
    hit = _ids_cache.get(p)
    if hit and hit[0] == key:
        return hit[1]
    text, _ = _read_text(p)
    ids = {e.job_id for e in _scan(_lines(text or "")) if e.job_id}
    _ids_cache[p] = (key, ids)
    return ids


def _trash_path(trash_dir: str, job_id: str) -> str:
    return os.path.join(trash_dir, job_id + ".json")


def saved_state(job_id: str, trash_dir: str, path: str = None):
    """True when the entry of `job_id` is in the log, False when it is not but is kept as removed, None when it is in
    neither (or the log cannot be read). Read from the log itself, not from the removed store."""
    try:
        if job_id in _log_ids(path or log_path()):
            return True
    except LogUnreadable:
        return None
    return False if os.path.exists(_trash_path(trash_dir, job_id)) else None


def _replace(p: str, text: str, mode: int):
    """Write `text` to a temp file in the log's folder, fsync, and rename it over the log. Raises OSError; the temp file
    never survives."""
    d = os.path.dirname(os.path.abspath(p))
    tmp = os.path.join(d, f".dipdive-log-{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            data = text.encode("utf-8", "surrogateescape")
            while data:
                n = os.write(fd, data)
                data = data[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(tmp, mode)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


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


def _unlink(path: str):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _mode(p: str) -> int:
    try:
        return os.stat(p).st_mode & 0o7777
    except OSError:
        return 0o644


def remove_entry(job_id: str, trash_dir: str, path: str = None) -> bool:
    """Cut the entry of `job_id` out of the log and keep it in trash_dir, with the ids of the entries before and after it
    and its date, so restore_entry() can put it back in place. One transaction under locked(): when the rewrite fails,
    the kept copy is deleted again and the log is as it was. Idempotent. Returns False (not saved). Raises NoSuchEntry
    when the id is in neither place, AmbiguousEntry when its text runs into a neighbour's, LogUnreadable or OSError."""
    if not _JOB_ID.match(job_id or ""):
        raise NoSuchEntry(job_id)
    p = path or log_path()
    tp = _trash_path(trash_dir, job_id)
    with locked(p) as lfd:
        text, _ = _read_text(p)
        lines = _lines(text or "")
        ents = _scan(lines)
        hits = [e for e in ents if e.job_id == job_id]
        if not hits:
            if os.path.exists(tp):
                return False
            raise NoSuchEntry(job_id)
        if len(hits) > 1 or hits[0].ambiguous:
            raise AmbiguousEntry(job_id)
        e = hits[0]
        x = ents.index(e)
        prev = next((o.job_id for o in reversed(ents[:x]) if o.job_id), None)
        nxt = next((o.job_id for o in ents[x + 1:] if o.job_id), None)
        os.makedirs(trash_dir, exist_ok=True)
        _atomic_json(tp, {"entry": "".join(lines[e.start:e.end]), "prev": prev, "next": nxt, "stamp": e.stamp,
                          "removed": time.time()})
        try:
            _replace(p, "".join(lines[:e.start] + lines[e.end:]), _mode(p))
        except BaseException:
            _unlink(tp)  # roll back: the entry is still in the log, so it must not also read as removed
            raise
        _bump_revision(lfd)
    return False


def restore_entry(job_id: str, trash_dir: str, path: str = None) -> bool:
    """Put a removed entry back in place: after the entry that was before it, else before the one that was after it,
    else among the others by its date, else at the bottom. One transaction under locked(); the kept copy is deleted only
    after the log is written. Idempotent: an entry that is in the log already stays as it is (and a stale kept copy is
    dropped). Returns True (saved). Raises NoSuchEntry when the id is in neither place, LogUnreadable or OSError."""
    if not _JOB_ID.match(job_id or ""):
        raise NoSuchEntry(job_id)
    p = path or log_path()
    tp = _trash_path(trash_dir, job_id)
    with locked(p) as lfd:
        text, _ = _read_text(p)
        text = text or ""
        lines = _lines(text)
        ents = _scan(lines)
        if any(e.job_id == job_id for e in ents):
            _unlink(tp)
            return True
        try:
            with open(tp, encoding="utf-8") as f:
                kept = json.load(f)
            entry = kept["entry"]
            if not isinstance(entry, str) or not entry.startswith("## "):
                raise ValueError("damaged")
        except FileNotFoundError:
            raise NoSuchEntry(job_id)
        except (OSError, ValueError, KeyError, TypeError) as err:
            raise NoSuchEntry(job_id) from err
        by_id = {e.job_id: e for e in ents if e.job_id}
        pos = None
        if kept.get("prev") in by_id:
            pos = by_id[kept["prev"]].end
        elif kept.get("next") in by_id:
            pos = by_id[kept["next"]].start
        stamp = kept.get("stamp") if isinstance(kept.get("stamp"), str) else None
        if pos is None and stamp:
            pos = next((e.start for e in ents if e.stamp > stamp), None)
        if pos is not None and stamp:
            # keep the dates in order around it: step past older entries that arrived after, and back before newer ones
            ahead = [e for e in ents if e.start >= pos]
            while ahead and ahead[0].stamp < stamp:
                pos = ahead.pop(0).end
            behind = [e for e in ents if e.end <= pos]
            while behind and behind[-1].stamp > stamp:
                pos = behind.pop().start
        nl = "\r\n" if "\r\n" in text else "\n"
        if not text:
            new = HEADING + entry
        elif pos is None or pos >= len(lines):
            sep = "" if text.endswith(("\n\n", "\r\n\r\n")) else (nl if text.endswith("\n") else nl + nl)
            new = text + sep + entry
        else:
            before, after = "".join(lines[:pos]), "".join(lines[pos:])
            if before and not before.endswith("\n"):
                before += nl + nl
            if not entry.endswith("\n"):
                entry += nl + nl  # a cut-off entry going back in the middle keeps its own lines
            new = before + entry + after
        _replace(p, new, _mode(p))
        _bump_revision(lfd)
        _unlink(tp)
    return True
