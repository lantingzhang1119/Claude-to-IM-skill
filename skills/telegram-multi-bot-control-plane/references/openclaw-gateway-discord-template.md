# OpenClaw Gateway Discord Template

Load this reference when the user wants domain-specific OpenClaw gateway bots such as Finance or Audit to gain their own Discord identities later, or when you need to explain how the gateway-side account model differs from the per-`CTI_HOME` bridge model.

## Current model split

- The `claude-to-im` bridge uses one `CTI_HOME` per bot runtime.
- The OpenClaw gateway uses multi-account channel config inside one `openclaw.json`.

For the gateway, audit the current account inventory without printing secrets:

```bash
python3 scripts/audit_openclaw_gateway_accounts.py --json
```

That audit highlights Telegram accounts that do not yet have dedicated Discord account peers.

## When to use dedicated Discord accounts

Use `channels.discord.accounts.<accountId>` when you want:

- one Discord bot per domain, such as Finance, Audit, or Info
- separate Discord tokens and guild routing per bot
- domain isolation without creating a second gateway instance

Stay on a single default Discord account when:

- one shared bot identity is enough
- routing is already handled by OpenClaw agent bindings or channel permissions

## Safe template

```json5
{
  channels: {
    discord: {
      enabled: true,
      groupPolicy: "allowlist",
      accounts: {
        finance_bot: {
          name: "FinanceBot",
          token: "DISCORD_FINANCE_TOKEN",
          guilds: {
            YOUR_GUILD_ID: {
              users: ["YOUR_USER_ID"],
              requireMention: true,
              channels: {
                finance: { allow: true, requireMention: true },
              },
            },
          },
        },
        audit_bot: {
          name: "AuditBot",
          token: "DISCORD_AUDIT_TOKEN",
          guilds: {
            YOUR_GUILD_ID: {
              users: ["YOUR_USER_ID"],
              requireMention: true,
              channels: {
                audit: { allow: true, requireMention: true },
              },
            },
          },
        },
      },
    },
  },
}
```

## Guardrails

- Keep `groupPolicy: "allowlist"` for shared guilds.
- Set `requireMention: true` at the guild or channel level for every shared channel.
- Do not paste real tokens into docs or git-tracked templates.
- After editing `openclaw.json`, verify with `openclaw doctor` and a real Discord channel mention test.

## Acceptance check

1. `python3 scripts/audit_openclaw_gateway_accounts.py --json`
2. `openclaw doctor`
3. Mention each Discord bot in its target channel once.
4. Send one no-mention message and confirm silence.
