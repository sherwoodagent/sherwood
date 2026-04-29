# Grid Trading Strategy — Design Spec

**Date:** 2026-04-21
**Status:** Approved
**Author:** Ana + Claude

## Problem

The directional signal-based agent sits idle 95% of cycles (37/732 active) because the market is ranging. Grid trading profits from volatility without predicting direction — capturing the micro-oscillations the directional model ignores.

## Architecture

Two new modules + minimal changes to existing code:

```
cli/src/agent/grid/
  grid-manager.ts       Core: level computation, fill simulation, rebalancing
  grid-portfolio.ts     Isolated capital tracking, persistence
  grid-config.ts        Constants, types, defaults
```

Existing changes:
- `loop.ts` — add `gridManager.tick(prices)` in runCycle (~10 lines)
- `summary-formatter.ts` — grid stats in XMTP message (~15 lines)
- `portfolio.ts` — one-time capital split on grid init (~20 lines)

No changes to: scoring, executor, risk, strategies, contracts.

## Capital Isolation

On first startup:
- Grid allocation: **35%** of total portfolio
- Directional allocation: remaining **65%**
- Persisted separately: `grid-portfolio.json` vs `portfolio.json`
- Grid profits compound in grid pool; directional never sees grid capital
- If grid pool drops **20%** from allocation → pause grid, alert

Within grid pool: **60% BTC / 40% ETH** (proportional to HL liquidity).

## Grid Level Computation

```
gridRange = currentPrice ± (2 × ATR14)
spacing   = (2 × ATR14) / levelsPerSide
levelSize = (tokenAllocation × leverage) / (levelsPerSide × currentPrice)
```

- **20 levels total** (10 buy below price, 10 sell above)
- **3x leverage** on grid capital
- ATR14 computed from HL 4h candles (already available)

Example: BTC at $85,000, ATR=$1,200:
- Range: $82,600 — $87,400
- Spacing: $240 per level
- Size: 0.0124 BTC per level

## Rebalancing

Every 5-min cycle:
1. Check if price within grid range → if yes, only check fills
2. If price drifted past **70%** of range toward one edge → **shift grid** (cancel far-side unfilled orders, place new near-side orders)
3. Full rebuild (all levels recomputed) on **ATR regime change (>20% shift)** or every **12 hours**

## Fill Simulation (Paper Trading)

Each 5-min tick:
```
for each level:
  BUY level: if currentPrice <= level.price → fill, create paired SELL one spacing above
  SELL level: if currentPrice >= level.price → fill
    if closes a prior buy → record profit = (sell - buy) × qty × leverage
    create paired BUY one spacing below
```

Multi-level sweeps: if price crosses N levels in one tick, all N fill at their respective prices.

Range breakout: filled positions held as directional exposure until rebalance shifts grid.

## Persistence

`~/.sherwood/agent/grid-portfolio.json`:
```typescript
interface GridState {
  token: string;
  levels: GridLevel[];
  filledPositions: GridFill[];
  stats: {
    totalRoundTrips: number;
    totalPnlUsd: number;
    todayPnlUsd: number;
    lastRebalanceAt: number;
  };
  config: {
    allocation: number;
    leverage: number;
    levelsPerSide: number;
    atrMultiplier: number;
  };
}
```

Atomic write via tmp-rename every tick (same pattern as portfolio.json).

## Configuration Defaults

```typescript
{
  enabled: true,
  tokens: ['bitcoin', 'ethereum'],
  allocationPct: 0.35,
  leverage: 3,
  levelsPerSide: 10,
  atrMultiplier: 2,
  atrPeriod: 14,
  rebalanceDriftPct: 0.70,
  fullRebuildIntervalMs: 43200000,  // 12h
  tokenSplit: { bitcoin: 0.60, ethereum: 0.40 },
  minProfitPerFillUsd: 0.50,
  pauseThresholdPct: 0.20,
}
```

## XMTP Summary Extension

```
💰 $10,366 (+3.66%)
   Directional: +$0.00 realized | -$43.70 open
   Grid: +$18.40 today (7 fills) | $3,628 allocated
```

## Success Criteria

- Grid generates positive daily PnL during ranging regime (>$5/day on $3.5k allocation)
- Grid fills are logged to `grid-portfolio.json` with full audit trail
- Directional strategy unaffected (same scoring, thresholds, risk management)
- Service restart preserves grid state (no orphaned positions)
- Capital isolation enforced (grid pool independent of directional)

## Out of Scope

- Live execution (paper trading only for this iteration)
- Grid on tokens other than BTC/ETH
- Dynamic allocation adjustment between grid and directional
- Grid-specific risk management beyond the 20% pause threshold
