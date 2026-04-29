# Smarter Entries + Adaptive Exits

**Date:** 2026-04-16
**Status:** Approved (brainstorm session)
**Branch:** TBD (new feature branch off main)
**PR:** TBD

## Context

First 12h of paper-trading data (15 Apr 20:53 – 16 Apr 10:40 UTC) revealed:
- 7 of 15 tokens opened positions, 90% capital deployed, 10% cash left
- 20.4% BUY rate across 338 signals — too many marginal entries (e.g. BLUR @ 0.25)
- 2 closed trades: 1 TP (+6.43%), 1 stop (-4.55%). Net +$18 but BLUR re-entered 24 min after stop → second loss
- Fixed 3% stop too tight for high-volatility alts (BLUR ATR ~8%)
- No trailing stop, no breakeven protection, no partial exits active
- 100% `ranging` regime — no adaptation

## Goals

1. **Higher-quality entries** — fewer trades, each with more conviction and more capital
2. **Adaptive exits** — ATR-based stops, trailing protection, partial exits, cooldown post-stop

## Non-Goals

- Changing the scoring engine or signal weights (stable post-calibration)
- Adding new signal sources
- Changing the regime classifier
- Live (on-chain) execution changes — paper trading only

---

## Section 1: Score-Based Entry Filter + Conviction Sizing

### 1.1 Raise ranging BUY threshold: 0.25 → 0.30

`scoring.ts` REGIME_THRESHOLDS for `ranging`:
```
Before: { strongBuy: 0.55, buy: 0.25, sell: -0.25, strongSell: -0.55 }
After:  { strongBuy: 0.55, buy: 0.30, sell: -0.30, strongSell: -0.55 }
```

Rationale: overnight, tokens scoring 0.25–0.29 (BLUR, SUI, WLD, LINK, SOL, XRP) added noise. Only AAVE (0.33), ETHENA (0.39), ETH (0.30) had genuine directional signal. The 0.25 threshold was a stopgap from the prior session; 0.30 is the validated level.

### 1.2 Conviction-scaled position sizing

New sizing multiplier in `executor.ts`, applied AFTER `calculatePositionSize()`:

| Score range | Label | Size multiplier |
|---|---|---|
| 0.30 – 0.35 | base | 1.0x |
| 0.35 – 0.45 | high conviction | 1.5x |
| 0.45+ | very high conviction | 2.0x |

The multiplier applies to `sizing.sizeUsd` and `sizing.quantity`. Caps still enforced by `maxSinglePosition`.

### 1.3 Position limits

| Parameter | Before | After |
|---|---|---|
| `maxConcurrentTrades` | 8 | 5 |
| `maxSinglePosition` | 10% | 20% |

With fewer entries (threshold 0.30) and conviction sizing (1.0–2.0x), 5 positions × ~$2k-3k ≈ $10k-15k deployed. Keeps ~30-40% cash free for better opportunities.

### Expected overnight effect

3-4 entries instead of 7. BLUR never enters. AAVE/ETHENA get 1.5x sizing (~$1.5k). Cash remains ~$5-6k.

---

## Section 2: ATR-Based Stops + Cooldown Post-Stop

### 2.1 Dynamic stop-loss: 1.5 × ATR-14

Replace the fixed `STOP_LOSS_PCT = 0.03` in `executor.ts` with ATR-derived distance:

```
stopDistance = clamp(1.5 × (ATR-14 / currentPrice), 0.02, 0.10)
stopLossPrice = isShort ? entry + entry * stopDistance : entry - entry * stopDistance
takeProfitPrice = entry ± (stopDistance * RR_RATIO)  // RR_RATIO stays at 2.0
```

| Asset class | Typical ATR-14 % | Stop distance | TP distance |
|---|---|---|---|
| BTC | ~2% | 3% | 6% |
| ETH | ~3% | 4.5% | 9% |
| Large alts (AAVE, LINK) | ~4% | 6% | 12% |
| Memes/microcaps (BLUR, FARTCOIN) | ~8% | 10% (cap) | 20% |

Floor: 2% (never less). Cap: 10% (limits blowup on shitcoins).

**ATR source:** `getLatestSignals(candles)` already computes ATR-14 in `technical.ts`. The executor needs it passed through. Options:
- (a) Executor calls `getLatestSignals()` directly (adds a CoinGecko OHLC fetch per trade — slow)
- (b) The analysis result (`TokenAnalysis`) already includes `technicals.atr` — pass it through the decision → executor chain
- **(b) is preferred** — no extra API call; ATR is already computed during the scan cycle

### 2.2 Post-stop cooldown per token

After a stop loss fires on token X:
- Record `lastStopTimestamp[tokenId] = Date.now()` in portfolio state
- `canOpenPosition(tokenId)` rejects for **4 hours** after a stop
- Prevents the BLUR pattern (stop 00:55 → re-entry 01:19 → second stop 04:15)

Implementation: add `stopCooldowns: Record<string, number>` to `PortfolioState`. `RiskManager.canOpenPosition()` checks it. `closePosition()` writes it when `exitReason` contains "stop".

### Expected overnight effect

BLUR#1: stop at ~12% instead of 3% → likely survives the -4.5% dip. If it does stop, cooldown blocks the re-entry. Net BLUR P&L: +$64 (TP only) or $0 (wider stop, no second trade) — both better than the actual +$18.

---

## Section 3: Trailing Stop Adaptativo + Partial Exits

### 3.1 Activate existing trailing infrastructure

`risk.ts` already has `trailingStopPct`, `breakevenTriggerPct`, and `profitLockSteps` — all defaulting to OFF (0 / []). Activate with ATR-derived values:

```
trailingStopPct = 1.0 × (ATR-14 / currentPrice)   // tighter than the initial 1.5×ATR stop
breakevenTriggerPct = 0.015                          // move to breakeven after +1.5% gain
profitLockSteps = [
  { trigger: 0.02, lock: 0.005 },   // after +2%, lock in +0.5%
  { trigger: 0.04, lock: 0.02 },    // after +4%, lock in +2%
]
```

Trailing stop only ratchets — stops never loosen. Already implemented for both longs and shorts in `updateTrailingStops()`.

The trailingStopPct and profitLockSteps should be ATR-derived per position instead of global config. This means storing the ATR-at-entry on each `Position` and computing trail distance from it.

### 3.2 Partial exit at +3% gain (new)

When a position reaches +3% unrealized gain:
- Close **50%** of the position (realized profit)
- Trailing stop activates on the remaining 50%
- The remaining runner can ride to TP or trail out

Implementation:
- `executor.processExits()` already iterates positions and checks conditions
- Add a new exit type: `PARTIAL_PROFIT` — calls `closePartialPosition(tokenId, 0.5, price, reason)`
- `portfolio.ts` needs a `closePartial(tokenId, fraction, exitPrice, reason)` method that:
  - Reduces `quantity` by `fraction`
  - Records the partial trade in `trades.json`
  - Keeps the remaining position with original entry + stops
- Flag `partialTaken: boolean` on Position to prevent re-triggering

### 3.3 Protection sequence (lifecycle of a long trade)

```
Entry (score ≥ 0.30)
  │
  ├─ Stop: entry - 1.5×ATR (ATR-adaptive, 2–10% range)
  ├─ TP:   entry + 3.0×ATR (2:1 R:R on the ATR stop)
  │
  ▼ +1.5% gain
  │  → Stop moves to breakeven (entry price)
  │
  ▼ +2% gain
  │  → Profit-lock: stop = entry + 0.5%
  │
  ▼ +3% gain
  │  → PARTIAL EXIT: close 50%, realize profit
  │  → Trailing stop activates on remaining 50% (1×ATR trail)
  │
  ▼ +4% gain
  │  → Profit-lock: stop = entry + 2% (on remaining 50%)
  │
  ▼ +6%+ or trail hit
     → Full exit (TP or trailing stop)
```

For shorts: symmetric inverse.

### Expected overnight effect

ETHENA (+1.55% at 14h hold): breakeven activated, if it reverses exits at zero instead of stop. If it reaches +3%, half is banked. AAVE (-1.18%): no trailing activated (still negative), ATR-based stop gives it more room (~6% for AAVE vs 3% fixed).

---

## Files to modify

| File | Changes |
|---|---|
| `cli/src/agent/scoring.ts` | Ranging threshold 0.25 → 0.30 |
| `cli/src/agent/executor.ts` | Conviction sizing multiplier, ATR-based stop/TP calculation, pass ATR from analysis |
| `cli/src/agent/risk.ts` | `maxConcurrentTrades` 8→5, `maxSinglePosition` 10%→20%, cooldown map, `DEFAULT_RISK_CONFIG` activate trailing/breakeven/profitLock, per-position ATR storage |
| `cli/src/agent/portfolio.ts` | `closePartial()` method, `stopCooldowns` in state, `partialTaken` flag on Position |
| `cli/src/agent/loop.ts` | Pass ATR value from analysis to executor |
| `cli/src/agent/index.ts` | Include ATR in `TokenAnalysis` return |
| `cli/src/agent/backtest.ts` | Mirror ATR-based stops + partial exits for consistent backtesting |
| `cli/src/agent/risk.test.ts` | Cooldown tests, conviction sizing tests |
| `cli/src/agent/portfolio.test.ts` | Partial close tests |
| `cli/src/agent/scoring.test.ts` | Update ranging threshold test |

## Risks

1. **ATR from CoinGecko candles may lag.** CoinGecko OHLC for 30 days gives daily candles — ATR-14 reflects 14-day volatility, not intraday. For a 15-min trading cycle this is a coarse proxy. Acceptable for paper trading; for live would need higher-resolution candles.
2. **Partial exit adds complexity to position tracking.** PnL accounting for a position that's been partially closed is non-trivial (realized vs unrealized). The `trades.json` record needs to reflect partial fills.
3. **Conviction sizing 2.0x with 20% max-single-position means one trade can be $2k on $10k.** A stop at 10% (cap for volatile alts) = $200 max loss per trade = 2% of portfolio. Within acceptable risk.
