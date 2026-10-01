# dipdive

PoC 1 of the Dip & Dive companion: acquisition (plan 3.3), isolated model calls (3.4) and prompts (3.5) as an importable Python module, plus a CLI. Plan: `CODEX PROJECTS/DIP_DIVE/PLAN.md` (see POINTER.md there).

## Use

    .venv/bin/python -m dipdive <url> <claude-dip|claude-dive|codex-dip|codex-dive|source>

Prints the summary, or `ERROR <code>: <message>` on stderr with exit status 1. The later HTTP server imports `dipdive.cli.run_job(url, mode)`, `dipdive.acquire.acquire(url)` and `dipdive.models.call_model(...)`.

## Server (plan 3.2, Stage A)

    .venv/bin/python -m dipdive.server [port]     # default 8765, binds 127.0.0.1 only

Files: `dipdive/service.py` (job store, source cache, workers, health), `dipdive/server.py` (HTTP, auth). State lives in `~/Library/Application Support/DipDive/` (override with `DIPDIVE_SUPPORT`): `jobs/`, `sources/`, `results/`, `logs/`, `state.json` (clear generation), `token` (0600, created on first start, never printed). Requests need `Authorization: Bearer <token>`; requests with a web-page `Origin` or a non-loopback, non-`*.ts.net` Host are refused; there is no CORS.

Endpoints: `POST /jobs {url, mode, requestId, force?}` (202 new, 200 existing, 429 `queue_full`), `GET /jobs/{id}`, `GET /source?job=<id>` (cache only, never fetches), `POST /clear`, `GET /health`. Dedupe key is sha256 of normalized source id, mode, model id and prompt version; the result cache additionally includes a hash of the source text.

iMac deployment (written, not loaded anywhere): `deploy/install-imac.sh [--dry-run] [--port N]` renders `deploy/com.jeffersonmoss.dipdive.plist.template` (RunAtLoad, KeepAlive, ThrottleInterval 10, explicit PATH, `DIPDIVE_DENO`), bootstraps it into the GUI session, and runs `tailscale serve --bg --https=443`. It prints the `pmset` command (needs sudo, run by hand).

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

`python -m unittest tests.test_regressions tests.test_server` (73 tests), `python -m tests.isolation` (plan 3.4.5) and `python -m tests.poc1` (writes tests/poc1-results.json). Temp dirs are made in the system temp dir with prefix `dipdive-` and a TEMP_README.md, and removed in `finally`.

## Codex home notes

The module creates `~/Library/Application Support/DipDive/codex-home` and its config.toml. The settings that matter are also passed as `-c` and `--disable` flags on every call, because `--ignore-user-config` makes config.toml dead. Codex still writes plugin clones (`.tmp/`), `skills/`, `memories_1.sqlite`, `goals_1.sqlite`, `state_*.sqlite` and logs into that home; they do not matter for isolation (the features that use them are disabled, and any tool item in the event stream kills the call). The module prunes `.tmp` and `shell_snapshots` entries older than a day.

Test-only hook: `DIPDIVE_TEST_ALLOW_LOOPBACK=1` lets the fetch worker reach 127.0.0.1 (used by tests/test_regressions.py). Never set it in production.

Live article sample (network, no model): `python -m tests.live_articles`.

## Chrome extension (plan 3.1, Stages B to D)

Source in `extension/` (Manifest V3, no build step, no CDN code, no content scripts). Load with `extension/LOAD-UNPACKED.md`.

1. Permissions: `contextMenus`, `sidePanel`, `storage`, `clipboardWrite`; no always-on host access; `https://*.ts.net/*`, `http://127.0.0.1/*` and `localhost` are optional and the options page requests exactly the saved origin.
2. Fixed extension ID `eokhjchjblklfkhcklpichdfjmmpcana` via the `key` in `manifest.json` (public key only). The PRIVATE key is `~/Library/Application Support/DipDive/extension-key.pem` (mode 0600, never in git). Keep it: it is needed to pack the extension later with the same ID.
3. Layout: `background.js` plus `lib/background-core.js` (menu, URL precedence, per-window slots); `panel.html`, `panel.js`, `panel.css`, `lib/controller.js` (submission, polling, selection and clear generations, Temp chat); `lib/markdown.js` (bundled renderer, HTML escaped, images never rendered, http(s) links only); `lib/api.js` (5 s AbortController deadlines); `options.html` and `options.js`.
4. Tests: `cd extension && node --test test/*.test.mjs` (40 tests: URL precedence, renderer safety, manifest and no-CDN checks, menu and click handler order with a mocked chrome, controller flows with a fake companion). Visual and flow check in a browser: `.venv/bin/python -m tests.dev_harness [port]` starts a real companion with faked model binaries plus a static and proxy server and prints a panel URL (`panel.html?base=...&token=...&url=...&mode=...`); the panel runs outside Chrome through `lib/shim.js`, which is inert inside the real extension. Screenshots: `extension/docs/panel-light.jpg`, `panel-dark.jpg`.

Codex isolation re-test (2 real Codex calls): `.venv/bin/python -m tests.codex_isolation`. Last result: PASS on Codex 0.159.2 (no command tool exposed; see RESULTS section 11).
