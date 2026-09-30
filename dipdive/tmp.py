"""Temp folders: system temp dir, prefix dipdive-, TEMP_README.md, removed by the caller in finally."""
import contextlib
import datetime
import os
import shutil
import tempfile
import time


@contextlib.contextmanager
def tempdir(purpose: str):
    d = tempfile.mkdtemp(prefix="dipdive-")
    try:
        with open(os.path.join(d, "TEMP_README.md"), "w") as f:
            f.write(
                f"# Temporary folder\n\nPurpose: {purpose}\n"
                "Made by: dipdive companion (chat: T1 Dip Dive PoC 1, machine: Thing 1)\n"
                f"Date: {datetime.date.today()}\n"
                "Needed until: the single call that created it returns (seconds).\n"
                "Costly to recreate: no.\n"
            )
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def sweep_stale(max_age_s=3600):
    """Delete own leftovers from crashed runs (prefix dipdive-, older than max_age_s)."""
    root = tempfile.gettempdir()
    for n in os.listdir(root):
        p = os.path.join(root, n)
        if n.startswith("dipdive-") and os.path.isdir(p) and time.time() - os.path.getmtime(p) > max_age_s:
            shutil.rmtree(p, ignore_errors=True)
