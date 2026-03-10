---
name: telegram-multi-bot-control-plane
description: Build, harden, debug, package, or extend a Telegram-based multi-bot LLM control plane where different bots map to different runtimes or providers such as Codex, Gemini, Claude, or Grok. Use when setting up mention-only group orchestration, isolating per-bot HOME and CTI_HOME state, fixing reply-chain bleed-through, repairing stale resume-session failures, recovering provider auth or MCP config issues, restarting daemons safely, auditing bindings and sessions, packaging the system into a sellable service offering, or adding new provider bots with a repeatable regression workflow.
---

# Telegram Multi-Bot Control Plane

## Overview

Treat each bot as its own runtime cell with isolated bridge state and shared user-level provider auth. Prefer the smallest reversible fix, prove it locally, then prove it in a real Telegram group before declaring the control plane healthy.

## Core Model

Keep these boundaries explicit for every bot:

- `CTI_HOME`: bridge-local state such as `config.env`, bindings, audit, logs, runtime status
- `HOME`: real login home for provider auth and user-level config unless you are intentionally testing a clean-room runtime
- Telegram identity: bot token, username, user id, group policy
- Runtime/provider: `codex`, `gemini`, `claude`, or future providers
- Acceptance path: local smoke -> daemon restart -> Telegram regression

## Workflow

### 1. Map the control plane before editing

Inspect, per bot:

- `config.env`
- `data/bindings.json`
- `data/sessions.json`
- `logs/bridge.log`
- `runtime/status.json`
- live process env from `ps eww -p <pid> -o command=`

Confirm:

- runtime and model defaults
- `CTI_HOME`
- effective `HOME`
- mention-only group policy
- whether bindings and sessions agree on `sdkSessionId`

### 2. Classify the failure before touching code

Use `references/failure-signatures.md` to map the symptom into one of these buckets:

- mention-routing or reply-chain bleed-through
- stale Gemini resume session or startup stall
- Codex config or MCP parse failure
- daemon environment isolation mistake
- binding/session drift between runtime files

Do not mix fixes across buckets until the active failure class is clear.

### 3. Apply the smallest durable fix

Follow these guardrails:

- Keep one `CTI_HOME` per bot.
- Keep user auth and provider config on the real login `HOME` unless deliberately isolating credentials.
- Backup runtime JSON or env files before rewriting them.
- Fix Telegram acceptance logic before changing model or prompt settings.
- Clear or realign stale `sdkSessionId` state instead of hiding resume bugs behind formatting.

### 4. Validate in layers

Run validation in this order:

1. `npm test`
2. `npm run build`
3. provider-local smoke checks
4. daemon restart for affected bots only
5. real Telegram regression matrix

Use `references/release-checklist.md` for the exact prompts and expected results.

### 5. Package it as a sellable offer when asked

When the user wants to commercialize the control plane, read `references/commercial-packaging.md` and turn the current system into a scoped offer with:

- who it is for
- what pains it removes
- what is explicitly in or out of scope
- delivery phases, acceptance criteria, and support boundaries
- upsells such as watchdogs, long-window regression, or additional providers

Do not invent a vague AI-agency pitch. Anchor the offer in the actual technical control plane that exists in the repo.

### 6. Expand to new providers with the same discipline

When adding `Claude bot`, `Grok bot`, or another runtime, read `references/provider-expansion.md` and keep the same pattern:

- isolated bot home
- real login `HOME`
- provider-specific auth/env
- local smoke command
- Telegram regression prompts
- audit and log inspection path

## References

Load only what is needed:

- `references/failure-signatures.md` for failure triage and root-cause patterns
- `references/release-checklist.md` for local + Telegram regression gates
- `references/commercial-packaging.md` for pricing, deliverables, and sales framing
- `references/provider-expansion.md` for onboarding Claude, Grok, or future bots
