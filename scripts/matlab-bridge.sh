#!/usr/bin/env bash
set -euo pipefail

MATLAB_BIN="${CTI_MATLAB_BIN:-/Applications/MATLAB_R2025b.app/bin/matlab}"

usage() {
  cat <<'USAGE'
Usage:
  matlab-bridge.sh release
  matlab-bridge.sh which
  matlab-bridge.sh run-script /absolute/or/relative/script.m
  matlab-bridge.sh run-function /absolute/or/relative/function_file.m
  matlab-bridge.sh run-test /absolute/or/relative/test_file_or_folder

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

resolve_allowed_target() {
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

run_script() {
  require_matlab
  local script_path="$1"
  local resolved_script escaped_script
  resolved_script="$(resolve_allowed_target "$script_path" m_file)"
  escaped_script="$(escape_for_matlab "$resolved_script")"
  exec "$MATLAB_BIN" -batch "run('$escaped_script');"
}

run_function() {
  require_matlab
  local function_file="$1"
  local resolved_file function_dir function_name escaped_dir escaped_name
  resolved_file="$(resolve_allowed_target "$function_file" m_file)"
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
  resolved_target="$(resolve_allowed_target "$target" file_or_dir)"
  escaped_target="$(escape_for_matlab "$resolved_target")"
  exec "$MATLAB_BIN" -batch "results = runtests('$escaped_target'); disp(results); failures = sum([results.Failed]); assert(failures == 0, 'MATLAB tests failed');"
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
  *)
    usage >&2
    exit 2
    ;;
esac
