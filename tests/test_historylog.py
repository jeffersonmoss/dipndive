"""History log tests: one Markdown entry per successful Dip or Dive result, safe appends, /clear leaves it alone.
Every test writes to a temp DIPDIVE_LOG_PATH (see tests/test_server.py), never to the real ~/Public.
Run: .venv/bin/python -m unittest tests.test_historylog -v"""
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


class Server(Base):
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

    def test_each_summary_mode_writes_one_entry(self):
        for i, (mode, label, result) in enumerate([("claude-dip", "Claude Dip", "answer 1"), ("claude-dive", "Claude Dive", "answer 2"),
                                                   ("codex-dip", "Codex Dip", "codex answer 1"), ("codex-dive", "Codex Dive", "codex answer 2")]):
            j = self.run_job(mode, f"r{i}", path=f"/p{i}")
            self.assertEqual((j["state"], j["result_markdown"]), ("done", result))
        t = read_log(LOG)
        es = entries(t)
        self.assertEqual(len(es), 4)
        for e, (label, result, i) in zip(es, [("Claude Dip", "answer 1", 0), ("Claude Dive", "answer 2", 1),
                                              ("Codex Dip", "codex answer 1", 2), ("Codex Dive", "codex answer 2", 3)]):
            self.assertRegex(e, r"^## Art\n\n\d{4}-\d\d-\d\d \d\d:\d\d \| %s \| \[%s/p%d\]\(<%s/p%d>\)\n\n%s$"
                             % (label, re.escape(self.base), i, re.escape(self.base), i, re.escape(result)))

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
