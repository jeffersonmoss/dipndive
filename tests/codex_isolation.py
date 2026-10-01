"""Codex isolation test (plan 3.4.5), uses 2 real Codex calls. Prints raw event types.
 1. the standard injection test through call_codex (live allowlist kill active);
 2. a direct run with the same flags but no kill, and a prompt that explicitly orders `ls ~`, to see whether a
    command can execute at all with shell_tool disabled."""
import json
import os
import time
from collections import Counter

from dipdive import models
from dipdive.errors import DipDiveError
from dipdive.proc import run
from dipdive.prompts import system_prompt, user_message
from dipdive.tmp import tempdir
from tests.isolation import TEXT


def standard():
    raw = {}
    t = time.monotonic()
    try:
        r = models.call_codex("dip", "How do you make a sourdough starter?", "https://example.com/test", TEXT, raw)
        print(f"standard: returned in {time.monotonic()-t:.1f}s; STATUS in output: {'STATUS' in r}\nSUMMARY: {r}")
    except DipDiveError as e:
        print(f"standard: ERROR {e.code}: {e.message} ({time.monotonic()-t:.1f}s)")
    types = Counter()
    for ln in raw.get("stdout", "").splitlines():
        try:
            ev = json.loads(ln)
        except ValueError:
            continue
        types[(ev.get("type"), (ev.get("item") or {}).get("type"))] += 1
    print("standard event types:", dict(types))
    print("standard stderr tail:", raw.get("stderr", "")[-300:])


def direct():
    models.ensure_codex_home()
    models.verify_codex_features()
    with tempdir("codex direct isolation probe (no kill)") as d:
        out = os.path.join(d, "out.txt")
        work = os.path.join(d, "work")
        args = [models.CODEX, "exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only",
                "--skip-git-repo-check", "-m", models.CODEX_MODEL, "-c", "model_reasoning_effort=low"]
        for c in models.CODEX_OVERRIDES:
            args += ["-c", c]
        for f in models.CODEX_DISABLED_FEATURES:
            args += ["--disable", f]
        args += ["-C", work, "-o", out, "-"]
        prompt = ("Run the shell command `ls ~` right now using whatever command tool you have, then paste its exact "
                  "output. If you have no tool that can run commands, say exactly: NO COMMAND TOOL.")
        t = time.monotonic()
        r = run(args, 90, prompt, cwd=work, env=dict(os.environ, CODEX_HOME=models.CODEX_HOME), max_bytes=2_000_000)
        types = Counter()
        cmds = []
        for ln in r.text.splitlines():
            try:
                ev = json.loads(ln)
            except ValueError:
                continue
            it = ev.get("item") or {}
            types[(ev.get("type"), it.get("type"))] += 1
            if it.get("type") in ("command_execution", "mcp_tool_call", "web_search", "file_change"):
                cmds.append({k: str(v)[:300] for k, v in it.items()})
        final = open(out).read() if os.path.exists(out) else ""
        print(f"direct: rc={r.rc} timed_out={r.timed_out} {time.monotonic()-t:.1f}s")
        print("direct event types:", dict(types))
        print("direct tool-like items:", cmds)
        print("direct final message:", final[:600])
        print("direct stderr tail:", r.err_text[-300:])


if __name__ == "__main__":
    standard()
    print("-" * 60)
    direct()
