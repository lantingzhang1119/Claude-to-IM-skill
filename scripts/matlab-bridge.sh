#!/usr/bin/env bash
set -euo pipefail

MATLAB_BIN="${CTI_MATLAB_BIN:-/Applications/MATLAB_R2025b.app/bin/matlab}"
BRIDGE_SELF="${BASH_SOURCE[0]:-$0}"

usage() {
  cat <<'USAGE'
Usage:
  matlab-bridge.sh release
  matlab-bridge.sh which
  matlab-bridge.sh run-script /absolute/or/relative/script.m
  matlab-bridge.sh run-function /absolute/or/relative/function_file.m
  matlab-bridge.sh run-test /absolute/or/relative/test_file_or_folder
  matlab-bridge.sh run-suite /absolute/or/relative/test_file_or_folder [artifact_dir]
  matlab-bridge.sh collect-artifacts /absolute/or/relative/path
  matlab-bridge.sh save-log /absolute/or/relative/log_file -- <bridge-subcommand> [args...]

Aliases:
  matlab-bridge.sh batch-file /path/to/script.m
USAGE
}

require_matlab() {
  if [ ! -x "$MATLAB_BIN" ]; then
    echo "ERROR: MATLAB binary not executable: $MATLAB_BIN" >&2
    exit 1
  fi
}

resolve_allowed_existing_target() {
  python3 - "$1" "$2" <<'PY'
import os
import pathlib
import sys

raw_target = sys.argv[1]
mode = sys.argv[2]
target = pathlib.Path(raw_target).expanduser()
if not target.exists():
    print(f"ERROR: target does not exist: {target}", file=sys.stderr)
    sys.exit(2)

resolved = target.resolve()
raw_roots = os.environ.get('CTI_MATLAB_ALLOWED_ROOTS', os.getcwd())
roots = []
for chunk in raw_roots.splitlines():
    roots.extend(part.strip() for part in chunk.split(',') if part.strip())
if not roots:
    roots = [os.getcwd()]
resolved_roots = [pathlib.Path(root).expanduser().resolve() for root in roots]


def within(child: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False

if not any(within(resolved, root) or resolved == root for root in resolved_roots):
    allowed = ', '.join(str(root) for root in resolved_roots)
    print(f"ERROR: target is outside allowed roots: {resolved} (allowed: {allowed})", file=sys.stderr)
    sys.exit(2)

if mode == 'm_file':
    if resolved.suffix.lower() != '.m':
        print(f"ERROR: target must end with .m: {resolved}", file=sys.stderr)
        sys.exit(2)
    if not resolved.is_file():
        print(f"ERROR: target must be a file: {resolved}", file=sys.stderr)
        sys.exit(2)
elif mode == 'file_or_dir':
    if not (resolved.is_file() or resolved.is_dir()):
        print(f"ERROR: target must be a file or directory: {resolved}", file=sys.stderr)
        sys.exit(2)
else:
    print(f"ERROR: unsupported validation mode: {mode}", file=sys.stderr)
    sys.exit(2)

print(resolved)
PY
}

resolve_allowed_future_path() {
  python3 - "$1" "$2" <<'PY'
import os
import pathlib
import sys

raw_target = sys.argv[1]
mode = sys.argv[2]
target = pathlib.Path(raw_target).expanduser()

raw_roots = os.environ.get('CTI_MATLAB_ALLOWED_ROOTS', os.getcwd())
roots = []
for chunk in raw_roots.splitlines():
    roots.extend(part.strip() for part in chunk.split(',') if part.strip())
if not roots:
    roots = [os.getcwd()]
resolved_roots = [pathlib.Path(root).expanduser().resolve() for root in roots]


def within(child: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_with_missing(path: pathlib.Path) -> pathlib.Path:
    path = path if path.is_absolute() else pathlib.Path.cwd() / path
    missing = []
    probe = path
    while not probe.exists():
        missing.append(probe.name)
        parent = probe.parent
        if parent == probe:
            break
        probe = parent
    if not probe.exists():
        print(f"ERROR: cannot resolve target path: {path}", file=sys.stderr)
        sys.exit(2)
    resolved = probe.resolve()
    for part in reversed(missing):
        resolved = resolved / part
    return resolved

resolved = resolve_with_missing(target)
base = resolved if resolved.exists() else resolved.parent
if not any(within(base, root) or base == root for root in resolved_roots):
    allowed = ', '.join(str(root) for root in resolved_roots)
    print(f"ERROR: target is outside allowed roots: {resolved} (allowed: {allowed})", file=sys.stderr)
    sys.exit(2)

if mode == 'log_file':
    if resolved.suffix.lower() not in {'.log', '.txt', '.json', '.md'}:
        print(f"ERROR: log file must end with .log, .txt, .json, or .md: {resolved}", file=sys.stderr)
        sys.exit(2)
elif mode == 'artifact_dir':
    pass
else:
    print(f"ERROR: unsupported validation mode: {mode}", file=sys.stderr)
    sys.exit(2)

print(resolved)
PY
}

escape_for_matlab() {
  python3 - "$1" <<'PY'
import sys
print(sys.argv[1].replace("'", "''"))
PY
}

validate_function_name() {
  python3 - "$1" <<'PY'
import pathlib
import re
import sys

name = pathlib.Path(sys.argv[1]).stem
if not re.fullmatch(r'[A-Za-z]\w*', name):
    print(f"ERROR: function file name is not a simple MATLAB identifier: {name}", file=sys.stderr)
    sys.exit(2)
print(name)
PY
}

collect_artifacts() {
  local target="$1"
  local resolved_target
  resolved_target="$(resolve_allowed_existing_target "$target" file_or_dir)"

  python3 - "$resolved_target" <<'PY'
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

root = pathlib.Path(sys.argv[1])
limit = int(os.environ.get('CTI_MATLAB_ARTIFACT_LIMIT', '50'))
artifact_exts = {
    '.mat', '.fig', '.png', '.jpg', '.jpeg', '.svg', '.pdf', '.txt', '.log',
    '.json', '.xml', '.csv', '.md', '.mlx'
}

items = []
if root.is_file():
    candidates = [root]
else:
    candidates = []
    for path in root.rglob('*'):
        if path.is_file() and path.suffix.lower() in artifact_exts:
            candidates.append(path)

for path in candidates:
    stat = path.stat()
    base = root.parent if root.is_file() else root
    try:
        rel = path.relative_to(base)
    except ValueError:
        rel = path.name
    items.append({
        'path': str(path),
        'relative_path': str(rel),
        'size_bytes': stat.st_size,
        'modified_at': datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    })

items.sort(key=lambda item: item['modified_at'], reverse=True)
items = items[:limit]
print(json.dumps({
    'root': str(root),
    'count': len(items),
    'artifacts': items,
}, ensure_ascii=False, indent=2))
PY
}

run_script() {
  require_matlab
  local script_path="$1"
  local resolved_script escaped_script
  resolved_script="$(resolve_allowed_existing_target "$script_path" m_file)"
  escaped_script="$(escape_for_matlab "$resolved_script")"
  exec "$MATLAB_BIN" -batch "run('$escaped_script');"
}

run_function() {
  require_matlab
  local function_file="$1"
  local resolved_file function_dir function_name escaped_dir escaped_name
  resolved_file="$(resolve_allowed_existing_target "$function_file" m_file)"
  function_dir="$(dirname "$resolved_file")"
  function_name="$(validate_function_name "$resolved_file")"
  escaped_dir="$(escape_for_matlab "$function_dir")"
  escaped_name="$(escape_for_matlab "$function_name")"
  exec "$MATLAB_BIN" -batch "cd('$escaped_dir'); feval('$escaped_name');"
}

run_test() {
  require_matlab
  local target="$1"
  local resolved_target escaped_target
  resolved_target="$(resolve_allowed_existing_target "$target" file_or_dir)"
  escaped_target="$(escape_for_matlab "$resolved_target")"
  exec "$MATLAB_BIN" -batch "results = runtests('$escaped_target'); disp(results); failures = sum([results.Failed]); assert(failures == 0, 'MATLAB tests failed');"
}

run_suite() {
  require_matlab
  local target="$1"
  local artifact_dir="${2:-}"
  local resolved_target escaped_target matlab_cmd
  resolved_target="$(resolve_allowed_existing_target "$target" file_or_dir)"
  escaped_target="$(escape_for_matlab "$resolved_target")"

  matlab_cmd="target = '$escaped_target'; results = runtests(target); total = numel(results); failed = sum([results.Failed]); incomplete = sum([results.Incomplete]); passed = total - failed - incomplete; durationSeconds = sum(seconds([results.Duration])); summary = struct('target', target, 'total', total, 'passed', passed, 'failed', failed, 'incomplete', incomplete, 'duration_seconds', durationSeconds); disp(jsonencode(summary)); mask = [results.Failed] | [results.Incomplete]; if any(mask); failedNames = string({results(mask).Name}); disp('FAILED_TESTS_BEGIN'); for idx = 1:numel(failedNames); disp(failedNames(idx)); end; disp('FAILED_TESTS_END'); end;"

  if [ -n "$artifact_dir" ]; then
    local resolved_artifact_dir escaped_artifact_dir
    resolved_artifact_dir="$(resolve_allowed_future_path "$artifact_dir" artifact_dir)"
    escaped_artifact_dir="$(escape_for_matlab "$resolved_artifact_dir")"
    matlab_cmd+=" artifactDir = '$escaped_artifact_dir'; if ~exist(artifactDir, 'dir'); mkdir(artifactDir); end; resultText = evalc('disp(results)'); fid = fopen(fullfile(artifactDir, 'matlab_suite_results.txt'), 'w'); fprintf(fid, '%s', resultText); fclose(fid); fid = fopen(fullfile(artifactDir, 'matlab_suite_summary.json'), 'w'); fprintf(fid, '%s', jsonencode(summary)); fclose(fid); if any(mask); failedNames = string({results(mask).Name}); fid = fopen(fullfile(artifactDir, 'matlab_suite_failures.txt'), 'w'); for idx = 1:numel(failedNames); fprintf(fid, '%s\\n', failedNames(idx)); end; fclose(fid); end;"
  fi

  matlab_cmd+=" assert(failed == 0 && incomplete == 0, 'MATLAB suite failed');"
  exec "$MATLAB_BIN" -batch "$matlab_cmd"
}

save_log() {
  local log_path="$1"
  shift
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  if [ "$#" -eq 0 ]; then
    usage >&2
    exit 2
  fi

  local resolved_log
  resolved_log="$(resolve_allowed_future_path "$log_path" log_file)"
  mkdir -p "$(dirname "$resolved_log")"

  set +e
  "$BRIDGE_SELF" "$@" 2>&1 | tee "$resolved_log"
  local status=${PIPESTATUS[0]}
  set -e
  exit "$status"
}

command="${1:-}"
case "$command" in
  release)
    require_matlab
    exec "$MATLAB_BIN" -batch "disp(version('-release'));"
    ;;
  which)
    printf '%s\n' "$MATLAB_BIN"
    ;;
  run-script)
    script_path="${2:-}"
    if [ -z "$script_path" ]; then
      usage >&2
      exit 2
    fi
    run_script "$script_path"
    ;;
  batch-file)
    script_path="${2:-}"
    if [ -z "$script_path" ]; then
      usage >&2
      exit 2
    fi
    run_script "$script_path"
    ;;
  run-function)
    function_file="${2:-}"
    if [ -z "$function_file" ]; then
      usage >&2
      exit 2
    fi
    run_function "$function_file"
    ;;
  run-test)
    test_target="${2:-}"
    if [ -z "$test_target" ]; then
      usage >&2
      exit 2
    fi
    run_test "$test_target"
    ;;
  run-suite)
    suite_target="${2:-}"
    artifact_dir="${3:-}"
    if [ -z "$suite_target" ]; then
      usage >&2
      exit 2
    fi
    run_suite "$suite_target" "$artifact_dir"
    ;;
  collect-artifacts)
    artifact_target="${2:-}"
    if [ -z "$artifact_target" ]; then
      usage >&2
      exit 2
    fi
    collect_artifacts "$artifact_target"
    ;;
  save-log)
    log_path="${2:-}"
    if [ -z "$log_path" ]; then
      usage >&2
      exit 2
    fi
    shift 2
    save_log "$log_path" "$@"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
