---
name: discord-mention-gate-alert-regression
description: Validate the end-to-end IM alert path for Discord mention-gate failures and recovery without leaving runtime health state dirty. Use when you need to prove that `runtime_health_runner.py` turns `discord_mention_gate_unhealthy` into a real Telegram alert, confirm the paired recovery message, or capture a rollback-safe regression artifact after control-plane changes.
---

# Discord Mention Gate Alert Regression

Use this skill when Discord mention gating itself is already configured, but you need confidence that the health and alert chain still works end to end.

## What this skill proves

- `runtime_health_runner.py` classifies `discord_mention_gate_unhealthy`
- the system delivery route can emit the failure alert
- the same route emits the recovery alert on the next healthy pass
- `runtime_health_state.json` is restored after the regression finishes
- a JSON artifact is written for audit and future comparison

## Canonical helper

Run from the bridge repo root:

```bash
python3 scripts/run_discord_mention_gate_alert_regression.py --send-real-alerts
```

Safer local rehearsal without sending Telegram messages:

```bash
python3 scripts/run_discord_mention_gate_alert_regression.py
```

## Outputs

- latest: `~/.openclaw/workspace/runtime/discord_mention_gate_alert_regression_latest.json`
- archived: `~/.openclaw/workspace/runtime/discord_mention_gate_alert_regression_*.json`

## Workflow

1. Confirm the system route is correct before running the regression.
2. Use the helper in dry-run mode if you only changed parsing or report formatting.
3. Use `--send-real-alerts` after control-plane, mention-gate, or routing changes.
4. Verify the Telegram failure alert and the paired recovery alert arrived.
5. Read the latest JSON artifact and confirm `success=true` and `restoredState=true`.

## Guardrails

- Prefer the default role-based system route unless you intentionally pass `--target`.
- Expect two messages in real-send mode: one failure and one recovery.
- Do not leave ad-hoc test payloads in the workspace; the helper creates ephemeral payloads and cleans them up.
- If the latest report fails, inspect the captured `cases.failure.result.payload` and `cases.recovery.result.payload` before changing runtime code.

## References

- `references/runbook.md` for the exact regression steps and pass criteria
- `../telegram-multi-bot-control-plane/references/discord-mention-gating.md` for mention-only rollout details
- `../telegram-multi-bot-control-plane/references/release-checklist.md` for broader IM regression context
