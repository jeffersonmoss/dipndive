"""dipdive <url> <mode>: modes claude-dip, claude-dive, codex-dip, codex-dive, source."""
import sys
import time

from .acquire import acquire
from .errors import DipDiveError
from .models import call_model
from .tmp import sweep_stale

MODES = ("claude-dip", "claude-dive", "codex-dip", "codex-dive", "source")


def run_job(url: str, mode: str) -> dict:
    t0 = time.monotonic()
    res = {"url": url, "mode": mode, "title": None, "error_code": None, "error_message": None, "text": None}
    try:
        src = acquire(url)
        res["title"] = src.title
        res["meta"] = {**src.meta, "kind": src.kind, "chars": len(src.text)}
        res["fetch_s"] = round(time.monotonic() - t0, 1)
        if mode == "source":
            res["text"] = src.text
        else:
            prov, level = mode.split("-")
            res["text"] = call_model(prov, level, src.title, src.url, src.text)
    except DipDiveError as e:
        res["error_code"], res["error_message"] = e.code, e.message
    res["seconds"] = round(time.monotonic() - t0, 1)
    return res


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2 or argv[1] not in MODES:
        print(f"usage: dipdive <url> <{'|'.join(MODES)}>", file=sys.stderr)
        return 2
    sweep_stale()
    r = run_job(*argv)
    if r["error_code"]:
        print(f"ERROR {r['error_code']}: {r['error_message']}", file=sys.stderr)
        return 1
    print(f"# {r['title']}\n")
    print(r["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
