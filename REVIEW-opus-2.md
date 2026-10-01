# Adversarial review, round 2 (Opus 5.5, 2026-09-30, Thing 1)

Scope: commits e19f509 (fixes for REVIEW-opus.md) and 7bd5f87 (HTTP server, deploy), against PLAN.md 3.1, 3.2, 3.3, 3.4 and 5.1. No code was modified. Real model calls: 3, all Claude Haiku (the isolation test, then one Dip and one Dive through a real server). No Codex mode was run; `codex features list`, `codex exec --help` and `codex login status` were run because none of them calls a model. Deploy files were read and not run. Probe scripts lived in my scratchpad and were deleted afterwards. Side effect to know about: I ran read-only `sqlite3 .tables` queries on the DipDive codex-home databases, which may have checkpointed their WAL files.

The full suite (`tests.test_regressions`, `tests.test_server`) ran twice: 44 tests, OK both times.

## New findings, most severe first

1. **HIGH. An empty token file opens the API to anyone (fail-open auth).** `dipdive/server.py:21-32, 59`.
   Reproduction: created a zero-byte token file, `load_token()` returned `''`, and a server built with it answered `GET /health` with `Authorization: Bearer ` (nothing after the space) with **HTTP 200**. `hmac.compare_digest(b"", b"")` is true. An empty file can come from a crash or a full disk during first-run creation (the file is created with `O_EXCL` before the token is written), or from someone clearing it by hand.
   Fix: refuse to start unless the token is at least 32 characters. Write the token to a temp file, fsync, then rename. In `_gate`, reject an empty presented token before comparing.

2. **MEDIUM-HIGH. `unified_exec` stays enabled despite `--disable unified_exec`; RESULTS 6.1's "features list reflects them" is not true for it.** `dipdive/models.py:29-34, 171-172`.
   Reproduction, with `CODEX_HOME` set to the DipDive home (which now has the generated config.toml with `unified_exec = false`):
   1. `codex features list` gives `unified_exec stable true`;
   2. `codex --disable unified_exec --disable shell_tool features list` gives `shell_tool false` but `unified_exec true`;
   3. `codex -c features.unified_exec=false features list` gives `unified_exec true`.
   `code_mode_host` and `sleep_tool` are also still on. `codex exec --disable` is accepted, and an unknown feature name is silently ignored (exit 0), so a typo in the list would never show. Whether the model can still run a command with `shell_tool` off and `unified_exec` on cannot be settled without a login. The stream allowlist would kill the job, but only after the command has run (read-only sandbox, so it can read any file).
   Fix: once the DipDive Codex login exists, run the isolation injection ("run `ls ~`") and read the JSONL for `command_execution`. If commands still run, find the setting that actually removes the exec tool, or drop Codex. Also check each `--disable` name against `codex features list` at startup and fail loudly on unknown names.

3. **MEDIUM. A storage error kills worker threads for good; enough of them and every new job sits `queued` forever.** `dipdive/service.py:228-234, 263-271`.
   Reproduction (in-process Service, `_atomic_write` patched to raise `OSError(28, "No space left on device")` for job records): 6 jobs submitted, the exception from `_set` in the `except` branch escaped `run_one` and ended each `_worker` loop. With the disk "recovered" (patch removed), a new job stayed **`queued`**. Such jobs count toward `QUEUE_CAP`, so after 20 the API answers `queue_full` until a restart.
   Fix: wrap the body of `_worker` in `try/except BaseException` that logs and continues. Make the error-path `_set` best-effort (update memory even if the save fails).

4. **MEDIUM. Silent partial article extraction (new, not a paywall issue).** `dipdive/acquire.py` `fetch_article`.
   Reproduction (live, no model): `arstechnica.com/science/2026/09/dinosaur-killing-impact-crater-might-have-been-teeming-with-life/` extracts **1,784** characters, while the page's article paragraphs (over 80 chars each) total about **5,500**. The same happens for the Ars measles article (1,588 characters). The result is identical whether trafilatura gets bytes or str, or `favor_recall=True`, so this is not a regression from the fixes. It passes every check and would be summarized as if complete, the same silent-wrong class as the teaser problem.
   Fix: compare the extracted length with the text of `<article>`/`<main>` paragraphs (or a second extractor). When extraction covers under about half, fall back to the longer text or label the result "may be partial".

5. **MEDIUM-LOW. Dedupe returns a done job for 30 days, ignoring the 7-day source expiry and the plan's key.** `dipdive/service.py:122, 127-132`.
   Reproduction: submitted a URL, job done; aged its source file 8 days; resubmitted with a new requestId. **The old job came back, and nothing was refetched.** Plan 3.2.5.1 puts the source hash in the key. RESULTS 7.4 documents the pre-key, but the effect is that an updated article (or a corrected caption track) keeps its old summary for up to 30 days unless he force-clicks.
   Fix: only reuse a done job whose source is still in the cache (`_read_source(norm)` is not None and its hash matches the job's full key); otherwise start a new attempt.

6. **MEDIUM-LOW. The paywall phrase check now refuses some free articles, and one marker form is still missed.** `dipdive/acquire.py` `_PAYWALL_PHRASES`, `declared_paywalled`.
   Reproduction (synthetic, distinct paragraphs):
   1. A free 4.4k article ending "Enjoyed this piece? Subscribe today to get our weekly newsletter" was **refused**: bare `subscribe today` matches.
   2. A free article whose last paragraph says "I plan to continue reading the series tomorrow" was **refused**: `to continue reading` matches.
   3. JSON-LD `{"@type":"WebPage","mainEntity":{"@type":"NewsArticle","isAccessibleForFree":false}}` **passed**, because nested `mainEntity` is not inspected.
   Live check (no model): 12 free articles from New Yorker, Wired, Guardian, Ars and Noahpinion all passed. NYT, Business Insider, Slow Boring, paid Noahpinion posts and The Verge were refused by the declared marker. No live false positive was seen.
   Fix: drop the bare `subscribe today` and `to continue reading` alternatives, or require them together with a subscription word in the same sentence. Also follow `mainEntity` and `mainEntityOfPage` one level down.

7. **LOW-MEDIUM. The Codex allowlist (`agent_message`, `reasoning`) will probably fail legitimate jobs as `tool_use`.** `dipdive/models.py:36, 143-156`.
   Reasoning (code read; Codex not run): exec's item set includes `todo_list` (the plan tool, which has no feature switch in the list above) and, I believe, non-fatal `error` items. Either one kills a normal summary as `tool_use`. This is the safe direction, but it is untested.
   Fix: after login, run 10 Dip and Dive calls and record the item types seen. Allow `todo_list` and `error` items explicitly, never any execution or search type.

8. **LOW. HTTP request desync: a body is not consumed when the gate or size check rejects the request.** `dipdive/server.py:52-61, 63-70, 100-106`.
   Reproduction: one keep-alive connection carrying `POST /jobs` with a wrong token and a body that is itself a full `GET /nosuch` request with a valid token. The server answered 401, then **parsed the body as a second request and answered it** (`not_found` in the same stream). Impact is limited: the smuggled request still needs the token, and Tailscale serve's Go proxy discards unsolicited responses.
   Fix: on any early error, send `Connection: close` and set `self.close_connection = True`, or drain `Content-Length` bytes first.

9. **LOW. `/health` blocks and stampedes on a cold cache.** `dipdive/service.py:296-343`.
   Reproduction: 8 concurrent first calls ran `_compute_health` **8 times**. Each run starts 5 subprocesses, each with a 15 s timeout, inside the HTTP handler thread. Plan 3.2.5 says handlers return quickly. If `_compute_health` raises (for example, `deno --version` printing nothing gives an IndexError), nothing is cached and every call recomputes.
   Fix: single-flight the first computation (a lock or Event), compute once at startup in the background, and return `{"state": "starting"}` until then.

10. **LOW. A job submitted after `/clear` can join a fetch that started before it.** `dipdive/service.py:192-225`.
    Reproduction: job A starts fetching, then `/clear`, then job B for the same URL. One fetch only; B ends `done`, but the source was never cached (the leader's generation is stale), so `GET /source` for B returns `source_gone`. The content used after the clear was fetched before it. Mostly harmless for model modes; it breaks the Temp chat flow, which needs `/source`.
    Fix: key `inflight` by `(generation, norm)`.

11. **LOW. Reusing a requestId for a different URL or mode silently returns the old job.** `dipdive/service.py:124-126`. Reproduced: `r3` reused for another URL and mode returned the original job. Fix: store url and mode with the requestId and return 409 on a mismatch.

12. **LOW. The HTTP layer has no read timeout and no thread cap, and its tracebacks go to an unrotated, uncleared log.** `dipdive/server.py:36-41, 124-130`; plist lines 25-26. Handler `timeout` is `None`, so 5 connections with half-sent headers held 5 threads indefinitely. `BrokenPipeError` tracebacks (seen during my Host and Origin probes) go to stderr, which launchd appends to `launchd.err.log`. That file is not rotated and not removed by `/clear`. Fix: set `timeout = 15` on the handler class, override `handle_error` to log one line, and include the launchd logs in `/clear` or truncate them at start.

13. **LOW. Delimiter neutralization misses look-alikes, and title and URL are not neutralized.** `dipdive/prompts.py:36-46`. Reproduced: `</sou​rce>`, `＜/source＞` and `&lt;/source&gt;` pass unchanged. The title (attacker-controlled page or video metadata) is not passed through `neutralize`. Haiku resisted a plain breakout in round 1, so this is defence in depth. Fix: strip zero-width characters and NFKC-normalize before matching, and neutralize the title and URL too (or use a random per-call delimiter).

14. **LOW. Crash-safety details.** `dipdive/joblog.py:18-29`, `dipdive/service.py:47-51, 86-102`.
    14.1 The joblog fence is checked outside the service lock, so a `/clear` landing between the check and the write leaves one log file.
    14.2 `_atomic_write` does not fsync, so a power cut can leave empty records. Those are skipped, which is fine.
    14.3 A record that parses as JSON but lacks `state`, `job_id` or `request_id` raises `KeyError` in `_load_jobs`, and the LaunchAgent then crash-loops every 10 s. Fix: write the log under the lock (or re-check after writing and delete), and skip records missing required keys.

15. **LOW. Deploy script details (read only).** `deploy/install-imac.sh:22-52`, `deploy/com.jeffersonmoss.dipdive.plist.template`.
    The plist matches plan 3.2.2: gui-domain bootstrap, `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, explicit PATH, deno passed by env, port bound to 127.0.0.1 by the server, `tailscale serve --bg --https=443` as planned. Issues:
    15.1 `/usr/local/bin/tailscale` is hardcoded. It exists on Thing 1 as a 68-byte wrapper, but may not on the iMac, and under `set -e` the script would stop after bootstrapping the agent. Use `command -v tailscale`, falling back to `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
    15.2 The sed substitutions are unescaped, so a path containing `&` or `|` corrupts the plist. `plutil -lint` would catch an XML break but not a wrong path.
    15.3 `--port` given as the last argument trips `set -u`.
    15.4 There is no post-install check that the agent is listening: suggest `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:$PORT/health`, expecting 401.

16. **LOW. Running the tests leaves temp folders.** One full suite run added one `dipdive-XXXX` call folder (TEMP_README plus `work`) to the system temp dir. Before that run the temp dir also held 29 `dipdive-test-bin-*` folders, one `dipdive-test-support-*` folder with `logs/`, and another call folder, all from today 18:44 to 18:54. `sweep_stale` removes these only when the CLI or server starts and they are over an hour old. Fix: have the test harness wait for or stop the worker threads before `tearDownModule`, and sweep its own prefixes at startup.

17. **INFO. `/clear` does not touch codex-home.** It holds `logs_2.sqlite` (currently empty, since no Codex call has succeeded). After the login, check whether Codex logs prompt text there. If it does, `/clear` must cover it (plan 3.2.5.4: clear deletes logs).

## Round 1 findings: verification

18. Finding 1 (Codex config ignored): the overrides are now passed with `-c` and `--disable`, and the module writes config.toml. **Partly fixed**: see new finding 2 (`unified_exec` cannot be turned off this way).
19. Finding 2 (deadline): **Fixed.** Reproduced: body drip gave `timeout` at 10.5 s and header drip at 10.0 s with the 10 s production limit (round 1: 30 s and 62 s at a 3 s limit). The message reads "python exceeded 10s"; cosmetic.
20. Finding 3 (paywall): **Mostly fixed.** Reproduced: microdata inside an Article itemscope, `"http://schema.org/False"`, `@type` given as a URL list, and the 3.3k teaser ending "Subscribe to continue reading" are now refused; the related-item false positive now passes. Still open: teasers with no marker (accepted in RESULTS 6.3), nested `mainEntity`, and the new false positives in finding 6. A bare `<meta itemprop>` with no itemscope passes, which is acceptable since it is invalid microdata.
21. Finding 4 (uncaught exceptions): **Fixed.** zlib-wrapped and raw deflate both extract 4,876 chars; the bad charset extracts; port 99999 gives `extract_failed: invalid port`; the 70-char label and `a..b` give `extract_failed: cannot resolve`; a PDF gives `no_article_text`.
22. Finding 5 (classification): **Fixed.** "input_tokens 14012" gives `model_failed`, usage-limit-plus-login gives `quota`, "status 401 Unauthorized" gives `auth`, "HTTP 5401" gives `model_failed`. Codex now classifies only `error` and `turn.failed` events (plus stderr when there was no `turn.completed`).
23. Finding 6 (detached descendant): **Fixed (bounded).** It returned after 6.0 s on a 2 s timeout, not 25 s. The extra 4 s is two 2 s reader joins, so "returns at the timeout" in RESULTS 6.6 is slightly optimistic.
24. Finding 7 (completeness): **Fixed** by code read: `subtype`, `stop_reason`, `turn.completed`, and `output_truncated` instead of a silent cut.
25. Finding 8 (gzip bomb): **Fixed.** Refused as `too_long` in 0.6 s, with inflation bounded by `max_length` in the worker process.
26. Finding 9 (Codex tool detection): **Fixed** as an allowlist scanned live, killing the group on the first other item. Over-strict, see finding 7.
27. Finding 10 (logging): **Fixed.** Per-call JSON logs exist and are fenced by the clear generation.
28. Finding 11 (delimiter): **Fixed** for ASCII variants (`</SOURCE >`, `< /source>`, `<source>`); see finding 13 for look-alikes.
29. Finding 12 (translated tracks): **Fixed.** The `tlang=` test replaces the language heuristic. Real runs: German video, manual `de`; auto video, `en-orig`; TED, manual `en`; rain video, `no_captions`.
30. Finding 13 (DNS rebinding): left open, as the plan accepts.
31. Findings 14 to 16: **Fixed** as described in RESULTS section 6, by code read (raw bytes to trafilatura, content-type check, mode validation, empty `work` cwd, hostname in TEMP_README, anchored Google regex).
32. SSRF guard after the move to `fetch_worker.py`: **still holds** against the full round-1 list, directly and through real httpbin redirects. 5 redirects followed, 6 refused; `file://` refused.

## Server claims confirmed with real Claude calls

33. Isolation test re-run: normal summary, no STATUS line, 8.6 s.
34. End to end through a real server (temp support dir, real token, real Haiku): Paul Graham Dip `done` in 11.7 s. The same URL with a `#frag` and a new requestId returned the same job (no second call). `/clear` while a Dive was `summarizing` returned generation 1, the job then answered 404, and after the in-flight Dive finished the support dir held no jobs, sources, results or logs (fencing works with a real model). `/health` reported `claude_logged_in: true`, `codex_logged_in: false`.
35. Host and Origin gate: foreign Host 403; `x.ts.net` allowed; `Origin: null` and a web origin 403; any `chrome-extension://` origin allowed (the token is the real protection, as the plan says); no token 401.
