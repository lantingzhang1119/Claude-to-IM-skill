#!/usr/bin/env bash
set -euo pipefail

MATLAB_BIN="${CTI_MATLAB_BIN:-/Applications/MATLAB_R2025b.app/bin/matlab}"
ALLOWED_ROOTS_RAW="${CTI_MATLAB_ALLOWED_ROOTS:-$PWD}"

usage() {
  cat <<'USAGE'
Usage:
  matlab-bridge.sh release
  matlab-bridge.sh which
  matlab-bridge.sh batch-file /absolute/or/relative/script.m
USAGE
}

require_matlab() {
  if [ ! -x "$MATLAB_BIN" ]; then
    echo "ERROR: MATLAB binary not executable: $MATLAB_BIN" >&2
    exit 1
  fi
}

resolve_allowed_script() {
  python3 - "$1" <<'PY'
import os
import pathlib
import sys

script_arg = sys.argv[1]
script_path = pathlib.Path(script_arg).expanduser()
if not script_path.exists():
    print(f"ERROR: script does not exist: {script_path}", file=sys.stderr)
    sys.exit(2)
if script_path.suffix.lower() != '.m':
    print(f"ERROR: script must end with .m: {script_path}", file=sys.stderr)
    sys.exit(2)

resolved_script = script_path.resolve()
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

if not any(within(resolved_script, root) or resolved_script == root for root in resolved_roots):
    allowed = ', '.join(str(root) for root in resolved_roots)
    print(f"ERROR: script path is outside allowed roots: {resolved_script} (allowed: {allowed})", file=sys.stderr)
    sys.exit(2)

print(resolved_script)
PY
}

escape_for_matlab() {
  python3 - "$1" <<'PY'
import sys
print(sys.argv[1].replace("'", "''"))
PY
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
  batch-file)
    require_matlab
    script_path="${2:-}"
    if [ -z "$script_path" ]; then
      usage >&2
      exit 2
    fi
    resolved_script="$(resolve_allowed_script "$script_path")"
    escaped_script="$(escape_for_matlab "$resolved_script")"
    exec "$MATLAB_BIN" -batch "run('$escaped_script');"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
