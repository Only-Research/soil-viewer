#!/bin/bash
#
# START SOIL VIEWER — double-click this file in Finder, or run `npm run open` from app/.
#
# It lives at the repository root because it is the one file here meant for a person rather
# than for a build, and a starter you have to go looking for is one you will not find on the
# day you need it.
#
# What it does, in order:
#   1. If Soil Viewer is already answering, it opens it in your browser and stops. If something
#      ELSE is answering on the port, it says so rather than opening a stranger's page.
#   2. If the app was never built, it says so and prints the one command to run.
#   3. If always-on is installed (see app/ops/), it restarts that and waits for it to answer.
#   4. Otherwise it starts the server right here, in this window, and opens your browser.
#      Closing this window stops it. To have it run on its own, see app/ops/README.md.
#
# If it still cannot start, it prints the last lines of the crash log and what they usually
# mean, so a bad day produces something to act on rather than the word "broken". Spec §2.1.
#
# It starts nothing but Soil Viewer and touches no other service on the machine.
#
# macOS may refuse to open a downloaded .command file the first time ("cannot be opened
# because it is from an unidentified developer"). Right-click it and choose Open, once.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="${ROOT}/app"
SERVER="${APP}/dist-server/main.js"

# All configuration through the environment, exactly as the server takes it; the defaults
# match the server's own. SOIL_NO_BROWSER=1 skips opening the browser.
LABEL="${SOIL_LAUNCH_LABEL:-com.soilviewer.server}"
PORT_TAILNET="${SOIL_PORT_TAILNET:-8766}"
STATE_DIR="${SOIL_STATE_DIR:-${HOME}/.soil-viewer}"
ERR_LOG="${STATE_DIR}/launchd.err.log"
PLIST_LIVE="${HOME}/Library/LaunchAgents/${LABEL}.plist"
URL="http://127.0.0.1:${PORT_TAILNET}"

say() { printf '%s\n' "$*"; }
rule() { printf '%s\n' "------------------------------------------------------------"; }
answering() { /usr/bin/nc -z 127.0.0.1 "${PORT_TAILNET}" 2>/dev/null; }
open_browser() { [ "${SOIL_NO_BROWSER:-}" = "1" ] || /usr/bin/open "${URL}"; }

# Is what is answering actually Soil Viewer? Its page carries a build-stamp tag that nothing
# else does. Without this check the script would find any program on the port and call it ours —
# the same mistake once made by a test suite here that pointed at a port, found a different
# application entirely, and passed.
is_soil_viewer() {
  printf 'GET / HTTP/1.0\r\nHost: 127.0.0.1:%s\r\n\r\n' "${PORT_TAILNET}" \
    | /usr/bin/nc -w 3 127.0.0.1 "${PORT_TAILNET}" 2>/dev/null \
    | grep -q 'name="soil-build"'
}

# The phone address, read from the installed agent rather than written here a second time, so
# it cannot drift from what the server allows — a mismatch there is refused as a bad host.
phone_url() {
  [ -f "${PLIST_LIVE}" ] || return 1
  local host port
  host=$(plutil -extract EnvironmentVariables.SOIL_TAILNET_HOST raw -o - "${PLIST_LIVE}" 2>/dev/null) || return 1
  port=$(plutil -extract EnvironmentVariables.SOIL_TAILNET_SERVE_PORT raw -o - "${PLIST_LIVE}" 2>/dev/null) || port=443
  [ -n "${host}" ] || return 1
  printf 'https://%s:%s' "${host}" "${port}"
}

addresses() {
  say "  On this Mac:   ${URL}"
  if PHONE="$(phone_url)"; then say "  On your phone: ${PHONE}"; fi
}

wait_for_it() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if answering; then return 0; fi
    sleep 1
  done
  return 1
}

crash_report() {
  say ""
  say "It did not come back. Here is everything this script can tell you."
  rule
  say ""
  say "Last lines of the crash log (${ERR_LOG})."
  say "This file is added to and never cleared, so some of it may be from an older failure."
  say "The lines at the very bottom are the most recent."
  say ""
  if [ -f "${ERR_LOG}" ]; then tail -n 25 "${ERR_LOG}"; else say "  (no crash log yet)"; fi
  say ""
  rule
  say "What this usually means:"
  say ""
  say "  \"Cannot find module\"     the build is missing or out of date — cd app && npm run build"
  say "  \"EADDRINUSE\"             something else already has port ${PORT_TAILNET}"
  say "  \"is not a usable port\"   the agent's environment has a bad port in it"
  say ""
  say "Copy this whole window into an issue and it will be enough to work from."
  say ""
}

say ""
say "Soil Viewer"
rule

# 1. Already answering? Then the only job is to open it — after checking it is ours.
if answering; then
  if is_soil_viewer; then
    say "Running and answering on port ${PORT_TAILNET}."
    say ""
    addresses
    say ""
    open_browser
    say "Nothing to do. You can close this window."
    exit 0
  fi
  say "Something is answering on port ${PORT_TAILNET}, but it is not Soil Viewer."
  say ""
  say "Another program has that port. Either stop it, or run Soil Viewer on a different port:"
  say ""
  say "  SOIL_PORT_TAILNET=8866 \"$0\""
  say ""
  exit 1
fi

# 2. Anything to run? The built server is not in git; a fresh clone has nothing here yet.
if [ ! -f "${SERVER}" ]; then
  say "The app has not been built yet, so there is nothing to start."
  say ""
  say "Run this once, then double-click this file again:"
  say ""
  say "  cd \"${APP}\" && npm ci --ignore-scripts --no-offline && npm run build"
  say ""
  exit 1
fi

# 3. Always-on installed? Then restart that rather than starting a second copy by hand.
if [ -f "${PLIST_LIVE}" ]; then
  say "Always-on is installed but the app is not answering. Restarting it."
  TARGET="gui/$(id -u)/${LABEL}"
  if ! launchctl kickstart -k "${TARGET}" 2>/dev/null; then
    launchctl bootstrap "gui/$(id -u)" "${PLIST_LIVE}" 2>/dev/null || true
  fi
  if wait_for_it; then
    say ""
    say "Back up and answering on port ${PORT_TAILNET}."
    addresses
    open_browser
    say ""
    say "You can close this window."
    exit 0
  fi
  crash_report
  exit 1
fi

# 4. No always-on: run it right here. Closing this window stops it, and the script says so.
if ! command -v node > /dev/null 2>&1; then
  say "Node is not on your PATH, so the server cannot start from here."
  say "Install Node 24 or newer, or open a terminal where \`node -v\` works and run: cd app && npm run serve"
  exit 1
fi
say "Starting Soil Viewer in this window."
say ""
say "  Close this window, or press Ctrl-C, to stop it."
say "  To have it run on its own at login instead:  cd app && npm run always-on"
say ""
cd "${APP}" || exit 1
node "${SERVER}" &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null' INT TERM HUP
if wait_for_it; then
  say ""
  say "Running and answering on port ${PORT_TAILNET}."
  say ""
  addresses
  say ""
  open_browser
  wait "${SERVER_PID}"
  exit 0
fi
kill "${SERVER_PID}" 2>/dev/null
say ""
say "It did not start. Whatever it printed above is the reason; the common ones:"
say ""
say "  \"Cannot find module\"     the build is out of date — npm run build"
say "  \"EADDRINUSE\"             something else already has port ${PORT_TAILNET}"
say ""
exit 1
