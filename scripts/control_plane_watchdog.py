#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(os.environ.get('CTI_BRIDGE_REPO', Path(__file__).resolve().parent.parent))
MONITOR_ROOT = Path(os.environ.get('CTI_WATCHDOG_ROOT', Path.home() / '.openclaw' / 'control-plane-watchdog'))
WINDOW_SECONDS = int(os.environ.get('CTI_WATCHDOG_RECENT_WINDOW_SEC', '900'))
RESTART_COOLDOWN_SECONDS = int(os.environ.get('CTI_WATCHDOG_RESTART_COOLDOWN_SEC', '900'))
LOCK_STALE_SECONDS = int(os.environ.get('CTI_WATCHDOG_LOCK_STALE_SEC', '1800'))
DEFAULT_HOMES = [Path.home() / '.claude-to-im', Path.home() / '.claude-to-im-codex']
HOMES = [Path(p) for p in os.environ.get('CTI_WATCHDOG_HOMES', '').split(',') if p.strip()] or DEFAULT_HOMES
DAEMON_SH = REPO_ROOT / 'scripts' / 'daemon.sh'
STATE_PATH = MONITOR_ROOT / 'state.json'
LATEST_PATH = MONITOR_ROOT / 'latest.json'
HISTORY_PATH = MONITOR_ROOT / 'history.ndjson'
LOCK_DIR = MONITOR_ROOT / 'lock'
TS_RE = re.compile(r'^\[(.*?)\]')
SIGNAL_PATTERNS = {
    'conflict409': re.compile(r'\b409\b'),
    'dropped_group_message': re.compile(r'Dropped group message', re.I),
    'error': re.compile(r'\[ERROR\]|Fatal error|uncaughtException|unhandledRejection', re.I),
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat().replace('+00:00', 'Z')


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def ensure_dirs() -> None:
    MONITOR_ROOT.mkdir(parents=True, exist_ok=True)
    (MONITOR_ROOT / 'logs').mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + '\n')
    tmp.replace(path)


def append_history(payload) -> None:
    with HISTORY_PATH.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + '\n')


def acquire_lock() -> None:
    ensure_dirs()
    if LOCK_DIR.exists():
        age = time.time() - LOCK_DIR.stat().st_mtime
        if age > LOCK_STALE_SECONDS:
            shutil.rmtree(LOCK_DIR, ignore_errors=True)
        else:
            raise RuntimeError(f'watchdog lock already held: {LOCK_DIR}')
    LOCK_DIR.mkdir(parents=True, exist_ok=False)
    (LOCK_DIR / 'pid').write_text(str(os.getpid()))


def release_lock() -> None:
    shutil.rmtree(LOCK_DIR, ignore_errors=True)


def run(cmd: list[str], extra_env: dict[str, str] | None = None, timeout: int = 120) -> dict:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    return {
        'cmd': cmd,
        'code': proc.returncode,
        'stdout': proc.stdout.strip(),
        'stderr': proc.stderr.strip(),
    }


def read_runtime(home: Path) -> str:
    config = home / 'config.env'
    if not config.exists():
        return 'unknown'
    for line in config.read_text(errors='replace').splitlines():
        if line.startswith('CTI_RUNTIME='):
            return line.split('=', 1)[1].strip().strip('"\'') or 'unknown'
    return 'unknown'


def find_matching_pids(home: Path) -> list[int]:
    proc = run(['ps', 'eww', '-axo', 'pid=,command='])
    matches: list[int] = []
    needle = str(REPO_ROOT / 'dist' / 'daemon.mjs')
    home_re = re.compile(rf'CTI_HOME={re.escape(str(home))}(?:\s|$)')
    for line in proc['stdout'].splitlines():
        if needle not in line or not home_re.search(line):
            continue
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        try:
            matches.append(int(parts[0]))
        except ValueError:
            continue
    return matches


def read_status(home: Path) -> dict:
    payload = load_json(home / 'runtime' / 'status.json', {})
    return payload if isinstance(payload, dict) else {}


def scan_recent_signals(home: Path, started_at: datetime | None) -> dict:
    log_path = home / 'logs' / 'bridge.log'
    counts = {key: 0 for key in SIGNAL_PATTERNS}
    recent_lines = {key: [] for key in SIGNAL_PATTERNS}
    if not log_path.exists():
        return {'counts': counts, 'lines': recent_lines}

    threshold = utc_now() - timedelta(seconds=WINDOW_SECONDS)
    if started_at and started_at > threshold:
        threshold = started_at

    for raw in log_path.read_text(errors='replace').splitlines():
        match = TS_RE.match(raw)
        if not match:
            continue
        ts = parse_iso(match.group(1))
        if ts and ts < threshold:
            continue
        for key, pattern in SIGNAL_PATTERNS.items():
            if pattern.search(raw):
                counts[key] += 1
                recent_lines[key].append(raw)

    for key in recent_lines:
        recent_lines[key] = recent_lines[key][-5:]
    return {'counts': counts, 'lines': recent_lines}


def read_state() -> dict:
    payload = load_json(STATE_PATH, {'homes': {}})
    if not isinstance(payload, dict):
        return {'homes': {}}
    payload.setdefault('homes', {})
    return payload


def save_state(state: dict) -> None:
    save_json(STATE_PATH, state)


def can_restart(home: Path, state: dict) -> bool:
    entry = state['homes'].get(str(home), {})
    last = parse_iso(entry.get('lastRestartAt'))
    if not last:
        return True
    return (utc_now() - last).total_seconds() >= RESTART_COOLDOWN_SECONDS


def mark_restart(home: Path, state: dict) -> None:
    entry = state['homes'].setdefault(str(home), {})
    entry['lastRestartAt'] = iso_now()


def restart_home(home: Path, state: dict) -> dict:
    mark_restart(home, state)
    stop_res = run(['bash', str(DAEMON_SH), 'stop'], {'CTI_HOME': str(home)})
    start_res = run(['bash', str(DAEMON_SH), 'start'], {'CTI_HOME': str(home)}, timeout=180)
    time.sleep(2)
    post_status = read_status(home)
    post_pids = find_matching_pids(home)
    return {
        'stop': stop_res,
        'start': start_res,
        'postStatus': post_status,
        'postPids': post_pids,
    }


def inspect_home(home: Path, state: dict) -> dict:
    runtime = read_runtime(home)
    status = read_status(home)
    started_at = parse_iso(status.get('startedAt'))
    pids = find_matching_pids(home)
    recent = scan_recent_signals(home, started_at)

    issues: list[str] = []
    warnings: list[str] = []
    actions: list[dict] = []
    restart_reasons: list[str] = []

    if not home.exists():
        issues.append('missing_home_directory')
    if len(pids) == 0:
        issues.append('process_missing')
        restart_reasons.append('process_missing')
    elif len(pids) > 1:
        issues.append('duplicate_processes')
        restart_reasons.append('duplicate_processes')

    if status.get('running') is not True:
        issues.append('status_not_running')
        if 'status_not_running' not in restart_reasons:
            restart_reasons.append('status_not_running')

    if recent['counts']['conflict409'] > 0:
        issues.append('recent_409_conflict')
        if 'recent_409_conflict' not in restart_reasons:
            restart_reasons.append('recent_409_conflict')

    if recent['counts']['error'] > 0:
        warnings.append('recent_error_lines_detected')

    healed = False
    if restart_reasons:
        if can_restart(home, state):
            action = restart_home(home, state)
            action['type'] = 'restart_home'
            action['reasons'] = restart_reasons
            actions.append(action)
            healed = bool(action['start']['code'] == 0 and action['postStatus'].get('running') is True)
        else:
            actions.append({'type': 'restart_skipped_cooldown', 'reasons': restart_reasons})

    final_status = read_status(home)
    final_pids = find_matching_pids(home)
    healthy = bool(final_status.get('running') is True and len(final_pids) == 1)
    if recent['counts']['conflict409'] > 0:
        healthy = False if not healed else healthy

    return {
        'home': str(home),
        'runtime': runtime,
        'pids': final_pids,
        'status': final_status,
        'recentSignals': recent,
        'issues': sorted(set(issues)),
        'warnings': sorted(set(warnings)),
        'actions': actions,
        'healthy': healthy,
    }


def main() -> int:
    acquire_lock()
    exit_code = 0
    try:
        state = read_state()
        homes = [inspect_home(home, state) for home in HOMES]
        save_state(state)

        overall = {
            'checkedAt': iso_now(),
            'repoRoot': str(REPO_ROOT),
            'monitorRoot': str(MONITOR_ROOT),
            'windowSeconds': WINDOW_SECONDS,
            'restartCooldownSeconds': RESTART_COOLDOWN_SECONDS,
            'homes': homes,
            'overallHealthy': all(item['healthy'] for item in homes),
            'autoHealed': any(action['type'] == 'restart_home' for item in homes for action in item['actions']),
        }
        save_json(LATEST_PATH, overall)
        append_history(overall)
        print(json.dumps(overall, ensure_ascii=True, indent=2))
        if not overall['overallHealthy']:
            exit_code = 1
        return exit_code
    finally:
        release_lock()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as err:
        payload = {
            'checkedAt': iso_now(),
            'overallHealthy': False,
            'fatal': str(err),
        }
        ensure_dirs()
        save_json(LATEST_PATH, payload)
        append_history(payload)
        print(json.dumps(payload, ensure_ascii=True, indent=2))
        raise SystemExit(1)
