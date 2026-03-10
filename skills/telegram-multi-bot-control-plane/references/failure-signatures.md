# Failure Signatures

## Group reply bleed-through

Symptoms:

- Codex replies to a message that only mentions Gemini.
- Gemini replies to a message that only mentions Codex.
- Replying to an old bot message causes the wrong bot to answer.

Check:

- `src/telegram-group-adapter.ts`
- both bots' `data/audit.json`
- both bots' `logs/bridge.log`

Fix shape:

- Reject group messages that explicitly mention other bots but not this bot, even if the message is a reply to this bot.
- Prove the fix with both reply-chain and non-reply group cases.

## Gemini stale resume session

Symptoms:

- `Error resuming session: Invalid session identifier`
- `Error resuming session: No previous sessions found for this project`
- a resumed session emits only startup events and never produces assistant output

Check:

- `src/gemini-provider.ts`
- runtime `data/bindings.json`
- runtime `data/sessions.json`
- `logs/bridge.log`

Fix shape:

- Treat stale resume identifiers as unhealthy and retry fresh.
- If bindings and sessions disagree, realign `sdkSessionId` state before restart.
- Keep Telegram-facing error messages short and actionable.

## Gemini fresh startup timeout

Symptoms:

- `Gemini 会话启动超时`
- local CLI succeeds sometimes, but preview traffic occasionally exceeds the startup timer

Check:

- `CTI_GEMINI_START_TIMEOUT_MS`
- `CTI_GEMINI_FALLBACK_MODELS`
- local CLI timing with the same prompt shape

Fix shape:

- Raise the startup timeout if the current threshold is too aggressive.
- Allow a fallback model for preview traffic stalls.
- Re-test fresh and follow-up turns in Telegram.

## Codex MCP/config parse failure

Symptoms:

- `Error loading config.toml: invalid transport`
- errors that point at `mcp_servers.<name>` during `codex exec`

Check:

- running daemon env via `ps eww -p <pid> -o command=`
- launchd plist or supervisor env generation
- user `~/.codex/config.toml`

Fix shape:

- Ensure daemon `HOME` points at the real login home, not `CTI_HOME`.
- Keep `CTI_HOME` isolated for bridge state, but let Codex reuse the user's auth and config.
- Re-run a local `codex exec` smoke check before Telegram testing.

## Runtime state drift

Symptoms:

- `bindings.json` and `sessions.json` disagree about `sdkSessionId`
- one chat resumes unexpectedly while another starts fresh

Check:

- `data/bindings.json`
- `data/sessions.json`

Fix shape:

- Make bindings the source of truth for active chat routing.
- Sync or clear stale `sdk_session_id` values, then restart the affected daemon.
