---
name: discord-multi-bot-mention-gate
description: Harden shared Discord channels so only the mentioned bot replies. Use when Codex, Gemini, Claude, or other bridge bots cross-reply in the same Discord guild, when no-mention messages wake every bot, or when you need to batch-apply mention-only guardrails across multiple CTI_HOME runtimes.
---

# Discord Multi Bot Mention Gate

## Overview

Use this skill for Discord-only routing problems in the multi-bot bridge. It gives you the canonical config keys, the batch-apply helper, and the exact regression prompts needed to prove that one mention maps to one bot.

## Workflow

1. Inspect every affected bot home:
   - `config.env`
   - `runtime/status.json`
   - `logs/bridge.log`
2. Confirm Discord is actually enabled before editing anything.
3. From the bridge repo root, audit what exists:

```bash
python3 scripts/audit_discord_mention_gate.py --json
```

4. Apply the canonical gate with:

```bash
python3 scripts/ensure_discord_mention_gate.py --cti-home "$BOT_HOME" --json
```

5. If the helper reports config changes, rerun it with `--restart` or restart the affected bridges manually.
6. Run `npm test` and `npm run build` in the bridge repo.
7. Prove real behavior in Discord:
   - `@CodexBot 只回复 1`
   - `@GeminiBot 只回复 2`
   - one plain message with no bot mention

Expected result:

- only the mentioned bot replies
- the other bots stay silent
- the no-mention message stays silent

## Canonical settings

- `CTI_DISCORD_REQUIRE_MENTION=true`
- `CTI_DISCORD_GROUP_POLICY=mention_only`

These keys must be mapped through `src/config.ts` into:

- `bridge_discord_require_mention=true`
- `bridge_discord_group_policy=mention_only`

## References

- `references/checklist.md` for the short execution list
- `../discord-mention-gate-alert-regression/SKILL.md` when mention gating is fixed but the Telegram alert path still needs end-to-end proof
- `../telegram-multi-bot-control-plane/references/discord-mention-gating.md` for the detailed runbook
- `../telegram-multi-bot-control-plane/references/release-checklist.md` for local plus real-IM regression gates
