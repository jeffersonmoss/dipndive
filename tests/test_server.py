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
from dipdive.tmp import sweep_stale  # noqa: E402

sweep_stale(600)  # leftovers of crashed earlier runs
_SUP = tempfile.mkdtemp(prefix="dipdive-test-support-")
os.environ["DIPDIVE_SUPPORT"] = _SUP
_LOGDIR = tempfile.mkdtemp(prefix="dipdive-test-log-")  # the history log lives here, never in the real ~/Public
with open(os.path.join(_LOGDIR, "TEMP_README.md"), "w") as _f:
    _f.write("# Temporary folder\n\nPurpose: DIPDIVE_LOG_PATH target for tests/test_server.py\n"
             "Made by: T1 Dip Dive chat on this Mac\nNeeded until: the test module ends (tearDownModule deletes it)\n"
             "Costly to recreate: no.\n")
LOG = os.path.join(_LOGDIR, "Dip'n'Dive Log.md")
os.environ["DIPDIVE_LOG_PATH"] = LOG

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
    with open(os.path.join(d, "TEMP_README.md"), "w") as f:
        f.write("# Temporary folder\n\nPurpose: fake model binary for tests/test_server.py\n"
                "Made by: T1 Dip Dive chat on this Mac\nNeeded until: the test module ends (tearDownModule deletes it)\n"
                "Costly to recreate: no.\n")
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
        os.environ["DIPDIVE_LOG_PATH"] = LOG  # other modules in a combined run set their own
        if os.path.isfile(LOG):
            os.remove(LOG)
        shutil.rmtree(_SUP, ignore_errors=True)
        os.makedirs(_SUP)
        joblog.LOG_DIR = os.path.join(_SUP, "logs")
        joblog.SUPPORT = _SUP  # modules may be imported together; point at our own dir
        self.token = server.load_token(os.path.join(_SUP, "token"))
        self.start()

    def start(self):
        self.svc = service.Service(_SUP)
        self.srv = server.make_server(0, self.svc, self.token)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.svc.wait_idle(40)  # no worker may still be writing temp folders when we clean up
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
        h = self.req("GET", "/health")[1]
        self.assertEqual((h.pop("log_path"), h.pop("log_writable")), (LOG, True))
        self.assertEqual(h, {"state": "starting"})
        time.sleep(0.3)
        for _ in range(3):
            self.assertEqual(self.req("GET", "/health")[0], 200)
        self.assertEqual(len(calls), 1)
        self.svc._health_at -= 61
        self.req("GET", "/health"); time.sleep(0.3)
        self.assertEqual(len(calls), 2)


class Round2(Base):
    def test_token_fail_closed(self):  # finding 1
        d = tempfile.mkdtemp(prefix="dipdive-test-tok-"); _BINS.append(d)
        p = os.path.join(d, "token")
        open(p, "w").close()
        with self.assertRaises(SystemExit):
            server.load_token(p)
        open(p, "w").write("short\n")
        with self.assertRaises(SystemExit):
            server.load_token(p)
        with self.assertRaises(ValueError):
            server.make_handler(self.svc, "")
        os.unlink(p)
        tok = server.load_token(p)
        self.assertGreaterEqual(len(tok), 32)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual([n for n in os.listdir(d) if n != "token"], [])  # no temp file left behind

    def test_empty_bearer_401(self):  # finding 1
        c, _ = self.req("GET", "/health", headers={"Authorization": "Bearer "}, auth=False)
        self.assertEqual(c, 401)
        c, _ = self.req("GET", "/health", headers={"Authorization": "Bearer"}, auth=False)
        self.assertEqual(c, 401)

    def test_worker_survives_exceptions(self):  # finding 3 (the 6-failure stall)
        real = service.Service.run_one
        n = {"c": 0}

        def boom(self_, j):
            n["c"] += 1
            if n["c"] <= 8:
                raise KeyError("boom")
            return real(self_, j)
        service.Service.run_one = boom
        try:
            ids = [self.submit("source", f"w{i}", f"/w{i}")[1]["job_id"] for i in range(8)]
            for i in ids:
                self.assertEqual(self.wait(i)["state"], "error")
            c, ok = self.submit("source", "after", "/after")
            self.assertEqual(self.wait(ok["job_id"])["state"], "done")
        finally:
            service.Service.run_one = real

    def test_storage_errors_do_not_kill_workers(self):  # finding 3 (disk full)
        real = service._atomic_write
        def full(path, obj):
            if os.sep + "jobs" + os.sep in path:
                raise OSError(28, "No space left on device")
            return real(path, obj)
        service._atomic_write = full
        try:
            for i in range(8):
                self.submit("source", f"d{i}", f"/d{i}")
            time.sleep(1.5)
        finally:
            service._atomic_write = real
        c, ok = self.submit("source", "recovered", "/recovered")
        self.assertEqual(self.wait(ok["job_id"])["state"], "done")

    def test_done_job_not_reused_when_source_expired(self):  # finding 5
        _, a = self.submit("source", "a1", "/same")
        self.wait(a["job_id"])
        p = self.svc._src_path(self.svc.jobs[a["job_id"]]["norm_id"])
        with open(p) as f:
            s = json.load(f)
        s["fetched"] -= 8 * 86400
        with open(p, "w") as f:
            json.dump(s, f)
        _, b = self.submit("source", "a2", "/same")
        self.assertNotEqual(a["job_id"], b["job_id"])
        self.wait(b["job_id"])
        _, c = self.submit("source", "a3", "/same")  # source fresh again: reused
        self.assertEqual(b["job_id"], c["job_id"])

    def test_done_job_not_reused_when_source_changed(self):  # finding 5
        _, a = self.submit("source", "c1", "/chg")
        self.wait(a["job_id"])
        p = self.svc._src_path(self.svc.jobs[a["job_id"]]["norm_id"])
        with open(p) as f:
            s = json.load(f)
        s["hash"] = "different"
        with open(p, "w") as f:
            json.dump(s, f)
        self.assertNotEqual(self.submit("source", "c2", "/chg")[1]["job_id"], a["job_id"])

    def test_request_id_conflict_409(self):  # finding 11
        self.submit("source", "dup", "/one")
        c, r = self.submit("source", "dup", "/two")
        self.assertEqual((c, r["error_code"]), (409, "request_id_conflict"))
        c, _ = self.submit("claude-dip", "dup", "/one")
        self.assertEqual(c, 409)

    def test_body_is_not_parsed_as_next_request(self):  # finding 8
        import socket
        inner = f"GET /nosuch HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {self.token}\r\n\r\n"
        outer = (f"POST /jobs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer wrong\r\n"
                 f"Content-Length: {len(inner)}\r\n\r\n{inner}")
        s = socket.create_connection(("127.0.0.1", self.srv.server_address[1]), timeout=5)
        s.sendall(outer.encode())
        data = b""
        while True:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
        s.close()
        self.assertEqual(data.count(b"HTTP/1.1 "), 1, data)
        self.assertIn(b"401", data)

    def test_health_single_flight_and_error_cached(self):  # finding 9
        calls = []

        def slow():
            calls.append(1); time.sleep(0.5); raise IndexError("deno printed nothing")
        self.svc._compute_health = slow
        res = []
        ts = [threading.Thread(target=lambda: res.append(self.req("GET", "/health")[1])) for _ in range(8)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(len(calls), 1)
        self.assertTrue(all({k: v for k, v in r.items() if not k.startswith("log_")} == {"state": "starting"} for r in res))
        time.sleep(0.8)
        self.assertEqual(self.req("GET", "/health")[1]["state"], "error")
        self.req("GET", "/health")
        self.assertEqual(len(calls), 1)  # failure cached for 60 s, not recomputed per call

    def test_job_after_clear_does_not_join_old_fetch(self):  # finding 10
        orig = service.acquire
        def slow(url):
            time.sleep(1.5)
            return orig(url)
        service.acquire = slow
        try:
            _, a = self.submit("source", "x1", "/race")
            time.sleep(0.5)
            self.req("POST", "/clear")
            _, b = self.submit("source", "x2", "/race")
            self.assertEqual(self.wait(b["job_id"])["state"], "done")
            self.assertEqual(self.req("GET", "/source?job=" + b["job_id"])[0], 200)
        finally:
            service.acquire = orig

    def test_handler_timeout_and_thread_cap(self):  # finding 12
        import socket
        H = server.make_handler(self.svc, self.token)
        self.assertEqual(H.timeout, 15)
        self.assertEqual(server.BoundedServer.MAX_THREADS, 64)
        socks = [socket.create_connection(("127.0.0.1", self.srv.server_address[1])) for _ in range(5)]
        for s_ in socks:
            s_.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n")  # half-sent headers
        self.assertEqual(self.req("GET", "/jobs/" + "0" * 32)[0], 404)  # server still answers others
        for s_ in socks:
            s_.close()

    def test_clear_truncates_launchd_logs_and_rotation(self):  # finding 12
        for n in service.LAUNCHD_LOGS:
            with open(os.path.join(_SUP, n), "w") as f:
                f.write("traceback " * 10)
        self.req("POST", "/clear")
        for n in service.LAUNCHD_LOGS:
            self.assertEqual(os.path.getsize(os.path.join(_SUP, n)), 0)
        big = os.path.join(_SUP, service.LAUNCHD_LOGS[1])
        with open(big, "w") as f:
            f.write("x" * 2_000_000)
        server.rotate_launchd_logs()
        self.assertFalse(os.path.exists(big))
        self.assertTrue(os.path.exists(big + ".1"))

    def test_malformed_job_records_do_not_crash_startup(self):  # finding 14
        d = os.path.join(_SUP, "jobs")
        with open(os.path.join(d, "bad1.json"), "w") as f:
            json.dump({"job_id": "x"}, f)
        with open(os.path.join(d, "bad2.json"), "w") as f:
            f.write("[1,2")
        with open(os.path.join(d, "bad3.json"), "w") as f:
            json.dump([1], f)
        svc = service.Service(_SUP, start_workers=False)
        self.assertEqual(len(svc.jobs), 0)


class Round3(Base):
    def test_health_reports_codex_readiness_fields(self):  # finding 12 (server side)
        saved = models.CODEX_HOME
        models.CODEX_HOME = os.path.join(_SUP, "codex-home")
        try:
            h = self.svc._compute_health()
        finally:
            models.CODEX_HOME = saved
        for k in ("codex_logged_in", "codex_isolation_ok", "codex_isolation_error", "codex_ready"):
            self.assertIn(k, h)
        self.assertEqual(h["codex_ready"], bool(h["codex_logged_in"] and h["codex_isolation_ok"]))
        self.assertFalse(h["codex_logged_in"])  # no DipDive Codex login exists in the test home


class StaleClearGeneration(Base):
    """Cross-machine clear: a client that last saw an older clear generation than the companion's is refused with 409
    stale_clear_generation, and nothing is made (no job, no fetch, no model call, no stored history)."""

    def clear(self, n=1):
        for _ in range(n):
            self.assertEqual(self.req("POST", "/clear", {})[0], 200)

    def assert_nothing_stored(self):
        self.assertEqual((self.svc.jobs, self.svc.by_request, self.svc.by_prekey), ({}, {}, {}))
        for d in ("jobs", "sources", "results", "logs"):
            p = os.path.join(_SUP, d)
            self.assertEqual(os.listdir(p) if os.path.isdir(p) else [], [], d)

    def test_an_older_generation_is_409_and_makes_nothing(self):
        counter = os.path.join(_SUP, "model-calls")
        models.CLAUDE = fake_claude(counter=counter)
        before = hits["n"]
        self.clear(2)
        for mode in ("claude-dip", "claude-dive", "codex-dip", "source"):
            for stale in (0, 1):
                c, r = self.submit(mode, f"s-{mode}-{stale}", clearGeneration=stale)
                self.assertEqual((c, r.get("error_code"), r.get("clear_generation")), (409, "stale_clear_generation", 2), (mode, stale))
                self.assertNotIn("job_id", r)
        self.assertEqual(hits["n"], before, "the source was never fetched")
        self.assertFalse(os.path.exists(counter), "no model call")
        self.assertTrue(self.svc.wait_idle(5))
        self.assert_nothing_stored()

    def test_the_refused_request_id_is_not_remembered(self):
        self.clear()
        self.assertEqual(self.submit("source", "same", clearGeneration=0)[0], 409)
        c, r = self.submit("source", "same", clearGeneration=1)
        self.assertEqual((c, r["clear_generation"]), (202, 1))
        self.assertEqual(self.wait(r["job_id"])["state"], "done")

    def test_current_newer_absent_and_null_generations_are_accepted(self):
        self.clear()
        for i, extra in enumerate(({"clearGeneration": 1}, {"clearGeneration": 7}, {}, {"clearGeneration": None})):
            c, r = self.submit("source", f"ok{i}", path=f"/p{i}", **extra)
            self.assertEqual((c, r.get("clear_generation")), (202, 1), extra)
            self.assertEqual(self.wait(r["job_id"])["state"], "done")

    def test_a_non_integer_generation_is_400_and_makes_nothing(self):
        for i, bad in enumerate(("1", 1.5, True, False, -1, [], {})):
            c, r = self.submit("source", f"bad{i}", clearGeneration=bad)
            self.assertEqual((c, r.get("error_code")), (400, "bad_request"), bad)
        self.assert_nothing_stored()

    def test_a_request_replayed_after_a_clear_with_its_old_generation_is_refused(self):
        _, old = self.submit("source", "before", clearGeneration=0)
        self.wait(old["job_id"])
        self.clear()
        c, r = self.submit("source", "before", clearGeneration=0)
        self.assertEqual((c, r.get("error_code")), (409, "stale_clear_generation"))
        self.assertEqual(self.req("GET", "/jobs/" + old["job_id"])[0], 404)
        c, fresh = self.submit("source", "before")  # a client that knows no generation is served, as the panel is after a restart
        self.assertEqual(c, 202)
        self.assertNotEqual(fresh["job_id"], old["job_id"])
        self.wait(fresh["job_id"])

    def test_two_machines_one_clears_and_the_other_is_told_before_it_is_served(self):
        _, a1 = self.submit("source", "a1")  # machine A's panel has not sent a generation yet
        self.assertEqual(a1["clear_generation"], 0)
        self.wait(a1["job_id"])
        self.clear()  # machine B presses Clear history
        c, r = self.submit("source", "a2", path="/b", clearGeneration=a1["clear_generation"])
        self.assertEqual((c, r["error_code"], r["clear_generation"]), (409, "stale_clear_generation", 1))
        c, r2 = self.submit("source", "a3", path="/b", clearGeneration=r["clear_generation"])  # A adopted the new generation
        self.assertEqual(c, 202)
        self.assertEqual(self.wait(r2["job_id"])["state"], "done")


def tearDownModule():
    shutil.rmtree(_SUP, ignore_errors=True)
    shutil.rmtree(_LOGDIR, ignore_errors=True)
    for d in _BINS:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
