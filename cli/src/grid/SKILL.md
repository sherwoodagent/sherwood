---
name: sherwood-grid-strategy
description: Reference for the standalone ATR-based grid strategy — config, runtime, allocation, and PnL accounting.
tags: [sherwood, grid, paper-trading, hyperliquid, atr]
---

# Sherwood Grid Strategy

ATR-based concentrated grid that profits from ranging-market volatility on
BTC + ETH + SOL. Runs as a standalone event loop (1-min cycles) with
isolated capital, parallel to the directional agent.

## Runtime

- `sherwood grid start` — start the standalone event loop.
- `sherwood grid status` — print current grid state, fills, PnL.
- Grid does not run inside the directional agent loop. It has its own
  binary entry point and its own portfolio file.

## Configuration

Authoritative values live in `cli/src/grid/config.ts:DEFAULT_GRID_CONFIG`.

| Field                | Value                                       | Notes                                       |
|----------------------|---------------------------------------------|---------------------------------------------|
| tokens               | `bitcoin`, `ethereum`, `solana`             | CoinGecko IDs                               |
| allocationPct        | 0.50                                        | 50% of total portfolio carved out for grid  |
| leverage             | 5                                           | was 4 — +25% profit per round-trip          |
| levelsPerSide        | 15                                          | 15 buy levels below + 15 sell levels above  |
| atrMultiplier        | 2                                           | grid range = price ± (2 × ATR)              |
| atrPeriod            | 14                                          |                                             |
| rebalanceDriftPct    | 0.40                                        | was 0.55 — rebuild faster when price drifts |
| fullRebuildIntervalMs| 12 h                                        | full grid rebuild cadence                   |
| tokenSplit           | BTC 0.45 / ETH 0.30 / SOL 0.25              | must sum to 1.0                             |
| minProfitPerFillUsd  | 0.50                                        | fee-floor for skipping unprofitable fills   |
| pauseThresholdPct    | 0.20                                        | pause grid if pool drops 20% from start     |

## Capital Accounting

Grid runs with isolated capital — totally separate from directional. State
lives at `~/.sherwood/grid/portfolio.json`:

- per-token levels, open fills, cumulative PnL
- per-token `allocation` (USD)
- `totalAllocation`, pause flag, pause reason

To get true total capital across both strategies:
`portfolio.totalValue + gridAllocation`. The summary formatter
(`summary-formatter.ts`) combines both for the headline number.

## Cycle Behavior

Each 1-min cycle (`grid/loop.ts`):

1. Pull latest prices.
2. Match fills against active levels.
3. Pair each new fill with its opposite-side target (buy → sell at
   `targetSellPrice`).
4. Credit `pnlUsd` (post-leverage) on close, increment `totalRoundTrips`.
5. Rebalance: if price has drifted past `rebalanceDriftPct` of the range
   toward one edge, rebuild levels around the new center.
6. Full rebuild every `fullRebuildIntervalMs` regardless of drift.
7. Pause if cumulative drawdown exceeds `pauseThresholdPct`.

## Tuning Notes

- Higher leverage amplifies both sides — keep `minProfitPerFillUsd` ≥ fee
  cost at the chosen leverage level.
- Tighter `rebalanceDriftPct` (e.g. 0.40 vs 0.55) trades more rebalance
  cost for tighter level spacing around current price.
- `tokenSplit` is rebalance-on-rebuild, not continuous — drift inside a
  cycle does not get rebalanced until the next full rebuild.

## Live Deployment (Hyperliquid)

The grid runs in two modes:

**Simulation (default):** `sherwood grid start --capital 5000 --cycle 60`
- Simulates fills against price, no real orders
- Use for backtesting and tuning

**Live:** `sherwood grid start --capital 5000 --cycle 60 --live --asset-indices bitcoin=3,ethereum=4,solana=5`
- Places real GTC limit orders on Hyperliquid via the HL SDK
- Requires `HYPERLIQUID_PRIVATE_KEY` env var (the keeper EOA, must be the proposer)
- Asset indices are HyperCore perp asset IDs (BTC=3, ETH=4, SOL=5 as of 2026-04)

### Prerequisites for live mode

1. Deploy `HyperliquidGridStrategy` clone via a Sherwood proposal
2. Strategy's `_execute()` pulls vault USDC and parks it on HyperCore margin
3. Keeper EOA = proposer EOA (only the proposer can call `updateParams`)
4. Set `HYPERLIQUID_PRIVATE_KEY` to the proposer's key
5. Run `sherwood grid start --live ...` — the loop will compute orders each tick and submit them

### On-chain Mode (Vault Funds)

For vault-funded grid trading, deploy `HyperliquidGridStrategy` and pass its address:

```bash
sherwood --network hyperevm grid start \
  --capital 5000 --cycle 60 --live \
  --asset-indices bitcoin=3,ethereum=4,solana=5 \
  --strategy 0xYourStrategyAddress
```

Requirements:
- `HYPEREVM_RPC_URL` env var
- `PRIVATE_KEY` env var (the proposer EOA — only this address can call `updateParams`)
- Strategy contract already executed (vault USDC parked on HyperCore margin)

Without `--strategy`: orders go to the keeper's own HyperCore account via HL SDK
With `--strategy`: orders go through `strategy.updateParams()` so the strategy contract's HyperCore account (funded by vault) is used
