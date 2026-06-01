#!/usr/bin/env bash
# Control the always-on animayte dashboard (launchd agent com.animayte.dashboard).
#   ./grid/_dashboard-ctl.sh {start|stop|restart|status|open|uninstall}
set -euo pipefail
LABEL="com.animayte.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
URL="http://localhost:4380/grid/dashboard.html"

case "${1:-status}" in
  start)
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
    launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "started → $URL" ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    echo "stopped" ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || { "$0" stop; "$0" start; }
    echo "restarted" ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|program =" || echo "not loaded"
    echo "health: $(curl -s --max-time 2 http://localhost:4380/__health || echo DOWN)" ;;
  open)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ -x "$CHROME" ]; then "$CHROME" --app="$URL" >/dev/null 2>&1 & else open "$URL"; fi
    echo "opened $URL" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled (agent removed; worktree files untouched)" ;;
  *) echo "usage: $0 {start|stop|restart|status|open|uninstall}"; exit 1 ;;
esac
