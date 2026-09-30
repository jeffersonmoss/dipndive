"""Subprocess helper: own process group, whole group killed on timeout, output capped."""
import os
import signal
import subprocess

from .errors import DipDiveError

OUTPUT_CAP = 20_000_000


def run(args, timeout, stdin_text=None, cwd=None, env=None):
    p = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd, env=env, start_new_session=True, text=True, errors="replace",
    )
    try:
        out, err = p.communicate(stdin_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.communicate()
        raise DipDiveError("timeout", f"{os.path.basename(args[0])} exceeded {timeout}s")
    finally:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return p.returncode, out[:OUTPUT_CAP], err[:OUTPUT_CAP]
