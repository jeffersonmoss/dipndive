"""Live sample (network, no model calls): free articles must extract in full and not be refused.
Run: .venv/bin/python -m tests.live_articles"""
import re
import urllib.request

from dipdive import acquire
from dipdive.errors import DipDiveError

FEEDS = ["https://feeds.arstechnica.com/arstechnica/index", "https://www.theguardian.com/uk/rss",
         "https://www.wired.com/feed/rss", "https://www.newyorker.com/feed/everything",
         "https://blog.cloudflare.com/rss/"]
FIXED = ["https://arstechnica.com/science/2026/09/dinosaur-killing-impact-crater-might-have-been-teeming-with-life/",
         "https://paulgraham.com/ds.html", "https://en.wikipedia.org/wiki/Sourdough"]


def links(feed, n=3):
    req = urllib.request.Request(feed, headers={"User-Agent": "Mozilla/5.0 DipDive-test"})
    xml = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    return re.findall(r"<link>(https?://[^<]+)</link>", xml)[1:n + 1]


if __name__ == "__main__":
    urls = list(FIXED)
    for f in FEEDS:
        try:
            urls += links(f)
        except Exception as e:
            print("feed failed", f, e)
    for u in urls:
        try:
            s = acquire.fetch_article(u)
            print("OK     ", len(s.text), u[:100])
        except DipDiveError as e:
            print("REFUSED", e.code, e.message[:60], u[:100])
