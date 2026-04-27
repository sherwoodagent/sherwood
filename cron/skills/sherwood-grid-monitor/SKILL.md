---
name: sherwood-grid-monitor
description: Monitor the Sherwood grid trading strategy — check performance, fills, round trips, and alert on anomalies.
tags: [sherwood, grid, trading, paper-trading, hyperliquid, cron]
triggers:
  - run sherwood grid monitor
  - check grid performance
  - grid strategy status
---

# Sherwood Grid Monitor

Monitor the ATR-based grid trading strategy running on BTC/ETH/SOL perps.

## What the Grid Does

The grid places buy levels below price and sell levels above. When price oscillates, each buy→sell pair completes a "round trip" for profit. It profits from mean reversion in ranging markets.

## Config (current production)

- **Tokens**: BTC (45%), ETH (30%), SOL (25%)
- **Levels**: 15 per side (30 total per token)
- **Leverage**: 5x
- **Spacing**: ATR-based (adapts to volatility)
- **Rebalance**: rebuilds when price drifts 40% toward grid edge
- **Allocation**: 50% of portfolio (~$5,200)
- **Pause**: only in high-volatility regime

## Data Files

- Grid state: `~/.sherwood/agent/grid-portfolio.json`
- Cycle logs: `~/.sherwood/agent/cycles.jsonl`
- Agent service: `systemctl --user status sherwood-agent`

## Monitoring Procedure

1. **Check service is running**:
   ```bash
   systemctl --user is-active sherwood-agent
   ```

2. **Read grid stats**:
   ```bash
   python3 -c "
   import json
   g = json.load(open('/home/ana/.sherwood/agent/grid-portfolio.json'))
   for grid in g['grids']:
       s = grid['stats']
       print(f\"{grid['token'].upper():10s} RTs={s['totalRoundTrips']} PnL=\${s['totalPnlUsd']:+.2f} todayFills={s['todayFills']} todayPnL=\${s['todayPnlUsd']:+.2f}\")
   "
   ```

3. **Check last cycle for grid fills**:
   ```bash
   tail -1 ~/.sherwood/agent/cycles.jsonl | python3 -c "
   import json,sys
   c = json.loads(sys.stdin.readline())
   print(f\"Grid: {c.get('gridFills',0)} fills, {c.get('gridRoundTrips',0)} RTs, \${c.get('gridPnlUsd',0):+.2f}\")
   "
   ```

4. **Check for anomalies**:
   - If `todayFills == 0` for >2h during market hours → grid may be stale or paused
   - If `totalPnlUsd` decreased significantly → check if grid was rebuilt during a trend
   - If service is not active → restart: `systemctl --user restart sherwood-agent`

## Alert Criteria

Report ONLY if:
- Service is DOWN (not active)
- Grid has 0 fills for >2 hours during active market
- Any token grid has negative PnL today (unusual — grid should be net positive)
- Grid is paused (check `paused` field in grid-portfolio.json)

If everything is healthy, respond with: `[SILENT]`

## Performance Benchmarks

- Normal: 20-30 round trips/day across all tokens
- Good day: $150-250/day grid PnL
- Expected monthly: ~$3,600 (69% monthly ROI on $5,200 allocation)
- Weekly minimum: $500 (if below, investigate)
