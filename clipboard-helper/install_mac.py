#!/usr/bin/env python3
"""Install the Mac clipboard poller and configure its LaunchAgent."""

import argparse
import getpass
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from urllib.parse import urlsplit

MACHINES = ("thing-1", "thing-2", "imac", "win")
LABEL = "com.jeffersonmoss.dipdive.clipboard-helper"


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
    parsed_base = urlsplit(args.base_url)
    if parsed_base.scheme not in ("http", "https") or not parsed_base.hostname or parsed_base.query or parsed_base.fragment:
        parser.error("--base-url must be an http or https base URL without query or fragment")

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

    script_path = Path(__file__).resolve().with_name("mac_clipboard_helper.py")
    python = sys.executable
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
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "StandardOutPath": str(log_dir / "clipboard-helper.out.log"),
        "StandardErrorPath": str(log_dir / "clipboard-helper.err.log"),
    }
    with open(plist_path, "wb") as file:
        plistlib.dump(plist, file)
    os.chmod(plist_path, 0o600)
    domain = "gui/" + str(os.getuid())
    subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist_path)], check=True)
    print("Installed Dip'n'Dive clipboard helper for " + args.machine + ".")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
