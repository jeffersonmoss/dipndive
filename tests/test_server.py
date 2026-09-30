"""Server tests: real HTTP on 127.0.0.1, faked model binaries, local article server.
Run: .venv/bin/python -m unittest tests.test_server -v"""
import http.server
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

os.environ["DIPDIVE_TEST_ALLOW_LOOPBACK"] = "1"
_SUP = tempfile.mkdtemp(prefix="dipdive-test-support-")
os.environ["DIPDIVE_SUPPORT"] = _SUP

from dipdive import joblog, models, server, service  # noqa: E402

_BINS = []
PARAS = "".join(f"<p>Paragraph {i} about topic {i*7919} with distinct words and more filler text here.</p>" for i in range(40))
hits = {"n": 0}


class ArticleH(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        hits["n"] += 1
        body = f"<html><head><title>Art</title></head><body><article>{PARAS}</article></body></html>".encode()
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)


def fake_claude(sleep=0.0, counter=None):
    d = tempfile.mkdtemp(prefix="dipdive-test-bin-")
    _BINS.append(d)
    p = os.path.join(d, "fake")
    ok = {"subtype": "success", "stop_reason": "end_turn", "is_error": False, "result": "fake summary", "permission_denials": []}
    open(p, "w").write(f"#!{sys.executable}\nimport sys,json,time\nsys.stdin.read()\n"
                       + (f"open({counter!r},'a').write('x')\n" if counter else "")
                       + f"time.sleep({sleep})\nprint(json.dumps({ok!r}))\n")
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return p


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.art = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ArticleH)
        threading.Thread(target=cls.art.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.art.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.art.shutdown()

    def setUp(self):
        self.saved = models.CLAUDE
        shutil.rmtree(_SUP, ignore_errors=True)
        os.makedirs(_SUP)
        joblog.LOG_DIR = os.path.join(_SUP, "logs")
        self.token = server.load_token(os.path.join(_SUP, "token"))
        self.start()

    def start(self):
        self.svc = service.Service(_SUP)
        self.srv = server.make_server(0, self.svc, self.token)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        models.CLAUDE = self.saved

    def req(self, method, path, body=None, headers=None, auth=True):
        h = dict(headers or {})
        if auth:
            h["Authorization"] = "Bearer " + self.token
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def submit(self, mode="claude-dip", rid="r1", path="/a", **kw):
        return self.req("POST", "/jobs", {"url": self.base + path, "mode": mode, "requestId": rid, **kw})

    def wait(self, jid, states=("done", "error"), t=30):
        end = time.time() + t
        while time.time() < end:
            _, j = self.req("GET", "/jobs/" + jid)
            if j.get("state") in states:
                return j
            time.sleep(0.1)
        self.fail("job did not finish: " + str(j))


class Auth(Base):
    def test_no_token_401_wrong_token_401(self):
        self.assertEqual(self.req("GET", "/health", auth=False)[0], 401)
        self.assertEqual(self.req("GET", "/health", headers={"Authorization": "Bearer nope"}, auth=False)[0], 401)

    def test_web_origin_rejected_extension_ok(self):
        self.assertEqual(self.req("GET", "/jobs/" + "0" * 32, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("GET", "/jobs/" + "0" * 32, headers={"Origin": "chrome-extension://abc"})[0], 404)
        self.assertEqual(self.req("GET", "/jobs/" + "0" * 32, headers={"Host": "evil.example"})[0], 403)

    def test_token_file_0600_and_loopback_bind(self):
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(_SUP, "token")).st_mode), 0o600)
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")

    def test_bad_requests(self):
        self.assertEqual(self.req("POST", "/jobs", {"url": "file:///etc/passwd", "mode": "source", "requestId": "x"})[0], 400)
        self.assertEqual(self.req("POST", "/jobs", {"url": self.base, "mode": "bogus", "requestId": "x"})[0], 400)
        self.assertEqual(self.req("POST", "/jobs", {"url": self.base, "mode": "source"})[0], 400)


class Jobs(Base):
    def test_source_mode_and_source_endpoint(self):
        c, r = self.submit("source")
        self.assertEqual(c, 202)
        j = self.wait(r["job_id"])
        self.assertEqual(j["state"], "done")
        c, s = self.req("GET", "/source?job=" + r["job_id"])
        self.assertEqual(c, 200)
        self.assertIn("Paragraph 3", s["text"])
        self.assertEqual(self.req("GET", "/source?job=" + "1" * 32)[0], 404)

    def test_source_endpoint_never_fetches(self):
        models.CLAUDE = fake_claude(sleep=2)
        _, r = self.submit("claude-dip")
        time.sleep(0.05)
        c, _ = self.req("GET", "/source?job=" + r["job_id"])  # may or may not be fetched yet, never triggers a fetch
        self.assertIn(c, (200, 404))
        self.wait(r["job_id"])

    def test_model_job_and_idempotency_and_dedupe_and_force(self):
        cnt = os.path.join(_SUP, "count")
        models.CLAUDE = fake_claude(counter=cnt)
        c, a = self.submit(rid="same")
        j = self.wait(a["job_id"])
        self.assertEqual((j["state"], j["result_markdown"]), ("done", "fake summary"))
        self.assertEqual(self.submit(rid="same")[1]["job_id"], a["job_id"])           # requestId idempotency
        self.assertEqual(self.submit(rid="other")[1]["job_id"], a["job_id"])          # same key, successful job
        c, f = self.submit(rid="forced", force=True)
        self.assertNotEqual(f["job_id"], a["job_id"])
        self.wait(f["job_id"])
        self.assertEqual(len(open(cnt).read()), 2)

    def test_triple_click_one_job_one_call(self):
        cnt = os.path.join(_SUP, "count")
        models.CLAUDE = fake_claude(sleep=1, counter=cnt)
        ids = {self.submit(rid=f"t{i}")[1]["job_id"] for i in range(3)}
        self.assertEqual(len(ids), 1)
        self.wait(ids.pop())
        self.assertEqual(len(open(cnt).read()), 1)

    def test_dip_then_dive_fetches_once(self):
        models.CLAUDE = fake_claude()
        hits["n"] = 0
        a = self.submit("claude-dip", "a", "/coalesce")[1]["job_id"]
        b = self.submit("claude-dive", "b", "/coalesce")[1]["job_id"]
        self.wait(a); self.wait(b)
        self.assertEqual(hits["n"], 1)

    def test_failure_not_reused(self):
        c, a = self.req("POST", "/jobs", {"url": "http://127.0.0.1:1/x", "mode": "source", "requestId": "e1"})
        j = self.wait(a["job_id"])
        self.assertEqual(j["state"], "error")
        c, b = self.req("POST", "/jobs", {"url": "http://127.0.0.1:1/x", "mode": "source", "requestId": "e2"})
        self.assertNotEqual(a["job_id"], b["job_id"])

    def test_queue_full(self):
        models.CLAUDE = fake_claude(sleep=3)
        old = service.QUEUE_CAP
        service.QUEUE_CAP = 2
        try:
            codes = [self.submit(rid=f"q{i}", path=f"/q{i}")[0] for i in range(4)]
        finally:
            service.QUEUE_CAP = old
        self.assertEqual(codes[:2], [202, 202])
        self.assertEqual(codes[2:], [429, 429])

    def test_source_expires_after_7_days(self):
        _, r = self.submit("source")
        self.wait(r["job_id"])
        p = self.svc._src_path(self.svc.jobs[r["job_id"]]["norm_id"])
        s = json.load(open(p)); s["fetched"] -= 8 * 86400; json.dump(s, open(p, "w"))
        self.assertEqual(self.req("GET", "/source?job=" + r["job_id"])[1]["error_code"], "source_gone")


class Lifecycle(Base):
    def test_clear_fences_in_flight_job(self):
        models.CLAUDE = fake_claude(sleep=2)
        _, r = self.submit()
        time.sleep(1.0)
        c, cl = self.req("POST", "/clear")
        self.assertEqual(c, 200)
        self.assertEqual(cl["clear_generation"], 1)
        time.sleep(3)  # let the in-flight job finish
        self.assertEqual(self.req("GET", "/jobs/" + r["job_id"])[0], 404)
        for d in ("jobs", "sources", "results", "logs"):
            p = os.path.join(_SUP, d)
            self.assertEqual(os.listdir(p) if os.path.isdir(p) else [], [], d)

    def test_clear_generation_persists_and_interrupted_marked(self):
        models.CLAUDE = fake_claude(sleep=5)
        _, r = self.submit()
        time.sleep(0.8)
        self.srv.shutdown(); self.srv.server_close()
        self.start()  # simulates a restart: a new Service loads the job files
        j = self.req("GET", "/jobs/" + r["job_id"])[1]
        self.assertEqual((j["state"], j["error_code"]), ("error", "interrupted"))
        self.assertEqual(self.submit(rid="r1")[1]["job_id"], r["job_id"])  # requestId still known

    def test_prune_30_days(self):
        _, r = self.submit("source")
        self.wait(r["job_id"])
        p = os.path.join(_SUP, "jobs", r["job_id"] + ".json")
        old = time.time() - 31 * 86400
        os.utime(p, (old, old))
        self.svc.jobs[r["job_id"]]["updated"] = old
        self.svc.prune()
        self.assertFalse(os.path.exists(p))
        self.assertNotIn(r["job_id"], self.svc.jobs)

    def test_health_cached_60s(self):
        calls = []
        self.svc._compute_health = lambda: calls.append(1) or {"ok": True}
        for _ in range(3):
            self.assertEqual(self.req("GET", "/health")[0], 200)
        self.assertEqual(len(calls), 1)
        self.svc._health_at -= 61
        self.req("GET", "/health"); time.sleep(0.3)
        self.assertEqual(len(calls), 2)


def tearDownModule():
    shutil.rmtree(_SUP, ignore_errors=True)
    for d in _BINS:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
