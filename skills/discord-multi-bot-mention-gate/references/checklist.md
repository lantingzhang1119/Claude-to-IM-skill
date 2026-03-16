# Checklist

Use this checklist after the skill triggers:

1. Inspect the affected bot homes and confirm Discord is enabled.
2. Run `scripts/audit_discord_mention_gate.py` to discover current homes and launchd-managed bridges.
3. Apply the canonical gate with `scripts/ensure_discord_mention_gate.py`.
4. Run `npm test` and `npm run build`.
5. Restart only the affected bridge homes.
6. Prove real Discord behavior with one explicit mention per bot plus one no-mention message.
