---
name: sherwood-trade-scanner
description: Post the latest Sherwood agent cycle summary to the syndicate XMTP chat. The agent loop runs as a persistent systemd service — this cron skill only handles reporting.
tags: [sherwood, defi, paper-trading, hyperliquid, xmtp, cron]
triggers:
  - run sherwood paper trade scan
  - sherwood trade-scanner cron
  - paper trading cycle
---

# Sherwood Trading Report

Posts the latest agent cycle summary to the syndicate XMTP chat.

**The trading agent runs continuously as a systemd service** (`sherwood-agent.service`)
with a 5-minute cycle. This cron skill does NOT run the scanner — it only reads
the latest cycle data and posts a formatted report.

The cron job invoking this skill MUST provide:
- `<SYNDICATE_NAME>` — XMTP chat identifier (e.g. `hyperliquid-algo`)
- `<CHAIN>` — chain for the chat (e.g. `hyperevm`)

If any of these are missing from the invocation, ask once for the missing
value (or skip the XMTP post and report locally only).

## Procedure

### 1. Verify the agent service is running

```bash
systemctl --user is-active sherwood-agent
```

If it shows `inactive` or `failed`, report this in your response and suggest
the user run `systemctl --user start sherwood-agent`. Do NOT start it yourself.

### 2. Post the formatted summary to XMTP

The CLI generates the formatted message deterministically — **do NOT
compose the message yourself**. Run:

```bash
sherwood agent summary | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

This pipes the output of `sherwood agent summary` (which reads the latest
cycle + portfolio + trades and renders a structured bot-style message)
directly into the XMTP send command. The `--stdin` flag reads the message
from stdin so `$` signs render literally.

If `sherwood agent summary` exits non-zero or produces no output, fall
back to a one-line "Scan complete, no summary available" message.

## Output policy

This is a reporting job. Always post the XMTP summary AND respond
in the cron channel with the same summary plus any notable observations
(e.g., service down, stale data, new entries/exits since last report).
Do NOT use `[SILENT]` — every cycle should produce a visible record.

## References

- Agent service: `systemctl --user status sherwood-agent`
- CLI version: ≥ 0.44.3
- Cycles log: `~/.sherwood/agent/cycles.jsonl`
- Signal log: `~/.sherwood/agent/signal-history.jsonl`
- Portfolio: `~/.sherwood/agent/portfolio.json`
