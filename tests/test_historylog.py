"""History log tests: one Markdown entry per successful Dip or Dive result, safe appends, /clear leaves it alone.
Every test writes to a temp DIPDIVE_LOG_PATH (see tests/test_server.py), never to the real ~/Public.
Run: .venv/bin/python -m unittest tests.test_historylog -v"""
import errno
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from tests.test_server import Base, LOG, _SUP, fake_claude  # noqa: E402  (sets DIPDIVE_SUPPORT and DIPDIVE_LOG_PATH first)
from tests.test_ask import fake_claude_recording, fake_codex_recording  # noqa: E402

from dipdive import acquire, historylog, models, service  # noqa: E402

_DIRS = []


def rec_dir():
    d = tempfile.mkdtemp(prefix="dipdive-test-rec-")
    _DIRS.append(d)
    with open(os.path.join(d, "TEMP_README.md"), "w") as f:
        f.write("# Temporary folder\n\nPurpose: fake model binaries for tests/test_historylog.py\n"
                "Made by: T1 Dip Dive chat on this Mac\nNeeded until: the test module ends (tearDownModule deletes it)\n"
                "Costly to recreate: no.\n")
    return d


def read_log(path=None):
    with open(path or LOG, encoding="utf-8") as f:
        return f.read()


def entries(text):
    """Entries after the file heading, split on the separator."""
    body = text.split("\n\n", 1)[1]
    return [e.strip() for e in body.split("\n---\n\n") if e.strip()]


class Format(unittest.TestCase):
    def setUp(self):
        self.d = rec_dir()
        self.p = os.path.join(self.d, "sub", "Log.md")

    def test_creates_file_with_heading_and_entry_format(self):
        historylog.append("A Video", "claude-dip", "https://example.com/watch?v=1", "- one\n- two", path=self.p)
        t = read_log(self.p)
        self.assertTrue(t.startswith("# Dip'n'Dive Log\n\n## A Video\n\n"))
        self.assertRegex(t, r"\n\n\d{4}-\d\d-\d\d \d\d:\d\d \| Claude Dip \| \[https://example\.com/watch\?v=1\]\(<https://example\.com/watch\?v=1>\)\n\n- one\n- two\n\n---\n\n$")

    def test_newest_at_the_bottom_and_existing_file_kept(self):
        os.makedirs(os.path.dirname(self.p))
        with open(self.p, "w") as f:
            f.write("# My own heading\n\nolder text without a final newline")
        historylog.append("First", "claude-dive", "https://e.com/1", "s1", path=self.p)
        historylog.append("Second", "codex-dive", "https://e.com/2", "s2", path=self.p)
        t = read_log(self.p)
        self.assertTrue(t.startswith("# My own heading\n\nolder text without a final newline\n\n## First"))
        self.assertLess(t.index("## First"), t.index("## Second"))
        self.assertEqual(t.count("# Dip'n'Dive Log"), 0)
        self.assertIn("Codex Dive", t)

    def test_summary_rule_line_cannot_break_the_separator(self):
        historylog.append("T", "claude-dip", "https://e.com/", "intro\n---\nmiddle\n - - -\n***\nend", path=self.p)
        t = read_log(self.p)
        self.assertEqual(t.count("\n---\n"), 1, "only the entry separator is a bare --- line")
        self.assertEqual(len(entries(t)), 1)
        self.assertIn("\\---", t)
        self.assertIn("middle", t)

    def test_open_code_fence_is_closed_and_summary_otherwise_verbatim(self):
        historylog.append("T", "claude-dip", "https://e.com/", "```py\nx = 1\n---\n", path=self.p)
        t = read_log(self.p)
        self.assertIn("```py\nx = 1\n---\n```\n\n---\n\n", t)  # inside a fence the --- line is left alone
        s = "# A heading\n\n**bold** [link](https://x.y) <b>tag</b>\n\n> quote"
        historylog.append("T2", "claude-dip", "https://e.com/2", s, path=self.p)
        self.assertIn(s + "\n\n---\n\n", read_log(self.p))

    def test_title_and_url_are_kept_well_formed(self):
        historylog.append("  Line one\n## injected\t heading  ", "claude-dip", "https://e.com/a b(c)>d", "s", path=self.p)
        historylog.append("", "claude-dip", "https://e.com/notitle", "s", path=self.p)
        historylog.append("### Hashes", "claude-dip", "https://e.com/h", "s", path=self.p)
        t = read_log(self.p)
        self.assertIn("\n## Line one ## injected heading\n", t)
        self.assertIn("\n## https://e.com/notitle\n", t)
        self.assertIn("\n## Hashes\n", t)
        self.assertIn("(<https://e.com/a b(c)%3Ed>)", t)
        self.assertEqual(len(re.findall(r"^## ", t, re.M)), 3)

    def test_concurrent_appends_from_threads_and_processes_stay_intact(self):
        body = "word " * 4000  # large enough that a torn write would show
        errs = []

        def go(i):
            try:
                historylog.append(f"T{i}", "claude-dip", f"https://e.com/{i}", f"{body}{i}", path=self.p)
            except Exception as e:  # pragma: no cover
                errs.append(e)

        ts = [threading.Thread(target=go, args=(i,)) for i in range(16)]
        code = ("import sys; from dipdive import historylog as h; "
                "h.append('P'+sys.argv[1], 'codex-dip', 'https://e.com/p', 'word '*4000 + sys.argv[1], path=sys.argv[2])")
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        procs = [subprocess.Popen([sys.executable, "-c", code, str(i), self.p], cwd=root) for i in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual([p.wait(30) for p in procs], [0] * 4)
        self.assertEqual(errs, [])
        t = read_log(self.p)
        es = entries(t)
        self.assertEqual(len(es), 20)
        self.assertEqual(t.count("# Dip'n'Dive Log"), 1)
        for e in es:
            self.assertRegex(e, r"^## [TP]\d+\n\n\d{4}-\d\d-\d\d \d\d:\d\d \| (Claude|Codex) Dip \| \[")
            self.assertEqual(e.count("word "), 4000)
        self.assertEqual(sorted(re.findall(r"^## ([TP]\d+)$", t, re.M)), sorted([f"T{i}" for i in range(16)] + [f"P{i}" for i in range(4)]))

    def test_is_writable(self):
        self.assertTrue(historylog.is_writable(self.p))                        # missing file, parents created on append
        self.assertTrue(historylog.is_writable(os.path.join(self.d, "x", "y", "z.md")))
        self.assertFalse(historylog.is_writable(os.path.join(self.d, "TEMP_README.md", "nope.md")))  # parent is a file
        self.assertEqual(os.listdir(self.d), ["TEMP_README.md"], "checking touches nothing")

    def test_default_path_and_env_override(self):
        saved = os.environ.pop("DIPDIVE_LOG_PATH", None)
        try:
            self.assertEqual(historylog.log_path(), os.path.expanduser("~/Public/Dip'n'Dive Log.md"))
            os.environ["DIPDIVE_LOG_PATH"] = "~/somewhere/else.md"
            self.assertEqual(historylog.log_path(), os.path.expanduser("~/somewhere/else.md"))
        finally:
            if saved is not None:
                os.environ["DIPDIVE_LOG_PATH"] = saved

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Channel(unittest.TestCase):
    def setUp(self):
        self.d = rec_dir()
        self.p = os.path.join(self.d, "Log.md")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_entry_has_channel_line_under_heading_and_neutralized(self):
        historylog.append("T", "claude-dip", "https://e.com/v", "s", path=self.p, channel="  TEDx\nTalks\r\n## x ")
        historylog.append("U", "claude-dip", "https://e.com/u", "s", path=self.p, channel="")
        historylog.append("V", "claude-dip", "https://e.com/w", "s", path=self.p)
        t = read_log(self.p)
        self.assertRegex(t, r"## T\n\nChannel: TEDx Talks ## x\n\n\d{4}-\d\d-\d\d \d\d:\d\d \| Claude Dip \|")
        self.assertEqual(t.count("Channel:"), 1, "missing channel: the line is omitted")
        self.assertRegex(t, r"## U\n\n\d{4}")
        self.assertRegex(t, r"## V\n\n\d{4}")

    def test_channel_name_prefers_channel_then_uploader(self):
        self.assertEqual(acquire.channel_name({"channel": "A", "uploader": "B"}), "A")
        self.assertEqual(acquire.channel_name({"channel": "  ", "uploader": " B "}), "B")
        self.assertEqual(acquire.channel_name({"channel": None}), "")
        self.assertEqual(acquire.channel_name({"channel": 5, "uploader": ["x"]}), "")

    def _youtube(self, info):
        def fake(args, timeout):
            if "-J" in args:
                return json.dumps(info)
            base = args[args.index("-o") + 1]
            with open(base + ".en.json3", "w") as f:
                json.dump({"events": [{"tStartMs": 0, "segs": [{"utf8": "hello world"}]}]}, f)
            return ""
        real = acquire._ytdlp
        acquire._ytdlp = fake
        try:
            return acquire.fetch_youtube("https://youtu.be/abcdefghijk", "abcdefghijk")
        finally:
            acquire._ytdlp = real

    def test_youtube_source_carries_channel_with_uploader_fallback_and_none(self):
        base = {"title": "Vid", "language": "en", "subtitles": {"en": [{"url": "https://x/a", "ext": "json3"}]},
                "automatic_captions": {}}
        self.assertEqual(self._youtube(dict(base, channel="TEDx Talks", uploader="Other")).meta["channel"], "TEDx Talks")
        self.assertEqual(self._youtube(dict(base, uploader="Only Uploader")).meta["channel"], "Only Uploader")
        self.assertEqual(self._youtube(dict(base)).meta["channel"], "")

    def _article(self, head):
        page = ARTICLE_PAGE % (head, "".join(f"<p>Paragraph {i} about topic {i*7919} with distinct words and more filler text here.</p>" for i in range(40)))
        real = acquire._fetch_html
        acquire._fetch_html = lambda u, **k: (page.encode(), u)
        try:
            return acquire.fetch_article("http://x.test/")
        finally:
            acquire._fetch_html = real

    def test_article_site_name_when_provided_otherwise_empty(self):
        self.assertEqual(self._article('<meta property="og:site_name" content="The Daily Test">').meta["channel"], "The Daily Test")
        self.assertEqual(self._article("").meta["channel"], "")


ARTICLE_PAGE = "<html><head><title>T</title>%s</head><body><article>%s</article></body></html>"


class FakeModels(Base):
    """Recording fake Claude and Codex binaries for the server tests below (no tests of its own)."""

    def setUp(self):
        super().setUp()
        self.saved_codex, self.saved_verified = models.CODEX, models._features_verified
        self.rec = rec_dir()
        models.CLAUDE = fake_claude_recording(self.rec)
        models.CODEX = fake_codex_recording(self.rec)
        models._features_verified = True
        models.CODEX_HOME = os.path.join(_SUP, "codex-home")

    def tearDown(self):
        super().tearDown()
        models.CODEX, models._features_verified = self.saved_codex, self.saved_verified
        os.environ["DIPDIVE_LOG_PATH"] = LOG

    def run_job(self, mode, rid, path="/a", **kw):
        c, r = self.submit(mode, rid, path, **kw)
        self.assertIn(c, (200, 202), r)
        j = self.wait(r["job_id"])
        self.assertTrue(self.svc.wait_idle(30))
        return j


class Server(FakeModels):
    def test_each_summary_mode_writes_one_entry(self):
        ids = []
        for i, (mode, label, result) in enumerate([("claude-dip", "Claude Dip", "answer 1"), ("claude-dive", "Claude Dive", "answer 2"),
                                                   ("codex-dip", "Codex Dip", "codex answer 1"), ("codex-dive", "Codex Dive", "codex answer 2")]):
            j = self.run_job(mode, f"r{i}", path=f"/p{i}")
            self.assertEqual((j["state"], j["result_markdown"], j["history_saved"]), ("done", result, True))
            ids.append(j["job_id"])
        t = read_log(LOG)
        es = entries(t)
        self.assertEqual(len(es), 4)
        for e, (label, result, i) in zip(es, [("Claude Dip", "answer 1", 0), ("Claude Dive", "answer 2", 1),
                                              ("Codex Dip", "codex answer 1", 2), ("Codex Dive", "codex answer 2", 3)]):
            # the job id rides in an HTML comment right under the date line
            self.assertRegex(e, r"^## Art\n\n\d{4}-\d\d-\d\d \d\d:\d\d \| %s \| \[%s/p%d\]\(<%s/p%d>\)\n<!-- dipdive-job: %s seq=\d+ -->\n\n%s$"
                             % (label, re.escape(self.base), i, re.escape(self.base), i, ids[i], re.escape(result)))

    def test_ask_source_and_error_jobs_write_nothing(self):
        self.run_job("source", "s1")
        self.run_job("claude-ask", "a1", question="what is it?")
        self.run_job("codex-ask", "a2", question="what is it?")
        models.CLAUDE = os.path.join(_SUP, "no-such-binary")
        j = self.run_job("claude-dip", "e1", path="/err")
        self.assertEqual(j["state"], "error")
        self.assertFalse(os.path.exists(LOG), "nothing logged: no file is even created")

    def test_cache_hits_and_dedupe_are_logged_once(self):
        j1 = self.run_job("claude-dip", "r1")
        self.assertEqual(len(entries(read_log(LOG))), 1)
        j2 = self.run_job("claude-dip", "r2")                  # same key: deduplicated onto the first job
        self.assertEqual(j2["job_id"], j1["job_id"])
        self.run_job("claude-dip", "r1")                       # same requestId
        self.svc.by_prekey.clear()                             # a fresh job that finds the stored result (result-cache hit)
        j3 = self.run_job("claude-dip", "r3")
        self.assertNotEqual(j3["job_id"], j1["job_id"])
        self.assertEqual(j3["result_markdown"], "answer 1")
        self.assertEqual(len([n for n in os.listdir(self.rec) if n.endswith(".in")]), 1, "one model call, the cache served the rest")
        self.assertEqual(len(entries(read_log(LOG))), 1)
        self.run_job("claude-dip", "r4", force=True)           # a forced re-run is a new model result: logged
        self.assertEqual(len(entries(read_log(LOG))), 2)

    def test_two_jobs_finishing_together_leave_two_intact_entries(self):
        models.CLAUDE = fake_claude(sleep=1.0)
        a = self.submit("claude-dip", "c1", "/a")[1]["job_id"]
        b = self.submit("claude-dive", "c2", "/b")[1]["job_id"]
        self.wait(a); self.wait(b)
        self.assertTrue(self.svc.wait_idle(30))
        es = entries(read_log(LOG))
        self.assertEqual(len(es), 2)
        self.assertEqual(sorted(re.search(r"\| (Claude \w+) \|", e).group(1) for e in es), ["Claude Dip", "Claude Dive"])
        for e in es:
            self.assertTrue(e.endswith("fake summary"))

    def test_channel_from_the_cached_source_reaches_dip_and_dive_entries(self):
        real, fetches = service.acquire, []

        def fake(url):
            fetches.append(url)
            return acquire.Source("youtube", "abcdefghijk", "Cached Vid", url, "text " * 200, {"channel": "TEDx Talks"})
        service.acquire = fake
        try:
            self.run_job("claude-dip", "y1")
            self.run_job("codex-dive", "y2")  # source comes from the cache
        finally:
            service.acquire = real
        self.assertEqual(len(fetches), 1)
        es = entries(read_log(LOG))
        self.assertEqual(len(es), 2)
        for e in es:
            self.assertRegex(e, r"^## Cached Vid\n\nChannel: TEDx Talks\n\n\d{4}-")

    def test_source_without_channel_omits_the_line(self):
        self.run_job("claude-dip", "n1")                       # the local article has no site name
        self.assertNotIn("Channel:", read_log(LOG))

    def test_log_failure_does_not_fail_the_job_and_is_logged_to_the_job_log(self):
        blocker = os.path.join(os.path.dirname(LOG), "blocker")
        with open(blocker, "w") as f:
            f.write("a file where a directory is needed")
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(blocker, "sub", "log.md")
        j = self.run_job("claude-dip", "f1")
        self.assertEqual((j["state"], j["result_markdown"]), ("done", "answer 1"))
        logs = [json.load(open(os.path.join(joblog_dir(), n))) for n in os.listdir(joblog_dir())]
        errs = [x for x in logs if "history_log_error" in x]
        self.assertEqual(len(errs), 1)
        self.assertEqual((errs[0]["mode"], errs[0]["url"]), ("claude-dip", self.base + "/a"))
        self.assertEqual(self.req("GET", "/health")[1]["log_writable"], False)

    def test_log_failure_from_an_unexpected_exception_is_contained_too(self):
        saved = historylog.append
        historylog.append = lambda *a, **k: (_ for _ in ()).throw(MemoryError("boom"))
        try:
            j = self.run_job("codex-dip", "f2")
        finally:
            historylog.append = saved
        self.assertEqual(j["state"], "done")
        self.run_job("claude-dip", "f3", path="/b")           # the worker pool is still alive
        self.assertEqual(len(entries(read_log(LOG))), 1)

    def test_clear_leaves_the_log_alone(self):
        self.run_job("claude-dip", "k1")
        before = read_log(LOG)
        self.assertEqual(self.req("POST", "/clear", {})[0], 200)
        self.assertEqual(read_log(LOG), before)
        self.assertEqual(self.req("GET", "/jobs/" + "0" * 32)[0], 404)
        j = self.run_job("claude-dip", "k2", path="/c")
        self.assertEqual(len(entries(read_log(LOG))), 2)
        self.assertTrue(read_log(LOG).startswith(before.rstrip("\n")))

    def test_job_finishing_after_a_clear_is_not_logged(self):
        models.CLAUDE = fake_claude(sleep=1.5)
        self.submit("claude-dip", "g1")
        time.sleep(0.8)
        self.req("POST", "/clear", {})
        time.sleep(2.2)
        self.assertTrue(self.svc.wait_idle(30))
        self.assertFalse(os.path.exists(LOG))

    def test_health_reports_log_path_and_writability(self):
        h = self.req("GET", "/health")[1]
        self.assertEqual((h["log_path"], h["log_writable"]), (LOG, True))
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(LOG, "inside-a-file.md")
        self.assertEqual(self.req("GET", "/health")[1]["log_writable"], True)  # LOG does not exist yet, parent dir is fine
        open(LOG, "w").close()
        h = self.req("GET", "/health")[1]
        self.assertEqual((h["log_path"], h["log_writable"]), (os.path.join(LOG, "inside-a-file.md"), False))


class HistoryRead(Base):
    """GET /history: the log parsed back into entries, newest first, paged with a stable cursor."""

    def seed(self, n, **kw):
        for i in range(n):
            historylog.append(f"Title {i}", ["claude-dip", "claude-dive", "codex-dip", "codex-dive"][i % 4], f"https://v.test/{i}",
                              f"Summary {i}\n\n- point {i}", path=LOG, channel=kw.get("channel", f"Chan {i}" if i % 2 == 0 else None))

    def test_requires_the_bearer_token_and_a_loopback_host(self):
        self.seed(1)
        self.assertEqual(self.req("GET", "/history", auth=False)[0], 401)
        self.assertEqual(self.req("GET", "/history", headers={"Authorization": "Bearer nope"}, auth=False)[0], 401)
        self.assertEqual(self.req("GET", "/history", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("GET", "/history", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("GET", "/history", headers={"Origin": "chrome-extension://abc"})[0], 200)
        self.assertEqual(self.req("POST", "/history", {})[0], 404)

    def test_missing_log_is_an_empty_list(self):
        c, j = self.req("GET", "/history")
        self.assertEqual((c, j["entries"], j["total"], j["next_before"]), (200, [], 0, None))

    def test_entries_come_back_newest_first_with_every_field(self):
        self.seed(3)
        c, j = self.req("GET", "/history")
        self.assertEqual(c, 200)
        self.assertEqual([e["title"] for e in j["entries"]], ["Title 2", "Title 1", "Title 0"])
        e = j["entries"][0]
        self.assertEqual((e["channel"], e["mode"], e["mode_label"], e["url"], e["summary"], e["index"]),
                         ("Chan 2", "codex-dip", "Codex Dip", "https://v.test/2", "Summary 2\n\n- point 2", 2))
        self.assertRegex(e["date"], r"^\d{4}-\d\d-\d\d$")
        self.assertRegex(e["time"], r"^\d\d:\d\d$")
        self.assertEqual(j["entries"][1]["channel"], "")
        self.assertEqual((j["total"], j["next_before"]), (3, None))

    def test_paging_with_a_cursor_never_repeats_or_skips_even_while_entries_arrive(self):
        self.seed(45)
        c, p1 = self.req("GET", "/history")
        self.assertEqual((len(p1["entries"]), p1["limit"], p1["total"], p1["next_before"]), (20, 20, 45, 25))
        self.assertEqual(p1["entries"][0]["title"], "Title 44")
        self.seed(3)  # three more finish while the reader is looking at page 1
        c, p2 = self.req("GET", f"/history?before={p1['next_before']}")
        self.assertEqual([e["title"] for e in p2["entries"]], [f"Title {i}" for i in range(24, 4, -1)])
        c, p3 = self.req("GET", f"/history?before={p2['next_before']}")
        self.assertEqual([e["title"] for e in p3["entries"]], [f"Title {i}" for i in range(4, -1, -1)])
        self.assertIsNone(p3["next_before"])
        c, small = self.req("GET", "/history?limit=2")
        self.assertEqual([e["index"] for e in small["entries"]], [47, 46])
        self.assertEqual(small["next_before"], 46)

    def test_bad_parameters_are_400(self):
        self.seed(2)
        for q in ("limit=0", "limit=101", "limit=-1", "limit=abc", "limit=", "before=-1", "before=x", "before=1.5", "limit=2&before=%20"):
            self.assertEqual(self.req("GET", "/history?" + q)[0], 400, q)
        self.assertEqual(self.req("GET", "/history?before=0")[1]["entries"], [])
        self.assertEqual(len(self.req("GET", "/history?before=99999")[1]["entries"]), 2)  # a cursor past the end is the newest page

    def test_unreadable_log_is_503_not_500_and_the_path_is_not_leaked(self):
        os.environ["DIPDIVE_LOG_PATH"] = os.path.dirname(LOG)  # a directory where the file should be
        c, j = self.req("GET", "/history")
        self.assertEqual((c, j["error_code"]), (503, "log_unreadable"))
        self.assertNotIn(os.path.dirname(LOG), json.dumps(j))

    def test_damaged_and_hand_edited_log_is_tolerated(self):
        good = historylog.format_entry("Good one", "claude-dip", "https://v.test/g", "ok summary")
        junk = ("# Dip'n'Dive Log\n\nsome note typed by hand\n\n---\n\n## No meta line here\n\njust text\n\n---\n\n"
                "## Bad stamp\n\n2026-13 | x | not a link\n\n---\n\n---\n\n---\n\n"
                + good + "## Half an entry with no separator\n\nChannel: C\n\n2026-10-01 09:00 | Claude Dip | [u](<https://v.test/h>)\nsummary but the file was cut")
        with open(LOG, "wb") as f:
            f.write(junk.encode() + b"\xff\xfe broken utf8 \n")
        c, j = self.req("GET", "/history")
        self.assertEqual(c, 200)
        self.assertEqual([e["title"] for e in j["entries"]], ["Half an entry with no separator", "Good one"])
        self.assertTrue(j["entries"][0]["summary"].startswith("summary but the file was cut"))
        for text in ("", "\n\n\n", "not markdown at all", "---", "\x00\x00\x00"):
            with open(LOG, "w") as f:
                f.write(text)
            c, j = self.req("GET", "/history")
            self.assertEqual((c, j["entries"]), (200, []), repr(text))

    def test_round_trip_of_awkward_summaries_titles_and_urls(self):
        awk = "Intro\n\n---\n\n## A heading inside\n\n```\n---\ncode with a rule\n```\n\n- - -\n\n  ---  \n\ntail [x](https://a.test) <b>raw</b>"
        historylog.append("# Title with [brackets] and\nnewline", "codex-dive", "https://v.test/a?x=1&y=<2>[3]\\", awk, path=LOG, channel="  Chan\nnel  ")
        historylog.append("Second", "claude-dive", "https://v.test/b", "```\nopen fence never closed", path=LOG)
        historylog.append("Third", "claude-dip", "https://v.test/c", "after", path=LOG)
        es = self.req("GET", "/history")[1]["entries"]
        self.assertEqual([e["title"] for e in es], ["Third", "Second", "Title with [brackets] and newline"])
        e = es[2]
        self.assertEqual((e["channel"], e["url"], e["mode"]), ("Chan nel", "https://v.test/a?x=1&y=<2>[3]\\", "codex-dive"))
        self.assertEqual(e["summary"], awk)  # rules unescaped, the in-fence line untouched, nothing split the entry
        self.assertEqual(es[1]["summary"], "```\nopen fence never closed\n```")

    def test_a_real_job_shows_up_and_clear_history_leaves_it_there(self):
        models.CLAUDE = fake_claude()
        c, r = self.submit("claude-dive", "h1", "/h")
        self.assertIn(c, (200, 202))
        self.wait(r["job_id"])
        self.assertTrue(self.svc.wait_idle(30))
        self.req("POST", "/clear", {})
        j = self.req("GET", "/history")[1]
        self.assertEqual((j["total"], j["entries"][0]["mode_label"], j["entries"][0]["summary"]), (1, "Claude Dive", "fake summary"))

    def test_a_log_over_the_read_cap_is_read_from_its_tail(self):
        self.seed(30)
        old = historylog.MAX_READ
        try:
            historylog.MAX_READ = os.path.getsize(LOG) // 2
            j = self.req("GET", "/history?limit=100")[1]
        finally:
            historylog.MAX_READ = old
        self.assertEqual(j["entries"][0]["title"], "Title 29")
        self.assertTrue(0 < len(j["entries"]) < 30)
        self.assertEqual([e["title"] for e in j["entries"]], [f"Title {i}" for i in range(29, 29 - len(j["entries"]), -1)])


class SaveToggle(Base):
    """The panel's "Save this Dip to history" checkbox: POST /history/<job id>/remove and /restore."""

    def setUp(self):
        super().setUp()
        self.trash = os.path.join(rec_dir(), "removed")

    T0 = 1790000000  # entries an hour apart, so their date lines differ

    def seed(self, n, path=LOG):
        ids = [f"{i:032x}" for i in range(1, n + 1)]
        for i, jid in enumerate(ids):
            historylog.append(f"Title {i}", "claude-dip", f"https://v.test/{i}", f"Summary {i}\n\n- point {i}", path=path, job_id=jid,
                              when=self.T0 + 3600 * i)
        return ids

    def later(self, title, jid, path=LOG, hours=100):
        historylog.append(title, "codex-dip", f"https://v.test/{title}", title, path=path, job_id=jid, when=self.T0 + 3600 * hours)

    def titles(self, path=LOG):
        return [e["title"] for e in historylog.read_entries(path)]

    def test_the_id_is_an_invisible_comment_and_reads_back_with_the_entry(self):
        jid = "ab" * 16
        e = historylog.format_entry("T", "claude-dive", "https://v.test/x", "body", job_id=jid)
        self.assertIn(f") \n".strip() + f"\n<!-- dipdive-job: {jid} -->\n\nbody\n\n---\n\n", e)
        self.assertNotIn("dipdive-job", historylog.format_entry("T", "claude-dive", "https://v.test/x", "body", job_id="not-hex"))
        historylog.append("Old", "claude-dip", "https://v.test/o", "old entry without an id", path=LOG)
        historylog.append("New", "claude-dive", "https://v.test/n", "new", path=LOG, job_id=jid)
        es = self.req("GET", "/history")[1]["entries"]
        self.assertEqual([(x["title"], x["job_id"], x["summary"]) for x in es], [("New", jid, "new"), ("Old", "", "old entry without an id")])

    def test_remove_then_restore_gives_back_the_exact_file_wherever_the_entry_was(self):
        ids = self.seed(4)
        original = read_log(LOG)
        for jid in (ids[0], ids[2], ids[3]):                          # first (under the file heading), middle, last
            self.assertFalse(historylog.remove_entry(jid, self.trash, LOG))
            t = read_log(LOG)
            self.assertNotIn(jid, t)
            self.assertTrue(t.startswith("# Dip'n'Dive Log\n\n## "))
            self.assertEqual(len(entries(t)), 3)
            self.assertFalse(historylog.saved_state(jid, self.trash, LOG))
            self.assertTrue(historylog.restore_entry(jid, self.trash, LOG))
            self.assertEqual(read_log(LOG), original)
            self.assertTrue(historylog.saved_state(jid, self.trash, LOG))

    def test_restore_keeps_order_when_neighbours_move_and_new_entries_arrive(self):
        ids = self.seed(3)
        historylog.remove_entry(ids[1], self.trash, LOG)
        historylog.remove_entry(ids[2], self.trash, LOG)              # the entry that followed it goes too
        self.later("Later", "f" * 32)
        historylog.restore_entry(ids[1], self.trash, LOG)             # after the one before it, before the newer arrival
        historylog.restore_entry(ids[2], self.trash, LOG)             # its recorded predecessor is Title 0: dates put it after Title 1
        self.assertEqual(self.titles(), ["Title 0", "Title 1", "Title 2", "Later"])
        p2 = os.path.join(os.path.dirname(self.trash), "b.md")
        ids2 = self.seed(2, path=p2)
        historylog.remove_entry(ids2[0], self.trash, p2)
        self.later("Arrived", "e" * 32, path=p2)
        historylog.restore_entry(ids2[0], self.trash, p2)            # no predecessor; its successor is still there
        self.assertEqual(self.titles(p2), ["Title 0", "Title 1", "Arrived"])

    def test_restoring_the_newest_after_newer_ones_arrived_keeps_dates_in_order(self):
        # review finding: remove the tail entry A, a newer B arrives, restore A -> A must come before B
        ids = self.seed(2)
        historylog.remove_entry(ids[1], self.trash, LOG)
        self.later("B", "b" * 32)
        historylog.restore_entry(ids[1], self.trash, LOG)
        self.assertEqual(self.titles(), ["Title 0", "Title 1", "B"])
        # both neighbours gone: placed by its date among the others
        ids3 = self.seed(5, path=os.path.join(os.path.dirname(self.trash), "c.md"))
        p3 = os.path.join(os.path.dirname(self.trash), "c.md")
        historylog.remove_entry(ids3[2], self.trash, p3)
        historylog.remove_entry(ids3[1], self.trash, p3)
        historylog.remove_entry(ids3[3], self.trash, p3)
        historylog.restore_entry(ids3[2], self.trash, p3)          # its prev (1) and next (3) are both still removed
        self.assertEqual(self.titles(p3), ["Title 0", "Title 2", "Title 4"])
        historylog.restore_entry(ids3[3], self.trash, p3)
        historylog.restore_entry(ids3[1], self.trash, p3)
        self.assertEqual(self.titles(p3), [f"Title {i}" for i in range(5)])

    def test_idempotent_and_unknown_ids(self):
        ids = self.seed(2)
        self.assertFalse(historylog.remove_entry(ids[0], self.trash, LOG))
        self.assertFalse(historylog.remove_entry(ids[0], self.trash, LOG))
        self.assertEqual(len(entries(read_log(LOG))), 1)
        self.assertTrue(historylog.restore_entry(ids[0], self.trash, LOG))
        self.assertTrue(historylog.restore_entry(ids[0], self.trash, LOG))
        self.assertTrue(historylog.restore_entry(ids[1], self.trash, LOG))  # never removed: already saved
        self.assertEqual(len(entries(read_log(LOG))), 2)
        for bad in ("9" * 32, "../../etc/passwd", "", "A" * 32):
            with self.assertRaises(historylog.NoSuchEntry):
                historylog.remove_entry(bad, self.trash, LOG)
            with self.assertRaises(historylog.NoSuchEntry):
                historylog.restore_entry(bad, self.trash, LOG)
        os.remove(LOG)
        with self.assertRaises(historylog.NoSuchEntry):
            historylog.remove_entry(ids[0], self.trash, LOG)

    def test_hand_edited_separators_never_take_a_neighbour_along(self):
        # review finding: A's separator replaced by *** (or deleted) used to merge A and B, and removing A removed B
        for edit in ("***", ""):
            ids = self.seed(3)
            t = read_log(LOG)
            first = t.index("\n---\n")
            with open(LOG, "w") as f:
                f.write(t[:first + 1] + edit + t[first + 4:])
            self.assertEqual(self.titles(), ["Title 0", "Title 1", "Title 2"], "read as three entries")
            historylog.remove_entry(ids[0], self.trash, LOG)
            self.assertEqual(self.titles(), ["Title 1", "Title 2"], repr(edit))
            historylog.restore_entry(ids[0], self.trash, LOG)
            self.assertEqual(self.titles(), ["Title 0", "Title 1", "Title 2"])
            os.remove(LOG)

    def test_an_entry_whose_neighbour_lost_its_heading_is_refused_not_cut(self):
        ids = self.seed(3)
        t = read_log(LOG).replace("## Title 1\n", "Title 1 (heading deleted by hand)\n")
        with open(LOG, "w") as f:
            f.write(t.replace("\n---\n\nTitle 1", "\n\nTitle 1"))  # and the separator before it
        before = read_log(LOG)
        with self.assertRaises(historylog.AmbiguousEntry):
            historylog.remove_entry(ids[0], self.trash, LOG)
        self.assertEqual(read_log(LOG), before, "nothing changed")
        self.assertFalse(os.path.exists(os.path.join(self.trash, ids[0] + ".json")))
        self.assertTrue(historylog.saved_state(ids[0], self.trash, LOG))
        historylog.remove_entry(ids[2], self.trash, LOG)  # an unaffected entry still works

    def test_line_breaks_other_than_newline_crlf_and_nbsp_rules_round_trip(self):
        # review finding: splitlines() split on U+2028, \x0c, \x1c and friends; a CRLF log gained a newline; ---+NBSP
        odd = "one\u2028two\x0cthree\x1cfour\u0085five\n---\u00a0\nsix"
        historylog.append("Odd", "claude-dip", "https://v.test/o", odd, path=LOG, job_id="1" * 32)
        historylog.append("Next", "claude-dip", "https://v.test/n", "n", path=LOG, job_id="2" * 32)
        es = historylog.read_entries(LOG)
        self.assertEqual([(e["title"], e["summary"]) for e in es], [("Odd", odd), ("Next", "n")], "---+NBSP is not a separator")
        original = read_log(LOG)
        for jid in ("1" * 32, "2" * 32):
            historylog.remove_entry(jid, self.trash, LOG)
            historylog.restore_entry(jid, self.trash, LOG)
            self.assertEqual(read_log(LOG), original)
        with open(LOG, "rb") as f:
            raw = f.read()
        with open(LOG, "wb") as f:
            f.write(raw.replace(b"\n", b"\r\n"))
        crlf = open(LOG, "rb").read()
        self.assertEqual(len(historylog.read_entries(LOG)), 2)
        for jid in ("2" * 32, "1" * 32):  # the last entry, then the first
            historylog.remove_entry(jid, self.trash, LOG)
            self.assertNotIn(jid.encode(), open(LOG, "rb").read())
            historylog.restore_entry(jid, self.trash, LOG)
            self.assertEqual(open(LOG, "rb").read(), crlf)

    def test_a_failed_rewrite_rolls_back_so_the_state_matches_the_log(self):
        # review finding: ENOSPC during the rewrite left the entry in the log but marked removed
        ids = self.seed(2)
        original = read_log(LOG)
        real = historylog._replace

        def full(*a, **k):
            raise OSError(errno.ENOSPC, "No space left on device")
        historylog._replace = full
        try:
            with self.assertRaises(OSError):
                historylog.remove_entry(ids[0], self.trash, LOG)
            self.assertEqual(read_log(LOG), original)
            self.assertTrue(historylog.saved_state(ids[0], self.trash, LOG))
            self.assertFalse(os.path.exists(os.path.join(self.trash, ids[0] + ".json")))
        finally:
            historylog._replace = real
        historylog.remove_entry(ids[0], self.trash, LOG)
        historylog._replace = full
        try:
            with self.assertRaises(OSError):
                historylog.restore_entry(ids[0], self.trash, LOG)
            self.assertFalse(historylog.saved_state(ids[0], self.trash, LOG), "still removed, and still restorable")
        finally:
            historylog._replace = real
        self.assertTrue(historylog.restore_entry(ids[0], self.trash, LOG))
        self.assertEqual(read_log(LOG), original)

    def test_state_is_read_from_the_log_not_the_removed_store(self):
        ids = self.seed(2)
        os.makedirs(self.trash, exist_ok=True)
        with open(os.path.join(self.trash, ids[0] + ".json"), "w") as f:
            f.write("{damaged")                                        # a stale, damaged copy while the entry is in the log
        self.assertTrue(historylog.saved_state(ids[0], self.trash, LOG))
        self.assertTrue(historylog.restore_entry(ids[0], self.trash, LOG), "reconciled, not 404")
        self.assertFalse(os.path.exists(os.path.join(self.trash, ids[0] + ".json")))
        t = read_log(LOG)
        with open(LOG, "w") as f:
            f.write(t[:t.index("## Title 1")])                          # the entry deleted by hand
        self.assertIsNone(historylog.saved_state(ids[1], self.trash, LOG))

    def test_restore_and_remove_are_one_transaction(self):
        # review finding: restore published the entry, released the lock, then deleted the copy a concurrent remove had
        # just written; the entry ended up nowhere
        ids = self.seed(2)
        historylog.remove_entry(ids[0], self.trash, LOG)
        real, other = historylog._replace, {}

        def slow(*a, **k):
            real(*a, **k)
            if "t" not in other:
                other["t"] = threading.Thread(target=lambda: other.setdefault("r", historylog.remove_entry(ids[0], self.trash, LOG)))
                other["t"].start()
                time.sleep(0.4)
                other["waited"] = other["t"].is_alive()  # the remove must be waiting for the restore to finish
        historylog._replace = slow
        try:
            historylog.restore_entry(ids[0], self.trash, LOG)
        finally:
            historylog._replace = real
        other["t"].join(10)
        self.assertTrue(other["waited"])
        self.assertFalse(historylog.saved_state(ids[0], self.trash, LOG))
        self.assertTrue(os.path.exists(os.path.join(self.trash, ids[0] + ".json")), "the remove's copy survived")
        self.assertTrue(historylog.restore_entry(ids[0], self.trash, LOG))

    def test_an_append_from_another_process_during_a_rewrite_is_not_lost(self):
        # review finding: a writer in another process waited on the old log inode, then appended to the unlinked file
        ids = self.seed(2)
        code = ("import sys; sys.path.insert(0, %r); from dipdive import historylog; "
                "historylog.append('From another process', 'codex-dive', 'https://v.test/x', 'x', path=%r, job_id='c' * 32)"
                % (os.getcwd(), LOG))
        with historylog.locked(LOG):
            proc = subprocess.Popen([sys.executable, "-c", code])
            time.sleep(1.0)                                            # it is now waiting for the lock
            self.assertIsNone(proc.poll())
            historylog.remove_entry(ids[0], self.trash, LOG)           # rewrites (and replaces) the log meanwhile
        self.assertEqual(proc.wait(20), 0)
        self.assertEqual(self.titles(), ["Title 1", "From another process"])
        self.assertTrue(os.path.exists(os.path.join(os.path.dirname(LOG), "." + os.path.basename(LOG) + ".lock")), "the stable sidecar lock")

    def test_removing_or_restoring_changes_the_revision_and_appends_do_not(self):
        # review finding: removals shifted positions under a reader's cursor (repeats or skips)
        ids = self.seed(25)
        p1 = historylog.read_page(None, 20, LOG)
        self.later("New", "d" * 32)
        self.assertEqual(historylog.read_page(p1["next_before"], 20, LOG, rev=p1["revision"])["entries"][0]["title"], "Title 4")
        historylog.remove_entry(ids[0], self.trash, LOG)
        with self.assertRaises(historylog.HistoryChanged):
            historylog.read_page(p1["next_before"], 20, LOG, rev=p1["revision"])
        fresh = historylog.read_page(None, 20, LOG)
        self.assertNotEqual(fresh["revision"], p1["revision"])
        historylog.restore_entry(ids[0], self.trash, LOG)
        self.assertNotEqual(historylog.read_page(None, 20, LOG)["revision"], fresh["revision"])

    def test_same_minute_entries_go_back_in_their_original_order(self):
        # re-verification finding 7: remove A, B arrives a second later in the same minute, restore A -> was [B, A]
        now = time.time()
        historylog.append("A", "claude-dip", "https://v.test/a", "a", path=LOG, job_id="a" * 32, when=now)
        historylog.remove_entry("a" * 32, self.trash, LOG)
        historylog.append("B", "claude-dip", "https://v.test/b", "b", path=LOG, job_id="b" * 32, when=now)
        historylog.restore_entry("a" * 32, self.trash, LOG)
        self.assertEqual(self.titles(), ["A", "B"])
        # chains of same-minute removals and restores, in every order
        os.remove(LOG)
        ids = [f"{i:032x}" for i in range(1, 6)]
        for i, jid in enumerate(ids):
            historylog.append(f"E{i}", "claude-dip", f"https://v.test/{i}", f"s{i}", path=LOG, job_id=jid, when=now)
        original = read_log(LOG)
        for order in ([1, 2, 3], [3, 1, 2], [0, 4, 2]):
            for k in order:
                historylog.remove_entry(ids[k], self.trash, LOG)
            for k in reversed(order[1:] + order[:1]):
                historylog.restore_entry(ids[k], self.trash, LOG)
            self.assertEqual(self.titles(), [f"E{i}" for i in range(5)], order)
            self.assertEqual(read_log(LOG), original, order)

    def test_entries_from_before_sequence_numbers_still_remove_and_restore(self):
        old = "".join(historylog.format_entry(f"Old {i}", "claude-dip", f"https://v.test/{i}", f"o{i}", job_id=f"{i:032x}",
                                              when=self.T0 + 3600 * i) for i in (1, 2, 3))
        with open(LOG, "w") as f:
            f.write(historylog.HEADING + old)
        self.assertNotIn("seq=", read_log(LOG))
        historylog.remove_entry(f"{2:032x}", self.trash, LOG)
        self.assertEqual(self.titles(), ["Old 1", "Old 3"])
        historylog.restore_entry(f"{2:032x}", self.trash, LOG)
        self.assertEqual(read_log(LOG), historylog.HEADING + old)

    def test_a_page_read_during_a_removal_sees_the_new_revision(self):
        # re-verification finding 8: between the replace and the revision bump a reader got the new file with the old
        # revision, and its next page repeated an entry
        ids = self.seed(4)
        first = historylog.read_page(None, 2, LOG)
        real, out = historylog._replace, {}

        def slow(*a, **k):
            real(*a, **k)
            time.sleep(0.6)  # the new file is in place; the revision is bumped after this returns
        historylog._replace = slow
        try:
            t = threading.Thread(target=lambda: historylog.remove_entry(ids[0], self.trash, LOG))
            t.start()
            time.sleep(0.2)
            try:
                out["page"] = historylog.read_page(first["next_before"], 2, LOG, rev=first["revision"])
            except historylog.HistoryChanged as e:
                out["changed"] = e.current
            t.join(10)
        finally:
            historylog._replace = real
        self.assertNotIn("page", out, out.get("page"))
        self.assertEqual(out["changed"], historylog.revision(LOG))

    def test_a_summary_cannot_forge_an_entry(self):
        # re-verification finding 9: "## heading" plus a valid-looking date and link line inside a summary became a
        # phantom entry, cutting the real summary short
        forged = ("Intro\n\n## Quoted record\n\n2026-10-01 09:00 | Claude Dip | [x](<https://x.test/>)\n"
                  "<!-- dipdive-job: " + "e" * 32 + " seq=5 -->\n\n## Another\n\n2026-10-01 09:01 | Codex Dive | [y](<https://y.test/>)\n\n"
                  "Important tail")
        historylog.append("Real", "claude-dip", "https://v.test/r", forged, path=LOG, job_id="1" * 32)
        historylog.append("Next", "claude-dip", "https://v.test/n", "n", path=LOG, job_id="2" * 32)
        es = historylog.read_entries(LOG)
        self.assertEqual([e["title"] for e in es], ["Real", "Next"])
        self.assertEqual(es[0]["summary"], forged)
        self.assertNotIn("e" * 32, {e["job_id"] for e in es})
        historylog.remove_entry("1" * 32, self.trash, LOG)
        self.assertEqual(self.titles(), ["Next"])
        self.assertNotIn("Important tail", read_log(LOG), "nothing of it is left behind")
        self.assertFalse(historylog.saved_state("1" * 32, self.trash, LOG))
        historylog.restore_entry("1" * 32, self.trash, LOG)
        self.assertEqual(historylog.read_entries(LOG)[0]["summary"], forged)
        # inside a code fence the same text is left as it is and is still never an entry
        fenced = "```\n" + forged + "\n```"
        historylog.append("Fenced", "claude-dip", "https://v.test/f", fenced, path=LOG, job_id="3" * 32)
        self.assertEqual([e["title"] for e in historylog.read_entries(LOG)], ["Real", "Next", "Fenced"])
        self.assertEqual(historylog.read_entries(LOG)[2]["summary"], fenced)

    def test_fences_rules_and_a_quoted_marker_in_a_summary_do_not_confuse_it(self):
        jid, other = "1" * 32, "2" * 32
        tricky = f"```\n---\n<!-- dipdive-job: {other} -->\n```\n\n---\n\n<!-- dipdive-job: {other} -->"
        historylog.append("Tricky", "claude-dip", "https://v.test/t", tricky, path=LOG, job_id=jid)
        historylog.append("Other", "claude-dip", "https://v.test/o", "plain", path=LOG, job_id=other)
        original = read_log(LOG)
        historylog.remove_entry(other, self.trash, LOG)
        self.assertEqual([e["title"] for e in historylog.read_entries(LOG)], ["Tricky"])
        # outside the fence the rule and the quoted marker are escaped, so neither can pass for the entry's own
        self.assertIn(tricky.replace("\n---\n\n<!--", "\n\\---\n\n\\<!--"), read_log(LOG))
        self.assertEqual(historylog.read_entries(LOG)[0]["summary"], tricky)
        historylog.restore_entry(other, self.trash, LOG)
        historylog.remove_entry(jid, self.trash, LOG)
        self.assertEqual([e["title"] for e in historylog.read_entries(LOG)], ["Other"])
        historylog.restore_entry(jid, self.trash, LOG)
        self.assertEqual(read_log(LOG), original)

    def test_toggling_while_jobs_append_from_threads_loses_nothing(self):
        ids = self.seed(3)
        errors = []

        def appender(k):
            try:
                for n in range(8):
                    historylog.append(f"T{k}-{n}", "codex-dive", f"https://v.test/{k}/{n}", "s", path=LOG, job_id=f"{k + 0xa0:02x}{n:030x}")
            except Exception as e:  # pragma: no cover
                errors.append(e)
        ts = [threading.Thread(target=appender, args=(k,)) for k in range(4)]
        for t in ts:
            t.start()
        for _ in range(10):
            historylog.remove_entry(ids[1], self.trash, LOG)
            historylog.restore_entry(ids[1], self.trash, LOG)
        for t in ts:
            t.join()
        self.assertEqual(errors, [])
        es = historylog.read_entries(LOG)
        self.assertEqual(len(es), 3 + 32)
        self.assertEqual([e["title"] for e in es[:2]], ["Title 0", "Title 1"])
        self.assertEqual(len({e["job_id"] for e in es}), 35)
        self.assertEqual([n for n in os.listdir(os.path.dirname(LOG)) if n.endswith(".tmp")], [], "no temp file left behind")


class SaveToggleServer(FakeModels):
    def test_uncheck_and_check_through_the_companion(self):
        j = self.run_job("claude-dip", "s1")
        jid = j["job_id"]
        self.assertTrue(j["history_saved"])
        original = read_log(LOG)
        self.assertRegex(original, f"\n<!-- dipdive-job: {jid} seq=\\d+ -->\n")
        for _ in range(2):  # idempotent
            c, r = self.req("POST", f"/history/{jid}/remove", {})
            self.assertEqual((c, r["saved"], r["job_id"]), (200, False, jid))
        self.assertFalse(os.path.exists(LOG) and jid in read_log(LOG))
        self.assertEqual(self.req("GET", "/history")[1]["total"], 0)
        self.assertFalse(self.req("GET", "/jobs/" + jid)[1]["history_saved"])
        for _ in range(2):
            c, r = self.req("POST", f"/history/{jid}/restore", {})
            self.assertEqual((c, r["saved"]), (200, True))
        self.assertEqual(read_log(LOG), original)
        self.assertTrue(self.req("GET", "/jobs/" + jid)[1]["history_saved"])

    def test_auth_origin_and_bad_ids(self):
        jid = self.run_job("claude-dip", "s2")["job_id"]
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {}, auth=False)[0], 401)
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {}, headers={"Host": "evil.example"})[0], 403)
        self.assertIn(jid, read_log(LOG), "nothing was removed by a refused request")
        self.assertEqual(self.req("POST", f"/history/{'9' * 32}/remove", {})[1]["error_code"], "no_such_entry")
        for bad in (f"/history/{jid}/delete", f"/history/{jid.upper()}/remove", "/history/abc/remove", f"/history/{jid}/remove/x"):
            self.assertEqual(self.req("POST", bad, {})[0], 404, bad)
        self.assertEqual(self.req("GET", f"/history/{jid}/remove")[0], 404, "only POST changes the log")
        a = self.run_job("claude-ask", "s3", question="why?")
        self.assertIsNone(a["history_saved"])
        c, r = self.req("POST", f"/history/{a['job_id']}/remove", {})
        self.assertEqual((c, r["error_code"]), (404, "not_logged"))

    def test_a_cache_hit_controls_the_entry_of_the_job_that_made_the_result(self):
        j1 = self.run_job("claude-dip", "c1")
        self.svc.by_prekey.clear()
        j2 = self.run_job("claude-dip", "c2")
        self.assertNotEqual(j1["job_id"], j2["job_id"])
        self.assertTrue(j2["history_saved"])
        self.assertEqual(self.req("POST", f"/history/{j2['job_id']}/remove", {})[0], 200)
        self.assertFalse(self.req("GET", "/jobs/" + j1["job_id"])[1]["history_saved"])
        self.assertEqual(len(historylog.read_entries(LOG)), 0)
        self.assertEqual(self.req("POST", f"/history/{j1['job_id']}/restore", {})[0], 200)
        self.assertTrue(self.req("GET", "/jobs/" + j2["job_id"])[1]["history_saved"])

    def test_a_job_whose_log_write_failed_has_no_checkbox_state(self):
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(os.path.dirname(LOG), "missing-dir-blocker")
        with open(os.environ["DIPDIVE_LOG_PATH"], "w") as f:
            f.write("x")
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(os.environ["DIPDIVE_LOG_PATH"], "log.md")
        j = self.run_job("claude-dip", "f1")
        self.assertEqual((j["state"], j["history_saved"]), ("done", None))
        self.assertEqual(self.req("POST", f"/history/{j['job_id']}/remove", {})[1]["error_code"], "not_logged")

    def test_stale_generation_is_refused_and_clear_waits_for_a_change_in_progress(self):
        # review finding: a restore that had read its copy before Clear finished after it and brought the entry back
        jid = self.run_job("claude-dip", "g1")["job_id"]
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {"clearGeneration": 0})[0], 200)
        real, timeline = historylog._replace, []

        def slow(*a, **k):
            time.sleep(0.6)
            real(*a, **k)
            timeline.append("restore written")
        historylog._replace = slow
        try:
            t = threading.Thread(target=lambda: timeline.append(("restore", self.req("POST", f"/history/{jid}/restore", {"clearGeneration": 0})[0])))
            t.start()
            time.sleep(0.2)
            self.assertEqual(self.req("POST", "/clear", {})[0], 200)
            timeline.append("clear done")
            t.join(10)
        finally:
            historylog._replace = real
        self.assertLess(timeline.index("restore written"), timeline.index("clear done"), timeline)
        self.assertIn(("restore", 200), timeline)
        self.assertIn(jid, read_log(LOG), "the restore finished whole before the clear")
        c, r = self.req("POST", f"/history/{jid}/remove", {"clearGeneration": 0})
        self.assertEqual((c, r["error_code"], r["clear_generation"]), (409, "stale_clear_generation", 1))
        self.assertIn(jid, read_log(LOG), "a stale request changes nothing")
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {"clearGeneration": "x"})[0], 400)
        # after a clear, an entry removed before it cannot come back: its copy went with the clear
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {"clearGeneration": 1})[0], 200)
        self.req("POST", "/clear", {})
        self.assertEqual(self.req("POST", f"/history/{jid}/restore", {"clearGeneration": 2})[1]["error_code"], "no_such_entry")
        self.assertNotIn(jid, read_log(LOG))

    def test_a_missing_job_answers_with_the_clear_generation(self):
        # lets a panel tell, on focus, that its job went with a Clear history on another machine
        self.req("POST", "/clear", {})
        c, r = self.req("GET", "/jobs/" + "0" * 32)
        self.assertEqual((c, r["error_code"], r["clear_generation"]), (404, "no_such_job", 1))

    def test_paging_after_a_removal_says_the_history_changed(self):
        for i in range(5):
            self.run_job("claude-dip", f"p{i}", path=f"/p{i}")
        ids = [e["job_id"] for e in historylog.read_entries(LOG)]
        c, p1 = self.req("GET", "/history?limit=2")
        self.assertEqual((c, p1["next_before"]), (200, 3))
        self.assertEqual(self.req("GET", f"/history?limit=2&before=3&revision={p1['revision']}")[0], 200)
        self.assertEqual(self.req("POST", f"/history/{ids[0]}/remove", {})[0], 200)
        c, r = self.req("GET", f"/history?limit=2&before=3&revision={p1['revision']}")
        self.assertEqual((c, r["error_code"]), (409, "history_changed"))
        self.assertNotEqual(r["revision"], p1["revision"])
        self.assertEqual(self.req("GET", "/history?limit=2&before=3")[0], 200, "without a revision: the old behaviour")
        self.assertEqual(self.req("GET", "/history?revision=abc")[0], 400)

    def test_unreadable_log_is_503_and_clear_forgets_removed_entries_but_not_the_log(self):
        jid = self.run_job("claude-dip", "u1")["job_id"]
        self.assertEqual(self.req("POST", f"/history/{jid}/remove", {})[0], 200)
        self.assertTrue(os.listdir(self.svc.removed_dir))
        self.run_job("claude-dive", "u2", path="/b")
        before = read_log(LOG)
        self.assertEqual(self.req("POST", "/clear", {})[0], 200)
        self.assertFalse(os.path.exists(self.svc.removed_dir))
        self.assertEqual(read_log(LOG), before)
        os.environ["DIPDIVE_LOG_PATH"] = os.path.dirname(LOG)
        c, r = self.req("POST", f"/history/{'1' * 32}/remove", {})
        self.assertEqual((c, r["error_code"]), (503, "log_unreadable"))


def joblog_dir():
    from dipdive import joblog
    return joblog.LOG_DIR


def tearDownModule():
    for d in _DIRS:
        shutil.rmtree(d, ignore_errors=True)
    from tests import test_server
    shutil.rmtree(os.path.dirname(LOG), ignore_errors=True)
    shutil.rmtree(test_server._SUP, ignore_errors=True)
    for d in test_server._BINS:  # fake_claude folders made by this module when it runs alone
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
