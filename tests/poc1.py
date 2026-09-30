"""Runs the PoC 1 sources, writes tests/poc1-results.json."""
import json
import sys
import urllib.parse

from dipdive.cli import run_job
from dipdive.tmp import sweep_stale

yt = lambda v: f"https://www.youtube.com/watch?v={v}"
wrapped = "https://www.google.com/url?q=" + urllib.parse.quote(yt("iG9CE55wbtY") + "&t=30s", safe="") + "&sa=D&source=gmail&ust=1&usg=x"
CASES = [
    ("manual English captions (TED)", yt("iG9CE55wbtY"), "claude-dip"),
    ("automatic captions only", yt("iMVgvkVJuDI"), "claude-dip"),
    ("non-English (German, manual de)", yt("FYh4dWI-bqQ"), "claude-dip"),
    ("no captions (8 h rain sounds)", yt("mPZkdNFkNps"), "claude-dip"),
    ("over 2 hours (3 h 31 m, auto captions)", yt("7xTGNNLPyMI"), "claude-dive"),
    ("Short (youtube.com/shorts)", "https://www.youtube.com/shorts/kKJr6eiLcoE", "claude-dip"),
    ("Gmail-wrapped link to TED video", wrapped, "claude-dip"),
    ("plain blog post (Paul Graham)", "https://paulgraham.com/ds.html", "claude-dip"),
    ("plain blog post (Paul Graham)", "https://paulgraham.com/ds.html", "claude-dive"),
    ("paywalled article (NYT)", "https://www.nytimes.com/2026/09/30/technology/meta-ai-data-centers-taxes.html", "claude-dip"),
    ("codex isolation of a real source (TED)", yt("iG9CE55wbtY"), "codex-dip"),
    ("Short without captions", "https://www.youtube.com/shorts/MNoEtQXekBM", "claude-dip"),
    ("over 2 hours, source only", yt("7xTGNNLPyMI"), "source"),
]
if __name__ == "__main__":
    sweep_stale()
    sel = set(map(int, sys.argv[1:])) or set(range(1, len(CASES) + 1))
    out = []
    for i, (name, url, mode) in enumerate(CASES, 1):
        if i not in sel:
            continue
        r = run_job(url, mode)
        r["n"], r["name"] = i, name
        if mode == "source" and r.get("text"):
            r["text"] = f"[{len(r['text'])} chars] " + r["text"][:300] + " ... " + r["text"][-300:]
        out.append(r)
        print(i, name, mode, r["error_code"], r["seconds"], flush=True)
    json.dump(out, open("tests/poc1-results.json", "w"), indent=1, ensure_ascii=False)
