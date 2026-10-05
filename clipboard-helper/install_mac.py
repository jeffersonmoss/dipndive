#!/usr/bin/env python3
"""Install the Mac clipboard poller and configure its LaunchAgent."""

import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import unicodedata
from urllib.parse import urlsplit

MACHINES = ("thing-1", "thing-2", "imac", "win")
LABEL = "com.jeffersonmoss.dipdive.clipboard-helper"


def secure_base_url(value):
    if not isinstance(value, str) or "\\" in value or any(unicodedata.category(c) in ("Cc", "Cf") for c in value):
        return False
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if not host or parsed.query or parsed.fragment or parsed.scheme.lower() not in ("http", "https"):
            return False
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host.lower() == "localhost" or host.lower().endswith(".localhost")
        return parsed.scheme.lower() == "https" or loopback or host.lower().endswith(".ts.net")
    except (TypeError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--machine", required=True, choices=MACHINES)
    token_source = parser.add_mutually_exclusive_group()
    token_source.add_argument("--token-file", help="read the bearer token from this file")
    token_source.add_argument("--prompt-token", action="store_true", help="prompt without echo")
    args = parser.parse_args()

    if sys.platform != "darwin":
        parser.error("this installer runs on macOS")
    token = getpass.getpass("Companion bearer token: ") if args.prompt_token or not args.token_file else Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        parser.error("the token is empty")
    if not secure_base_url(args.base_url):
        parser.error("--base-url must use https, except loopback or *.ts.net; query and fragment are not allowed")

    support = Path.home() / "Library" / "Application Support" / "DipDive"
    support.mkdir(parents=True, exist_ok=True)
    config_path = support / "clipboard-helper.json"
    data = {"base_url": args.base_url.rstrip("/"), "token": token, "machine": args.machine}
    descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
        json.dump(data, config_file)
        config_file.write("\n")
        config_file.flush()
        os.fsync(config_file.fileno())

    script_path = support / "mac_clipboard_helper.py"
    script_path.write_bytes(Path(__file__).resolve().with_name("mac_clipboard_helper.py").read_bytes())
    os.chmod(script_path, 0o700)
    python = "/usr/bin/python3"
    agent_dir = Path.home() / "Library" / "LaunchAgents"
    log_dir = Path.home() / "Library" / "Logs" / "DipDive"
    agent_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    plist_path = agent_dir / (LABEL + ".plist")
    plist = {
        "Label": LABEL,
        "ProgramArguments": [python, str(script_path), "--config", str(config_path)],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "EnvironmentVariables": {"LANG": "en_US.UTF-8"},
        "ProcessType": "Background",
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    with open(plist_path, "wb") as file:
        plistlib.dump(plist, file)
    os.chmod(plist_path, 0o600)
    domain = "gui/" + str(os.getuid())
    subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for attempt in range(2):
        result = subprocess.run(["launchctl", "bootstrap", domain, str(plist_path)], check=False,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0:
            break
        if attempt == 0:
            time.sleep(0.5)
    else:
        raise subprocess.CalledProcessError(result.returncode, ["launchctl", "bootstrap", domain, str(plist_path)])
    print("Installed Dip'n'Dive clipboard helper for " + args.machine + ".")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
