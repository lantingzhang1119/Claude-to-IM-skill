# Checklist

Use this checklist after the skill triggers:

1. Inspect the affected bot homes and confirm Discord is enabled.
2. Apply the canonical gate with `scripts/ensure_discord_mention_gate.py`.
3. Run `npm test` and `npm run build`.
4. Restart only the affected bridge homes.
5. Prove real Discord behavior with one explicit mention per bot plus one no-mention message.
