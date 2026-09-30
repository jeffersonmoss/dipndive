"""Subprocess helper with a hard wall-clock limit.

Own process group, whole group killed on timeout, output capped WHILE capturing, pipes read in
threads so a descendant that detached (setsid) and still holds a pipe cannot block the caller.
"""
import os
import signal
import subprocess
import threading
import time

from .errors import DipDiveError

OUTPUT_CAP = 20_000_000


class Result:
    def __init__(self):
        self.rc = None
        self.out = b""
        self.err = b""
        self.timed_out = False
        self.aborted = None      # reason string when on_line asked to kill, or "output_cap"
        self.truncated = False

    @property
    def text(self):
        return self.out.decode("utf-8", errors="replace")

    @property
    def err_text(self):
        return self.err.decode("utf-8", errors="replace")


def _kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run(args, timeout, stdin_text=None, cwd=None, env=None, max_bytes=OUTPUT_CAP, on_line=None):
    """Run args. on_line(bytes_line) is called for each stdout line as it arrives; if it returns a
    truthy reason string the process group is killed at once and Result.aborted holds the reason."""
    res = Result()
    p = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd, env=env, start_new_session=True,
    )
    stop = threading.Event()
    bufs = {"out": bytearray(), "err": bytearray()}

    def reader(stream, name):
        pending = b""
        try:
            while True:
                chunk = stream.read1(65536)
                if not chunk:
                    break
                room = max_bytes - len(bufs[name])
                if len(chunk) > room:
                    bufs[name] += chunk[:max(room, 0)]
                    res.truncated = True
                    res.aborted = res.aborted or "output_cap"
                    stop.set()
                    break
                bufs[name] += chunk
                if name == "out" and on_line:
                    pending += chunk
                    *lines, pending = pending.split(b"\n")
                    for ln in lines:
                        reason = on_line(ln)
                        if reason:
                            res.aborted = res.aborted or reason
                            stop.set()
                            return
        except (ValueError, OSError):
            pass

    def writer():
        try:
            if stdin_text is not None:
                p.stdin.write(stdin_text.encode("utf-8"))
            p.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    threads = [threading.Thread(target=reader, args=(p.stdout, "out"), daemon=True),
               threading.Thread(target=reader, args=(p.stderr, "err"), daemon=True),
               threading.Thread(target=writer, daemon=True)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + timeout
    try:
        while p.poll() is None:
            if stop.is_set():
                break
            if time.monotonic() >= deadline:
                res.timed_out = True
                break
            time.sleep(0.02)
    finally:
        _kill_group(p.pid)
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        for t in threads[:2]:
            t.join(timeout=2)
        # A reader still blocked means a detached descendant holds the pipe: closing would block on the
        # buffer lock, so leave that pipe to the daemon thread (released when the descendant exits).
        for s, t in zip((p.stdout, p.stderr), threads[:2]):
            if not t.is_alive():
                try:
                    s.close()
                except Exception:
                    pass
    res.rc = p.returncode
    res.out, res.err = bytes(bufs["out"]), bytes(bufs["err"])
    return res


def run_or_timeout(args, timeout, **kw):
    r = run(args, timeout, **kw)
    if r.timed_out:
        e = DipDiveError("timeout", f"{os.path.basename(args[0])} exceeded {timeout}s")
        e.partial = r
        raise e
    return r
