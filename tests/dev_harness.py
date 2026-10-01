"""Dev harness for the extension panel: a real companion (faked model binaries, local article pages) plus a
static and proxy server, so panel.html can be opened as a plain page in a browser.

    .venv/bin/python -m tests.dev_harness [port]

Serves the extension at /ext/ and proxies /c/* to the companion without an Origin header (the companion
rejects web-page origins on purpose). Prints a panel URL. Stops on Ctrl-C or SIGTERM and removes its temp folder."""
import atexit
import http.client
import http.server
import json
import os
import shutil
import signal
import stat
import sys
import tempfile
import threading
import time

os.environ["DIPDIVE_TEST_ALLOW_LOOPBACK"] = "1"
ROOT = tempfile.mkdtemp(prefix="dipdive-harness-")
os.environ["DIPDIVE_SUPPORT"] = os.path.join(ROOT, "support")
os.environ["DIPDIVE_LOG_PATH"] = os.path.join(ROOT, "Dip-n-Dive Log.md")  # never the real ~/Public log
with open(os.path.join(ROOT, "TEMP_README.md"), "w") as f:
    f.write("# Temporary folder\n\nPurpose: extension panel dev harness (fake model binaries, local pages)\n"
            f"Made by: T1 Dip Dive chat on this Mac, {time.strftime('%Y-%m-%d')}\n"
            "Needed until: the harness process exits (it deletes this folder).\nCostly to recreate: no.\n")
atexit.register(lambda: shutil.rmtree(ROOT, ignore_errors=True))

from dipdive import joblog, models, server  # noqa: E402

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
CLAUDE_OUT = ("Yes, the **crater** was habitable for up to 8 million years.\n\n- Hot water and nutrients\n- Only 8 of 70 similar craters "
              "show life\n\nSee [the study](https://example.com/study). Raw HTML stays inert: <img src=x onerror=alert(1)> "
              "and ![pic](https://example.com/p.png).")
ASK_OUT = ("The chocolate is **mentioned** near the end: it was a *test batch*, not the main product. "
           "(Fake Claude answer to: {q}; earlier turns sent: {n}; summary sent: {s}.) See [the page](https://example.com/choc). "
           "Raw HTML stays inert: <img src=x onerror=alert(1)>.")
CODEX_ASK_OUT = "Codex answer to: {q}. Earlier turns sent: {n}; summary sent: {s}. The source does not cover anything else."
CODEX_OUT = "Codex says: the answer is **no**, schools do not need to kill creativity.\n\nThe source is [here](javascript:alert(1))."


def fake(body):
    p = os.path.join(ROOT, f"fake-{abs(hash(body)) % 10**6}")
    open(p, "w").write(f"#!{sys.executable}\nimport sys, json, time, os, re\ninp = sys.stdin.read()\n"
                       "m = re.search(r'<question>\\n(.*?)\\n</question>', inp, re.S)\n"
                       "asked = m.group(1) if m else None\n"
                       "turns = inp.count('<turn>')\n"
                       "has_summary = '<summary>' in inp\n"
                       + body)
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return p


PARA = "".join(f"<p>Paragraph {i} discusses topic {i * 7919} with many distinct words and details here.</p>" for i in range(60))
LONG = "".join(f"<p>Long paragraph {i} about subject {i * 104729} " + "word " * 40 + "</p>" for i in range(700))


class Pages(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = (LONG if self.path.startswith("/long") else PARA)
        page = f"<html><head><title>Page {self.path}</title></head><body><article>{body}</article></body></html>".encode()
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(page)))
        self.end_headers(); self.wfile.write(page)


def make_front(comp_port, token):
    class Front(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _static(self):
            rel = self.path.split("?")[0][len("/ext/"):] or "panel.html"
            p = os.path.realpath(os.path.join(EXT, rel))
            if not p.startswith(EXT) or not os.path.isfile(p):
                self.send_error(404); return
            ctype = {"js": "text/javascript", "html": "text/html", "css": "text/css", "json": "application/json", "png": "image/png"}.get(p.rsplit(".", 1)[-1], "application/octet-stream")
            data = open(p, "rb").read()
            self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(data)

        def _proxy(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else None
            hdrs = {k: v for k, v in self.headers.items() if k.lower() in ("authorization", "content-type")}
            c = http.client.HTTPConnection("127.0.0.1", comp_port, timeout=30)
            try:
                c.request(self.command, self.path[len("/c"):], body, hdrs)  # no Origin header forwarded
                r = c.getresponse(); data = r.read()
                self.send_response(r.status); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            except OSError:
                self.send_error(502)
            finally:
                c.close()

        def do_GET(self):
            self._proxy() if self.path.startswith("/c/") else self._static()

        def do_POST(self):
            self._proxy() if self.path.startswith("/c/") else self.send_error(404)
    return Front


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    models.CLAUDE = fake(f"time.sleep(float(os.environ.get('DIPDIVE_FAKE_DELAY','2.5')))\nres = ASK_OUT.format(q=asked, n=turns, s='yes' if has_summary else 'no') if asked else {CLAUDE_OUT!r}\nprint(json.dumps({{'subtype':'success','stop_reason':'end_turn','is_error':False,'result':res,'permission_denials':[]}}))\n".replace("ASK_OUT", repr(ASK_OUT)))
    models.CODEX = fake("o=sys.argv[sys.argv.index('-o')+1]\ntime.sleep(float(os.environ.get('DIPDIVE_FAKE_DELAY','2.5')))\nopen(o,'w').write(%r.format(q=asked, n=turns, s='yes' if has_summary else 'no') if asked else %r)\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'x'}}))\nprint(json.dumps({'type':'turn.completed'}))\n" % (CODEX_ASK_OUT, CODEX_OUT))
    models._features_verified = True
    models.CODEX_HOME = os.path.join(ROOT, "support", "codex-home")
    token = server.load_token(os.path.join(ROOT, "support", "token"))
    comp = server.make_server(0, None, token)
    threading.Thread(target=comp.serve_forever, daemon=True).start()
    pages = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Pages)
    threading.Thread(target=pages.serve_forever, daemon=True).start()
    front = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_front(comp.server_address[1], token))
    signal.signal(signal.SIGTERM, lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
    pbase = f"http://127.0.0.1:{pages.server_address[1]}"
    print(json.dumps({"front": f"http://127.0.0.1:{port}", "token": token, "pages": pbase}), flush=True)
    try:
        front.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for s in (front, pages, comp):
            s.shutdown() if False else None
        shutil.rmtree(ROOT, ignore_errors=True)


if __name__ == "__main__":
    main()
