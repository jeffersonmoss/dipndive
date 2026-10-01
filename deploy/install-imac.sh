#!/bin/bash
# Install the Dip & Dive companion as a LaunchAgent on the iMac (plan 3.2.2 and 3.2.3).
# NOT run automatically. Usage: deploy/install-imac.sh [--dry-run] [--port N]
#   --dry-run  renders the plist into a temp folder, lints it, prints every command, changes nothing.
# Prerequisites on the iMac: repo cloned, `python3 -m venv .venv` and pip installs done (see README),
# deno installed (brew install deno), HTTPS certificates enabled in the Tailscale admin console,
# and `CODEX_HOME=... codex login` run once in the GUI session.
set -euo pipefail

DRY=0; PORT=8765
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --port) [ $# -ge 2 ] || { echo "--port needs a value" >&2; exit 2; }; PORT="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jeffersonmoss.dipdive"
DENO="$(command -v deno || true)"
[ -n "$DENO" ] || DENO=/opt/homebrew/bin/deno
# A LaunchAgent's PATH has no Homebrew or ~/.local/bin, so set one explicitly.
AGENT_PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SUPPORT="$HOME/Library/Application Support/DipDive"

if [ "$DRY" = 1 ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/dipdive-install-XXXXXX")"
  printf '# Temporary folder\nPurpose: dry-run plist render for install-imac.sh\nMade by: install-imac.sh, %s, %s\nNeeded until: the script exits.\nCostly to recreate: no.\n' "$(hostname)" "$(date +%F)" > "$OUT/TEMP_README.md"
  trap 'rm -rf "$OUT"' EXIT
  PLIST="$OUT/$LABEL.plist"
else
  mkdir -p "$HOME/Library/LaunchAgents" "$SUPPORT"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
fi

# Escape sed replacement metacharacters (& | \) and XML ones (& < >) in values taken from paths.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' | sed -e 's/[\\&|]/\\&/g'; }
sed -e "s|@LABEL@|$(esc "$LABEL")|g" -e "s|@REPO@|$(esc "$REPO")|g" -e "s|@PATH@|$(esc "$AGENT_PATH")|g" \
    -e "s|@HOME@|$(esc "$HOME")|g" -e "s|@DENO@|$(esc "$DENO")|g" -e "s|@PORT@|$(esc "$PORT")|g" \
    "$REPO/deploy/$LABEL.plist.template" > "$PLIST"
plutil -lint "$PLIST"
[ "$DRY" = 1 ] && { echo "--- rendered plist:"; cat "$PLIST"; echo "---"; }

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

# Bootstrap into the GUI session (needed: headless claude -p reads the login keychain).
# Expect a one-time Keychain "Always Allow" prompt the first time claude runs.
run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
run launchctl bootstrap "gui/$(id -u)" "$PLIST"
run launchctl kickstart -k "gui/$(id -u)/$LABEL"

# Tailnet-only HTTPS with a real certificate; persists across reboots. Run once.
TAILSCALE="$(command -v tailscale || true)"
[ -n "$TAILSCALE" ] || TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TAILSCALE" ] || { echo "tailscale not found; install it, then re-run" >&2; exit 1; }
run "$TAILSCALE" serve --bg --https=443 "http://127.0.0.1:$PORT"

if [ "$DRY" != 1 ]; then
  sleep 3
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)"
  echo "Post-install check: GET /health without a token returned HTTP $CODE (expected 401)."
  [ "$CODE" = 401 ] || echo "WARNING: the companion is not answering as expected; see $SUPPORT/launchd.err.log" >&2
fi

cat <<NOTE

The bearer token is created on first server start at: $SUPPORT/token (mode 0600).
Copy it by hand into each machine's extension options page. It is never printed here.

Keep the iMac awake (desktop, on power). Needs sudo, so run it yourself:
  sudo pmset -c sleep 0 displaysleep 10 disksleep 0
Wake-on-network does not work over Tailscale, so the iMac must not sleep.
NOTE
