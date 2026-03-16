#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SEC="21600"
REAL_SEND="0"
LABEL="com.zhichaorong.openclaw.discord-mention-gate-alert-regression"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.openclaw/logs"
SCRIPT_PATH="$REPO_ROOT/scripts/run_discord_mention_gate_alert_regression.py"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--interval-sec N] [--send-real-alerts]

Installs a launchd agent for Discord mention-gate alert regression.
Default mode is dry-run (no Telegram messages are sent).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval-sec)
      INTERVAL_SEC="${2:?missing value for --interval-sec}"
      shift 2
      ;;
    --send-real-alerts)
      REAL_SEND="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$LOG_DIR"

ARGS=$(cat <<EOF
    <string>/usr/bin/env</string>
    <string>python3</string>
    <string>$SCRIPT_PATH</string>
EOF
)

if [[ "$REAL_SEND" == "1" ]]; then
  ARGS+=$'\n    <string>--send-real-alerts</string>'
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${ARGS}
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/discord-mention-gate-alert-regression.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/discord-mention-gate-alert-regression.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "installed: $PLIST"
echo "interval_sec=${INTERVAL_SEC}"
echo "real_send=${REAL_SEND}"
