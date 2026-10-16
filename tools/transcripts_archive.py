#!/usr/bin/env python3
"""Thing 2's copy of every Dip'n'Dive transcript, and the "get my latest transcript" lookup.

Installed on Thing 2 as ~/.local/bin/dipdive-transcript (a copy of this file). Standard library only.

    dipdive-transcript            the newest Dip: title, link, summary and full transcript
    dipdive-transcript 3          the third newest
    dipdive-transcript --list 10  the ten newest, numbered
    dipdive-transcript --sync     copy new Dips from the iMac and exit (the LaunchAgent runs this every 5 minutes)

Every lookup first tries a quick sync from the companion on the iMac (GET /history, then GET /transcript?url= for each
Dip not yet copied), then reads the local archive, so it works with the iMac off. Nothing is ever deleted here.
Archive: ~/Documents/Dip'n'Dive Transcripts (one Markdown file per Dip plus index.json). Token: Thing 2's copy at
~/Library/Application Support/DipDive/token, never printed.
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("DIPDIVE_BASE", "https://jeffersons-imac.tailb5e03c.ts.net:8443")
TOKEN_PATH = os.path.expanduser(os.environ.get("DIPDIVE_TOKEN_FILE", "~/Library/Application Support/DipDive/token"))
ARCHIVE = os.path.expanduser(os.environ.get("DIPDIVE_ARCHIVE", "~/Documents/Dip'n'Dive Transcripts"))
INDEX = os.path.join(ARCHIVE, "index.json")
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
EXTRA_WORDS = ["again", "third copy", "fourth copy", "fifth copy", "sixth copy", "seventh copy", "eighth copy"]


def _token():
    with open(TOKEN_PATH) as f:
        return f.read().strip()


def _get(path, timeout):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + _token()})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _load_index():
    try:
        with open(INDEX) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".writing-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _date_words(day):
    try:
        y, m, d = (int(x) for x in day.split("-"))
        return f"{d} {MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return "undated"


def _file_name(entry, taken):
    """<title> - <Claude Dip> - <16 October 2026>.md. Jefferson's naming rule: at most three numeric chunks of up to
    four digits, words between them, so the title keeps at most its first short number and loses the rest."""
    title = re.sub(r'[/\\:*?"<>|\x00-\x1f]', " ", entry.get("title") or "Untitled")
    kept = []

    def num(m):
        if not kept and len(m.group(0)) <= 4:
            kept.append(m.group(0))
            return m.group(0)
        return ""
    title = re.sub(r"\d+", num, title)
    title = re.sub(r"(?<=\w)[.,-]+(?=\s|$)", "", title)  # "GPT-" or "v." left behind by a dropped number
    title = re.sub(r"\s+", " ", re.sub(r"\s*([.,-])(\s*[.,-])+", r"\1", title)).strip(" .-,") or "Untitled"
    title = title[:120].rstrip(" .-,")
    mode = re.sub(r"[^A-Za-z' ]", "", entry.get("mode_label") or "Dip").strip() or "Dip"
    base = f"{title} - {mode} - {_date_words(entry.get('date') or '')}"
    name = base + ".md"
    for word in EXTRA_WORDS:
        if name not in taken:
            break
        name = f"{base} - {word}.md"
    return name


def _render(entry, src):
    lines = [f"# {entry.get('title') or 'Untitled'}", ""]
    channel = entry.get("channel") or (src or {}).get("channel") or ""
    if channel:
        lines.append(f"Channel: {channel}  ")
    lines.append(f"Link: {entry.get('url')}  ")
    lines.append(f"Dipped: {_date_words(entry.get('date') or '')} {entry.get('time') or ''} ({entry.get('mode_label') or 'Dip'})  ")
    lines += [f"Job: {entry.get('job_id')}", "", "## Summary", "", (entry.get("summary") or "").strip(), "", "## Transcript", ""]
    lines.append(src["text"].strip() if src else "(The transcript was not available from the iMac when this Dip was copied.)")
    return "\n".join(lines) + "\n"


def sync(timeout=8, quiet=False):
    """Copy every Dip in the log that is not here yet (or is here without its transcript). Returns how many changed."""
    os.makedirs(ARCHIVE, exist_ok=True)
    idx = _load_index()
    entries, before = [], None
    while True:
        q = "/history?limit=100" + (f"&before={before}" if before is not None else "")
        page = _get(q, timeout)
        entries += page.get("entries", [])
        before = page.get("next_before")
        if before is None:
            break
    taken = {v.get("file") for v in idx.values()}
    changed = 0
    for e in entries:
        jid = e.get("job_id")
        if not jid or not e.get("url"):
            continue
        have = idx.get(jid)
        if have and have.get("transcript"):
            continue
        src = None
        try:
            src = _get("/transcript?url=" + urllib.parse.quote(e["url"], safe=""), timeout)
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
        if have and not src:
            continue  # still no transcript; the summary-only copy stays as it is
        name = have["file"] if have else _file_name(e, taken)
        taken.add(name)
        _write_atomic(os.path.join(ARCHIVE, name), _render(e, src))
        idx[jid] = {"file": name, "transcript": bool(src), "date": e.get("date") or "", "time": e.get("time") or "",
                    "title": e.get("title") or "", "url": e["url"], "mode": e.get("mode_label") or "",
                    "copied": time.strftime("%Y-%m-%d %H:%M")}
        _write_atomic(INDEX, json.dumps(idx, indent=1, ensure_ascii=False))
        changed += 1
    if not quiet:
        print(f"synced: {changed} new or completed, {len(idx)} kept", file=sys.stderr)
    return changed


def newest_first():
    idx = _load_index()
    return sorted(idx.values(), key=lambda v: (v.get("date", ""), v.get("time", ""), v.get("copied", "")), reverse=True)


def main(argv):
    args = argv[1:]
    if "--sync" in args:
        try:
            sync(quiet="--quiet" in args)
            return 0
        except Exception as e:  # the LaunchAgent's log gets one line; the next run tries again
            print(f"sync failed: {type(e).__name__}: {e}", file=sys.stderr)
            return 1
    if "--no-sync" not in args:
        try:
            sync(timeout=4, quiet=True)
        except Exception as e:
            print(f"(iMac not reached, using Thing 2's copy: {type(e).__name__})", file=sys.stderr)
    items = newest_first()
    if "--list" in args:
        rest = [a for a in args if a.isdigit()]
        for i, v in enumerate(items[:int(rest[0]) if rest else 10], 1):
            flag = "" if v.get("transcript") else "  [no transcript]"
            print(f"{i}. {v['title']} ({v.get('mode')}, {v.get('date')} {v.get('time')}){flag}")
        return 0
    nums = [a for a in args if a.isdigit()]
    n = int(nums[0]) if nums else 1
    if not 1 <= n <= len(items):
        print(f"there are {len(items)} Dips in the archive", file=sys.stderr)
        return 1
    path = os.path.join(ARCHIVE, items[n - 1]["file"])
    print(f"File: {path}\n")
    with open(path) as f:
        sys.stdout.write(f.read())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
