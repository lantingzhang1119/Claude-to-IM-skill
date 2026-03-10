---
name: telegram-multi-bot-control-plane
description: Build, harden, or debug a Telegram-based multi-bot LLM control plane where different bots map to different runtimes or providers such as Codex, Gemini, Claude, or Grok. Use when setting up mention-only group orchestration, isolating per-bot HOME and CTI_HOME state, fixing reply-chain bleed-through, repairing stale resume-session failures, recovering provider auth or MCP config issues, restarting daemons safely, auditing bindings and sessions, and proving changes with real Telegram regression.
---

# Telegram Multi-Bot Control Plane

## Overview

Treat each bot as an isolated runtime instance with its own `CTI_HOME`, Telegram identity, bindings store, logs, and provider auth path. Prefer the smallest reversible fix, then prove it with local smoke plus real Telegram group regression before declaring the control plane healthy.

## Workflow

### 1. Map the control plane first

Inspect each bot home before editing code:

- `config.env`
- `data/bindings.json`
- `data/sessions.json`
- `logs/bridge.log`
- `runtime/status.json`

Confirm, per bot:

- `CTI_RUNTIME`
- `CTI_TG_BOT_USERNAME`
- `CTI_HOME`
- effective `HOME` seen by the daemon process
- provider auth source and model defaults

When a group-routing bug appears, inspect both bots. A wrong reply is often an inbound gating bug, not the speaking bot's model.

### 2. Classify the failure before changing code

Use `references/failure-signatures.md` to map the symptom into one of these buckets:

- mention-routing or reply-chain bleed-through
- stale Gemini resume session or startup stall
- Codex config or MCP parse failure
- daemon environment isolation mistake
- binding/session drift between runtime files

Do not mix fixes across buckets until the active failure class is clear.

### 3. Apply the smallest durable fix

Follow these guardrails:

- Keep each bot on its own `CTI_HOME`.
- Keep provider auth and user-level config tied to the real login `HOME` unless you are intentionally testing a clean-room runtime.
- Backup runtime JSON or env files before rewriting them.
- Fix acceptance filters before changing prompt or model settings.
- For session-resume bugs, clear or realign stale `sdkSessionId` state rather than masking the symptom in Telegram formatting.

### 4. Validate in layers

Run validation in this order:

1. `npm test`
2. `npm run build`
3. provider-local smoke checks
4. daemon restart for affected bots only
5. real Telegram regression matrix

Use `references/release-checklist.md` for the exact regression prompts and expected outcomes.

### 5. Release cleanly

Commit only control-plane files related to the fix. Exclude unrelated drift such as pre-existing lockfile noise unless the change is intentional and reviewed. Push only after the real Telegram checks pass.
