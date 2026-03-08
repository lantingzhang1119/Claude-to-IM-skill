# Telegram Bot Control Plane V2

## Positioning

This bridge stack is no longer treated as a single-bot utility. It is operated as a control plane for multiple Telegram AI bots with explicit routing, isolated runtime homes, supervised lifecycle, and mandatory real-message regression.

## Design goals

1. One bot should never steal another bot's traffic.
2. A routing bug must be distinguishable from a runtime duplication bug.
3. Every bot instance must be restartable and diagnosable independently.
4. The system must be stable enough to onboard future Claude and Grok bots without redesign.

## V2 architecture

- Shared runtime codebase:
  - `/Users/zhichaorong/.openclaw/skills-sandbox/claude-to-im-skill`
- Per-bot isolated homes:
  - Gemini -> `/Users/zhichaorong/.claude-to-im`
  - Codex -> `/Users/zhichaorong/.claude-to-im-codex`
- Per-bot state isolation:
  - `config.env`
  - `runtime/status.json`
  - `runtime/bridge.pid`
  - `logs/bridge.log`
  - `data/audit.json`
- Group routing contract:
  - `CTI_TG_GROUP_POLICY=mention`
  - `CTI_TG_BOT_USERNAME`
  - `CTI_TG_BOT_USER_ID`
- Supervision:
  - launchd labels derived from `CTI_HOME`

## Key lesson from the March 8 incident

The visible symptom was: Gemini replied to a Codex-directed mention.

The real root cause was not mention-gating logic failure. The managed Gemini daemon correctly dropped the Codex mention, but a second unmanaged Gemini daemon was still polling the same bot token. That created:

- `409 Conflict` noise
- misleading audit trails
- wrong-bot replies
- stale or inconsistent health signals

Therefore, V2 treats duplicate consumers as a first-class failure mode.

## V2 operating rules

1. Never run unmanaged `node dist/daemon.mjs` beside launchd for the same home.
2. Never trust `status.json` alone.
3. Always pair runtime repair with real Telegram regression.
4. Keep changes minimal and rollback-safe.
5. Do not mix unrelated drift into bridge stabilization commits.

## Standard validation sequence

1. `CTI_HOME=<home> bash scripts/daemon.sh status`
2. `CTI_HOME=<home> bash scripts/doctor.sh`
3. inspect recent logs
4. run real Telegram group matrix
5. record exact observed bot behavior

## 24/7 watchdog

V2 now includes a dedicated control-plane watchdog for macOS launchd. It monitors the Gemini and Codex runtime homes every 300 seconds, records health reports under `~/.openclaw/control-plane-watchdog`, and performs bounded self-healing only for control-plane failures such as missing daemons, duplicate consumers, stale `status.json`, and fresh Telegram `409 Conflict` incidents.

See `docs/CONTROL_PLANE_WATCHDOG_247.md` for installation, status, and rollback.

## Ready for next expansion

With V2 in place, new bots should be added by cloning the runtime-home pattern, not by changing shared routing semantics:

- one new bot token
- one new `CTI_HOME`
- one new launchd label
- one explicit username/user-id identity
- one regression pass in the shared group
