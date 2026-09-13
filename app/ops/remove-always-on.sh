#!/bin/bash
#
# REMOVE ALWAYS-ON — stops Soil Viewer starting at login. Run as `npm run always-on:off`.
#
# It unloads the agent and moves its file aside with a timestamp — nothing is deleted. Your
# folders, the app's state directory and its logs are untouched, and the app can still be started
# by hand with start-soil-viewer.command or `npm run serve`.

set -eu

LABEL="${SOIL_LAUNCH_LABEL:-com.soilviewer.server}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
say() { printf '%s\n' "$*"; }

if launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null; then
  say "Stopped the agent."
else
  say "The agent was not loaded, so nothing was running under it."
fi
if [ -f "${PLIST}" ]; then
  KEPT="${PLIST}.removed-$(date +%Y%m%d-%H%M%S)"
  mv "${PLIST}" "${KEPT}"
  say "Moved its file aside: ${KEPT}"
else
  say "No agent file to move: ${PLIST}"
fi
say ""
say "Soil Viewer will no longer start on its own. Your files and its state directory are untouched."
