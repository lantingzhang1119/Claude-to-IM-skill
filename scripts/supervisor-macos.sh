#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

DEFAULT_LAUNCHD_LABEL="com.claude-to-im.bridge"
DEFAULT_CTI_HOME="$HOME/.claude-to-im"

slugify_label_suffix() {
  local raw="$1"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

if [ -n "${CTI_BRIDGE_LABEL:-}" ]; then
  LAUNCHD_LABEL="$CTI_BRIDGE_LABEL"
elif [ "$CTI_HOME" = "$DEFAULT_CTI_HOME" ]; then
  LAUNCHD_LABEL="$DEFAULT_LAUNCHD_LABEL"
else
  CTI_INSTANCE_SUFFIX="$(slugify_label_suffix "$(basename "$CTI_HOME")")"
  [ -n "$CTI_INSTANCE_SUFFIX" ] || CTI_INSTANCE_SUFFIX="custom"
  LAUNCHD_LABEL="$DEFAULT_LAUNCHD_LABEL.$CTI_INSTANCE_SUFFIX"
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

list_matching_bridge_pids() {
  local daemon_path="$SKILL_DIR/dist/daemon.mjs"
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    ps eww -p "$pid" -o command= 2>/dev/null | grep -F "CTI_HOME=$CTI_HOME" >/dev/null || continue
    printf '%s\n' "$pid"
  done < <(pgrep -f "$daemon_path" 2>/dev/null || true)
}

kill_matching_bridge_pids() {
  local pids pid
  pids="$(list_matching_bridge_pids | tr '\n' ' ')"
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done

  sleep 1

  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

# ── launchd helpers ──

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""

  # Always forward basics
  for var in HOME PATH USER SHELL LANG TMPDIR; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  # Forward CTI_* vars
  while IFS='=' read -r name val; do
    case "$name" in CTI_*)
      dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
      ;; esac
  done < <(env)

  # Forward runtime-specific API keys
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  case "$runtime" in
    codex|auto)
      for var in OPENAI_API_KEY CODEX_API_KEY CTI_CODEX_API_KEY CTI_CODEX_BASE_URL; do
        local val="${!var:-}"
        [ -z "$val" ] && continue
        dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
      done
      ;;
  esac
  case "$runtime" in
    claude|auto)
      if [ "${CTI_ANTHROPIC_PASSTHROUGH:-}" = "true" ]; then
        for var in ANTHROPIC_API_KEY ANTHROPIC_BASE_URL; do
          local val="${!var:-}"
          [ -z "$val" ] && continue
          dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
        done
      fi
      ;;
  esac

  echo -e "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  kill_matching_bridge_pids
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  kill_matching_bridge_pids
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
