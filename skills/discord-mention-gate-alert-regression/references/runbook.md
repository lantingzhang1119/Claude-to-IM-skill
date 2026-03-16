# Runbook

## Default command

Run the helper from `/Users/zhichaorong/.openclaw/skills-sandbox/claude-to-im-skill`:

```bash
python3 scripts/run_discord_mention_gate_alert_regression.py --send-real-alerts
```

## Periodic dry-run installation

Install the launchd agent with the default dry-run behavior:

```bash
bash scripts/install_discord_mention_gate_alert_regression_launchagent.sh
```

Default cadence is every 6 hours. Change it when needed:

```bash
bash scripts/install_discord_mention_gate_alert_regression_launchagent.sh --interval-sec 14400
```

Only opt into scheduled real alerts if you intentionally want the job to send Telegram messages:

```bash
bash scripts/install_discord_mention_gate_alert_regression_launchagent.sh --send-real-alerts
```

## What the helper does

1. Loads `runtime_health_runner.py` from the OpenClaw workspace.
2. Resolves the current `system` delivery route unless overrides are provided.
3. Backs up `runtime/runtime_health_state.json`.
4. Seeds a clean baseline state so cooldown logic does not suppress the regression.
5. Injects an ephemeral control-plane payload with a Discord mention-gate failure.
6. Runs the failure pass and captures the alert event.
7. Injects an ephemeral healthy payload.
8. Runs the recovery pass and captures the recovery event.
9. Restores the original health state file.
10. Writes `discord_mention_gate_alert_regression_latest.json` plus an archived timestamped copy.

## Pass criteria

- failure case exits non-zero
- failure case includes `discord_mention_gate_unhealthy`
- failure case records one alert event
- recovery case exits zero
- recovery case returns `ok=true`
- recovery case records one recovery event
- final artifact shows `success=true`
- final artifact shows `restoredState=true`

## Useful flags

- `--send-real-alerts`
  - send the two Telegram messages for real
- `--interval-sec <seconds>` on the install script
  - control the launchd cadence; default is 21600 seconds
- `--target <chat_id>`
  - override the system route target for isolated testing
- `--channel <name>` and `--account <id>`
  - override route resolution if needed
- `--recovery-delay-sec <seconds>`
  - wait longer between failure and recovery if the IM route is slow

## Artifact fields worth checking

- `delivery`
- `cases.failure.result.payload`
- `cases.failure.sendEvents`
- `cases.recovery.result.payload`
- `cases.recovery.sendEvents`
- `success`
- `failures`
- `restoredState`
