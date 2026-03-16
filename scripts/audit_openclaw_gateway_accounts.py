#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def bool_token(value: object) -> bool:
    return bool(isinstance(value, str) and value.strip())


def summarize_telegram_accounts(channels: dict) -> list[dict[str, object]]:
    telegram = channels.get("telegram") or {}
    accounts = telegram.get("accounts") or {}
    summary: list[dict[str, object]] = []
    for account_id, cfg in sorted(accounts.items()):
        cfg = cfg or {}
        groups = cfg.get("groups") or {}
        summary.append(
            {
                "account_id": account_id,
                "name": cfg.get("name"),
                "enabled": cfg.get("enabled", True),
                "has_bot_token": bool_token(cfg.get("botToken")) or bool_token(cfg.get("token")) or bool(cfg.get("tokenFile")),
                "group_count": len(groups),
                "allow_from_count": len(cfg.get("allowFrom") or []),
                "group_policy": cfg.get("groupPolicy"),
            }
        )
    return summary


def summarize_discord_accounts(channels: dict) -> dict[str, object]:
    discord = channels.get("discord") or {}
    accounts = discord.get("accounts") or {}
    named_accounts: list[dict[str, object]] = []
    for account_id, cfg in sorted(accounts.items()):
        cfg = cfg or {}
        named_accounts.append(
            {
                "account_id": account_id,
                "name": cfg.get("name"),
                "enabled": cfg.get("enabled", True),
                "has_token": bool_token(cfg.get("token")),
                "guild_count": len(cfg.get("guilds") or {}),
            }
        )

    return {
        "enabled": discord.get("enabled", False),
        "group_policy": discord.get("groupPolicy"),
        "has_default_token": bool_token(discord.get("token")),
        "named_account_count": len(named_accounts),
        "named_accounts": named_accounts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit OpenClaw gateway Telegram/Discord account inventory without printing secrets."
    )
    parser.add_argument(
        "--config",
        default=str(Path.home() / ".openclaw" / "openclaw.json"),
        help="Path to openclaw.json",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    config_path = Path(args.config).expanduser().resolve()
    data = load_json(config_path)
    channels = data.get("channels") or {}
    telegram_accounts = summarize_telegram_accounts(channels)
    discord = summarize_discord_accounts(channels)

    telegram_ids = {item["account_id"] for item in telegram_accounts if item["account_id"] != "default"}
    discord_ids = {item["account_id"] for item in discord["named_accounts"]}
    telegram_only_accounts = sorted(telegram_ids - discord_ids)

    payload = {
        "ok": True,
        "config": str(config_path),
        "telegram_accounts": telegram_accounts,
        "discord": discord,
        "telegram_only_accounts": telegram_only_accounts,
        "notes": [
            "telegram_only_accounts are candidates for future dedicated Discord bot accounts if you want one-bot-per-domain parity."
        ],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"config: {config_path}")
        print("telegram accounts:")
        for item in telegram_accounts:
            print(
                f"  - {item['account_id']} name={item['name']} enabled={item['enabled']} "
                f"token={item['has_bot_token']} groups={item['group_count']} policy={item['group_policy']}"
            )
        print(
            f"discord: enabled={discord['enabled']} default_token={discord['has_default_token']} "
            f"named_accounts={discord['named_account_count']} group_policy={discord['group_policy']}"
        )
        if telegram_only_accounts:
            print("telegram_only_accounts:", ", ".join(telegram_only_accounts))
        else:
            print("telegram_only_accounts: (none)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
