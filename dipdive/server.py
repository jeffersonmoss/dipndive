"""HTTP API (plan 3.2): 127.0.0.1 only, bearer token, no CORS. Run: python -m dipdive.server [port]"""
import hmac
import json
import os
import re
import stat
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import historylog, joblog
from .ask import AskError
from .service import LAUNCHD_LOGS, MODES, Service
from .tmp import sweep_stale

TOKEN_PATH = os.path.join(joblog.SUPPORT, "token")
MAX_BODY = 64 * 1024
HOST_OK = re.compile(r"^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9.-]+\.ts\.net)(:\d+)?$", re.I)
JOB_PATH = re.compile(r"^/jobs/([0-9a-f]{32})$")
SAVE_PATH = re.compile(r"^/history/([0-9a-f]{32})/(remove|restore)$")


MIN_TOKEN = 32


def load_token(path=None) -> str:
    """Read the bearer token; create it atomically (0600, fsync, no-clobber link) when the file is absent.
    Fails closed: an existing token that is empty or shorter than 32 characters aborts startup."""
    path = path or TOKEN_PATH
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    if not os.path.exists(path):
        import secrets
        tmp = f"{path}.{secrets.token_hex(4)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_urlsafe(32) + "\n")
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(tmp, path)  # atomic and refuses to overwrite a token another start just made
            except FileExistsError:
                pass
        finally:
            os.unlink(tmp)
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    if stat.S_IMODE(os.stat(path).st_mode) != 0o600:
        os.chmod(path, 0o600)
    with open(path) as f:
        tok = f.read().strip()
    if len(tok) < MIN_TOKEN:
        raise SystemExit(f"dipdive: token file {path} is empty or shorter than {MIN_TOKEN} characters; "
                         "delete it to generate a new one, then update every extension")
    return tok


def make_handler(svc: Service, token: str):
    if len(token) < MIN_TOKEN:
        raise ValueError("token too short")

    class H(BaseHTTPRequestHandler):
        server_version = "dipdive"
        protocol_version = "HTTP/1.1"
        timeout = 15  # half-sent requests must not hold a thread forever

        def log_message(self, *a):
            pass

        def _send(self, code, obj, close=False):
            body = json.dumps(obj, ensure_ascii=False).encode()
            if close:
                self.close_connection = True  # unread body bytes must not be parsed as the next request
            self.send_response(code)
            if close:
                self.send_header("Connection", "close")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _gate(self) -> bool:
            if not HOST_OK.match(self.headers.get("Host", "")):
                self._send(403, {"error_code": "bad_host"}, True); return False
            origin = self.headers.get("Origin")
            if origin is not None and not origin.startswith(("chrome-extension://", "moz-extension://")):
                self._send(403, {"error_code": "bad_origin", "error_message": "web-page origins are rejected"}, True); return False
            got = self.headers.get("Authorization", "")
            presented = got[7:].strip() if got.startswith("Bearer ") else ""
            if not presented or not hmac.compare_digest(presented.encode(), token.encode()):
                self._send(401, {"error_code": "unauthorized"}, True); return False
            return True

        def _json_body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                self._send(413, {"error_code": "bad_request", "error_message": "body too large"}, True); return None
            raw = self.rfile.read(n) if n else b""
            try:
                d = json.loads(raw or b"{}")
                if not isinstance(d, dict):
                    raise ValueError
                return d
            except ValueError:
                self._send(400, {"error_code": "bad_request", "error_message": "body must be a JSON object"}); return None

        def do_OPTIONS(self):
            self._send(403, {"error_code": "no_cors"}, True)

        def do_GET(self):
            if not self._gate():
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n:
                if 0 < n <= MAX_BODY:
                    self.rfile.read(n)
                else:
                    self.close_connection = True
            u = urllib.parse.urlparse(self.path)
            m = JOB_PATH.match(u.path)
            try:
                if m:
                    j = svc.get_job(m.group(1))
                    # a missing job carries the clear generation too, so a panel can tell its job was cleared elsewhere
                    return self._send(200, j) if j else self._send(404, {"error_code": "no_such_job", "clear_generation": svc.generation})
                if u.path == "/source":
                    jid = (urllib.parse.parse_qs(u.query).get("job") or [""])[0]
                    return self._send(*svc.get_source_for_job(jid))
                if u.path == "/health":
                    return self._send(200, svc.health())
                if u.path == "/history":
                    return self._history(u.query)
            except Exception as e:
                return self._send(500, {"error_code": "internal_error", "error_message": type(e).__name__})
            self._send(404, {"error_code": "not_found"})

        def _history(self, query):
            """GET /history?limit=20&before=<position>: log entries newest first (see historylog.read_page)."""
            q = urllib.parse.parse_qs(query, keep_blank_values=True)

            def num(name, default, lo, hi):
                v = (q.get(name) or [None])[0]
                if v is None:
                    return default
                if not re.fullmatch(r"[0-9]{1,9}", v) or not lo <= int(v) <= hi:
                    raise ValueError(name)
                return int(v)
            try:
                limit = num("limit", historylog.PAGE_DEFAULT, 1, historylog.PAGE_MAX)
                before = num("before", None, 0, 10**9)
                rev = num("revision", None, 0, 10**9)
            except ValueError as e:
                return self._send(400, {"error_code": "bad_request",
                                        "error_message": f"{e.args[0]} must be a whole number"
                                                         f"{' from 1 to %d' % historylog.PAGE_MAX if e.args[0] == 'limit' else ''}"})
            try:
                page = historylog.read_page(before, limit, rev=rev)
            except historylog.HistoryChanged as e:
                return self._send(409, {"error_code": "history_changed", "revision": e.current,
                                        "error_message": "entries were removed or restored since that page; start again from the newest"})
            except historylog.LogUnreadable as e:
                return self._send(503, {"error_code": "log_unreadable", "error_message": f"the history log cannot be read ({e})"})
            self._send(200, page)

        def do_POST(self):
            if not self._gate():
                return
            u = urllib.parse.urlparse(self.path)
            d = self._json_body()
            if d is None:
                return
            try:
                if u.path == "/jobs":
                    url, mode, rid, force = d.get("url"), d.get("mode"), d.get("requestId"), d.get("force", False)
                    question, history, summary = d.get("question"), d.get("history"), d.get("summary")
                    cgen = d.get("clearGeneration")  # the clear generation the client last saw (absent: it has seen none)
                    if (not isinstance(url, str) or not re.match(r"^https?://", url) or len(url) > 4096
                            or mode not in MODES or not isinstance(rid, str) or not 1 <= len(rid) <= 128
                            or not isinstance(force, bool)
                            or (cgen is not None and (type(cgen) is not int or cgen < 0))):
                        return self._send(400, {"error_code": "bad_request",
                                                "error_message": "need url (http/https), mode, requestId, optional force:boolean "
                                                                 "and clearGeneration:integer"})
                    try:
                        return self._send(*svc.submit(url, mode, rid, force, question, history, summary, cgen))
                    except AskError as e:
                        return self._send(400, {"error_code": "bad_request", "error_message": str(e)})
                if u.path == "/clear":
                    return self._send(200, svc.clear())
                m = SAVE_PATH.match(u.path)
                if m:
                    cgen = d.get("clearGeneration")
                    if cgen is not None and (type(cgen) is not int or cgen < 0):
                        return self._send(400, {"error_code": "bad_request", "error_message": "clearGeneration must be a whole number"})
                    return self._send(*svc.set_saved(m.group(1), m.group(2) == "restore", cgen))
            except UnicodeError:  # text that cannot be encoded (a lone surrogate in url or requestId): the client's mistake
                return self._send(400, {"error_code": "bad_request", "error_message": "text is not valid unicode"})
            except Exception as e:
                return self._send(500, {"error_code": "internal_error", "error_message": type(e).__name__})
            self._send(404, {"error_code": "not_found"})
    return H


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    MAX_THREADS = 64

    def __init__(self, *a, **kw):
        self._slots = threading.BoundedSemaphore(self.MAX_THREADS)
        super().__init__(*a, **kw)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)  # over the thread cap: drop the connection
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        print(f"dipdive: connection error {type(e).__name__}: {e}", file=sys.stderr, flush=True)  # one line, no traceback


def rotate_launchd_logs(limit=1_000_000):
    """Keep launchd's stdout/stderr files from growing without bound: keep one .1 backup past 1 MB."""
    for n in LAUNCHD_LOGS:
        p = os.path.join(joblog.SUPPORT, n)
        try:
            if os.path.getsize(p) > limit:
                os.replace(p, p + ".1")
        except OSError:
            pass


def make_server(port=0, svc=None, token=None):
    token = token or load_token()
    svc = svc or Service()
    srv = BoundedServer(("127.0.0.1", port), make_handler(svc, token))
    srv.svc = svc
    return srv


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port = int(argv[0]) if argv else int(os.environ.get("DIPDIVE_PORT", "8765"))
    sweep_stale()
    rotate_launchd_logs()
    srv = make_server(port)
    srv.svc.warm_health()
    print(f"dipdive listening on 127.0.0.1:{srv.server_address[1]}; token file {TOKEN_PATH}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
