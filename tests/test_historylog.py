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

from dipdive import historylog, models  # noqa: E402

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
