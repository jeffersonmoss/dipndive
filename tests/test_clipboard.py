"""Clipboard mailbox API tests. Run: .venv/bin/python -m unittest tests.test_clipboard -v"""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

os.environ["DIPDIVE_TEST_ALLOW_LOOPBACK"] = "1"

from dipdive import joblog, server, service  # noqa: E402


class ClipboardMailbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dipdive-clipboard-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        with open(os.path.join(self.tmp, "TEMP_README.md"), "w") as f:
            f.write("owner: tests/test_clipboard.py\nshared: no\n"
                    "purpose: temporary support and history data for clipboard mailbox tests\n"
                    "chat and machine: Dip'n'Dive clipboard feature on this Mac\n"
                    "date: 2026-10-05\nneeded until: this test case ends\n"
                    "costly to recreate: no\n")
        self.old_log_path = os.environ.get("DIPDIVE_LOG_PATH")
        self.old_log_dir, self.old_support = joblog.LOG_DIR, joblog.SUPPORT
        self.addCleanup(self.restore_globals)
        os.environ["DIPDIVE_LOG_PATH"] = os.path.join(self.tmp, "history.md")
        joblog.LOG_DIR = os.path.join(self.tmp, "logs")
        joblog.SUPPORT = self.tmp
        self.token = "t" * 48
        self.server_started = False
        self.start_server()

    def restore_globals(self):
        if self.old_log_path is None:
            os.environ.pop("DIPDIVE_LOG_PATH", None)
        else:
            os.environ["DIPDIVE_LOG_PATH"] = self.old_log_path
        joblog.LOG_DIR, joblog.SUPPORT = self.old_log_dir, self.old_support

    def start_server(self):
        self.svc = service.Service(self.tmp, start_workers=False)
        self.srv = server.make_server(0, self.svc, self.token)
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self.server_started = True
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def stop_server(self):
        if not getattr(self, "server_started", False):
            return
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join(timeout=3)
        self.server_started = False

    def tearDown(self):
        self.stop_server()

    def request(self, method, path, body=None, token=None, headers=None):
        h = dict(headers or {})
        if token is not False:
            h["Authorization"] = "Bearer " + (self.token if token is None else token)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read()
            return error.code, json.loads(raw) if raw else None

    def enqueue(self, url="https://example.com/article", machines=None):
        return self.request("POST", "/clipboard", {"url": url, "machines": machines or ["thing-1"]})

    def next(self, machine="thing-1"):
        return self.request("GET", "/clipboard/next?machine=" + machine)

    def test_auth_host_and_origin_checks(self):
        self.assertEqual(self.request("POST", "/clipboard", {"url": "https://example.com", "machines": ["imac"]}, token=False)[0], 401)
        self.assertEqual(self.request("GET", "/clipboard/next?machine=imac", token="wrong")[0], 401)
        self.assertEqual(self.request("POST", "/clipboard", {"url": "https://example.com", "machines": ["imac"]},
                                       headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/clipboard/next?machine=imac",
                                      headers={"Host": "evil.example"})[0], 403)

    def test_url_and_machine_validation(self):
        good = "https://example.com/a"
        for url in ("file:///tmp/a", "ftp://example.com", "https://", "http://example.com:bad/path", "https://example.com/a b",
                    "https://example.com/\u0085",
                    "https://example.com/\nheader", "https://example.com/\x00", "https://example.com/" + "a" * 2040):
            with self.subTest(url=url[:40]):
                self.assertEqual(self.enqueue(url)[0], 400)
        for machines in ([], ["other"], ["imac", "unknown"], ["win", "win"], "imac"):
            with self.subTest(machines=machines):
                self.assertEqual(self.enqueue(good, machines)[0], 400)
        self.assertEqual(self.enqueue(good, ["thing-2", "win"])[0], 202)

    def test_fifo_expiry_and_empty_204(self):
        self.assertEqual(self.next("imac")[0], 204)
        self.enqueue("https://example.com/first")
        self.enqueue("https://example.com/second")
        path = self.svc.clipboard_path
        with open(path) as f:
            queues = json.load(f)
        queues["thing-1"][0]["expires"] = time.time() - 1
        with open(path, "w") as f:
            json.dump(queues, f)
        self.assertEqual(self.next()[1], {"url": "https://example.com/second"})
        self.assertEqual(self.next()[0], 204)

    def test_per_machine_isolation(self):
        self.enqueue("https://example.com/two", ["thing-2"])
        self.assertEqual(self.next("thing-1")[0], 204)
        self.assertEqual(self.next("imac")[0], 204)
        self.assertEqual(self.next("thing-2")[1], {"url": "https://example.com/two"})

    def test_cap_discards_oldest(self):
        for i in range(service.CLIPBOARD_CAP + 2):
            self.enqueue(f"https://example.com/{i}")
        self.assertEqual(self.next()[1], {"url": "https://example.com/2"})

    def test_pending_items_survive_service_restart(self):
        self.enqueue("https://example.com/persist", ["imac", "win"])
        self.stop_server()
        self.start_server()
        self.assertEqual(self.next("imac")[1], {"url": "https://example.com/persist"})
        self.assertEqual(self.next("win")[1], {"url": "https://example.com/persist"})


if __name__ == "__main__":
    unittest.main()
