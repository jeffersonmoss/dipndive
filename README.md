# dipdive

PoC 1 of the Dip & Dive companion: acquisition (plan 3.3), isolated model calls (3.4) and prompts (3.5) as an importable Python module, plus a CLI. Plan: `CODEX PROJECTS/DIP_DIVE/PLAN.md` (see POINTER.md there).

## Use

    .venv/bin/python -m dipdive <url> <claude-dip|claude-dive|codex-dip|codex-dive|source>

Prints the summary, or `ERROR <code>: <message>` on stderr with exit status 1. The later HTTP server imports `dipdive.cli.run_job(url, mode)`, `dipdive.acquire.acquire(url)` and `dipdive.models.call_model(...)`.

## Setup

    python3 -m venv .venv && .venv/bin/pip install "yt-dlp[default]" yt-dlp-ejs trafilatura
    brew install deno   # if missing

Codex needs its own sign-in (never copy `~/.codex/auth.json`):

    CODEX_HOME="$HOME/Library/Application Support/DipDive/codex-home" /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex login

## Exact versions (2026-09-30, Thing 1)

1. Python 3.14.6 (Homebrew)
2. yt-dlp 2026.8.19
3. yt-dlp-ejs 0.8.0
4. trafilatura 2.2.0
5. deno 2.9.4 (stable, Homebrew, /opt/homebrew/bin/deno)
6. Claude Code 2.1.285, model claude-haiku-4-5-20251001
7. Codex CLI 0.159.2 (ChatGPT.app bundle), model gpt-5.6-luna

## Tests

`python -m tests.isolation` (plan 3.4.5) and `python -m tests.poc1` (writes tests/poc1-results.json). Temp dirs are made in the system temp dir with prefix `dipdive-` and a TEMP_README.md, and removed in `finally`.

## Codex home notes

The module creates `~/Library/Application Support/DipDive/codex-home` and its config.toml. The settings that matter are also passed as `-c` and `--disable` flags on every call, because `--ignore-user-config` makes config.toml dead. Codex still writes plugin clones (`.tmp/`), `skills/`, `memories_1.sqlite`, `goals_1.sqlite`, `state_*.sqlite` and logs into that home; they do not matter for isolation (the features that use them are disabled, and any tool item in the event stream kills the call). The module prunes `.tmp` and `shell_snapshots` entries older than a day.

Test-only hook: `DIPDIVE_TEST_ALLOW_LOOPBACK=1` lets the fetch worker reach 127.0.0.1 (used by tests/test_regressions.py). Never set it in production.
