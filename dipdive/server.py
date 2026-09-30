"""HTTP API (plan 3.2): 127.0.0.1 only, bearer token, no CORS. Run: python -m dipdive.server [port]"""
import hmac
import json
import os
import re
import stat
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import joblog
from .service import MODES, Service
from .tmp import sweep_stale

TOKEN_PATH = os.path.join(joblog.SUPPORT, "token")
MAX_BODY = 64 * 1024
HOST_OK = re.compile(r"^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9.-]+\.ts\.net)(:\d+)?$", re.I)
JOB_PATH = re.compile(r"^/jobs/([0-9a-f]{32})$")


def load_token(path=None) -> str:
    """Read the bearer token; create it (0600) on first run."""
    path = path or TOKEN_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        import secrets
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(32) + "\n")
    if stat.S_IMODE(os.stat(path).st_mode) != 0o600:
        os.chmod(path, 0o600)
    return open(path).read().strip()


def make_handler(svc: Service, token: str):
    class H(BaseHTTPRequestHandler):
        server_version = "dipdive"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _gate(self) -> bool:
            if not HOST_OK.match(self.headers.get("Host", "")):
                self._send(403, {"error_code": "bad_host"}); return False
            origin = self.headers.get("Origin")
            if origin is not None and not origin.startswith(("chrome-extension://", "moz-extension://")):
                self._send(403, {"error_code": "bad_origin", "error_message": "web-page origins are rejected"}); return False
            got = self.headers.get("Authorization", "")
            if not got.startswith("Bearer ") or not hmac.compare_digest(got[7:].strip().encode(), token.encode()):
                self._send(401, {"error_code": "unauthorized"}); return False
            return True

        def _json_body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                self._send(413, {"error_code": "bad_request", "error_message": "body too large"}); return None
            raw = self.rfile.read(n) if n else b""
            try:
                d = json.loads(raw or b"{}")
                if not isinstance(d, dict):
                    raise ValueError
                return d
            except ValueError:
                self._send(400, {"error_code": "bad_request", "error_message": "body must be a JSON object"}); return None

        def do_OPTIONS(self):
            self._send(403, {"error_code": "no_cors"})

        def do_GET(self):
            if not self._gate():
                return
            u = urllib.parse.urlparse(self.path)
            m = JOB_PATH.match(u.path)
            try:
                if m:
                    j = svc.get_job(m.group(1))
                    return self._send(200, j) if j else self._send(404, {"error_code": "no_such_job"})
                if u.path == "/source":
                    jid = (urllib.parse.parse_qs(u.query).get("job") or [""])[0]
                    return self._send(*svc.get_source_for_job(jid))
                if u.path == "/health":
                    return self._send(200, svc.health())
            except Exception as e:
                return self._send(500, {"error_code": "internal_error", "error_message": type(e).__name__})
            self._send(404, {"error_code": "not_found"})

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
                    if (not isinstance(url, str) or not re.match(r"^https?://", url) or len(url) > 4096
                            or mode not in MODES or not isinstance(rid, str) or not 1 <= len(rid) <= 128
                            or not isinstance(force, bool)):
                        return self._send(400, {"error_code": "bad_request",
                                                "error_message": "need url (http/https), mode, requestId, optional force:boolean"})
                    return self._send(*svc.submit(url, mode, rid, force))
                if u.path == "/clear":
                    return self._send(200, svc.clear())
            except Exception as e:
                return self._send(500, {"error_code": "internal_error", "error_message": type(e).__name__})
            self._send(404, {"error_code": "not_found"})
    return H


def make_server(port=0, svc=None, token=None):
    svc = svc or Service()
    token = token or load_token()
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(svc, token))
    srv.daemon_threads = True
    srv.svc = svc
    return srv


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port = int(argv[0]) if argv else int(os.environ.get("DIPDIVE_PORT", "8765"))
    sweep_stale()
    srv = make_server(port)
    print(f"dipdive listening on 127.0.0.1:{srv.server_address[1]}; token file {TOKEN_PATH}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
