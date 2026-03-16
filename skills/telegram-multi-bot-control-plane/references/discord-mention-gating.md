# Discord Mention Gating

Load this reference when a shared Discord channel causes the wrong bot to reply, multiple bots reply to the same prompt, or you are onboarding a new Discord bot and want mention-only behavior from day one.

## Canonical settings

For every Discord-enabled bot home:

- `CTI_DISCORD_REQUIRE_MENTION=true`
- `CTI_DISCORD_GROUP_POLICY=mention_only`

These keys must survive the config layer and appear in the bridge settings as:

- `bridge_discord_require_mention=true`
- `bridge_discord_group_policy=mention_only`

If the env file has the keys but the running daemon still behaves like an open channel, inspect `src/config.ts` first.

## Canonical files

- `src/config.ts`
- `scripts/ensure_discord_mention_gate.py`
- `<CTI_HOME>/config.env`
- `<CTI_HOME>/logs/bridge.log`
- `<CTI_HOME>/runtime/status.json`

## Safe apply workflow

1. Inspect every affected bot home and confirm Discord is actually enabled.
2. Run the helper:

```bash
python3 scripts/ensure_discord_mention_gate.py --cti-home "$BOT_HOME" --json
```

3. If the helper reports changes, restart only the affected bridge:

```bash
python3 scripts/ensure_discord_mention_gate.py --cti-home "$BOT_HOME" --restart --json
```

4. Confirm the daemon came back and that `logs/bridge.log` shows the Discord adapter started successfully.

The helper automatically creates `config.env.bak-*-discord-mention-gate` backups before rewriting.

## Real Discord regression matrix

Run this in the shared Discord channel:

1. `@CodexBot 只回复 1`
2. `@GeminiBot 只回复 2`
3. A plain message without any bot mention

Expected result:

- only the explicitly mentioned bot replies
- the non-addressed bot stays silent
- the no-mention message stays silent for every bot in the channel

## If the bug persists

Check these in order:

1. `src/config.ts` actually maps the two Discord keys into `configToSettings`
2. the affected bot homes were restarted after the config change
3. the user is typing a direct bot mention and not relying on display-name text
4. the bot has channel access but is not also behind a broad role mention rule
