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

## State directory

By default the grid writes to `~/.sherwood/grid/`. Operators running multiple
grids in parallel (e.g. paper + live) pass `--state-dir` to isolate state. If
this monitor needs to report on a non-default directory, set the
`GRID_STATE_DIR` env var (e.g. `GRID_STATE_DIR=~/.sherwood/grid-live`); the
report below resolves all reads from that base.

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
# If GRID_STATE_DIR is set, forward it to the CLI so the status is for the
# right process. Otherwise this falls through to the default ~/.sherwood/grid.
sherwood grid status ${GRID_STATE_DIR:+--state-dir "$GRID_STATE_DIR"}
```

This prints a formatted table. Use its output as the base.

## Step 3: Get detailed stats for the report

```bash
python3 -c "
import json, os
from datetime import datetime

home = os.path.expanduser('~')
state_dir = os.environ.get('GRID_STATE_DIR') or os.path.join(home, '.sherwood', 'grid')
state_dir = os.path.expanduser(state_dir)
g = json.load(open(os.path.join(state_dir, 'portfolio.json')))
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
roi_pct = (monthly / total_alloc * 100) if total_alloc > 0 else 0

# As of the leverage double-count fix (PR #265, commit 4e5dee5),
# stats.totalPnlUsd represents REAL dollar PnL. Historically it was
# inflated by leverage (×5 at default config). If you compare to old
# reports the numbers will look ~5x smaller — that's the honest figure.

# Pull leverage + exposure-cap config so we can spot capped grids.
# Cron runs in a separate process; we recover config by reading the
# initial grid config from cycles.jsonl if available, else assume
# defaults (lev=5, multiple=2.0).
leverage = 5
max_open_multiple = 2.0
downtrend_block_pct = 0.10
cycles_path = os.path.join(state_dir, 'cycles.jsonl')

# Hedge stats (delta-neutral hedging PnL)
hedge_path = os.path.join(state_dir, 'hedge.json')
hedge_realized = 0.0
hedge_today = 0.0
hedge_count = 0
hedge_unrealized = 0.0
try:
    h = json.load(open(hedge_path))
    hedge_realized = h.get('totalRealizedPnl', 0.0)
    hedge_today = h.get('todayRealizedPnl', 0.0)
    hedge_count = len([p for p in h.get('positions', []) if p.get('quantity', 0) > 0])
except (FileNotFoundError, json.JSONDecodeError):
    pass
# Unrealized hedge PnL from latest cycle log
try:
    with open(cycles_path) as f:
        lines = f.readlines()
    if lines:
        last = json.loads(lines[-1])
        hedge_unrealized = last.get('hedgeUnrealizedPnl', 0.0)
except (FileNotFoundError, json.JSONDecodeError):
    pass

print(f'GRID STRATEGY REPORT')
print(f'━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
print()
print(f'💰 Total PnL: \${total_pnl:+.2f} ({total_rts} round trips)')
print(f'🛡️ Hedge: \${hedge_realized:+.2f} realized, \${hedge_unrealized:+.2f} unrealized ({hedge_count} active)')
print(f'📊 Today: \${today_pnl:+.2f} grid ({today_fills} fills) | \${hedge_today:+.2f} hedge')
print(f'📈 Daily avg: \${daily_avg:+.2f}/day')
print(f'📅 Monthly projection: \${monthly:+.0f}/month ({roi_pct:+.0f}% ROI)')
print(f'💼 Allocation: \${total_alloc:,.0f}')
print(f'⏱️ Running: {age_days:.1f} days')
print()
for grid in grids:
    tok = grid['token'].upper()
    s = grid['stats']
    alloc = grid['allocation']
    daily_tok = s['totalPnlUsd'] / age_days
    # Trend (set at last grid build / hourly tick refresh).
    trend = grid.get('trend', 0.0) * 100  # to %
    trend_marker = ''
    if trend <= -downtrend_block_pct * 100:
        trend_marker = ' 🔻 DOWNTREND (buys blocked)'
    elif trend >= 5.0:
        trend_marker = ' 📈'
    elif trend <= -2.0:
        trend_marker = ' 📉'
    # Exposure-cap detection: sum entry notional of open fills.
    open_fills = [f for f in grid.get('openFills', []) if not f.get('closed', False)]
    open_count = len(open_fills)
    open_notional = sum(f.get('quantity', 0) * f.get('buyPrice', 0) for f in open_fills)
    exposure_cap = alloc * leverage * max_open_multiple
    cap_pct = (open_notional / exposure_cap * 100) if exposure_cap > 0 else 0
    cap_marker = ' ⛔ AT CAP' if cap_pct >= 95 else (' ⚠️ near cap' if cap_pct >= 80 else '')
    print(f'{tok:6s}  PnL: \${s[\"totalPnlUsd\"]:>+7.2f}  RTs: {s[\"totalRoundTrips\"]:>3d}  Today: \${s[\"todayPnlUsd\"]:>+6.2f} ({s[\"todayFills\"]} fills)  \${daily_tok:+.0f}/day')
    print(f'        opens: {open_count}  trend: {trend:+.1f}%{trend_marker}  exposure: {cap_pct:.0f}% of cap{cap_marker}')
print()
paused = g.get('paused', False)
pause_reason = g.get('pauseReason', '')
if paused:
    print(f'⚠️ Status: PAUSED — {pause_reason or \"<no reason recorded>\"}')
    print(f'   Resume: \`sherwood grid resume\` (or wait for auto-resume when pool recovers)')
else:
    print(f'✅ Status: ACTIVE')
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
- If grid is PAUSED, include ⚠️ PAUSED warning AND the pause reason. If reason mentions "Manually paused by operator", note it's intentional and don't escalate. If it's auto-pause from `pauseThresholdPct`, include the current drop % and the resume threshold so the user knows when it will auto-resume.
- If any token shows `🔻 DOWNTREND (buys blocked)`, note that the downtrend filter is active for that token — buys are paused until trend recovers above `-10%`.
- If any token shows `⛔ AT CAP`, note that the exposure cap is active — no new buys until existing fills close. Common in extended downtrends.
- If today's fills are 0 for >2 hours during market hours AND nothing above is filtering buys, that's a real anomaly — surface it.

## Notes on PnL units (post PR #265)

Sherwood PR #265 fixed a long-standing leverage double-count bug in `manager.simulateFills`. After that fix, `stats.totalPnlUsd` reports the REAL dollar PnL (matches exchange records). Historical reports were inflated by `leverage` (×5 at default). If today's PnL number looks ~5× smaller than reports from before 2026-05-01, that's the honest figure — not a regression.
