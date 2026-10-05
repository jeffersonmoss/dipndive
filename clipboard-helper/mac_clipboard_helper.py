#!/usr/bin/env python3
"""Poll the Dip'n'Dive companion and copy queued URLs to this Mac."""

import argparse
import json
import ipaddress
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MACHINES = {"thing-1", "thing-2", "imac", "win"}
POLL_SECONDS = 2
MAX_BACKOFF_SECONDS = 30
CONFIG_PATH = Path.home() / "Library" / "Application Support" / "DipDive" / "clipboard-helper.json"
LOG_PATH = Path.home() / "Library" / "Logs" / "DipDive" / "clipboard-helper.log"
MAX_RESPONSE_BYTES = 64 * 1024
WRITE_ATTEMPTS = 4
WRITE_RETRY_SECONDS = 0.25


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def secure_base_url(value):
    if not isinstance(value, str) or "\\" in value or any(unicodedata.category(c) in ("Cc", "Cf") for c in value):
        return False
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if parsed.scheme.lower() not in ("http", "https") or not host or parsed.query or parsed.fragment:
            return False
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host.lower() == "localhost" or host.lower().endswith(".localhost")
        return parsed.scheme.lower() == "https" or loopback or host.lower().endswith(".ts.net")
    except ValueError:
        return False


def valid_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        return False
    if "\\" in value or any(char.isspace() or unicodedata.category(char) in ("Cc", "Cf") for char in value):
        return False
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc or not parsed.hostname:
            return False
        return True
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
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            if response.status == 204:
                return None
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError("clipboard response too large")
            payload = json.loads(raw.decode("utf-8"))
            return extract_url(payload)
    except HTTPError as error:
        if error.code == 204:
            return None
        error.close()
        raise


def write_with_pbcopy(value):
    subprocess.run(["/usr/bin/pbcopy"], input=value.encode("utf-8"), check=True)


def poll_once(config, clipboard_writer=write_with_pbcopy, fetcher=fetch_next, sleeper=time.sleep):
    """Fetch at most one item and copy it. Return True when a URL was copied."""
    value = fetcher(config)
    if not valid_url(value):
        return False
    for attempt in range(WRITE_ATTEMPTS):
        try:
            clipboard_writer(value)
            return True
        except Exception:
            if attempt + 1 == WRITE_ATTEMPTS:
                raise
            sleeper(WRITE_RETRY_SECONDS)


def load_config(path=CONFIG_PATH):
    with open(path, "r", encoding="utf-8") as file:
        config = json.load(file)
    if (not isinstance(config, dict) or not isinstance(config.get("base_url"), str)
            or not isinstance(config.get("token"), str) or not config["token"]
            or config.get("machine") not in MACHINES):
        raise ValueError("clipboard helper config is incomplete")
    if not secure_base_url(config["base_url"]):
        raise ValueError("clipboard helper base URL must use https, except loopback or *.ts.net")
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
        logger=None, stop=None, config_loader=None):
    logger = logger or make_logger()
    backoff = POLL_SECONDS
    current = config
    last_unauthorized_log = 0
    while stop is None or not stop():
        try:
            if current is None:
                current = (config_loader or load_config)()
            poll_once(current, clipboard_writer, fetcher, sleeper)
            backoff = POLL_SECONDS
            sleeper(POLL_SECONDS)
        except HTTPError as error:
            if error.code != 401:
                logger.warning("poll failed (%s)", type(error).__name__)
            else:
                now = time.time()
                if now - last_unauthorized_log >= 3600:
                    logger.warning("unauthorized; reloading config")
                    last_unauthorized_log = now
                try:
                    current = (config_loader or load_config)()
                except Exception:
                    current = None
            sleeper(backoff)
            backoff = min(MAX_BACKOFF_SECONDS, max(POLL_SECONDS, backoff * 2))
        except Exception as error:  # no request data or exception details in the log
            logger.warning("poll failed (%s)", type(error).__name__)
            sleeper(backoff)
            backoff = min(MAX_BACKOFF_SECONDS, max(POLL_SECONDS, backoff * 2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(CONFIG_PATH))
    args = parser.parse_args()
    run(None, config_loader=lambda: load_config(args.config))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
