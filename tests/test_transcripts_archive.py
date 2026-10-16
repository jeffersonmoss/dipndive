"""tools/transcripts_archive.py against a fake companion: sync, numbering, offline reads, file names."""
import http.server
import importlib.util
import io
import json
import os
import re
import shutil
import tempfile
import threading
import unittest
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "t" * 40


class Fake(http.server.BaseHTTPRequestHandler):
    entries = []          # newest first, like GET /history
    texts = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self._send(401, {})
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/history":
            limit = int(q["limit"][0])
            top = int(q["before"][0]) if "before" in q else len(self.entries)
            oldest_first = list(reversed(self.entries))
            lo = max(0, top - limit)
            page = [dict(oldest_first[i], index=i) for i in range(top - 1, lo - 1, -1)]
            return self._send(200, {"entries": page, "next_before": lo if lo > 0 else None})
        if u.path == "/transcript":
            url = q["url"][0]
            if url in self.texts:
                return self._send(200, {"title": "t", "url": url, "text": self.texts[url], "channel": "Chan"})
            return self._send(404, {"error_code": "not_archived"})
        self._send(404, {})

    def _send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


def entry(n, title=None, day="2026-10-16", hm=None, mode="Claude Dip"):
    return {"title": title or f"Video {chr(64 + n)}", "channel": "", "date": day, "time": hm or f"10:{n:02d}",
            "mode_label": mode, "url": f"https://www.youtube.com/watch?v=vid{n}", "summary": f"Summary {n}",
            "job_id": f"{n:032x}"}


class Archive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dipdive-archive-test-")
        with open(os.path.join(self.tmp, "token"), "w") as f:
            f.write(TOKEN)
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        os.environ.update(DIPDIVE_BASE=f"http://127.0.0.1:{self.srv.server_port}",
                          DIPDIVE_TOKEN_FILE=os.path.join(self.tmp, "token"),
                          DIPDIVE_ARCHIVE=os.path.join(self.tmp, "archive"))
        spec = importlib.util.spec_from_file_location("ta", os.path.join(HERE, "..", "tools", "transcripts_archive.py"))
        self.ta = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ta)
        Fake.entries = [entry(3), entry(2), entry(1)]
        Fake.texts = {e["url"]: f"transcript of {e['title']}" for e in Fake.entries}

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for k in ("DIPDIVE_BASE", "DIPDIVE_TOKEN_FILE", "DIPDIVE_ARCHIVE"):
            os.environ.pop(k, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.ta.main(["dipdive-transcript", *args])
        return code, out.getvalue(), err.getvalue()

    def test_latest_and_nth_with_full_transcript(self):
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("# Video C", out)
        self.assertIn("transcript of Video C", out)
        self.assertIn("Summary 3", out)
        self.assertIn("transcript of Video A", self.run_main("3")[1])
        listing = self.run_main("--list", "5")[1]
        self.assertEqual([l.split(" (")[0] for l in listing.splitlines()], ["1. Video C", "2. Video B", "3. Video A"])

    def test_works_offline_and_keeps_everything(self):
        self.run_main("--sync")
        self.srv.shutdown()
        Fake.entries = []  # even if the log lost them, the archive keeps them
        code, out, err = self.run_main("2")
        self.assertEqual(code, 0)
        self.assertIn("transcript of Video B", out)
        self.assertIn("iMac not reached", err)

    def test_missing_transcript_is_filled_in_later(self):
        Fake.texts.pop(Fake.entries[0]["url"])
        self.run_main("--sync")
        self.assertIn("not available", self.run_main("1", "--no-sync")[1])
        Fake.texts[Fake.entries[0]["url"]] = "late transcript"
        self.assertIn("late transcript", self.run_main("1")[1])
        self.assertEqual(len(os.listdir(os.path.join(self.tmp, "archive"))), 4, "three Dips and the index, no duplicates")

    def test_file_names_follow_the_naming_rule(self):
        Fake.entries = [entry(4, title="Top 10 AI tools of 2026: GPT-6.1 vs 12345"), entry(5, title="Top 10 AI tools of 2026: GPT-6.1 vs 12345")]
        self.run_main("--sync")
        names = sorted(n for n in os.listdir(os.path.join(self.tmp, "archive")) if n.endswith(".md"))
        self.assertEqual(len(names), 2)
        for n in names:
            chunks = re.findall(r"\d+", n[:-3])
            self.assertLessEqual(len(chunks), 3, n)
            self.assertTrue(all(len(c) <= 4 for c in chunks), n)
            self.assertNotRegex(n[:-3], r"\d[\s.,:-]+\d", n)  # every pair of numbers has a word between
        self.assertTrue(any(n.endswith(" - again.md") for n in names), names)


if __name__ == "__main__":
    unittest.main()
