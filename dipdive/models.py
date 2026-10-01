"""Isolated model calls (plan 3.4)."""
import json
import os
import re
import shutil
import time

from . import joblog
from .errors import DipDiveError
from .proc import run
from .prompts import ask_message, system_prompt, user_message
from .tmp import tempdir

_LOCAL_CLAUDE = os.path.expanduser("~/.local/bin/claude")
CLAUDE = _LOCAL_CLAUDE if os.path.exists(_LOCAL_CLAUDE) else (shutil.which("claude") or "claude")
CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
CODEX_HOME = os.path.join(joblog.SUPPORT, "codex-home")
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CODEX_MODEL = "gpt-5.6-luna"
TIMEOUT = {"dip": 45, "dive": 90, "ask": 45}
EFFORT = {"dip": "low", "dive": "medium", "ask": "low"}
OUT_CAP = 20_000
STDERR_LOG_CAP = 20_000

# Isolation settings passed as -c overrides: --ignore-user-config makes config.toml dead, -c still applies.
CODEX_OVERRIDES = [
    "web_search=\"disabled\"", "mcp_servers={}", "approval_policy=\"never\"", "sandbox_mode=\"read-only\"",
]
CODEX_DISABLED_FEATURES = [
    "shell_tool", "unified_exec", "apps", "plugins", "hooks", "memories", "multi_agent", "view_image",
    "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
    "image_generation", "goals", "skill_search", "remote_plugin", "tool_suggest", "worktrees",
    "write_stdin_approval", "workspace_dependencies",
]
# Allowlist of Codex exec item types (plan 3.4.2 backstop). Anything else kills the call.
# todo_list (plan tool) and non-fatal error items are harmless. Final list to be confirmed by the
# post-login injection test (RESULTS: pending).
CODEX_ALLOWED_ITEMS = {"agent_message", "reasoning", "todo_list", "error"}

# Features that `codex features list` reports as enabled in 0.159.2 whatever we pass (verified 2026-09-30:
# `--disable`, `-c features.x=false` and `codex features disable x` all leave it true). shell_tool=false is
# the gate for command execution; whether the model can still run commands through unified_exec is
# decided by the post-login injection test. Everything else we disable must read false, or we fail closed.
CODEX_CANNOT_DISABLE = {"unified_exec": "reads true even when disabled; shell_tool=false is the gate (to be proven by injection test)"}

_AUTH = re.compile(r"\b(not logged in|please run /login|invalid (api key|authentication)|unauthorized|401)\b", re.I)
_QUOTA = re.compile(r"\b(usage limit|quota|limit reached|credit balance)\b", re.I)
_RATE = re.compile(r"\b(rate.?limit(ed)?|429|overloaded|too many requests)\b", re.I)


def _classify_error_message(msg: str) -> str:
    """Only ever called on CLI- or API-generated error text, never on model output. Quota before auth."""
    if _QUOTA.search(msg):
        return "quota"
    if _AUTH.search(msg):
        return "auth"
    if _RATE.search(msg):
        return "rate_limited"
    return "model_failed"


def ensure_codex_home():
    """Create the DipDive Codex home and a belt-and-braces config.toml; prune state Codex adds."""
    os.makedirs(CODEX_HOME, exist_ok=True)
    cfg = os.path.join(CODEX_HOME, "config.toml")
    want = "\n".join(CODEX_OVERRIDES + [f'model = "{CODEX_MODEL}"']) + "\n[features]\n" + \
        "".join(f"{f} = false\n" for f in CODEX_DISABLED_FEATURES)
    if not os.path.exists(cfg) or open(cfg).read() != want:
        with open(cfg, "w") as f:
            f.write(want)
    # Plugin clones and shell snapshots are re-creatable; drop those older than a day. Never touch auth.json.
    cutoff = time.time() - 86400
    for sub in (".tmp", "shell_snapshots"):
        d = os.path.join(CODEX_HOME, sub)
        if os.path.isdir(d):
            for n in os.listdir(d):
                p = os.path.join(d, n)
                try:
                    if os.path.getmtime(p) < cutoff:
                        shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
                except OSError:
                    pass


_features_verified = None


def verify_codex_features(force=False):
    """Fail closed: every feature in CODEX_DISABLED_FEATURES must exist in `codex features list` and read
    disabled under our exact overrides, except the documented CODEX_CANNOT_DISABLE set. Cached per process."""
    global _features_verified
    if _features_verified is not None and not force:
        return _features_verified
    ensure_codex_home()
    args = [CODEX]
    for c in CODEX_OVERRIDES:
        args += ["-c", c]
    for f in CODEX_DISABLED_FEATURES:
        args += ["--disable", f]
    args += ["features", "list"]
    r = run(args, 30, env=dict(os.environ, CODEX_HOME=CODEX_HOME), max_bytes=200_000)
    if r.rc != 0:
        raise DipDiveError("codex_isolation_unverified", f"codex features list failed: {r.err_text.strip()[-200:]}")
    state = {}
    for line in r.text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1] in ("true", "false"):
            state[parts[0]] = parts[-1] == "true"
    problems = []
    for f in CODEX_DISABLED_FEATURES:
        if f not in state:
            problems.append(f"unknown feature name {f}")
        elif state[f] and f not in CODEX_CANNOT_DISABLE:
            problems.append(f"{f} still enabled")
    if state.get("shell_tool", True):
        problems.append("shell_tool still enabled")
    if problems:
        raise DipDiveError("codex_isolation_unverified", "; ".join(problems))
    _features_verified = True
    return True


def codex_logged_in() -> bool:
    ensure_codex_home()
    r = run([CODEX, "login", "status"], 20, env=dict(os.environ, CODEX_HOME=CODEX_HOME))
    return r.rc == 0 and "not logged in" not in (r.text + r.err_text).lower()


def _log(provider, level, r, extra):
    data = {"provider": provider, "level": level, "rc": r.rc, "timed_out": r.timed_out,
            "aborted": r.aborted, "stderr": r.err_text[-STDERR_LOG_CAP:], **extra}
    try:
        return joblog.write(data)
    except OSError:
        return None


def _finish(text: str) -> str:
    text = text.strip()
    if not text:
        raise DipDiveError("model_failed", "empty result")
    if len(text) > OUT_CAP:
        raise DipDiveError("output_truncated", f"output over {OUT_CAP} characters")
    return text


def _message(level, title, url, text, question, history, summary=None):
    if level == "ask":
        return ask_message(title, url, text, question, history or [], summary)
    return user_message(title, url, text)


def call_claude(level: str, title: str, url: str, text: str, raw_out: dict = None, question=None, history=None,
                summary=None) -> str:
    args = [CLAUDE, "-p", "--output-format", "json", "--safe-mode", "--strict-mcp-config",
            "--tools", "", "--no-session-persistence", "--model", CLAUDE_MODEL,
            "--system-prompt", system_prompt(level)]
    with tempdir("empty cwd for an isolated claude call") as d:
        r = run(args, TIMEOUT[level], _message(level, title, url, text, question, history, summary), cwd=os.path.join(d, "work"),
                max_bytes=2_000_000)
    if raw_out is not None:
        raw_out.update(rc=r.rc, stdout=r.text, stderr=r.err_text)
    j = None
    try:
        j = json.loads(r.text)
        if not isinstance(j, dict):
            j = None
    except json.JSONDecodeError:
        pass
    _log("claude", level, r, {"result_meta": {k: j.get(k) for k in (
        "subtype", "stop_reason", "terminal_reason", "is_error", "api_error_status", "num_turns",
        "permission_denials")} if j else None})
    if r.timed_out:
        raise DipDiveError("timeout", f"claude exceeded {TIMEOUT[level]}s")
    if r.aborted:
        raise DipDiveError("model_failed", f"claude output aborted: {r.aborted}")
    if j is None:
        raise DipDiveError("model_failed", f"claude exit {r.rc}, no JSON result: {r.err_text.strip()[-200:]}")
    if j.get("is_error") or r.rc != 0:
        status = j.get("api_error_status")
        msg = str(j.get("result") or "")
        code = _classify_error_message(msg)
        if code == "model_failed" and status in (401, 403):
            code = "auth"
        elif code == "model_failed" and status == 429:
            code = "rate_limited"
        raise DipDiveError(code, msg[:300] or f"claude exit {r.rc}")
    if j.get("permission_denials"):
        raise DipDiveError("tool_use", f"permission denials: {j['permission_denials']}")
    if j.get("subtype") != "success" or j.get("stop_reason") != "end_turn":
        raise DipDiveError("output_truncated" if j.get("stop_reason") == "max_tokens" else "model_failed",
                           f"incomplete: subtype={j.get('subtype')} stop_reason={j.get('stop_reason')}")
    return _finish(j.get("result") or "")


def _codex_event_check(tool_events):
    def on_line(line: bytes):
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(ev, dict):
            return None
        item = ev.get("item")
        if isinstance(item, dict) and item.get("type") not in CODEX_ALLOWED_ITEMS:
            tool_events.append(item)
            return f"tool_use:{item.get('type')}"
        return None
    return on_line


def call_codex(level: str, title: str, url: str, text: str, raw_out: dict = None, question=None, history=None,
                summary=None) -> str:
    ensure_codex_home()
    verify_codex_features()
    env = dict(os.environ, CODEX_HOME=CODEX_HOME)
    tool_events = []
    with tempdir("empty cwd and output file for an isolated codex call") as d:
        outfile = os.path.join(d, "out.txt")
        work = os.path.join(d, "work")
        args = [CODEX, "exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--sandbox", "read-only", "--skip-git-repo-check", "-m", CODEX_MODEL,
                "-c", f"model_reasoning_effort={EFFORT[level]}"]
        for c in CODEX_OVERRIDES:
            args += ["-c", c]
        for f in CODEX_DISABLED_FEATURES:
            args += ["--disable", f]
        args += ["-C", work, "-o", outfile, "-"]
        prompt = system_prompt(level) + "\n\n" + _message(level, title, url, text, question, history, summary)
        r = run(args, TIMEOUT[level], prompt, cwd=work, env=env, max_bytes=5_000_000,
                on_line=_codex_event_check(tool_events))
        final = open(outfile).read() if os.path.exists(outfile) else ""
    if raw_out is not None:
        raw_out.update(rc=r.rc, stdout=r.text, stderr=r.err_text)
    completed, errors = False, []
    seen = {}
    for line in r.text.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        key = f"{t}/{(ev.get('item') or {}).get('type')}" if isinstance(ev.get("item"), dict) else str(t)
        seen[key] = seen.get(key, 0) + 1
        if t == "turn.completed":
            completed = True
        elif t == "turn.failed":
            errors.append(str((ev.get("error") or {}).get("message", "")))
        elif t == "error":
            errors.append(str(ev.get("message", "")))
    _log("codex", level, r, {"tool_events": tool_events, "errors": errors, "completed": completed, "event_types": seen})
    if tool_events:
        raise DipDiveError("tool_use", f"codex emitted item type {tool_events[0].get('type')}")
    if r.aborted:
        raise DipDiveError("model_failed", f"codex output aborted: {r.aborted}")
    if r.timed_out:
        raise DipDiveError("timeout", f"codex exceeded {TIMEOUT[level]}s")
    if errors or r.rc != 0 or not completed:
        msg = " | ".join(errors) or r.err_text.strip()[-300:] or f"codex exit {r.rc}, no turn.completed"
        code = _classify_error_message(" ".join(errors) + " " + (r.err_text if not completed else ""))
        raise DipDiveError(code, msg[:300])
    return _finish(final)


def call_model(provider: str, level: str, title: str, url: str, text: str, question=None, history=None,
               summary=None) -> str:
    if provider not in ("claude", "codex") or level not in ("dip", "dive", "ask"):
        raise DipDiveError("invalid_mode", f"{provider}-{level}")
    if level == "ask" and not (isinstance(question, str) and question.strip()):
        raise DipDiveError("invalid_mode", f"{provider}-ask needs a question")
    return (call_claude if provider == "claude" else call_codex)(level, title, url, text, question=question,
                                                                   history=history, summary=summary)
