#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DAEMON = REPO_ROOT / "scripts" / "daemon.sh"
TARGET_KEYS = {
    "CTI_DISCORD_REQUIRE_MENTION": "true",
    "CTI_DISCORD_GROUP_POLICY": "mention_only",
}


@dataclass
class UpdateResult:
    cti_home: str
    enabled_channels: list[str]
    has_discord_token: bool
    changed: bool
    changed_keys: list[str]
    backup: str | None
    restart: dict[str, object] | None
    skipped: str | None


def parse_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def update_env_lines(lines: list[str]) -> tuple[list[str], list[str]]:
    changed_keys: list[str] = []
    seen: set[str] = set()
    updated_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            updated_lines.append(line)
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in TARGET_KEYS:
            updated_lines.append(line)
            continue

        seen.add(key)
        desired = TARGET_KEYS[key]
        if value != desired:
            changed_keys.append(key)
        updated_lines.append(f"{key}={desired}")

    for key, desired in TARGET_KEYS.items():
        if key in seen:
            continue
        changed_keys.append(key)
        updated_lines.append(f"{key}={desired}")

    return updated_lines, changed_keys


def discover_cti_homes() -> list[Path]:
    homes: dict[str, Path] = {}
    for path in discover_launchagent_homes() + discover_filesystem_homes():
        homes[str(path)] = path
    return [homes[key] for key in sorted(homes)]


def discover_filesystem_homes() -> list[Path]:
    home = Path.home()
    homes = sorted(path for path in home.glob(".claude-to-im*") if path.is_dir())
    return [path for path in homes if (path / "config.env").exists()]


def discover_launchagent_homes() -> list[Path]:
    agents_dir = Path.home() / "Library" / "LaunchAgents"
    if not agents_dir.exists():
        return []

    homes: list[Path] = []
    for plist_path in sorted(agents_dir.glob("com.claude-to-im*.plist")):
        try:
            with plist_path.open("rb") as handle:
                payload = plistlib.load(handle)
        except Exception:
            continue
        env = payload.get("EnvironmentVariables") or {}
        cti_home = env.get("CTI_HOME")
        if not cti_home:
            continue
        home = Path(str(cti_home)).expanduser().resolve()
        if (home / "config.env").exists():
            homes.append(home)
    return homes


def restart_bridge(cti_home: Path, daemon_script: Path) -> dict[str, object]:
    commands = []
    for action in ("stop", "start", "status"):
        proc = subprocess.run(
            ["bash", str(daemon_script), action],
            cwd=str(REPO_ROOT),
            env={"CTI_HOME": str(cti_home), **os.environ},
            capture_output=True,
            text=True,
            check=False,
        )
        commands.append(
            {
                "action": action,
                "returncode": proc.returncode,
                "stdout": proc.stdout.strip(),
                "stderr": proc.stderr.strip(),
            }
        )
        if action == "start":
            # Give the bridge a moment to bring the adapters online.
            time.sleep(3)
    return {"commands": commands}


def update_cti_home(cti_home: Path, daemon_script: Path, restart: bool) -> UpdateResult:
    config_path = cti_home / "config.env"
    if not config_path.exists():
        return UpdateResult(
            cti_home=str(cti_home),
            enabled_channels=[],
            has_discord_token=False,
            changed=False,
            changed_keys=[],
            backup=None,
            restart=None,
            skipped="config.env missing",
        )

    env = parse_env(config_path)
    enabled_channels = split_csv(env.get("CTI_ENABLED_CHANNELS"))
    has_discord_token = bool(env.get("CTI_DISCORD_BOT_TOKEN"))
    if "discord" not in enabled_channels or not has_discord_token:
        return UpdateResult(
            cti_home=str(cti_home),
            enabled_channels=enabled_channels,
            has_discord_token=has_discord_token,
            changed=False,
            changed_keys=[],
            backup=None,
            restart=None,
            skipped="discord not enabled for this bot home",
        )

    original_lines = config_path.read_text(encoding="utf-8").splitlines()
    updated_lines, changed_keys = update_env_lines(original_lines)
    changed = bool(changed_keys)
    backup_path: Path | None = None

    if changed:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = config_path.with_name(f"{config_path.name}.bak-{stamp}-discord-mention-gate")
        shutil.copy2(config_path, backup_path)
        config_path.write_text("\n".join(updated_lines).rstrip() + "\n", encoding="utf-8")

    restart_result = restart_bridge(cti_home, daemon_script) if restart else None
    return UpdateResult(
        cti_home=str(cti_home),
        enabled_channels=enabled_channels,
        has_discord_token=has_discord_token,
        changed=changed,
        changed_keys=changed_keys,
        backup=str(backup_path) if backup_path else None,
        restart=restart_result,
        skipped=None,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enforce mention-only routing for Discord-enabled bridge homes."
    )
    parser.add_argument(
        "--cti-home",
        action="append",
        default=[],
        help="Bridge home to update. Repeat for multiple homes. Defaults to ~/.claude-to-im*.",
    )
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Restart the affected bridge(s) after writing config.env.",
    )
    parser.add_argument(
        "--daemon-script",
        default=str(DEFAULT_DAEMON),
        help="Path to daemon.sh for restarts.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    daemon_script = Path(args.daemon_script).expanduser().resolve()
    homes = [Path(item).expanduser().resolve() for item in args.cti_home] or discover_cti_homes()
    if not homes:
        raise SystemExit("no bridge homes found")

    results = [update_cti_home(home, daemon_script, args.restart) for home in homes]
    payload = {
        "ok": True,
        "daemon_script": str(daemon_script),
        "results": [result.__dict__ for result in results],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for result in results:
            print(f"[{result.cti_home}]")
            if result.skipped:
                print(f"  skipped: {result.skipped}")
                continue
            print(f"  changed: {result.changed}")
            if result.changed_keys:
                print(f"  changed_keys: {', '.join(result.changed_keys)}")
            if result.backup:
                print(f"  backup: {result.backup}")
            if result.restart:
                for command in result.restart["commands"]:
                    print(f"  {command['action']}: rc={command['returncode']}")
        print("")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
