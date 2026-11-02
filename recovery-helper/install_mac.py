#!/usr/bin/env python3
"""Install this fixed-target helper for Chrome; no daemon or password storage."""
import base64
import hashlib
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import sys


def extension_id(manifest):
    digest = hashlib.sha256(base64.b64decode(manifest['key'])).digest()[:16]
    return ''.join(chr(ord('a') + (b >> 4)) + chr(ord('a') + (b & 15)) for b in digest)


def install(home=None):
    if sys.platform != 'darwin':
        raise SystemExit('The recovery helper is Mac-only.')
    home = Path(home or Path.home())
    source = Path(__file__).resolve().parent
    manifest = json.loads((source.parent / 'extension/manifest.json').read_text())
    origin = 'chrome-extension://' + extension_id(manifest) + '/'
    target = home / 'Library/Application Support/DipDive Recovery'
    native_dir = home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
    native_path = native_dir / 'com.jeffersonmoss.dipdive_recovery.json'
    # A fixed helper upgrade preserves its current exact files before replacement.
    if target.exists() and any(not (target / name).is_file() or (target / name).read_bytes() != (source / name).read_bytes()
                               for name in ('recovery.py', 'Repair instructions.txt', 'VERSION.txt', 'Trusted hosts.known_hosts')):
        stem = 'Recovery helper before update - ' + datetime.date.today().strftime('%-d %B %Y')
        backup = home / 'dipndive' / stem
        copy = 1
        while backup.exists():
            copy += 1
            backup = home / 'dipndive' / (stem + ' - copy ' + str(copy))
        shutil.copytree(target, backup)
        if native_path.exists():
            shutil.copy2(native_path, backup / 'Native host registration.json')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.chmod(0o700)
    for name in ('recovery.py', 'Repair instructions.txt', 'VERSION.txt', 'Trusted hosts.known_hosts'):
        shutil.copy2(source / name, target / name)
        (target / name).chmod(0o600)
    (target / 'host-config.json').write_text(json.dumps({'origin': origin}))
    (target / 'host-config.json').chmod(0o600)
    python = '/usr/bin/python3'
    for name, arg in [('Native host.command', '--native'), ('Recover iMac.command', 'recover'),
                      ('Repair with codex.command', 'codex'), ('Repair with claude.command', 'claude')]:
        text = '#!/bin/zsh\nexec ' + shlex.quote(python) + ' ' + shlex.quote(str(target / 'recovery.py')) + ' ' + arg
        if arg == '--native':
            text += ' "$@"'
        (target / name).write_text(text + '\n')
        (target / name).chmod(0o700)
    native_dir.mkdir(parents=True, exist_ok=True)
    native = {'name': 'com.jeffersonmoss.dipdive_recovery', 'description': 'DipDive fixed-target iMac recovery',
              'path': str(target / 'Native host.command'), 'type': 'stdio', 'allowed_origins': [origin]}
    native_path.write_text(json.dumps(native, indent=2) + '\n')
    native_path.chmod(0o600)
    print('Installed Mac recovery helper:', target)
    print('Allowed extension:', extension_id(manifest))
    print('No background service installed. Native messaging is requested only when a recovery control is clicked.')


if __name__ == '__main__':
    install()
