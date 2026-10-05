#!/usr/bin/env python3
"""Unload and remove the Mac clipboard helper LaunchAgent and config."""

import os
from pathlib import Path
import subprocess

LABEL = "com.jeffersonmoss.dipdive.clipboard-helper"


def main():
    domain = "gui/" + str(os.getuid())
    subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (Path.home() / "Library" / "LaunchAgents" / (LABEL + ".plist")).unlink(missing_ok=True)
    (Path.home() / "Library" / "Application Support" / "DipDive" / "clipboard-helper.json").unlink(missing_ok=True)
    (Path.home() / "Library" / "Application Support" / "DipDive" / "mac_clipboard_helper.py").unlink(missing_ok=True)
    print("Removed Dip'n'Dive clipboard helper.")


if __name__ == "__main__":
    raise SystemExit(main())
