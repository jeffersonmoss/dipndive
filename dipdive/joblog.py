"""Per-call logs (stderr, tool events) under the DipDive Application Support folder, pruned after 30 days."""
import json
import os
import time
import uuid

SUPPORT = os.environ.get("DIPDIVE_SUPPORT") or os.path.expanduser("~/Library/Application Support/DipDive")
LOG_DIR = os.path.join(SUPPORT, "logs")
KEEP_DAYS = 30


def write(data: dict) -> str:
    os.makedirs(LOG_DIR, exist_ok=True)
    prune()
    path = os.path.join(LOG_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)
    return path


def prune():
    cutoff = time.time() - KEEP_DAYS * 86400
    try:
        for n in os.listdir(LOG_DIR):
            p = os.path.join(LOG_DIR, n)
            if n.endswith((".json", ".tmp")) and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass
