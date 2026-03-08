#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
AGENT="${OPENCLAW_TELEGRAM_GATE_AGENT:-main}"
TARGET="${OPENCLAW_TELEGRAM_GATE_TARGET:-8540734140}"
SESSION_PREFIX="${OPENCLAW_TELEGRAM_GATE_SESSION_PREFIX:-tg-gate}"
RECEIVE_MESSAGE="${OPENCLAW_TELEGRAM_GATE_RECEIVE_MESSAGE:-健康检查：只回复 Gate OK，不要调用工具。}"
RECEIVE_EXPECT="${OPENCLAW_TELEGRAM_GATE_RECEIVE_EXPECT:-Gate OK}"
SEND_MESSAGE_DEFAULT_PREFIX="${OPENCLAW_TELEGRAM_GATE_SEND_PREFIX:-[telegram-gate]}"
REPORT_DIR="${OPENCLAW_TELEGRAM_GATE_REPORT_DIR:-runtime}"
SEND_MESSAGE=""
RECEIVE_RETRIES="${OPENCLAW_TELEGRAM_GATE_RECEIVE_RETRIES:-2}"
RECEIVE_RETRY_SLEEP="${OPENCLAW_TELEGRAM_GATE_RECEIVE_RETRY_SLEEP_SEC:-2}"
FALLBACK_AGENTS_CSV="${OPENCLAW_TELEGRAM_GATE_FALLBACK_AGENTS:-ops-worker,link-worker,news-worker}"

usage() {
  cat <<'EOH'
Usage:
  scripts/telegram_regression_gate.sh [options]

Options:
  --target <chat_id>           Telegram target chat/user id (default: 8540734140)
  --agent <agent_id>           OpenClaw agent id (default: main)
  --session-id-prefix <prefix> Session id prefix (default: tg-gate)
  --receive-message <text>     Receive-path probe prompt
  --receive-expect <text>      Substring expected in receive reply (default: Gate OK)
  --send-message <text>        Send-path probe text
  --fallback-agents <csv>      Additional receive fallback agents
  --report-dir <dir>           Report output directory (default: runtime)
  -h, --help                   Show help

Exit code:
  0 = both receive/send gates passed
  1 = gate failed
EOH
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --session-id-prefix) SESSION_PREFIX="$2"; shift 2 ;;
    --receive-message) RECEIVE_MESSAGE="$2"; shift 2 ;;
    --receive-expect) RECEIVE_EXPECT="$2"; shift 2 ;;
    --send-message) SEND_MESSAGE="$2"; shift 2 ;;
    --fallback-agents) FALLBACK_AGENTS_CSV="$2"; shift 2 ;;
    --report-dir) REPORT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[telegram-gate] unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  echo "[telegram-gate] missing binary: $OPENCLAW_BIN" >&2
  exit 1
fi

if [[ -z "$SEND_MESSAGE" ]]; then
  SEND_MESSAGE="${SEND_MESSAGE_DEFAULT_PREFIX} send-path probe $(date '+%Y-%m-%d %H:%M:%S %z')"
fi

mkdir -p "$REPORT_DIR"
ts_compact="$(date '+%Y%m%dT%H%M%S')"
recv_log="$(mktemp)"
send_log="$(mktemp)"
recv_json_file="$(mktemp)"
send_json_file="$(mktemp)"
report_path="${REPORT_DIR}/telegram_regression_gate_${ts_compact}.md"

cleanup() {
  rm -f "$recv_log" "$send_log" "$recv_json_file" "$send_json_file"
}
trap cleanup EXIT

parse_agent_json() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
raw = path.read_text(encoding='utf-8', errors='replace')
obj = None
for m in reversed(list(re.finditer(r"(?m)^\{", raw))):
    snippet = raw[m.start():].strip()
    try:
        obj = json.loads(snippet)
        break
    except Exception:
        continue
if obj is None:
    print('NO_JSON')
    sys.exit(2)
payloads = obj.get('payloads', []) if isinstance(obj, dict) else []
meta = obj.get('meta', {}) if isinstance(obj, dict) else {}
agent_meta = meta.get('agentMeta', {}) if isinstance(meta, dict) else {}
texts = []
if isinstance(payloads, list):
    for p in payloads:
        if isinstance(p, dict):
            t = p.get('text')
            if isinstance(t, str) and t.strip():
                texts.append(t.strip())
reply_text = "\n".join(texts).strip()
print(json.dumps({
    'ok': bool(reply_text and not bool(meta.get('aborted'))),
    'aborted': bool(meta.get('aborted')),
    'text_size': len(reply_text),
    'reply_text': reply_text,
    'provider': str(agent_meta.get('provider', '')),
    'model': str(agent_meta.get('model', '')),
    'sessionId': str(agent_meta.get('sessionId', '')),
}, ensure_ascii=False))
PY
}

parse_send_json() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
raw = path.read_text(encoding='utf-8', errors='replace')
obj = None
for m in reversed(list(re.finditer(r"(?m)^\{", raw))):
    snippet = raw[m.start():].strip()
    try:
        obj = json.loads(snippet)
        break
    except Exception:
        continue
if obj is None:
    print('NO_JSON')
    sys.exit(2)
payload = obj.get('payload', {}) if isinstance(obj, dict) else {}
print(json.dumps({
    'ok': bool(payload.get('ok')),
    'messageId': str(payload.get('messageId', '')),
    'chatId': str(payload.get('chatId', '')),
}, ensure_ascii=False))
PY
}

json_get_file() {
  python3 - "$1" "$2" <<'PY'
import json, pathlib, sys
obj = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
value = obj.get(sys.argv[2], '')
print(value)
PY
}

escape_md_fence() {
  sed -n "$1" "$2"
}

recv_rc=1
recv_json="NO_JSON"
recv_ok="false"
recv_reply_text=""
recv_provider=""
recv_model=""
recv_runtime_session=""
recv_text_size="0"
recv_attempts=0
session_id=""
receive_agent_used=""

candidate_agents=()
candidate_agents+=("$AGENT")
IFS=',' read -r -a fallback_agents <<< "$FALLBACK_AGENTS_CSV"
for candidate in "${fallback_agents[@]}"; do
  candidate="${candidate// /}"
  [[ -z "$candidate" ]] && continue
  if [[ "$candidate" == "$AGENT" ]]; then
    continue
  fi
  candidate_agents+=("$candidate")
done

for candidate_agent in "${candidate_agents[@]}"; do
  for attempt in $(seq 1 "$RECEIVE_RETRIES"); do
    recv_attempts="$attempt"
    receive_agent_used="$candidate_agent"
    session_id="${SESSION_PREFIX}-${ts_compact}-${candidate_agent}-a${attempt}-$$"
    echo "[telegram-gate] receive probe -> agent=$candidate_agent session=$session_id target=$TARGET attempt=$attempt"
    set +e
    OPENAI_LOG=debug "$OPENCLAW_BIN" agent --local --channel telegram --session-id "$session_id" --agent "$candidate_agent" --message "$RECEIVE_MESSAGE" --json >"$recv_log" 2>&1
    recv_rc=$?
    set -e

    recv_json="$(parse_agent_json "$recv_log" || true)"
    if [[ "$recv_json" != "NO_JSON" ]]; then
      printf '%s' "$recv_json" > "$recv_json_file"
      recv_ok="$(json_get_file "$recv_json_file" ok)"
      recv_reply_text="$(json_get_file "$recv_json_file" reply_text)"
      recv_provider="$(json_get_file "$recv_json_file" provider)"
      recv_model="$(json_get_file "$recv_json_file" model)"
      recv_runtime_session="$(json_get_file "$recv_json_file" sessionId)"
      recv_text_size="$(json_get_file "$recv_json_file" text_size)"
    else
      recv_ok="false"
      recv_reply_text=""
      recv_provider=""
      recv_model=""
      recv_runtime_session=""
      recv_text_size="0"
    fi

    if [[ "$recv_rc" -eq 0 && "$recv_ok" == "True" ]]; then
      recv_ok="true"
    fi
    if [[ "$recv_ok" == "true" && "$recv_reply_text" == *"$RECEIVE_EXPECT"* ]]; then
      break 2
    fi

    if rg -q "session file locked|Invalid config|Config invalid|timed out|timeout" "$recv_log"; then
      if [[ "$attempt" -lt "$RECEIVE_RETRIES" ]]; then
        sleep "$RECEIVE_RETRY_SLEEP"
        continue
      fi
      break
    fi
    break
  done
done

recv_expect_ok="false"
if [[ "$recv_ok" == "true" && "$recv_reply_text" == *"$RECEIVE_EXPECT"* ]]; then
  recv_expect_ok="true"
fi

echo "[telegram-gate] send probe -> target=$TARGET"
set +e
"$OPENCLAW_BIN" message send --channel telegram --target "$TARGET" --message "$SEND_MESSAGE" --json >"$send_log" 2>&1
send_rc=$?
set -e

send_json="$(parse_send_json "$send_log" || true)"
send_ok="false"
send_message_id=""
send_chat_id=""
if [[ "$send_json" != "NO_JSON" ]]; then
  printf '%s' "$send_json" > "$send_json_file"
  send_ok="$(json_get_file "$send_json_file" ok)"
  send_message_id="$(json_get_file "$send_json_file" messageId)"
  send_chat_id="$(json_get_file "$send_json_file" chatId)"
  [[ "$send_ok" == "True" ]] && send_ok="true"
fi

overall_ok="true"
if [[ "$recv_rc" -ne 0 || "$recv_ok" != "true" || "$recv_expect_ok" != "true" ]]; then overall_ok="false"; fi
if [[ "$send_rc" -ne 0 || "$send_ok" != "true" ]]; then overall_ok="false"; fi

{
  echo "# Telegram Regression Gate Report"
  echo
  echo "- Time: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "- Session ID: $session_id"
  echo "- Agent: $AGENT"
  echo "- Receive agent used: $receive_agent_used"
  echo "- Target: $TARGET"
  echo "- Overall: $overall_ok"
  echo
  echo "## Receive Gate"
  echo "- Command: OPENAI_LOG=debug $OPENCLAW_BIN agent --local --channel telegram --session-id $session_id --agent $receive_agent_used --message \"$RECEIVE_MESSAGE\" --json"
  echo "- Attempts: $recv_attempts"
  echo "- Exit code: $recv_rc"
  echo "- Parsed ok: $recv_ok"
  echo "- Expected substring: $RECEIVE_EXPECT"
  echo "- Expected matched: $recv_expect_ok"
  echo "- Provider/Model: $recv_provider / $recv_model"
  echo "- Runtime session: $recv_runtime_session"
  echo "- Reply text size: $recv_text_size"
  echo "- Reply text: $recv_reply_text"
  echo
  echo "## Send Gate"
  echo "- Command: $OPENCLAW_BIN message send --channel telegram --target $TARGET --message \"$SEND_MESSAGE\" --json"
  echo "- Exit code: $send_rc"
  echo "- Parsed ok: $send_ok"
  echo "- messageId/chatId: $send_message_id / $send_chat_id"
  echo
  echo "## Raw Output Snippet (Receive)"
  echo '```'
  escape_md_fence '1,120p' "$recv_log"
  echo '```'
  echo
  echo "## Raw Output Snippet (Send)"
  echo '```'
  escape_md_fence '1,80p' "$send_log"
  echo '```'
} > "$report_path"

echo "[telegram-gate] report: $report_path"
if [[ "$overall_ok" != "true" ]]; then
  echo "[telegram-gate] FAILED" >&2
  exit 1
fi

echo "[telegram-gate] PASSED (agent=$receive_agent_used, messageId=$send_message_id, provider=$recv_provider, model=$recv_model)"
