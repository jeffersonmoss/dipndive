"""Content acquisition (plan 3.3): URL unwrapping, YouTube captions via yt-dlp, articles via trafilatura."""
import json
import os
import re
import sys
import urllib.parse

from .errors import DipDiveError
from .proc import run_or_timeout
from .tmp import tempdir

BIN_DIR = os.path.dirname(os.path.abspath(sys.executable))
YTDLP = os.path.join(BIN_DIR, "yt-dlp")
DENO = os.environ.get("DIPDIVE_DENO") or "/opt/homebrew/bin/deno"

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
    (re.compile(r"^(www\.)?google\.(com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$"), "/url", ("q", "url")),
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
    r = run_or_timeout(base + args, timeout, max_bytes=50_000_000)
    if r.rc != 0:
        code, msg = _classify_ytdlp(r.err_text)
        raise DipDiveError(code, msg)
    return r.text


def _is_translation(entries) -> bool:
    """Machine-translated automatic tracks are fetched with tlang=<code>."""
    return any("tlang=" in (e.get("url") or "") for e in (entries or []))


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
    if "en-orig" in auto and not _is_translation(auto["en-orig"]):
        return "en-orig", True
    if "en" in auto and not _is_translation(auto["en"]):
        return "en", True
    if lang and lang in subs:
        return lang, False
    if lang and f"{lang}-orig" in auto and not _is_translation(auto[f"{lang}-orig"]):
        return f"{lang}-orig", True
    if lang:
        for k in subs:
            if k.lower().split("-")[0] == lang.split("-")[0]:
                return k, False
        for k in auto:
            if (k.lower().endswith("-orig") and k.lower().split("-")[0] == lang.split("-")[0]
                    and not _is_translation(auto[k])):
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


def channel_name(info) -> str:
    """The channel from yt-dlp metadata: `channel`, else `uploader`, else empty (never raises)."""
    for k in ("channel", "uploader"):
        v = info.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


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
                   "language": info.get("language"), "channel": channel_name(info)})


# ---------- 3.3.6 articles ----------
# The whole fetch (DNS, connect, headers, body, redirects) runs in a worker subprocess so a hard
# wall-clock limit applies and the whole process group dies on timeout. See fetch_worker.py.

ALLOWED_CTYPES = ("text/html", "application/xhtml+xml")


def _fetch_html(url: str, deadline_s: float = T_ARTICLE):
    """Returns (raw bytes, final url). Raises DipDiveError."""
    r = run_or_timeout([sys.executable, "-m", "dipdive.fetch_worker", url], deadline_s,
                       cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), max_bytes=ARTICLE_MAX_BYTES + 65536)
    if r.truncated:
        raise DipDiveError("too_long", "article over 5 MB")
    if r.rc != 0:
        try:
            e = json.loads(r.err_text.strip().splitlines()[-1])
            raise DipDiveError(e["code"], e["message"])
        except (ValueError, KeyError, IndexError):
            raise DipDiveError("extract_failed", "fetch worker failed")
    head, _, body = r.out.partition(b"\n")
    meta = json.loads(head)
    ctype = (meta.get("content_type") or "").split(";")[0].strip().lower()
    if ctype and ctype not in ALLOWED_CTYPES:
        raise DipDiveError("no_article_text", f"content type {ctype} is not HTML")
    return body, meta["url"]


# Phrases that appear as paywall or login prompts, not in ordinary prose. Checked in the last 400 characters
# of the extracted text, or anywhere when the body is short.
_PAYWALL_PHRASES = re.compile(
    r"(subscribe (to|now to)[^.\n]{0,30}(continue|keep) reading|subscribe to read|subscribers only|"
    r"(for|to) (paid )?(subscribers|members) only|already a (paid )?(subscriber|member)\b|"
    r"(sign|log) ?in to (continue reading|read (the|this) (full|rest|whole))|"
    r"create a free account to (read|continue)|register (for free )?to (continue reading|read)|"
    r"to continue reading( this (article|story))?,? (please )?(subscribe|sign|log|register)|"
    r"this (article|story|content) is (only )?(available )?(to|for) (paid )?(subscribers|members)|"
    r"unlock this (article|story)|become a (paid )?(member|subscriber) to (read|continue)|"
    r"free (articles?|stories) (remaining|left))", re.I)
SHORT_BODY = 2000
TAIL = 400

_ARTICLE_TYPES = {"article", "newsarticle", "reportagenewsarticle", "analysisnewsarticle", "opinionnewsarticle",
                  "blogposting", "webpage", "scholarlyarticle", "techarticle", "report", "creativework"}


def _is_false(v) -> bool:
    if isinstance(v, bool):
        return v is False
    if isinstance(v, str):
        return v.strip().lower().rstrip("/").split("/")[-1] == "false"
    return False


def _types(obj) -> set:
    t = obj.get("@type")
    t = t if isinstance(t, list) else [t]
    return {str(x).lower().split("/")[-1].split(":")[-1] for x in t if x}


def declared_paywalled(html: str) -> bool:
    """True when the page's OWN main entity (not a related item) declares isAccessibleForFree false.
    Checks JSON-LD top-level objects and @graph members, and microdata on top-level itemscopes."""
    from lxml import html as lh
    try:
        doc = lh.fromstring(html)
    except Exception:
        return False
    for sc in doc.xpath('//script[@type="application/ld+json"]'):
        try:
            data = json.loads(sc.text_content())
        except (ValueError, TypeError):
            continue
        cands = []
        for top in (data if isinstance(data, list) else [data]):
            if isinstance(top, dict):
                cands.append(top)
                g = top.get("@graph")
                if isinstance(g, list):
                    cands += [x for x in g if isinstance(x, dict)]
        for o in list(cands):  # the page's own main entity, one level down
            for k in ("mainEntity", "mainEntityOfPage"):
                v = o.get(k)
                for m in (v if isinstance(v, list) else [v]):
                    if isinstance(m, dict):
                        cands.append(m)
        for o in cands:
            if _types(o) & _ARTICLE_TYPES and "isAccessibleForFree" in o and _is_false(o["isAccessibleForFree"]):
                return True
    for el in doc.xpath('//*[@itemprop="isAccessibleForFree"]'):
        scope = next((a for a in el.iterancestors() if a.get("itemscope") is not None), None)
        if scope is None:
            continue
        if any(a.get("itemscope") is not None for a in scope.iterancestors()):
            continue  # nested scope: a related item, not the page itself
        itype = (scope.get("itemtype") or "").lower().rsplit("/", 1)[-1]
        if itype not in _ARTICLE_TYPES:
            continue
        val = el.get("content") or el.get("href") or el.text_content()
        if _is_false(val):
            return True
    return False


_JUNK_TAGS = {"aside", "nav", "footer", "form", "script", "style", "noscript", "iframe", "button"}
_JUNK_ATTR = re.compile(r"comment|related|promo|newsletter|sidebar|recirc|more-stories|share|social|advert|outbrain|"
                        r"taboola|disqus|subscribe|signup|trending|read-next", re.I)


def _shingles(text: str, n: int = 5) -> set:
    w = re.findall(r"\w+", text.lower())
    return {" ".join(w[i:i + n]) for i in range(max(len(w) - n + 1, 0))}


def _clean_paragraphs(el) -> str:
    """Paragraphs (40+ chars) of el with comment, related, promo, newsletter, aside, nav and footer parts removed."""
    import copy
    el = copy.deepcopy(el)
    for d in list(el.iterdescendants()):
        if not isinstance(d.tag, str):
            continue
        attrs = f"{d.get('class') or ''} {d.get('id') or ''}"
        if d.tag in _JUNK_TAGS or _JUNK_ATTR.search(attrs):
            if d.getparent() is not None:
                d.drop_tree()
    ps = [" ".join(p.text_content().split()) for p in el.xpath(".//p")]
    return "\n".join(p for p in ps if len(p) >= 40)


def _dom_article_text(html: str, reference: str = "") -> str:
    """Second opinion on extraction. Candidates are every <article>, <main> and role=main element; the one that
    contains most of the extractor's own text wins, so the result can only extend the same story (never another
    story or a different region). With no reference text there is nothing to anchor on, and it returns ''."""
    from lxml import html as lh
    try:
        doc = lh.fromstring(html)
    except Exception:
        return ""
    ref = _shingles(reference)
    if not ref:
        return ""
    best, best_cov = "", 0.0
    for xp in ("//article", "//main", '//*[@role="main"]'):
        for el in doc.xpath(xp):
            t = _clean_paragraphs(el)
            if not t:
                continue
            cov = len(ref & _shingles(t)) / len(ref)
            if cov > best_cov or (cov == best_cov and len(t) > len(best)):
                best, best_cov = t, cov
    return best if best_cov >= 0.6 else ""


def fetch_article(url: str) -> Source:
    import trafilatura
    from trafilatura.utils import decode_file
    raw, final = _fetch_html(url)
    try:
        html = decode_file(raw)
    except Exception:
        html = raw.decode("utf-8", errors="replace")
    if declared_paywalled(html):
        raise DipDiveError("no_article_text", "page declares isAccessibleForFree=false (paywalled)")
    text = trafilatura.extract(raw, include_comments=False, include_tables=False, favor_recall=True) or ""
    dom = _dom_article_text(html, text)
    if len(dom) >= MIN_ARTICLE_CHARS and len(dom) > 1.5 * len(text):
        text = dom  # extractor kept under two thirds of the article's own paragraphs
    if len(text) < MIN_ARTICLE_CHARS:
        raise DipDiveError("no_article_text", f"extracted {len(text)} chars (login, paywall or no article)")
    if _PAYWALL_PHRASES.search(text if len(text) < SHORT_BODY else text[-TAIL:]):
        raise DipDiveError("no_article_text", "text ends with a paywall or login prompt")
    md = trafilatura.extract_metadata(html)
    title = (md.title if md and md.title else final)
    site = getattr(md, "sitename", None) if md else None
    return Source("article", final, title, final, text, {"channel": site.strip() if isinstance(site, str) else ""})


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
