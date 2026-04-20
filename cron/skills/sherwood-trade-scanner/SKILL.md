---
name: sherwood-trade-scanner
description: Run one paper-trading cycle of the Sherwood agent on the auto-selected Hyperliquid token universe and post a concise summary to a syndicate XMTP chat.
tags: [sherwood, defi, paper-trading, hyperliquid, xmtp, cron]
triggers:
  - run sherwood paper trade scan
  - sherwood trade-scanner cron
  - paper trading cycle
---

# Sherwood Paper-Trading Scan

Executes one analyze + paper-execute cycle of the Sherwood trading agent
and posts a short summary to the configured syndicate XMTP chat. Designed
for fresh-session cron use — assume zero prior context.

The cron job invoking this skill MUST provide:
- `<REPO_DIR>` — local sherwood checkout (e.g. `~/code/sherwood`)
- `<SYNDICATE_NAME>` — XMTP chat identifier (e.g. `hyperliquid-algo`)
- `<CHAIN>` — chain for the chat & execution (e.g. `hyperevm`)

If any of these are missing from the invocation, ask once for the missing
value (or skip the XMTP post and report locally only).

## Procedure

### 1. Run the scanner

From `<REPO_DIR>`:

```bash
sherwood agent start --auto --cycle 1 --use-judge
```

This executes one DRY-RUN cycle in paper-trading mode:
- Dynamic token selection from Hyperliquid (up to 25 tokens, $5M+ 24h volume)
- Full signal engine (technical + sentiment + on-chain + smart-money)
- Paper trades logged when BUY / SELL fires (no on-chain execution)
- Paper PnL tracked in `~/.sherwood/agent/portfolio.json`
- Exit logic: 3% stop, 6% take-profit, 2.5% trailing, 48h time-stop

Capture the latest cycle from the log:

```bash
tail -1 ~/.sherwood/agent/cycles.jsonl
```

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
For unmapped tokens, uppercase the first 5 chars of the CoinGecko ID.

## Output policy

This is a data-collection job. Always post the XMTP summary AND respond
in the cron channel with the same summary plus any notable observations.
Do NOT use `[SILENT]` — every cycle should produce a visible record.

## Idempotency

Each run is independent. Re-execution opens a new paper position only if
a fresh signal fires; the position-tracker prevents duplicate entries on
the same token within the pyramid spacing window (4h, max 2 adds).

## References

- CLI version: ≥ 0.40.2 (required for `--stdin`)
- Cycles log: `~/.sherwood/agent/cycles.jsonl`
- Signal log: `~/.sherwood/agent/signal-history.jsonl`
- Portfolio: `~/.sherwood/agent/portfolio.json`
