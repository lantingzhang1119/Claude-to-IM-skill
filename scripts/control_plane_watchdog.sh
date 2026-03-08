#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG_PY="$SKILL_DIR/scripts/control_plane_watchdog.py"
WATCHDOG_ROOT="${CTI_WATCHDOG_ROOT:-$HOME/.openclaw/control-plane-watchdog}"
WATCHDOG_ENV="$WATCHDOG_ROOT/watchdog.env"
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

ensure_watchdog_env() {
  ensure_dirs
  if [[ -f "$WATCHDOG_ENV" ]]; then
    return 0
  fi
  cat > "$WATCHDOG_ENV" <<EOF_ENV
# Control Plane Watchdog runtime config
# Edit this file to add future bot homes without changing launchd.

CTI_WATCHDOG_HOMES=$HOME/.claude-to-im,$HOME/.claude-to-im-codex
CTI_WATCHDOG_RECENT_WINDOW_SEC=900
CTI_WATCHDOG_RESTART_COOLDOWN_SEC=900
CTI_WATCHDOG_LOCK_STALE_SEC=1800

# Future bot homes example:
# CTI_WATCHDOG_HOMES=$HOME/.claude-to-im,$HOME/.claude-to-im-codex,$HOME/.claude-to-im-claude,$HOME/.claude-to-im-grok
EOF_ENV
}

generate_plist() {
  ensure_dirs
  ensure_watchdog_env
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
    ensure_watchdog_env
    exec "$PYTHON_BIN" "$WATCHDOG_PY"
    ;;
  install)
    ensure_dirs
    ensure_watchdog_env
    generate_plist
    launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
    launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"
    echo "Installed watchdog: $PLIST_LABEL"
    echo "Plist: $PLIST_FILE"
    echo "Config: $WATCHDOG_ENV"
    [ -f "$LATEST_FILE" ] && cat "$LATEST_FILE"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    echo "Removed watchdog: $PLIST_LABEL"
    ;;
  status)
    if [[ -f "$PLIST_FILE" ]]; then
      echo "Plist: $PLIST_FILE"
    else
      echo "Plist not installed"
    fi
    echo "Config: $WATCHDOG_ENV"
    if [[ -f "$WATCHDOG_ENV" ]]; then
      echo "--- config ---"
      cat "$WATCHDOG_ENV"
    fi
    launchd_status
    if [[ -f "$LATEST_FILE" ]]; then
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
