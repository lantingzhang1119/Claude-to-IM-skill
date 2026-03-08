#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG_PY="$SKILL_DIR/scripts/control_plane_watchdog.py"
WATCHDOG_ROOT="${CTI_WATCHDOG_ROOT:-$HOME/.openclaw/control-plane-watchdog}"
PLIST_LABEL="com.claude-to-im.control-plane-watchdog"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$PLIST_LABEL.plist"
PYTHON_BIN="$(command -v python3)"
START_INTERVAL="${CTI_WATCHDOG_START_INTERVAL:-300}"
LOG_FILE="$WATCHDOG_ROOT/logs/watchdog.log"
LATEST_FILE="$WATCHDOG_ROOT/latest.json"

ensure_dirs() {
  mkdir -p "$WATCHDOG_ROOT/logs" "$PLIST_DIR"
}

generate_plist() {
  ensure_dirs
  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON_BIN}</string>
        <string>${WATCHDOG_PY}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>${PATH}</string>
        <key>USER</key>
        <string>${USER}</string>
        <key>SHELL</key>
        <string>${SHELL:-/bin/zsh}</string>
        <key>LANG</key>
        <string>${LANG:-C.UTF-8}</string>
        <key>CTI_BRIDGE_REPO</key>
        <string>${SKILL_DIR}</string>
        <key>CTI_WATCHDOG_ROOT</key>
        <string>${WATCHDOG_ROOT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${START_INTERVAL}</integer>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST
}

launchd_status() {
  launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
}

case "${1:-help}" in
  run-now)
    ensure_dirs
    exec "$PYTHON_BIN" "$WATCHDOG_PY"
    ;;
  install)
    ensure_dirs
    generate_plist
    launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
    launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"
    echo "Installed watchdog: $PLIST_LABEL"
    echo "Plist: $PLIST_FILE"
    [ -f "$LATEST_FILE" ] && cat "$LATEST_FILE"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    echo "Removed watchdog: $PLIST_LABEL"
    ;;
  status)
    if [ -f "$PLIST_FILE" ]; then
      echo "Plist: $PLIST_FILE"
    else
      echo "Plist not installed"
    fi
    launchd_status
    if [ -f "$LATEST_FILE" ]; then
      echo "--- latest ---"
      cat "$LATEST_FILE"
    fi
    ;;
  logs)
    tail -n "${2:-80}" "$LOG_FILE" 2>/dev/null || true
    ;;
  help|*)
    echo "Usage: control_plane_watchdog.sh {install|uninstall|status|run-now|logs [N]}"
    ;;
esac
