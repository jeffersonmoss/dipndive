"""Live check of the ask modes against a real local companion and the real Claude CLI (3 Haiku calls).

    .venv/bin/python -m tests.e2e_ask [video-url]

Starts the companion on a free port with a throwaway support folder (so Jefferson's real DipDive folder, token and
history are not touched), asks a question about a public YouTube video, asks a follow-up that depends on the first
answer, then asks something the video cannot cover. Prints the questions, the answers and the timings as JSON.
The temp folder and the server process are removed on success, failure and Ctrl-C."""
import atexit
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DEFAULT_URL = "https://www.youtube.com/watch?v=iG9CE55wbtY"  # Ken Robinson, "Do schools kill creativity?" (manual captions)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sweep(prefix="dipdive-e2e-", older_than=3600):
    for n in os.listdir(tempfile.gettempdir()):
        p = os.path.join(tempfile.gettempdir(), n)
        if n.startswith(prefix) and os.path.isdir(p) and time.time() - os.path.getmtime(p) > older_than:
            shutil.rmtree(p, ignore_errors=True)


def main(argv):
    sweep()
    url = argv[0] if argv else DEFAULT_URL
    tmp = tempfile.mkdtemp(prefix="dipdive-e2e-")
    with open(os.path.join(tmp, "TEMP_README.md"), "w") as f:
        f.write("# Temporary folder\n\nPurpose: support folder for a live ask-mode check (tests/e2e_ask.py)\n"
                f"Made by: T1 Dip Dive chat on this Mac, {time.strftime('%Y-%m-%d')}\n"
                "Needed until: the script ends (it deletes this folder)\nCostly to recreate: no.\n")
    proc = None

    def cleanup():
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
    try:
        port = 8700 + os.getpid() % 200
        env = dict(os.environ, DIPDIVE_SUPPORT=os.path.join(tmp, "support"),
                   DIPDIVE_LOG_PATH=os.path.join(tmp, "history-log.md"))  # never the real ~/Public log
        proc = subprocess.Popen([sys.executable, "-m", "dipdive.server", str(port)], cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        proc.stdout.readline()  # "dipdive listening ..."
        token = open(os.path.join(tmp, "support", "token")).read().strip()
        base = f"http://127.0.0.1:{port}"

        def call(method, path, body=None):
            r = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                       headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r, timeout=30) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")

        def ask(question, history, rid, mode="claude-ask"):
            t0 = time.time()
            code, r = call("POST", "/jobs", {"url": url, "mode": mode, "requestId": rid, "question": question, "history": history})
            assert code in (200, 202), (code, r)
            while True:
                _, j = call("GET", "/jobs/" + r["job_id"])
                if j["state"] in ("done", "error"):
                    return {"question": question, "history_turns": len(history), "state": j["state"], "answer": j["result_markdown"],
                            "error": j["error_code"], "title": j["title"], "seconds": round(time.time() - t0, 1)}
                time.sleep(0.5)
                if time.time() - t0 > 150:
                    raise SystemExit("timed out")

        out = []
        a1 = ask("Okay, what's the deal with the dancer he talks about?", [], "e2e-1")
        out.append(a1)
        hist = [{"q": a1["question"], "a": a1["answer"] or ""}]
        a2 = ask("And what did the doctor tell her mother?", hist, "e2e-2")
        out.append(a2)
        hist.append({"q": a2["question"], "a": a2["answer"] or ""})
        out.append(ask("What is the capital of Australia?", hist, "e2e-3"))
        print(json.dumps(out, indent=1, ensure_ascii=False))
        return 0 if all(o["state"] == "done" for o in out) else 1
    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
