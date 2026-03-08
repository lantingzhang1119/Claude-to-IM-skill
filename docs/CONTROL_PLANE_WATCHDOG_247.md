# Control Plane Watchdog 24/7

## Purpose

This watchdog is the always-on health guard for the Telegram Bot Control Plane V2 stack.

It watches the shared runtime codebase in `/Users/zhichaorong/.openclaw/skills-sandbox/claude-to-im-skill` and the two production runtime homes:

- Gemini: `/Users/zhichaorong/.claude-to-im`
- Codex: `/Users/zhichaorong/.claude-to-im-codex`

## What it checks

Every cycle, the watchdog inspects each runtime home for:

1. missing bridge process
2. duplicate bridge processes for the same `CTI_HOME`
3. `runtime/status.json` not reporting `running: true`
4. fresh Telegram `409 Conflict` lines in the recent time window
5. recent error lines, recorded as warnings

## What it will auto-heal

The watchdog performs a bounded restart only for control-plane failures:

- no process
- duplicate processes
- stale `status.json`
- fresh `409 Conflict`

It does **not** blindly restart for all provider/model errors. Those are logged as warnings for manual inspection.

## Files and commands

- watchdog script: `scripts/control_plane_watchdog.py`
- launchd manager: `scripts/control_plane_watchdog.sh`
- runtime root: `~/.openclaw/control-plane-watchdog`
- latest report: `~/.openclaw/control-plane-watchdog/latest.json`
- history: `~/.openclaw/control-plane-watchdog/history.ndjson`
- log: `~/.openclaw/control-plane-watchdog/logs/watchdog.log`

## launchd operations

Install and start:

```bash
bash scripts/control_plane_watchdog.sh install
```

Run one cycle immediately:

```bash
bash scripts/control_plane_watchdog.sh run-now
```

Check status:

```bash
bash scripts/control_plane_watchdog.sh status
```

Tail watchdog log:

```bash
bash scripts/control_plane_watchdog.sh logs 80
```

Uninstall:

```bash
bash scripts/control_plane_watchdog.sh uninstall
```

## Operating notes

- Default cadence is every 300 seconds.
- Restart cooldown is 900 seconds by default to avoid restart storms.
- This watchdog protects runtime topology and poll-loop health; it does not replace real Telegram regression after meaningful behavior changes.
