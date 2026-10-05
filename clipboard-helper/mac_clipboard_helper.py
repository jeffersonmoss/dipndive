#!/usr/bin/env python3
"""Poll the Dip'n'Dive companion and copy queued URLs to this Mac."""

import argparse
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import sys
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

MACHINES = {"thing-1", "thing-2", "imac", "win"}
POLL_SECONDS = 2
MAX_BACKOFF_SECONDS = 30
CONFIG_PATH = Path.home() / "Library" / "Application Support" / "DipDive" / "clipboard-helper.json"
LOG_PATH = Path.home() / "Library" / "Logs" / "DipDive" / "clipboard-helper.log"


def valid_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        return False
    if any(char.isspace() or unicodedata.category(char) == "Cc" for char in value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme.lower() in ("http", "https") and bool(parsed.hostname)
    except ValueError:
        return False


def extract_url(payload):
    if isinstance(payload, dict):
        candidate = payload.get("url")
    elif isinstance(payload, str):
        candidate = payload
    else:
        candidate = None
    return candidate if valid_url(candidate) else None


def fetch_next(config, timeout=10):
    query = urlencode({"machine": config["machine"]})
    endpoint = config["base_url"].rstrip("/") + "/clipboard/next?" + query
    request = Request(endpoint, headers={"Authorization": "Bearer " + config["token"]})
    try:
        with urlopen(request, timeout=timeout) as response:
            if response.status == 204:
                return None
            payload = json.loads(response.read().decode("utf-8"))
            return extract_url(payload)
    except HTTPError as error:
        if error.code == 204:
            return None
        raise


def write_with_pbcopy(value):
    subprocess.run(["/usr/bin/pbcopy"], input=value.encode("utf-8"), check=True)


def poll_once(config, clipboard_writer=write_with_pbcopy, fetcher=fetch_next):
    """Fetch at most one item and copy it. Return True when a URL was copied."""
    value = fetcher(config)
    if not valid_url(value):
        return False
    clipboard_writer(value)
    return True


def load_config(path=CONFIG_PATH):
    with open(path, "r", encoding="utf-8") as file:
        config = json.load(file)
    if (not isinstance(config, dict) or not isinstance(config.get("base_url"), str)
            or not isinstance(config.get("token"), str) or not config["token"]
            or config.get("machine") not in MACHINES):
        raise ValueError("clipboard helper config is incomplete")
    base = urlsplit(config["base_url"])
    if base.scheme not in ("http", "https") or not base.hostname or base.query or base.fragment:
        raise ValueError("clipboard helper base URL must use http or https")
    return config


def make_logger(path=LOG_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("dipdive_clipboard_helper")
    logger.setLevel(logging.WARNING)
    logger.handlers.clear()
    handler = RotatingFileHandler(path, maxBytes=64 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger


def run(config, clipboard_writer=write_with_pbcopy, fetcher=fetch_next, sleeper=time.sleep,
        logger=None, stop=None):
    logger = logger or make_logger()
    backoff = POLL_SECONDS
    while stop is None or not stop():
        try:
            poll_once(config, clipboard_writer, fetcher)
            backoff = POLL_SECONDS
            sleeper(POLL_SECONDS)
        except Exception as error:  # no request data or exception details in the log
            logger.warning("poll failed (%s)", type(error).__name__)
            sleeper(backoff)
            backoff = min(MAX_BACKOFF_SECONDS, max(POLL_SECONDS, backoff * 2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(CONFIG_PATH))
    args = parser.parse_args()
    try:
        run(load_config(args.config))
    except Exception as error:
        print("Dip'n'Dive clipboard helper: " + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
