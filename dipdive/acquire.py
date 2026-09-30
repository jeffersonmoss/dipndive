"""Content acquisition (plan 3.3): URL unwrapping, YouTube captions via yt-dlp, articles via trafilatura."""
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import urllib.parse
import zlib

from .errors import DipDiveError
from .proc import run
from .tmp import tempdir

BIN_DIR = os.path.dirname(os.path.abspath(sys.executable))
YTDLP = os.path.join(BIN_DIR, "yt-dlp")
DENO = "/opt/homebrew/bin/deno"

T_META, T_CAPS, T_ARTICLE = 30, 60, 10
ARTICLE_MAX_BYTES = 5 * 1024 * 1024
MIN_ARTICLE_CHARS = 800
# Estimated tokens (chars / 4). Provisional until each model's context is confirmed on his account.
TOKEN_BUDGET = 120_000


class Source:
    def __init__(self, kind, source_id, title, url, text, meta=None):
        self.kind, self.source_id, self.title, self.url, self.text = kind, source_id, title, url, text
        self.meta = meta or {}

    @property
    def est_tokens(self):
        return len(self.text) // 4


# ---------- 3.3.1 / 3.3.2 URL handling ----------

_WRAPPERS = [
    (re.compile(r"(^|\.)google\.[a-z.]+$"), "/url", ("q", "url")),
    (re.compile(r"(^|\.)youtube\.com$"), "/redirect", ("q",)),
    (re.compile(r"^l\.facebook\.com$"), "/l.php", ("u",)),
]


def unwrap(url: str) -> str:
    for _ in range(5):
        u = urllib.parse.urlparse(url)
        host = (u.hostname or "").lower()
        for hre, path, keys in _WRAPPERS:
            if hre.search(host) and u.path == path:
                qs = urllib.parse.parse_qs(u.query)
                for k in keys:
                    if qs.get(k):
                        url = qs[k][0]
                        break
                else:
                    continue
                break
        else:
            return url
    return url


_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_id(url: str):
    """Return (video_id | None, is_youtube). Playlist-only and channel links give (None, True)."""
    u = urllib.parse.urlparse(url)
    host = (u.hostname or "").lower()
    qs = urllib.parse.parse_qs(u.query)
    if host == "youtu.be":
        vid = u.path.strip("/").split("/")[0]
        return (vid if _ID.match(vid) else None), True
    if host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com"):
        if u.path == "/watch" and qs.get("v") and _ID.match(qs["v"][0]):
            return qs["v"][0], True
        m = re.match(r"^/(shorts|live|embed|v)/([A-Za-z0-9_-]{11})(/|$)", u.path)
        if m:
            return m.group(2), True
        return None, True
    return None, False


# ---------- 3.3.3 to 3.3.5 YouTube ----------

def _classify_ytdlp(err: str):
    e = err.lower()
    if "private video" in e:
        return "private", "video is private"
    if "members-only" in e or "members only" in e or "join this channel" in e:
        return "members_only", "members-only video"
    if "sign in to confirm your age" in e or "age-restricted" in e or "age restricted" in e:
        return "age_gated", "age-gated video"
    if "video unavailable" in e or "has been removed" in e or "no longer available" in e or "this video is not available" in e:
        return "unavailable", "video removed or unavailable"
    if "429" in e or "too many requests" in e:
        return "rate_limited", "YouTube rate limit"
    if "sign in to confirm you" in e and "bot" in e:
        return "rate_limited", "YouTube bot check"
    return "extract_failed", err.strip().splitlines()[-1][:300] if err.strip() else "yt-dlp failed"


def _ytdlp(args, timeout):
    base = [YTDLP, "--no-config", "--js-runtimes", f"deno:{DENO}"]
    rc, out, err = run(base + args, timeout)
    if rc != 0:
        code, msg = _classify_ytdlp(err)
        raise DipDiveError(code, msg)
    return out


def pick_track(info: dict):
    """Plan 3.3.4. Returns (lang_code, is_auto) or raises no_captions."""
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    lang = (info.get("language") or "").lower()
    if "en" in subs:
        return "en", False
    for k in subs:
        if k.lower().startswith("en-") and not k.lower().endswith("-orig"):
            return k, False
    if "en-orig" in auto:
        return "en-orig", True
    if "en" in auto and lang.startswith("en"):
        return "en", True
    if lang and lang in subs:
        return lang, False
    if lang and f"{lang}-orig" in auto:
        return f"{lang}-orig", True
    # Manual track in the video's own language under a regional code, e.g. es-419 when language is "es".
    if lang:
        for k in subs:
            if k.lower().split("-")[0] == lang.split("-")[0]:
                return k, False
        for k in auto:
            if k.lower().endswith("-orig") and k.lower().split("-")[0] == lang.split("-")[0]:
                return k, True
    raise DipDiveError("no_captions", "no usable manual or original-language caption track")


def _parse_json3(raw: str) -> str:
    data = json.loads(raw)
    lines = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        t = "".join(s.get("utf8", "") for s in segs).replace("\n", " ").strip()
        if t:
            lines.append(t)
    return _dedupe(lines)


_TAG = re.compile(r"<[^>]+>")


def _parse_vtt(raw: str) -> str:
    lines = []
    for block in re.split(r"\n\s*\n", raw):
        ls = [l for l in block.splitlines() if l.strip()]
        if not ls or ls[0].startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE")):
            continue
        for l in ls:
            if "-->" in l or re.fullmatch(r"\d+", l.strip()):
                continue
            t = _TAG.sub("", l).strip()
            if t:
                lines.append(t)
    return _dedupe(lines)


def _dedupe(lines):
    """Collapse rolling duplicate lines of automatic captions."""
    out = []
    for l in lines:
        if out and (l == out[-1] or out[-1].endswith(l)):
            continue
        if out and l.startswith(out[-1]):
            out[-1] = l
            continue
        out.append(l)
    return " ".join(out)


def fetch_youtube(url: str, vid: str) -> Source:
    canon = f"https://www.youtube.com/watch?v={vid}"
    with tempdir("yt-dlp metadata and one caption track") as d:
        out = _ytdlp(["-J", "--no-playlist", canon], T_META)
        try:
            info = json.loads(out)
        except json.JSONDecodeError:
            raise DipDiveError("extract_failed", "metadata was not JSON")
        if info.get("live_status") == "is_live":
            raise DipDiveError("live_in_progress", "live stream in progress")
        if info.get("availability") in ("private", "needs_auth", "subscriber_only", "premium_only"):
            raise DipDiveError("unavailable", f"availability: {info['availability']}")
        lang, is_auto = pick_track(info)
        ipath = os.path.join(d, "info.json")
        with open(ipath, "w") as f:
            json.dump(info, f)
        _ytdlp([
            "--load-info-json", ipath, "--skip-download",
            "--write-auto-subs" if is_auto else "--write-subs",
            "--sub-langs", lang, "--sub-format", "json3/vtt/best",
            "-o", os.path.join(d, "sub"),
        ], T_CAPS)
        files = [f for f in os.listdir(d) if f.startswith("sub.") and f != "info.json"]
        if not files:
            raise DipDiveError("no_captions", f"track {lang} did not download")
        path = os.path.join(d, files[0])
        raw = open(path, encoding="utf-8", errors="replace").read()
        text = _parse_json3(raw) if path.endswith(".json3") else _parse_vtt(raw)
    if not text.strip():
        raise DipDiveError("no_captions", "caption track was empty")
    return Source("youtube", vid, info.get("title") or vid, canon, text,
                  {"duration": info.get("duration"), "track": lang, "auto": is_auto,
                   "language": info.get("language")})


# ---------- 3.3.6 articles ----------

def _host_ok(host: str):
    h = host.lower().rstrip(".")
    if h.endswith((".ts.net", ".local", ".internal", ".localhost")) or h in ("localhost", "metadata.google.internal"):
        raise DipDiveError("blocked_address", f"host {host} refused")
    try:
        infos = socket.getaddrinfo(h, None)
    except socket.gaierror:
        raise DipDiveError("extract_failed", f"cannot resolve {host}")
    cgnat = ipaddress.ip_network("100.64.0.0/10")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast
                or ip.is_unspecified or (ip.version == 4 and ip in cgnat)
                or str(ip) == "169.254.169.254"):
            raise DipDiveError("blocked_address", f"{host} resolves to {ip}")


def _fetch_html(url: str, deadline_s: float = T_ARTICLE) -> tuple:
    import time
    start = time.monotonic()
    for _ in range(6):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise DipDiveError("not_a_video", "only http(s) URLs are supported")
        if u.username or u.password:
            raise DipDiveError("blocked_address", "credentials in URL refused")
        _host_ok(u.hostname)
        remaining = deadline_s - (time.monotonic() - start)
        if remaining <= 0:
            raise DipDiveError("timeout", "article fetch deadline")
        cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        kw = {"context": ssl.create_default_context()} if u.scheme == "https" else {}
        conn = cls(u.hostname, u.port, timeout=min(remaining, 10), **kw)
        try:
            path = (u.path or "/") + (("?" + u.query) if u.query else "")
            conn.request("GET", path, headers={
                "Host": u.netloc, "User-Agent": "Mozilla/5.0 (Macintosh) DipDive/0.1",
                "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "en"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("Location")
                if not loc:
                    raise DipDiveError("extract_failed", "redirect without Location")
                url = urllib.parse.urljoin(url, loc)
                continue
            if r.status in (401, 402, 403):
                raise DipDiveError("no_article_text", f"HTTP {r.status} (login, paywall or bot block)")
            if r.status == 429:
                raise DipDiveError("rate_limited", "HTTP 429")
            if r.status >= 400:
                raise DipDiveError("extract_failed", f"HTTP {r.status}")
            enc = (r.getheader("Content-Encoding") or "").lower()
            body = b""
            dec = zlib.decompressobj(47 if enc == "gzip" else (-15 if enc == "deflate" else 0)) if enc in ("gzip", "deflate") else None
            while True:
                if time.monotonic() - start > deadline_s:
                    raise DipDiveError("timeout", "article fetch deadline")
                chunk = r.read(65536)
                if not chunk:
                    break
                body += dec.decompress(chunk) if dec else chunk
                if len(body) > ARTICLE_MAX_BYTES:
                    raise DipDiveError("too_long", "article over 5 MB")
            ctype = r.getheader("Content-Type") or ""
            m = re.search(r"charset=([\w-]+)", ctype, re.I)
            return body.decode(m.group(1) if m else "utf-8", errors="replace"), url
        except (socket.timeout, TimeoutError):
            raise DipDiveError("timeout", "article fetch timed out")
        except (OSError, http.client.HTTPException) as e:
            raise DipDiveError("extract_failed", f"{type(e).__name__}: {e}")
        finally:
            conn.close()
    raise DipDiveError("extract_failed", "too many redirects")


_PAYWALL = re.compile(r"(subscribe to (continue|read)|sign in to (continue|read)|log in to (continue|read)|"
                      r"create a free account to|already a subscriber|this content is for subscribers)", re.I)


def fetch_article(url: str) -> Source:
    import trafilatura
    html, final = _fetch_html(url)
    text = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
    if len(text) < MIN_ARTICLE_CHARS or (_PAYWALL.search(text) and len(text) < 3000):
        raise DipDiveError("no_article_text", f"extracted {len(text)} chars (login, paywall or no article)")
    md = trafilatura.extract_metadata(html)
    title = (md.title if md and md.title else final)
    return Source("article", final, title, final, text)


def acquire(url: str) -> Source:
    url = unwrap(url.strip())
    vid, is_yt = youtube_id(url)
    if is_yt:
        if not vid:
            raise DipDiveError("not_a_video", "playlist, channel or unrecognized YouTube link")
        s = fetch_youtube(url, vid)
    else:
        s = fetch_article(url)
    if s.est_tokens > TOKEN_BUDGET:
        raise DipDiveError("too_long", f"about {s.est_tokens} tokens exceeds budget {TOKEN_BUDGET}")
    return s
