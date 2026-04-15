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
sherwood agent start --auto --cycle 1
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

### 2. Post a concise summary to XMTP — use --stdin (CRITICAL)

`sherwood chat send` arguments are passed through bash. A naive
`send "Portfolio $10,000"` becomes `Portfolio 0,000` because bash expands
`$10` (empty positional arg). ALWAYS pipe via `--stdin`:

```bash
printf '%s' 'Paper cycle: regime=ranging. Top scores: AAVE 0.27, ETH 0.22. 0/16 BUY. Portfolio $10,000, PnL $0.' \
  | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

- Single quotes around `printf` prevent shell expansion at quote time
- `--stdin` reads the message after argv parsing → dollar signs render literally
- The `--stdin` flag was added in CLI 0.40.2; require ≥ 0.40.2

### 3. Summary content (≤500 chars)

Include:
- Regime + active thresholds
- Top 3 scores with action
- Lowest 1–2 scores
- Trades triggered / exits fired counts
- Portfolio value + daily PnL

If a paper trade fired, prepend `🎯 ENTRY:` or `✅ EXIT:` and include token,
direction, entry price, stop, take-profit, size.

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
