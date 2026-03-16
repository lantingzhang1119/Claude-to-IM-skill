#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import plistlib
from pathlib import Path

from ensure_discord_mention_gate import discover_cti_homes, parse_env, split_csv


def parse_launchagents() -> dict[str, list[dict[str, str]]]:
    agents_dir = Path.home() / "Library" / "LaunchAgents"
    results: dict[str, list[dict[str, str]]] = {}
    if not agents_dir.exists():
        return results

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
        key = str(Path(str(cti_home)).expanduser().resolve())
        results.setdefault(key, []).append(
            {
                "label": str(payload.get("Label", "")),
                "plist": str(plist_path),
            }
        )
    return results


def inspect_home(home: Path, launchagents: dict[str, list[dict[str, str]]]) -> dict[str, object]:
    config_path = home / "config.env"
    runtime_status = home / "runtime" / "status.json"
    log_path = home / "logs" / "bridge.log"

    if not config_path.exists():
        return {
            "cti_home": str(home),
            "exists": False,
            "ok": False,
            "reason": "missing config.env",
            "launchagents": launchagents.get(str(home), []),
        }

    env = parse_env(config_path)
    enabled_channels = split_csv(env.get("CTI_ENABLED_CHANNELS"))
    has_discord = "discord" in enabled_channels and bool(env.get("CTI_DISCORD_BOT_TOKEN"))
    mention = env.get("CTI_DISCORD_REQUIRE_MENTION")
    policy = env.get("CTI_DISCORD_GROUP_POLICY")
    status_payload = {}
    if runtime_status.exists():
        try:
            status_payload = json.loads(runtime_status.read_text(encoding="utf-8"))
        except Exception:
            status_payload = {}

    issues: list[str] = []
    if has_discord:
        if mention != "true":
            issues.append("missing_or_false_CTI_DISCORD_REQUIRE_MENTION")
        if policy != "mention_only":
            issues.append("missing_or_wrong_CTI_DISCORD_GROUP_POLICY")
    ok = has_discord and not issues

    return {
        "cti_home": str(home),
        "exists": True,
        "runtime": env.get("CTI_RUNTIME", "unknown"),
        "enabled_channels": enabled_channels,
        "has_discord": has_discord,
        "discord_require_mention": mention,
        "discord_group_policy": policy,
        "launchagents": launchagents.get(str(home), []),
        "status_running": status_payload.get("running"),
        "status_pid": status_payload.get("pid"),
        "bridge_log_exists": log_path.exists(),
        "ok": ok if has_discord else True,
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit Discord mention-only gating across all discovered bridge homes."
    )
    parser.add_argument(
        "--cti-home",
        action="append",
        default=[],
        help="Explicit bridge home to audit. Repeat as needed. Defaults to auto-discovery.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    homes = [Path(item).expanduser().resolve() for item in args.cti_home] or discover_cti_homes()
    launchagents = parse_launchagents()
    results = [inspect_home(home, launchagents) for home in homes]
    payload = {
        "ok": True,
        "homes_checked": len(results),
        "results": results,
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for result in results:
            print(f"[{result['cti_home']}]")
            if not result["exists"]:
                print(f"  reason: {result['reason']}")
                continue
            print(f"  runtime: {result['runtime']}")
            print(f"  channels: {', '.join(result['enabled_channels']) or '(none)'}")
            print(f"  has_discord: {result['has_discord']}")
            print(f"  mention_gate: require={result['discord_require_mention']} policy={result['discord_group_policy']}")
            print(f"  running: {result['status_running']} pid={result['status_pid']}")
            if result["issues"]:
                print(f"  issues: {', '.join(result['issues'])}")
            else:
                print("  issues: (none)")
        print("")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
