#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

DEFAULT_WORKSPACE = pathlib.Path.home() / '.openclaw' / 'workspace'
DEFAULT_RUNTIME_HEALTH_RUNNER = DEFAULT_WORKSPACE / 'scripts' / 'runtime_health_runner.py'
DEFAULT_STATE_PATH = DEFAULT_WORKSPACE / 'runtime' / 'runtime_health_state.json'
DEFAULT_LATEST_REPORT = DEFAULT_WORKSPACE / 'runtime' / 'discord_mention_gate_alert_regression_latest.json'
DEFAULT_ARCHIVE_DIR = DEFAULT_WORKSPACE / 'runtime'


@dataclass
class Delivery:
    channel: str
    target: str
    account: str
    resolved: dict[str, Any]


@dataclass
class SendRecorder:
    real_send: bool
    delegate: Any
    events: list[dict[str, Any]]

    def __call__(self, openclaw_bin: str, *, channel: str, target: str, message: str, account: str | None):
        preview = [line for line in str(message or '').splitlines()[:6]]
        if self.real_send:
            ok, detail = self.delegate(
                openclaw_bin,
                channel=channel,
                target=target,
                message=message,
                account=account,
            )
        else:
            ok, detail = True, 'dry_run_not_sent'
        self.events.append(
            {
                'sentAt': iso_now(),
                'realSend': self.real_send,
                'ok': bool(ok),
                'detail': str(detail or '')[:400],
                'channel': channel,
                'target': target,
                'account': account or '',
                'messagePreview': preview,
            }
        )
        return ok, detail


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def write_json(path: pathlib.Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def import_runtime_health_runner(path: pathlib.Path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location('runtime_health_runner_for_alert_regression', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'failed to load module from {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_json_from_text(text: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    for idx, ch in enumerate(text or ''):
        if ch != '{':
            continue
        try:
            payload, _ = decoder.raw_decode(text[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def make_baseline_state() -> dict[str, Any]:
    return {
        'lastOutcome': 'ok',
        'lastCheckedAt': None,
        'lastIssues': [],
        'consecutiveFailures': 0,
    }


def build_failure_payload() -> dict[str, Any]:
    return {
        'checkedAt': iso_now(),
        'overallHealthy': False,
        'homes': [
            {
                'home': str(pathlib.Path.home() / '.claude-to-im'),
                'runtime': 'gemini',
                'healthy': False,
                'mentionGate': {
                    'has_discord': True,
                    'ok': False,
                    'issues': ['discord_group_policy_not_mention_only'],
                },
            },
            {
                'home': str(pathlib.Path.home() / '.claude-to-im-codex'),
                'runtime': 'codex',
                'healthy': True,
                'mentionGate': {
                    'has_discord': True,
                    'ok': True,
                    'issues': [],
                },
            },
        ],
    }


def build_recovery_payload() -> dict[str, Any]:
    return {
        'checkedAt': iso_now(),
        'overallHealthy': True,
        'homes': [
            {
                'home': str(pathlib.Path.home() / '.claude-to-im'),
                'runtime': 'gemini',
                'healthy': True,
                'mentionGate': {
                    'has_discord': True,
                    'ok': True,
                    'issues': [],
                },
            },
            {
                'home': str(pathlib.Path.home() / '.claude-to-im-codex'),
                'runtime': 'codex',
                'healthy': True,
                'mentionGate': {
                    'has_discord': True,
                    'ok': True,
                    'issues': [],
                },
            },
        ],
    }


def resolve_delivery(module: Any, channel: str, target: str, account: str) -> Delivery:
    resolved = module.resolve_delivery_by_role('system')
    resolved_channel = channel or str(resolved.get('channel', '')).strip() or module.get_channel_by_role('system') or 'telegram'
    resolved_target = target or str(resolved.get('target', '')).strip() or module.get_target_by_role('system') or ''
    resolved_account = account or str(resolved.get('account', '')).strip() or module.get_account_by_role('system') or ''
    if not resolved_target:
        raise RuntimeError('system delivery target is empty; pass --target explicitly')
    return Delivery(
        channel=resolved_channel,
        target=resolved_target,
        account=resolved_account,
        resolved=resolved if isinstance(resolved, dict) else {},
    )


def run_case(module: Any, delivery: Delivery, cp_path: pathlib.Path, max_age_min: int, cooldown_min: int) -> dict[str, Any]:
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    argv = [
        'runtime_health_runner.py',
        '--channel', delivery.channel,
        '--target', delivery.target,
        '--account', delivery.account,
        '--control-plane-watchdog-path', str(cp_path),
        '--control-plane-watchdog-max-age-min', str(max_age_min),
        '--failure-alert-cooldown-min', str(cooldown_min),
    ]
    old_argv = sys.argv[:]
    try:
        sys.argv = argv
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            rc = module.main()
    finally:
        sys.argv = old_argv

    stdout_text = stdout_buffer.getvalue().strip()
    stderr_text = stderr_buffer.getvalue().strip()
    payload = parse_json_from_text(stdout_text)
    return {
        'rc': rc,
        'stdout': stdout_text,
        'stderr': stderr_text,
        'payload': payload,
    }


def evaluate_report(report: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    cases = report.get('cases', {})
    failure_case = cases.get('failure', {})
    recovery_case = cases.get('recovery', {})

    failure_payload = failure_case.get('result', {}).get('payload') or {}
    recovery_payload = recovery_case.get('result', {}).get('payload') or {}

    if failure_case.get('result', {}).get('rc') != 1:
        failures.append('failure_case_did_not_exit_nonzero')
    if 'discord_mention_gate_unhealthy' not in list(failure_payload.get('issues') or []):
        failures.append('failure_case_missing_discord_issue')
    if not list(failure_case.get('sendEvents') or []):
        failures.append('failure_case_missing_alert_event')

    if recovery_case.get('result', {}).get('rc') != 0:
        failures.append('recovery_case_did_not_exit_zero')
    if recovery_payload.get('ok') is not True:
        failures.append('recovery_case_missing_ok_payload')
    if not list(recovery_case.get('sendEvents') or []):
        failures.append('recovery_case_missing_recovery_event')

    return (not failures, failures)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Rollback-safe Discord mention-gate alert regression runner.')
    parser.add_argument('--workspace', default=str(DEFAULT_WORKSPACE))
    parser.add_argument('--runtime-health-runner', default=str(DEFAULT_RUNTIME_HEALTH_RUNNER))
    parser.add_argument('--state-path', default=str(DEFAULT_STATE_PATH))
    parser.add_argument('--channel', default='')
    parser.add_argument('--target', default='')
    parser.add_argument('--account', default='')
    parser.add_argument('--send-real-alerts', action='store_true', help='Actually send Telegram alerts instead of simulating send_alert.')
    parser.add_argument('--control-plane-watchdog-max-age-min', type=int, default=20)
    parser.add_argument('--failure-alert-cooldown-min', type=int, default=120)
    parser.add_argument('--recovery-delay-sec', type=float, default=2.0)
    parser.add_argument('--latest-report', default=str(DEFAULT_LATEST_REPORT))
    parser.add_argument('--archive-dir', default=str(DEFAULT_ARCHIVE_DIR))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = pathlib.Path(args.workspace).expanduser().resolve()
    runner_path = pathlib.Path(args.runtime_health_runner).expanduser().resolve()
    state_path = pathlib.Path(args.state_path).expanduser().resolve()
    latest_report_path = pathlib.Path(args.latest_report).expanduser().resolve()
    archive_dir = pathlib.Path(args.archive_dir).expanduser().resolve()

    started_at = iso_now()
    module = import_runtime_health_runner(runner_path)
    delivery = resolve_delivery(module, args.channel, args.target, args.account)

    original_send_alert = module.send_alert
    send_events: list[dict[str, Any]] = []
    module.send_alert = SendRecorder(args.send_real_alerts, original_send_alert, send_events)

    state_backup = state_path.read_text(encoding='utf-8') if state_path.exists() else None
    restored_state = False

    report: dict[str, Any] = {
        'startedAt': started_at,
        'workspace': str(workspace),
        'runtimeHealthRunner': str(runner_path),
        'statePath': str(state_path),
        'sendRealAlerts': bool(args.send_real_alerts),
        'delivery': {
            'channel': delivery.channel,
            'target': delivery.target,
            'account': delivery.account,
            'resolved': delivery.resolved,
        },
        'cases': {},
    }

    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(state_path, make_baseline_state())

        tempdir = pathlib.Path(tempfile.mkdtemp(prefix='discord-mention-gate-alert-regression-'))
        try:
            failure_cp = tempdir / 'control_plane_failure.json'
            recovery_cp = tempdir / 'control_plane_recovery.json'
            write_json(failure_cp, build_failure_payload())
            write_json(recovery_cp, build_recovery_payload())

            before = len(send_events)
            failure_result = run_case(
                module,
                delivery,
                failure_cp,
                max(5, int(args.control_plane_watchdog_max_age_min)),
                max(5, int(args.failure_alert_cooldown_min)),
            )
            report['cases']['failure'] = {
                'controlPlanePayloadPath': str(failure_cp),
                'result': failure_result,
                'sendEvents': copy.deepcopy(send_events[before:]),
            }

            time.sleep(max(0.0, float(args.recovery_delay_sec)))

            before = len(send_events)
            recovery_result = run_case(
                module,
                delivery,
                recovery_cp,
                max(5, int(args.control_plane_watchdog_max_age_min)),
                max(5, int(args.failure_alert_cooldown_min)),
            )
            report['cases']['recovery'] = {
                'controlPlanePayloadPath': str(recovery_cp),
                'result': recovery_result,
                'sendEvents': copy.deepcopy(send_events[before:]),
            }
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)
    finally:
        module.send_alert = original_send_alert
        if state_backup is None:
            if state_path.exists():
                state_path.unlink()
            restored_state = True
        else:
            state_path.write_text(state_backup, encoding='utf-8')
            restored_state = True

    ok, failures = evaluate_report(report)
    finished_at = iso_now()
    report['finishedAt'] = finished_at
    report['restoredState'] = restored_state
    report['success'] = ok
    report['failures'] = failures
    report['latestReportPath'] = str(latest_report_path)
    archive_name = f"discord_mention_gate_alert_regression_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    archive_path = archive_dir / archive_name
    report['archiveReportPath'] = str(archive_path)

    write_json(latest_report_path, report)
    write_json(archive_path, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
