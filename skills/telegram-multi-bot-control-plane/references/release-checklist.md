# Release Checklist

## Local validation

Run inside the repo:

```bash
npm test
npm run build
```

For Discord mention-only rollouts, inspect or apply the canonical gate before restart:

```bash
python3 scripts/audit_discord_mention_gate.py --json
python3 scripts/ensure_discord_mention_gate.py --cti-home "$BOT_HOME" --json
```

For Codex smoke, prefer the real login home:

```bash
HOME="$REAL_HOME" codex exec --experimental-json --skip-git-repo-check \
  --config 'approval_policy="never"' \
  --config 'mcp_servers.linear.enabled=false' \
  --config 'mcp_servers.notion.enabled=false' \
  --config 'mcp_servers.playwright.enabled=false'
```

For Gemini smoke, prefer the real login home and the same include directories used by the bot:

```bash
HOME="$REAL_HOME" gemini -p 'Reply exactly: Gemini OK' --yolo -o stream-json \
  --include-directories "$WORKDIR"
```

## Restart affected bots only

```bash
CTI_HOME="$BOT_HOME" bash scripts/daemon.sh stop
CTI_HOME="$BOT_HOME" bash scripts/daemon.sh start
```

Verify:

- `runtime/status.json` shows `running: true`
- the daemon process has the expected `CTI_HOME`
- the daemon process `HOME` is the real login home when provider auth depends on user config

## Real Telegram regression matrix

Run these in the shared group and capture the raw results:

1. Reply to an old Codex bot message: `@enyi11_bot 只回复 Gemini OK`
2. Reply to an old Gemini bot message: `@Enyi12_bot 只回复 Codex OK`
3. New group message: `@enyi11_bot 只回复 G`
4. New group message: `@Enyi12_bot 只回复 C`
5. Gemini follow-up stress check: `@enyi11_bot 只回复 Gemini 再来一次`

Expected result:

- only the addressed bot responds
- no Gemini resume-session error leaks to Telegram
- no Codex `invalid transport` or MCP config parse error leaks to Telegram

## Real Discord regression matrix

Run these in the shared Discord channel and capture the raw results:

1. `@CodexBot 只回复 1`
2. `@GeminiBot 只回复 2`
3. a plain message with no bot mention

Expected result:

- only the explicitly mentioned bot responds
- the non-addressed bot stays silent
- the no-mention message stays silent for every bot in the channel

## Commit scope

Include:

- provider/runtime fixes
- group-adapter fixes
- tests
- skill assets that document the control-plane workflow

Exclude:

- unrelated lockfile drift
- runtime logs, backups, or bot-home JSON state
