# Strategy Tune v2 — Post Trade-Review Adjustments

**Date:** 2026-04-16
**Status:** Approved (brainstorm session)
**Branch:** `fix/sentiment-contrarian-thresholds` (continued)
**PR:** TBD
**Predecessor spec:** `2026-04-16-smarter-entries-adaptive-exits-design.md`

## Context

After the first full paper-trading window (9 closed trades, net +$45.64, NAV $10,023), the
`2026-04-16-smarter-entries-adaptive-exits-design` improvements are live. Review of the
trade log surfaced residual issues:

1. **BLUR#2** re-entered right after BLUR#1 take-profit → immediate stop-out (-$45.72).
   Cooldown logic only fires on stop-loss, not on TP / partial-TP.
2. **AAVE / LINK / RIPPLE** all entered in `ranging` regime with scores 0.23–0.24, never
   reached +3%, drifted down through stops. Ranging threshold 0.25 is too permissive.
3. **WLD runner** round-tripped from +3.2% peak to +0.6% exit — the trailing stop
   multiplier after partial profit is as wide as before partial, leaving too much slack.
4. **Exit slippage** of 0.3–0.5% below stop trigger observed on LINK, WLD, RIPPLE.
   RIPPLE in particular shows entry==exit with PnL=0, indicating the stop fill is being
   recorded at spot rather than at the trigger price.
5. **Partial at +3%** cuts trending winners (like BLUR#1 which ran to +6.4%) in half too
   early. Ranging wins should still bank at +3%, trending should breathe.
6. No **daily drawdown brake** exists — losing day can keep opening new positions.

## Goals

1. Eliminate the "re-enter immediately after TP" failure mode.
2. Drop ranging-regime noise trades (score 0.25–0.30 in ranging).
3. Preserve more profit on the post-partial runner half.
4. Reconcile paper-trade stop fills with the stop price (optimistic fill).
5. Let trending winners run by 1 extra point before the partial fires.
6. Pause new entries on bad days until the calendar flips.

## Non-Goals

- Changing the scoring weights themselves (still post-calibration stable).
- Adding new signal sources.
- Changing the regime classifier.
- Live execution changes — paper trading only.

---

## 1. Post-TP cooldown per token

**Files:** `cli/src/agent/risk.ts`, `cli/src/agent/portfolio.ts`

- Add `TP_COOLDOWN_MS = 2 * 60 * 60 * 1000` (2h).
- In `Portfolio.closePosition`, when `exitReason` matches `/Take profit|Partial profit/i`,
  write `stopCooldowns[tokenId] = Date.now()`. Keep existing behavior for stop-loss
  (4h already applied).
- In `RiskManager.shouldEnter`, compute the applicable cooldown per token:
  - If the last cooldown was a stop-loss → 4h (existing `STOP_COOLDOWN_MS`).
  - If it was a TP / partial → 2h (`TP_COOLDOWN_MS`).
- To distinguish the two, persist `stopCooldownKind: Record<string, 'stop' | 'tp'>`
  alongside `stopCooldowns`. Back-compat: missing entry defaults to `'stop'`.

**Acceptance:** After a partial-TP or TP exit, a BUY signal on the same token within
2h is rejected with reason `TP cooldown active for <token>`.

## 2. Ranging-regime entry threshold 0.25 → 0.30

**File:** `cli/src/agent/scoring.ts`

- Locate the ranging-regime BUY/SELL thresholds (currently `±0.25`).
- Change to `±0.30`.
- Trending-regime thresholds unchanged.
- Update `scoring.test.ts` cases that assert on the old threshold.

**Acceptance:** In ranging regime, a composite score of 0.27 returns `HOLD`, not `BUY`.

## 3. Tighter trail after partial exit

**Files:** `cli/src/agent/risk.ts`, `cli/src/agent/portfolio.ts`, `cli/src/agent/types.ts`

- Add `Position.trailMultAfterPartial?: number` (default 1.0).
- The trailing-stop computation (in `risk.ts`) currently uses a single ATR multiplier
  (`RECOMMENDED_TRAILING_CONFIG.atrMultiplier`, likely 2.0). Branch:
  - `partialTaken === true` → use `trailMultAfterPartial` (1.0)
  - else → existing multiplier
- When `Portfolio.closePartial` succeeds, also immediately recompute and persist a
  tightened `trailingStop` using the 1.0 multiplier so the next cycle reflects it.

**Acceptance:** On a long with ATR=2% and entry $100 that has taken partial at $103,
the trailing stop sits at `peakPrice − 1×ATR` rather than `peakPrice − 2×ATR`.

## 4. Exit slippage reconciliation + RIPPLE anomaly

**File:** `cli/src/agent/executor.ts`

In `processExits`, after the risk manager returns `toClose` + `reasons`:

- Parse the reason. If it contains `Stop loss hit at $<triggerPrice>`:
  - For longs, set `exitPrice = Math.max(triggerPrice, currentPrice)`.
  - For shorts, set `exitPrice = Math.min(triggerPrice, currentPrice)`.
  - This caps paper-trade stop slippage at zero — we assume a real exchange fills at or
    just beyond the stop.
  - **Scope note:** this is a paper-trading simulation choice only. When `mode` is
    `hyperliquid-perp` (live), the real fill price from the exchange is used and this
    reconciliation does not apply.
- Log a warning when `|currentPrice − triggerPrice| / triggerPrice > 0.003` so any
  future cadence-induced drift remains visible in cycle logs.
- Add `executor.test.ts` case: long with entry $100, stop $98, currentPrice $97.5 →
  recorded `exitPrice === 98` and PnL reflects the stop, not the spot.

**RIPPLE anomaly note:** With the max-of rule applied, the zero-PnL case (entry 1.40,
stop 1.407, exit 1.40 on a long) is impossible — the exit would record at 1.407, yielding
a tiny positive PnL for a trailing stop above entry.

## 5. Regime-aware partial-exit trigger

**Files:** `cli/src/agent/executor.ts`, `cli/src/agent/types.ts`,
`cli/src/agent/portfolio.ts`

- Add `Position.regimeAtEntry?: 'trending' | 'ranging'` (optional).
- `execution-pipeline` (or wherever `openPosition` is called) passes the regime from the
  current signal into the new position.
- In `processExits` partial logic, compute the trigger:
  ```ts
  const trigger = pos.regimeAtEntry === 'trending' ? 0.04 : 0.03;
  ```
- Ranging entries still partial at +3%; trending entries partial at +4%.
- Missing `regimeAtEntry` (legacy positions) → default 0.03.

**Acceptance:** A long opened in trending regime at $100 does not fire partial-TP at
$103, but does at $104.

## 6. Daily drawdown brake

**File:** `cli/src/agent/risk.ts`

- Add `DAILY_DRAWDOWN_BRAKE = -0.02` (−2%).
- In `shouldEnter`, compute:
  ```ts
  const startOfDayNav = state.totalValue - state.dailyPnl;
  const dayReturn = startOfDayNav > 0 ? state.dailyPnl / startOfDayNav : 0;
  if (dayReturn < DAILY_DRAWDOWN_BRAKE) {
    return { allowed: false, reason: `Daily drawdown brake (−${(dayReturn * -100).toFixed(2)}%)` };
  }
  ```
- Existing positions still exit normally; only new entries blocked.
- `lastDailyReset` already resets `dailyPnl` at the UTC day boundary — no new reset
  logic needed.

**Acceptance:** When `dailyPnl / startOfDayNav <= -0.02`, `shouldEnter` rejects all new
entries until the next daily reset.

---

## Data model changes

New optional `Position` fields (all default-safe for existing persisted positions):

```ts
interface Position {
  // … existing …
  regimeAtEntry?: 'trending' | 'ranging';
  trailMultAfterPartial?: number; // default 1.0
}
```

New optional `PortfolioState` field:

```ts
interface PortfolioState {
  // … existing …
  stopCooldownKind?: Record<string, 'stop' | 'tp'>;
}
```

## Version bump

`cli/package.json`: `0.41.0 → 0.42.0` (new features, no breaking API).

## Testing

- `risk.test.ts`:
  - rejects entry within TP cooldown (2h)
  - allows entry after TP cooldown expires
  - rejects entry when dailyPnl ≤ −2% of start-of-day NAV
  - allows entry when dailyPnl > −2%
- `portfolio.test.ts`:
  - closePartial sets `stopCooldowns[token]` with kind `'tp'`
  - closePosition with `Take profit` reason sets kind `'tp'`
  - closePosition with `Stop loss` reason sets kind `'stop'`
- `scoring.test.ts`:
  - ranging regime, score 0.27 → HOLD
  - ranging regime, score 0.31 → BUY
  - trending regime, score 0.26 → BUY (unchanged)
- `executor.test.ts`:
  - long stop-out records exitPrice at or above trigger
  - short stop-out records exitPrice at or below trigger
  - trending-regime partial trigger is 4%, ranging is 3%
  - partial exit tightens trailingStop

## Rollout

- Single commit series on `fix/sentiment-contrarian-thresholds`.
- Verify `forge build` n/a (no contract changes), `npm run typecheck` and `npm test`
  in `cli/`.
- Update PR description with trade-review context and acceptance criteria.
