---
name: sherwood-grid-monitor
description: Monitor and report Sherwood grid strategy performance. Posts formatted status with PnL, round trips, fills, and per-token breakdown.
tags: [sherwood, grid, trading, paper-trading, hyperliquid, cron]
triggers:
  - run sherwood grid monitor
  - check grid performance
  - grid strategy status
---

# Sherwood Grid Monitor

Post a formatted grid performance report to the user. The grid runs as an independent service (`sherwood-grid.service`) on 1-minute cycles.

## Step 1: Check service health

```bash
systemctl --user is-active sherwood-grid
```

If not active, ALERT immediately and try to restart:
```bash
systemctl --user restart sherwood-grid
```

## Step 2: Get grid status

```bash
sherwood grid status
```

This prints a formatted table. Use its output as the base.

## Step 3: Get detailed stats for the report

```bash
python3 -c "
import json
from datetime import datetime

g = json.load(open('/home/ana/.sherwood/grid/portfolio.json'))
grids = g.get('grids', [])
init_ts = g.get('initializedAt', 0)
age_days = max(1, (datetime.now().timestamp() * 1000 - init_ts) / 86400000) if init_ts else 1

total_pnl = sum(grid['stats']['totalPnlUsd'] for grid in grids)
total_rts = sum(grid['stats']['totalRoundTrips'] for grid in grids)
total_alloc = sum(grid['allocation'] for grid in grids)
today_pnl = sum(grid['stats']['todayPnlUsd'] for grid in grids)
today_fills = sum(grid['stats']['todayFills'] for grid in grids)
daily_avg = total_pnl / age_days
monthly = daily_avg * 30

print(f'GRID STRATEGY REPORT')
print(f'━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
print()
print(f'💰 Total PnL: +\${total_pnl:.2f} ({total_rts} round trips)')
print(f'📊 Today: +\${today_pnl:.2f} ({today_fills} fills)')
print(f'📈 Daily avg: \${daily_avg:.2f}/day')
print(f'📅 Monthly projection: \${monthly:.0f}/month ({monthly/total_alloc*100:.0f}% ROI)')
print(f'💼 Allocation: \${total_alloc:,.0f}')
print(f'⏱️ Running: {age_days:.1f} days')
print()
for grid in grids:
    tok = grid['token'].upper()
    s = grid['stats']
    alloc = grid['allocation']
    daily_tok = s['totalPnlUsd'] / age_days
    print(f'{tok:6s}  PnL: +\${s[\"totalPnlUsd\"]:>7.2f}  RTs: {s[\"totalRoundTrips\"]:>3d}  Today: +\${s[\"todayPnlUsd\"]:>6.2f} ({s[\"todayFills\"]} fills)  \${daily_tok:.0f}/day')
print()
print(f'Status: {\"PAUSED\" if g.get(\"paused\") else \"ACTIVE\"}')
"
```

## Step 4: Post the report

Take the output from Step 3 and post it. Always include:
- Total PnL and round trips
- Today's PnL and fills
- Daily average and monthly projection
- Per-token breakdown
- Service status

## Output Policy

- ALWAYS post a report (this is a reporting cron, not anomaly-only)
- If service is DOWN, include 🚨 ALERT at the top
- If grid is PAUSED, include ⚠️ PAUSED warning
- If today's fills are 0 for >2 hours during market hours, note it as unusual
