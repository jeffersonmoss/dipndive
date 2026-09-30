"""Isolated model calls (plan 3.4)."""
import json
import os
import shutil

from .errors import DipDiveError
from .proc import run
from .prompts import system_prompt, user_message
from .tmp import tempdir

CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
CODEX_HOME = os.path.expanduser("~/Library/Application Support/DipDive/codex-home")
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CODEX_MODEL = "gpt-5.6-luna"
TIMEOUT = {"dip": 45, "dive": 90}
EFFORT = {"dip": "low", "dive": "medium"}
OUT_CAP = 20_000


def _classify(text: str):
    t = text.lower()
    if "not logged in" in t or "log in" in t or "401" in t or "unauthorized" in t or "login" in t:
        return "auth"
    if "rate limit" in t or "429" in t:
        return "rate_limited"
    if "usage limit" in t or "quota" in t or "limit reached" in t:
        return "quota"
    return "model_failed"


def call_claude(level: str, title: str, url: str, text: str, raw_out: dict = None) -> str:
    args = [CLAUDE, "-p", "--output-format", "json", "--safe-mode", "--strict-mcp-config",
            "--tools", "", "--no-session-persistence", "--model", CLAUDE_MODEL,
            "--system-prompt", system_prompt(level)]
    with tempdir("empty cwd for an isolated claude call") as d:
        rc, out, err = run(args, TIMEOUT[level], user_message(title, url, text), cwd=d)
    if raw_out is not None:
        raw_out.update(rc=rc, stdout=out, stderr=err)
    try:
        j = json.loads(out)
    except json.JSONDecodeError:
        raise DipDiveError(_classify(out + err), (err or out).strip()[:300])
    if rc != 0 or j.get("is_error"):
        raise DipDiveError(_classify(str(j.get("result", "")) + err), str(j.get("result", err))[:300])
    if j.get("permission_denials"):
        raise DipDiveError("tool_use", f"permission denials: {j['permission_denials']}")
    res = (j.get("result") or "").strip()
    if not res:
        raise DipDiveError("model_failed", "empty result")
    return res[:OUT_CAP]


TOOL_ITEMS = {"command_execution", "mcp_tool_call", "web_search", "file_change", "tool_call", "function_call"}


def codex_logged_in() -> bool:
    env = dict(os.environ, CODEX_HOME=CODEX_HOME)
    rc, out, err = run([CODEX, "login", "status"], 20, env=env)
    return rc == 0 and "not logged in" not in (out + err).lower()


def call_codex(level: str, title: str, url: str, text: str, raw_out: dict = None) -> str:
    env = dict(os.environ, CODEX_HOME=CODEX_HOME)
    with tempdir("empty cwd and output file for an isolated codex call") as d:
        outfile = os.path.join(d, "out.txt")
        work = os.path.join(d, "work")
        os.mkdir(work)
        args = [CODEX, "exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--sandbox", "read-only", "--skip-git-repo-check", "-m", CODEX_MODEL,
                "-c", f"model_reasoning_effort={EFFORT[level]}", "-C", work, "-o", outfile, "-"]
        prompt = system_prompt(level) + "\n\n" + user_message(title, url, text)
        rc, out, err = run(args, TIMEOUT[level], prompt, cwd=work, env=env)
        final = open(outfile).read().strip() if os.path.exists(outfile) else ""
    if raw_out is not None:
        raw_out.update(rc=rc, stdout=out, stderr=err)
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = ev.get("item") or {}
        if item.get("type") in TOOL_ITEMS:
            raise DipDiveError("tool_use", f"codex emitted {item.get('type')}")
    if rc != 0:
        raise DipDiveError(_classify(out + err), (err or out).strip()[-300:])
    if not final:
        raise DipDiveError("model_failed", "empty output")
    return final[:OUT_CAP]


def call_model(provider: str, level: str, title: str, url: str, text: str) -> str:
    return (call_claude if provider == "claude" else call_codex)(level, title, url, text)
