# Telegram Regression Gate

## Purpose

This gate is the product-safety check that runs before `git push` when the global hook is enabled.

It verifies two things:

1. receive path: `openclaw agent --local --channel telegram ...` can produce the expected reply for a minimal Telegram-scoped probe
2. send path: `openclaw message send --channel telegram ...` can deliver a real Telegram message to the target chat

## Script

- `scripts/telegram_regression_gate.sh`

## Default behavior

- agent: `main`
- target: `8540734140`
- receive prompt: `健康检查：只回复 Gate OK，不要调用工具。`
- expected reply substring: `Gate OK`
- send message prefix: `[telegram-gate]`
- report dir: `runtime/`

## Why this version is more stable

This gate intentionally uses the existing OpenClaw config instead of cloning to a temporary config file. That avoids the previous failure mode where temp config validation broke on plugin allow-lists or missing local plugin registrations.

It also retries the receive probe for transient failures such as session-file locks or temporary config/runtime contention.

## Manual commands

Run the gate once:

```bash
bash scripts/telegram_regression_gate.sh
```

Custom target:

```bash
bash scripts/telegram_regression_gate.sh --target 8540734140
```

Custom expectation:

```bash
bash scripts/telegram_regression_gate.sh --receive-expect "Gate OK"
```

## Reports

Each run writes a Markdown report to:

- `runtime/telegram_regression_gate_<timestamp>.md`

The report records:

- receive command and parsed reply
- expected substring match result
- send command and Telegram `messageId`
- raw output snippets for fast debugging
