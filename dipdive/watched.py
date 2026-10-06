"""Monthly Markdown transcript archive for videos watched in the extension."""
import fcntl
import os
import re
import time
import urllib.parse

from . import historylog
from .acquire import youtube_id


def is_short_or_live_url(url):
    """True for YouTube Shorts and live URL paths, which are never recorded."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except (TypeError, ValueError):
        return False
    host = (parsed.hostname or "").lower().removeprefix("www.")
    return (host == "youtube.com" or host.endswith(".youtube.com")) and bool(
        re.match(r"^/(?:shorts|live)(?:/|$)", parsed.path))


def transcripts_dir(log_path=None):
    configured = os.environ.get("DIPDIVE_TRANSCRIPTS_DIR")
    return os.path.expanduser(configured) if configured else os.path.dirname(os.path.abspath(log_path or historylog.log_path()))


def locked(log_path=None):
    """Use the history log's stable, fail-closed sidecar lock for archive/index transactions."""
    return historylog.locked(log_path or historylog.log_path())


def _one_line(value):
    return re.sub(r"\s+", " ", value or "").strip()


def _link(url):
    safe = _one_line(url).replace("<", "%3C").replace(">", "%3E").replace("\\", "%5C")
    label = _one_line(url).replace("[", "\\[").replace("]", "\\]")
    return f"[{label}](<{safe}>)"


def format_entry(source, url, when=None):
    when = time.localtime(time.time() if when is None else when)
    title = _one_line(source.title) or "Untitled"
    channel = _one_line((source.meta or {}).get("channel") or "Unknown")
    stamp = time.strftime("%Y-%m-%d %H:%M", when)
    text = (source.text or "").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = "\n\n".join(" ".join(p.split()) for p in re.split(r"\n\s*\n", text) if p.strip())
    return f"## {title}\n\nChannel: {channel}\n\n{stamp}\n\n{_link(url)}\n\n{paragraphs}\n\n---\n\n"


def contains_video(directory, video_id):
    """Recover safely if a process stopped after the Markdown append but before index update."""
    if not os.path.isdir(directory):
        return False
    needle = re.compile(r"(?:[?&]v=|youtu\.be/|/shorts/|/live/)" + re.escape(video_id) + r"(?:[&#>/\s)]|$)")
    for name in os.listdir(directory):
        if not (name.startswith("Dipn Dive Transcripts - ") and name.endswith(".md")):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as f:
                for line in f:
                    if needle.search(line):
                        return True
        except OSError:
            raise
    return False


def append(source, url, directory=None, when=None):
    log_path = historylog.log_path()
    directory = directory or transcripts_dir()
    os.makedirs(directory, exist_ok=True)
    local = time.localtime(time.time() if when is None else when)
    name = time.strftime("Dipn Dive Transcripts - %B %Y.md", local)
    path = os.path.join(directory, name)
    vid, is_youtube = youtube_id(url)
    if not is_youtube or not vid:
        raise ValueError("transcript URL must identify a YouTube video")
    data = format_entry(source, url, when).encode("utf-8", "replace")
    with locked(log_path):
        if contains_video(directory, vid):
            return False
        fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError:
                pass  # the stable history sidecar lock above is mandatory
            size = os.fstat(fd).st_size
            if size:
                tail = os.pread(fd, 2, max(0, size - 2))
                prefix = b"" if tail.endswith(b"\n\n") else (b"\n" if tail.endswith(b"\n") else b"\n\n")
            else:
                prefix = b"# Dip'n'Dive Watched Transcripts\n\n"
            payload = prefix + data
            n = os.write(fd, payload)
            if n != len(payload):
                raise OSError("short transcript append")
            os.fsync(fd)
        finally:
            os.close(fd)
    return True
