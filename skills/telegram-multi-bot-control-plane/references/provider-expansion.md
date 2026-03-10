# Provider Expansion

## Goal

Add a new provider bot without breaking the isolation and recovery guarantees already proven for Codex and Gemini.

## Per-provider checklist

For every new bot, define:

- bot name and Telegram username
- bot home, for example `~/.claude-to-im-claude` or `~/.claude-to-im-grok`
- runtime selection in `config.env`
- provider auth source on real login `HOME`
- local smoke command
- expected Telegram regression prompts

## Required invariants

- one `CTI_HOME` per bot
- shared real login `HOME` for provider auth unless intentionally isolated
- distinct audit, log, bindings, and sessions files per bot
- same mention-only group policy
- same release gate expectations before push

## Claude bot onboarding

Minimum checks:

- Claude CLI path resolves correctly
- auth is available to the daemon process
- stale non-Claude session ids are ignored if they leak in from another runtime

Suggested smoke:

```bash
HOME="$REAL_HOME" claude --print 'Reply exactly: Claude OK'
```

## Grok bot onboarding

Define first:

- actual CLI or API shim
- auth env names
- non-interactive smoke command
- session resume behavior and storage rules

Do not copy Gemini or Codex resume logic blindly until Grok's transport behavior is known.

## Regression prompts

After adding a provider, extend the group matrix with:

- reply to old message, mention only new bot
- reply to old message of another bot, mention only new bot
- fresh group message mentioning only new bot
- follow-up message to test resume behavior

## Audit path

For every failure, inspect these before changing code:

- `<bot-home>/data/audit.json`
- `<bot-home>/data/bindings.json`
- `<bot-home>/data/sessions.json`
- `<bot-home>/logs/bridge.log`
- live daemon env from `ps eww -p <pid> -o command=`
