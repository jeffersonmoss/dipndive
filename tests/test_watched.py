"""Watched transcript API and archive tests. All files stay in a labeled temporary folder."""
import json
import io
import os
import shutil
import tempfile
import threading
import time
import unittest
from email.message import Message
from unittest.mock import patch

os.environ["DIPDIVE_TEST_ALLOW_LOOPBACK"] = "1"

from dipdive import historylog, joblog, server, service, watched
from dipdive.acquire import Source
from dipdive.errors import DipDiveError


class WatchedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dipdive-watched-tests-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        with open(os.path.join(self.tmp, "TEMP_README.md"), "w") as f:
            f.write("owner: tests/test_watched.py\nshared: no\n"
                    "purpose: temporary support, transcript and history files for watched transcript tests\n"
                    "chat and machine: Dip'n'Dive watched recorder on this Mac\n"
                    "date: 2026-10-06\nneeded until: test case cleanup\n"
                    "costly to recreate: no\n")
        self.old = {"log": os.environ.get("DIPDIVE_LOG_PATH"), "dir": os.environ.get("DIPDIVE_TRANSCRIPTS_DIR"),
                    "support": joblog.SUPPORT, "logdir": joblog.LOG_DIR}
        self.addCleanup(self.restore)
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(self.tmp, "history.md")
        os.environ.pop("DIPDIVE_TRANSCRIPTS_DIR", None)
        joblog.SUPPORT = self.tmp
        joblog.LOG_DIR = os.path.join(self.tmp, "logs")
        self.token = "t" * 48
        self.svc = service.Service(self.tmp, start_workers=False)
        self.handler = server.make_handler(self.svc, self.token)

    def restore(self):
        for key, env in (("log", "DIPDIVE_LOG_PATH"), ("dir", "DIPDIVE_TRANSCRIPTS_DIR")):
            if self.old[key] is None:
                os.environ.pop(env, None)
            else:
                os.environ[env] = self.old[key]
        joblog.SUPPORT, joblog.LOG_DIR = self.old["support"], self.old["logdir"]

    def req(self, body, token=None, headers=None, path="/watched"):
        raw = json.dumps(body).encode()
        h = Message()
        h["Host"] = "127.0.0.1:8765"
        h["Content-Length"] = str(len(raw))
        if token is not False:
            h["Authorization"] = "Bearer " + (self.token if token is None else token)
        for key, value in (headers or {}).items(): h[key] = value
        class Handler(self.handler):
            def send_response(self, code, message=None): self.status = code
            def send_header(self, key, value): pass
            def end_headers(self): pass
        request = Handler.__new__(Handler)
        request.headers, request.path = h, path
        request.rfile, request.wfile = io.BytesIO(raw), io.BytesIO()
        request.close_connection = False
        request.do_POST()
        return request.status, json.loads(request.wfile.getvalue())

    @staticmethod
    def source(vid="dQw4w9WgXcQ", **meta):
        return Source("youtube", vid, "A title", f"https://www.youtube.com/watch?v={vid}",
                      "First transcript paragraph.\n\nSecond transcript paragraph.",
                      {"channel": "Creator", **meta})

    def test_watched_auth_and_validation(self):
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        self.assertEqual(self.req({"url": url}, token=False)[0], 401)
        self.assertEqual(self.req({"url": url}, token="x" * 48)[0], 401)
        self.assertEqual(self.req({"url": "https://youtube.com/playlist?list=PL1"})[0], 400)
        self.assertEqual(self.req({"url": "file:///tmp/x"})[0], 400)
        for path in ("/watched", "/watched/prefetch"):
            self.assertEqual(self.req({"url": "https://www.youtube.com/shorts/dQw4w9WgXcQ"}, path=path)[0], 400)
            self.assertEqual(self.req({"url": "https://www.youtube.com/live/dQw4w9WgXcQ"}, path=path)[0], 400)
        self.assertEqual(self.req({"url": url}, headers={"Origin": "https://evil.example"})[0], 403)

    def test_prefetch_queues_and_deduplicates(self):
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        self.assertEqual(self.req({"url": url}, path="/watched/prefetch")[0], 202)
        self.assertEqual(self.svc.queue_watched_prefetch(url)[0], 200)
        self.assertEqual(self.svc.prefetch_q.qsize(), 1)

    def test_prefetch_caches_source_without_archive_or_index(self):
        src = self.source()
        with patch("dipdive.service.acquire", return_value=src):
            self.assertTrue(self.svc._prefetch_watched(src.source_id, src.url))
        norm = f"yt:{src.source_id}"
        cached = self.svc._read_source(norm)
        self.assertEqual(cached["ttl"], service.SOURCE_TTL)
        self.assertEqual(cached["text"], src.text)
        self.assertEqual(self.svc.queue_watched_prefetch(src.url), (200, {"queued": False, "cached": True}))
        self.assertFalse(os.path.exists(self.svc.watched_index))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "Dipn Dive Transcripts - October 2026.md")))

    def test_queue_dedupes_concurrent_reports(self):
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.req({"url": url})[0])) for _ in range(12)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(results.count(202), 1)
        self.assertEqual(results.count(200), 11)
        self.assertEqual(self.svc.watched_q.qsize(), 1)

    def test_live_status_values_and_missing_captions_are_quietly_skipped(self):
        for index, status in enumerate(("is_live", "is_upcoming", "was_live", "post_live")):
            live = self.source(f"{index:011d}", live_status=status)
            with patch("dipdive.service.acquire", return_value=live):
                self.assertFalse(self.svc._record_watched(live.source_id, live.url))
                self.assertFalse(self.svc._prefetch_watched(live.source_id, live.url))
        no_caps = self.source("a" * 11)
        with patch("dipdive.service.acquire", side_effect=DipDiveError("no_captions", "none")):
            self.assertFalse(self.svc._record_watched(no_caps.source_id, no_caps.url))
            self.assertFalse(self.svc._prefetch_watched(no_caps.source_id, no_caps.url))
        with patch("dipdive.service.acquire", side_effect=DipDiveError("live_in_progress", "live")):
            self.assertFalse(self.svc._record_watched("live-video-01", no_caps.url))
            self.assertFalse(self.svc._prefetch_watched("live-video-01", no_caps.url))
        self.assertFalse(os.path.exists(self.svc.watched_index))
        self.assertFalse(os.path.exists(os.environ["DIPDIVE_LOG_PATH"]))

    def test_monthly_filename_and_entry_format(self):
        stamp = time.mktime((2026, 10, 6, 13, 4, 0, 0, 0, -1))
        src = self.source()
        with watched.locked():
            self.assertTrue(watched.append(src, src.url, when=stamp))
        path = os.path.join(self.tmp, "Dipn Dive Transcripts - October 2026.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("## A title\n\nChannel: Creator\n\n2026-10-06 13:04", text)
        self.assertIn("[https://www.youtube.com/watch?v=dQw4w9WgXcQ](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>)", text)
        self.assertIn("First transcript paragraph.\n\nSecond transcript paragraph.", text)
        self.assertTrue(text.endswith("---\n\n"))

    def test_concurrent_distinct_appends_remain_intact(self):
        items = [self.source(f"{i:011d}") for i in range(12)]
        errors = []
        def add(src):
            try:
                with watched.locked():
                    watched.append(src, src.url, when=1791311040)
            except Exception as e:
                errors.append(e)
        threads = [threading.Thread(target=add, args=(src,)) for src in items]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(errors, [])
        path = os.path.join(self.tmp, "Dipn Dive Transcripts - October 2026.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertEqual(text.count("## A title"), len(items))
        self.assertEqual(text.count("\n---\n"), len(items))

    def test_watched_save_reuses_prefetched_cache_and_extends_ttl(self):
        src = self.source()
        with patch("dipdive.service.acquire", return_value=src):
            self.assertTrue(self.svc._prefetch_watched(src.source_id, src.url))
        with patch("dipdive.service.acquire", side_effect=AssertionError("prefetched captions should be reused")):
            self.assertTrue(self.svc._record_watched(src.source_id, src.url))
        self.assertFalse(self.svc._record_watched(src.source_id, src.url))
        norm = f"yt:{src.source_id}"
        cached = self.svc._read_source(norm)
        self.assertEqual(cached["ttl"], service.WATCHED_SOURCE_TTL)
        cached["fetched"] -= 29 * 86400
        with open(self.svc._src_path(norm), "w") as f:
            json.dump(cached, f)
        with patch("dipdive.service.acquire", side_effect=AssertionError("cache should be reused")):
            got = self.svc._get_source({"norm_id": norm, "force": False, "generation": self.svc.generation,
                                        "url": src.url})
        self.assertEqual(got["text"], src.text)
        self.assertTrue(watched.contains_video(self.tmp, src.source_id))


if __name__ == "__main__":
    unittest.main()
