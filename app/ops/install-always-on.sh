#!/bin/bash
#
# INSTALL ALWAYS-ON — makes Soil Viewer start at login and come back if it ever stops.
#
# Run from app/ as `npm run always-on`, or directly: bash app/ops/install-always-on.sh
#
# What it does:
#   1. Fills in com.soilviewer.server.plist.template with THIS machine's paths — where Node is,
#      where this folder is, where the app keeps its state.
#   2. Writes the result to ~/Library/LaunchAgents/, moving any previous copy aside with a
#      timestamp. Nothing is overwritten and nothing is deleted.
#   3. Tells macOS to load it now and at every login, then waits for the app to answer.
#
# It installs a user LaunchAgent, not a system daemon: it runs as you, only while you are logged
# in, and touches nothing else on the machine. With FileVault on, the app comes back after a reboot
# once you have unlocked the disk — not before. Spec §2.1.
#
# Configuration comes from the environment, the same variables the server reads:
#   SOIL_TAILNET_HOST        your Mac's Tailscale name — set it to reach the app from your phone
#   SOIL_TAILNET_SERVE_PORT  the port `tailscale serve` publishes on (default 443)
#   SOIL_PORT_LOCAL / SOIL_PORT_TAILNET / SOIL_STATE_DIR   as documented in the README
# Leave them unset for this Mac only, on the default ports.

set -eu

APP="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${APP}/ops/com.soilviewer.server.plist.template"
LABEL="${SOIL_LAUNCH_LABEL:-com.soilviewer.server}"
PORT_LOCAL="${SOIL_PORT_LOCAL:-8765}"
PORT_TAILNET="${SOIL_PORT_TAILNET:-8766}"
STATE_DIR="${SOIL_STATE_DIR:-${HOME}/.soil-viewer}"
AGENTS="${HOME}/Library/LaunchAgents"
PLIST="${AGENTS}/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
fail() { say ""; say "STOPPED: $*"; exit 1; }

# 0. What has to be true before anything is written.
[ -f "${TEMPLATE}" ] || fail "the template is missing: ${TEMPLATE}"
[ -f "${APP}/dist-server/main.js" ] || fail "the app has not been built. Run this first:  cd \"${APP}\" && npm run build"
NODE="$(command -v node || true)"
[ -n "${NODE}" ] || fail "Node is not on your PATH. Install Node 24 or newer and try again."
MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "${MAJOR}" -ge 24 ] || fail "Node 24 or newer is required; found $(node -v)."
case "${NODE}" in /*) ;; *) fail "could not resolve an absolute path to node (${NODE})";; esac

mkdir -p "${STATE_DIR}" "${AGENTS}"

# 1. Fill the template. Plain string replacement, so a path containing & or | is fine.
CONTENT="$(cat "${TEMPLATE}")"
TAILNET_BLOCK=""
if [ -n "${SOIL_TAILNET_HOST:-}" ]; then
  TAILNET_BLOCK="    <key>SOIL_TAILNET_HOST</key>
    <string>${SOIL_TAILNET_HOST}</string>
    <key>SOIL_TAILNET_SERVE_PORT</key>
    <string>${SOIL_TAILNET_SERVE_PORT:-443}</string>"
fi
BROWSE_BLOCK=""
if [ -n "${SOIL_BROWSE_HOME:-}" ]; then
  BROWSE_BLOCK="    <key>SOIL_BROWSE_HOME</key>
    <string>${SOIL_BROWSE_HOME}</string>
    <key>SOIL_BROWSE_VOLUMES</key>
    <string>${SOIL_BROWSE_VOLUMES:-${SOIL_BROWSE_HOME}}</string>"
fi
NODE_DIR="$(dirname "${NODE}")"
CONTENT="${CONTENT//__LABEL__/${LABEL}}"
CONTENT="${CONTENT//__NODE__/${NODE}}"
CONTENT="${CONTENT//__APP__/${APP}}"
CONTENT="${CONTENT//__STATE_DIR__/${STATE_DIR}}"
CONTENT="${CONTENT//__PATH__/${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin}"
CONTENT="${CONTENT//__PORT_LOCAL__/${PORT_LOCAL}}"
CONTENT="${CONTENT//__PORT_TAILNET__/${PORT_TAILNET}}"
CONTENT="${CONTENT//__TAILNET_BLOCK__/${TAILNET_BLOCK}}"
CONTENT="${CONTENT//__BROWSE_BLOCK__/${BROWSE_BLOCK}}"
case "${CONTENT}" in *__[A-Z_]*__*) fail "a placeholder was left unfilled — the template and this script disagree";; esac

# 2. Never overwrite a live file: a previous copy is moved aside with a timestamp.
if [ -f "${PLIST}" ]; then
  KEPT="${PLIST}.replaced-$(date +%Y%m%d-%H%M%S)"
  mv "${PLIST}" "${KEPT}"
  say "A previous agent file was moved aside: ${KEPT}"
fi
printf '%s\n' "${CONTENT}" > "${PLIST}"
plutil -lint "${PLIST}" > /dev/null || fail "the rendered agent is not a valid plist: ${PLIST}"

# 3. Load it. An older one still loaded is unloaded first — a kickstart would keep its old environment.
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"

say ""
say "Installed: ${PLIST}"
say "Waiting for the app to answer on port ${PORT_TAILNET}..."
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if /usr/bin/nc -z 127.0.0.1 "${PORT_TAILNET}" 2>/dev/null; then
    say ""
    say "Soil Viewer is running, and will start on its own at every login."
    say ""
    say "  On this Mac:   http://127.0.0.1:${PORT_TAILNET}"
    if [ -n "${SOIL_TAILNET_HOST:-}" ]; then
      say "  On your phone: https://${SOIL_TAILNET_HOST}:${SOIL_TAILNET_SERVE_PORT:-443}"
    fi
    say ""
    say "  Restart it:    npm run always-on:restart"
    say "  Turn it off:   npm run always-on:off"
    say "  Its logs:      ${STATE_DIR}/launchd.out.log and launchd.err.log"
    say ""
    say "With FileVault on, it returns after a reboot once you have unlocked the disk — not before."
    exit 0
  fi
  sleep 1
done
say ""
say "It was installed but is not answering yet. The crash log is ${STATE_DIR}/launchd.err.log;"
say "double-clicking start-soil-viewer.command at the repository root will read it for you."
exit 1
