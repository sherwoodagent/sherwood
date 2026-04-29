# Smarter Entries + Adaptive Exits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed 3% stop / 6% TP with ATR-adaptive exits, add conviction-scaled sizing, post-stop cooldown, trailing stops, and partial exits — all informed by the first 12h of paper-trading data.

**Architecture:** Pass ATR from the analysis result through to the executor so stop/TP distances adapt per-asset. New `convictionMultiplier()` scales position size by score band. Activate the existing trailing/breakeven/profit-lock infrastructure in risk.ts with per-position ATR storage. Add `closePartial()` to portfolio for 50% profit-taking. Post-stop cooldown via `stopCooldowns` map on PortfolioState.

**Tech Stack:** TypeScript, vitest, sherwood CLI (cli/src/agent/)

---

### Task 1: Raise ranging BUY threshold + update tests

**Files:**
- Modify: `cli/src/agent/scoring.ts:126-136` (REGIME_THRESHOLDS)
- Modify: `cli/src/agent/scoring.test.ts` (ranging threshold test)
- Modify: `cli/src/agent/risk.ts:82-97` (DEFAULT_RISK_CONFIG — maxConcurrentTrades, maxSinglePosition)

- [ ] **Step 1: Update scoring.ts REGIME_THRESHOLDS**

In `cli/src/agent/scoring.ts`, change the `ranging` row at ~line 130:

```ts
// Before
"ranging":        { strongBuy: 0.55, buy: 0.25, sell: -0.25, strongSell: -0.55 },

// After
"ranging":        { strongBuy: 0.55, buy: 0.30, sell: -0.30, strongSell: -0.55 },
```

Update the comment above to note this is reverting to 0.30 based on paper-trading data (0.25 was too loose — let marginal entries like BLUR @ 0.25 through).

- [ ] **Step 2: Update scoring.test.ts ranging threshold test**

Find the test "ranging regime fires BUY at the lowered 0.25 threshold". Change signal values from 0.27 to 0.32, expectations from 0.25 to 0.30:

```ts
it("ranging regime fires BUY at the 0.30 threshold", () => {
  const signals: Signal[] = [
    makeSignal("technical", 0.32),
    makeSignal("sentiment", 0.32),
    makeSignal("onchain", 0.32),
  ];
  const rangingDecision = computeTradeDecision(
    signals, undefined, undefined, undefined, "ranging",
  );
  expect(rangingDecision.score).toBeGreaterThan(0.30);
  expect(rangingDecision.score).toBeLessThan(0.4);
  expect(rangingDecision.action).toBe("BUY");
  expect(rangingDecision.thresholds?.buy).toBe(0.30);
  expect(rangingDecision.thresholds?.sell).toBe(-0.30);
});
```

- [ ] **Step 3: Update risk.ts DEFAULT_RISK_CONFIG**

In `cli/src/agent/risk.ts`, update two fields in DEFAULT_RISK_CONFIG:

```ts
// Before
maxSinglePosition: 0.10,
maxConcurrentTrades: 8,

// After
maxSinglePosition: 0.20,
maxConcurrentTrades: 5,
```

- [ ] **Step 4: Run tests**

```bash
cd cli && npm run typecheck && npm test -- src/agent/scoring.test.ts src/agent/risk.test.ts
```

Expected: all pass (the risk tests don't assert specific maxConcurrentTrades or maxSinglePosition values — only the scoring test changes).

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent/scoring.ts cli/src/agent/scoring.test.ts cli/src/agent/risk.ts
git commit -m "fix(agent): raise ranging threshold 0.25→0.30, reduce max positions 8→5, bump max-single 10%→20%

Paper trading showed 7/15 tokens opening positions with 90% capital
deployed. Tokens scoring 0.25-0.29 (BLUR, SUI, WLD, LINK) added noise.
Raising to 0.30 filters marginals while keeping genuine signals (AAVE
0.33, ETH 0.30, ETHENA 0.39). Fewer but bigger positions via max-single
20% and max-concurrent 5."
```

---

### Task 2: Add ATR to the executor chain

**Files:**
- Modify: `cli/src/agent/executor.ts:85-94` (execute signature + stop/TP calc)
- Modify: `cli/src/agent/loop.ts:243` (pass ATR to execute)

- [ ] **Step 1: Add `atr` param to executor.execute()**

In `cli/src/agent/executor.ts`, update the execute() method signature (~line 85):

```ts
// Before
async execute(
  decision: TradeDecision,
  tokenId: string,
  currentPrice: number,
): Promise<{...}>

// After
async execute(
  decision: TradeDecision,
  tokenId: string,
  currentPrice: number,
  atr?: number,
): Promise<{...}>
```

- [ ] **Step 2: Replace fixed STOP_LOSS_PCT with ATR-derived stop**

In `executor.ts`, replace the fixed constants (~lines 163-167) with ATR-adaptive calculation:

```ts
// Before
const STOP_LOSS_PCT = 0.03;
const RR_RATIO = 2.0;
const stopLossDistance = currentPrice * STOP_LOSS_PCT;

// After
const RR_RATIO = 2.0;
const ATR_STOP_MULTIPLIER = 1.5;
const STOP_FLOOR = 0.02;   // minimum 2%
const STOP_CAP = 0.10;     // maximum 10%
const FALLBACK_STOP = 0.03; // when no ATR available

const atrPct = (atr && currentPrice > 0 && !isNaN(atr))
  ? atr / currentPrice
  : FALLBACK_STOP / ATR_STOP_MULTIPLIER; // fallback yields 3% stop
const stopPct = Math.min(STOP_CAP, Math.max(STOP_FLOOR, atrPct * ATR_STOP_MULTIPLIER));
const stopLossDistance = currentPrice * stopPct;
```

The rest of the stop/TP calculation stays the same (it already uses `stopLossDistance`).

- [ ] **Step 3: Pass ATR from loop.ts to executor**

In `cli/src/agent/loop.ts`, update the execute call (~line 243):

```ts
// Before
const execResult = await this.executor.execute(result.decision, result.token, currentPrice);

// After
const atr = result.data?.technicalSignals?.atr;
const execResult = await this.executor.execute(result.decision, result.token, currentPrice, atr);
```

- [ ] **Step 4: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: clean (atr is optional param — all existing callers still work).

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent/executor.ts cli/src/agent/loop.ts
git commit -m "feat(agent): ATR-based stop/TP — 1.5×ATR stop with 2-10% clamp

Replaces fixed 3% stop / 6% TP with ATR-14 derived distances. BTC
(ATR ~2%) keeps ~3% stop, ETH gets ~4.5%, volatile alts up to 10%
cap. Prevents premature stops on high-vol assets like BLUR (ATR ~8%)
that whip 3% in minutes. ATR flows from analysis result through
loop.ts to executor — no extra API call."
```

---

### Task 3: Conviction-scaled sizing

**Files:**
- Modify: `cli/src/agent/executor.ts` (add convictionMultiplier, apply after sizing)

- [ ] **Step 1: Add convictionMultiplier function**

In `cli/src/agent/executor.ts`, add a helper after the class declaration (before execute method) or as a private method:

```ts
/** Score-based position sizing multiplier. Higher-conviction entries get larger positions. */
function convictionMultiplier(score: number): number {
  const absScore = Math.abs(score);
  if (absScore >= 0.45) return 2.0;
  if (absScore >= 0.35) return 1.5;
  return 1.0;
}
```

- [ ] **Step 2: Apply conviction multiplier alongside pyramid multiplier**

In `executor.ts`, after the pyramid sizeMultiplier calculation (~line 180), add conviction:

```ts
// After existing pyramid sizeMultiplier computation
const conviction = convictionMultiplier(decision.score);

// Apply both: pyramid haircut × conviction boost
const pyramidQuantity = sizing.quantity * sizeMultiplier * conviction;
const pyramidSizeUsd = sizing.sizeUsd * sizeMultiplier * conviction;
```

Note: `maxSinglePosition` (now 20%) is still enforced by `canOpenPosition` downstream, so conviction 2.0x won't exceed the cap.

- [ ] **Step 3: Run typecheck + test**

```bash
cd cli && npm run typecheck && npm test
```

Expected: clean. Existing tests don't assert specific sizing values — they test risk gates.

- [ ] **Step 4: Commit**

```bash
git add cli/src/agent/executor.ts
git commit -m "feat(agent): conviction-scaled sizing — 1.0x/1.5x/2.0x by score band

Score 0.30-0.35: 1.0x (base). Score 0.35-0.45: 1.5x. Score 0.45+:
2.0x. Applied alongside pyramid haircut. maxSinglePosition (20%) still
caps total size. Net effect: AAVE at score 0.33 gets 1.0x, ETHENA at
0.39 gets 1.5x — concentrates capital on higher-conviction entries."
```

---

### Task 4: Post-stop cooldown

**Files:**
- Modify: `cli/src/agent/risk.ts` (Position type + canOpenPosition + PortfolioState)
- Modify: `cli/src/agent/portfolio.ts` (write cooldown on stop-loss close)
- Create: test additions in `cli/src/agent/risk.test.ts`

- [ ] **Step 1: Add stopCooldowns to PortfolioState**

In `cli/src/agent/risk.ts`, add to the PortfolioState interface:

```ts
export interface PortfolioState {
  // ... existing fields ...
  /** Token → timestamp of last stop-loss exit. Used to enforce cooldown
   *  before re-entry to prevent the stop-reentry-stop pattern. */
  stopCooldowns?: Record<string, number>;
}
```

- [ ] **Step 2: Add cooldown constant and check to canOpenPosition**

In `cli/src/agent/risk.ts`, add the constant near MAX_PYRAMID_ADDS:

```ts
export const STOP_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours after a stop-loss
```

In `canOpenPosition()`, add a check BEFORE the existing position check (around line 185):

```ts
// Check post-stop cooldown — prevent rapid re-entry after a stop loss
const cooldowns = this.portfolio.stopCooldowns ?? {};
const lastStop = cooldowns[token];
if (lastStop !== undefined) {
  const elapsed = Date.now() - lastStop;
  if (elapsed < STOP_COOLDOWN_MS) {
    const remainHrs = ((STOP_COOLDOWN_MS - elapsed) / 3_600_000).toFixed(1);
    return { allowed: false, reason: `Stop cooldown active for ${token} (${remainHrs}h remaining)` };
  }
}
```

- [ ] **Step 3: Write cooldown on stop-loss close in portfolio.ts**

In `cli/src/agent/portfolio.ts`, in `closePosition()` method, after recording the trade and before returning (~line 350), add:

```ts
// Record stop-loss cooldown to prevent rapid re-entry
if (reason.toLowerCase().includes('stop')) {
  if (!this.state.stopCooldowns) this.state.stopCooldowns = {};
  this.state.stopCooldowns[tokenId] = Date.now();
}
```

- [ ] **Step 4: Write cooldown test**

In `cli/src/agent/risk.test.ts`, add:

```ts
it("rejects entry during post-stop cooldown", () => {
  rm.updatePortfolio({
    totalValue: 50000,
    cash: 40000,
    positions: [],
    stopCooldowns: { bitcoin: Date.now() - 1000 }, // stopped 1 sec ago
  });
  const result = rm.canOpenPosition("bitcoin", 500, "long");
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/Stop cooldown/);
});

it("allows entry after stop cooldown expires", () => {
  rm.updatePortfolio({
    totalValue: 50000,
    cash: 40000,
    positions: [],
    stopCooldowns: { bitcoin: Date.now() - 5 * 60 * 60 * 1000 }, // 5h ago
  });
  const result = rm.canOpenPosition("bitcoin", 500, "long");
  expect(result.allowed).toBe(true);
});
```

Note: `updatePortfolio` accepts `Partial<PortfolioState>`, so passing `stopCooldowns` works with the existing interface. Add `stopCooldowns` to the spread type if the compiler complains.

- [ ] **Step 5: Run tests**

```bash
cd cli && npm run typecheck && npm test -- src/agent/risk.test.ts src/agent/portfolio.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add cli/src/agent/risk.ts cli/src/agent/portfolio.ts cli/src/agent/risk.test.ts
git commit -m "feat(agent): 4h post-stop cooldown — prevent stop-reentry-stop pattern

After a stop loss fires, the token enters a 4h cooldown before new
entries are allowed. Prevents the BLUR pattern (stop 00:55, re-entry
01:19, second stop 04:15). Cooldown stored as stopCooldowns map on
PortfolioState, persisted to portfolio.json."
```

---

### Task 5: Per-position ATR storage + activate trailing infrastructure

**Files:**
- Modify: `cli/src/agent/risk.ts` (Position type + DEFAULT_RISK_CONFIG)
- Modify: `cli/src/agent/executor.ts` (store atrAtEntry on Position, set trailing config)
- Modify: `cli/src/agent/portfolio.ts` (openPosition accepts atrAtEntry)

- [ ] **Step 1: Add atrAtEntry and partialTaken to Position**

In `cli/src/agent/risk.ts`, add to the Position interface:

```ts
export interface Position {
  // ... existing fields ...
  /** ATR-14 at the time of entry. Used for per-position trailing stop
   *  distance (1.0×ATR) and breakeven trigger calibration. */
  atrAtEntry?: number;
  /** Whether the 50% partial-profit exit has been taken. Prevents
   *  re-triggering on subsequent cycles. */
  partialTaken?: boolean;
}
```

- [ ] **Step 2: Activate trailing/breakeven/profitLock defaults in DEFAULT_RISK_CONFIG**

In `cli/src/agent/risk.ts`, update DEFAULT_RISK_CONFIG:

```ts
// Before
trailingStopPct: 0,         // OFF
breakevenTriggerPct: 0,     // OFF
profitLockSteps: [],        // OFF

// After
trailingStopPct: 0.025,              // 2.5% fallback trail (overridden per-position by ATR when available)
breakevenTriggerPct: 0.015,          // move to breakeven after +1.5% gain
profitLockSteps: [
  { trigger: 0.02, lock: 0.005 },   // after +2%, lock in +0.5%
  { trigger: 0.04, lock: 0.02 },    // after +4%, lock in +2%
],
```

- [ ] **Step 3: Store atrAtEntry when opening positions**

In `cli/src/agent/executor.ts`, in the `executeDryRun` method, add `atrAtEntry` to the openPosition call:

```ts
// In executeDryRun, inside the openPosition call:
const position = await this.portfolio.openPosition({
  tokenId: order.tokenId,
  symbol: order.tokenId.toUpperCase(),
  side: direction,
  entryPrice: currentPrice,
  currentPrice,
  quantity,
  entryTimestamp: Date.now(),
  stopLoss: order.stopLoss,
  takeProfit: order.takeProfit,
  strategy: 'paper',
  atrAtEntry: this.lastAtr,  // see next step
});
```

Store the ATR on the executor instance for the current trade:

In `execute()`, right after the ATR-based stop calculation, stash it:

```ts
// After computing stopPct
this.lastAtr = atr;  // store for executeDryRun/executeLive to pick up
```

Add the instance field at the top of TradeExecutor class:

```ts
private lastAtr?: number;
```

Do the same for the `executeLive` branch and for the pyramid `addToPosition` path.

- [ ] **Step 4: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: clean. All new fields are optional.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent/risk.ts cli/src/agent/executor.ts cli/src/agent/portfolio.ts
git commit -m "feat(agent): per-position ATR storage + activate trailing/breakeven/profit-lock

Store atrAtEntry on each Position for per-asset trailing stop distance.
Activate the existing trailing/breakeven/profitLock infrastructure in
DEFAULT_RISK_CONFIG that was previously OFF by default:
- breakevenTriggerPct: 0.015 (move to entry after +1.5%)
- profitLockSteps: +2%→lock 0.5%, +4%→lock 2%
- trailingStopPct: 0.025 (2.5% fallback, overridden per-position by ATR)"
```

---

### Task 6: Partial exit at +3% gain

**Files:**
- Modify: `cli/src/agent/portfolio.ts` (add closePartial method)
- Modify: `cli/src/agent/executor.ts` (add partial exit check to processExits)
- Modify: `cli/src/agent/risk.ts` (checkExits returns partial-profit candidates)
- Add tests: `cli/src/agent/portfolio.test.ts`

- [ ] **Step 1: Add closePartial() to PortfolioTracker**

In `cli/src/agent/portfolio.ts`, add after `closePosition()`:

```ts
/**
 * Close a fraction of a position. Records a partial trade and reduces
 * the position's quantity. Entry price and stops are preserved.
 */
async closePartial(
  tokenId: string,
  fraction: number,
  exitPrice: number,
  reason: string,
): Promise<{ pnl: number; pnlPercent: number; quantityClosed: number }> {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error(`Invalid fraction: ${fraction} (must be between 0 and 1 exclusive)`);
  }
  await this.load();

  const idx = this.state.positions.findIndex((p) => p.tokenId === tokenId);
  if (idx === -1) throw new Error(`No open position for ${tokenId}`);

  const pos = this.state.positions[idx]!;
  const isShort = pos.side === 'short';
  const quantityClosed = pos.quantity * fraction;
  const pnlUsd = isShort
    ? (pos.entryPrice - exitPrice) * quantityClosed
    : (exitPrice - pos.entryPrice) * quantityClosed;
  const pnlPercent = isShort
    ? (pos.entryPrice - exitPrice) / (pos.entryPrice || 1)
    : (exitPrice - pos.entryPrice) / (pos.entryPrice || 1);

  // Record partial trade
  const record: TradeRecord = {
    tokenId: pos.tokenId,
    symbol: pos.symbol,
    side: pos.side ?? 'long',
    entryPrice: pos.entryPrice,
    exitPrice,
    quantity: quantityClosed,
    pnlUsd,
    pnlPercent,
    entryTimestamp: pos.entryTimestamp,
    exitTimestamp: Date.now(),
    duration: Math.floor((Date.now() - pos.entryTimestamp) / 1000),
    strategy: pos.strategy,
    exitReason: reason,
  };
  await this.appendTradeRecord(record);

  // Reduce position
  pos.quantity -= quantityClosed;
  pos.partialTaken = true;
  this.state.cash += exitPrice * quantityClosed;
  this.state.dailyPnl += pnlUsd;
  this.state.weeklyPnl += pnlUsd;
  this.state.monthlyPnl += pnlUsd;
  this.state.totalValue = this.state.cash + this.state.positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice, 0,
  );

  await this.save(this.state);
  return { pnl: pnlUsd, pnlPercent, quantityClosed };
}
```

- [ ] **Step 2: Add partial exit to processExits in executor.ts**

In `cli/src/agent/executor.ts`, in the `processExits()` method, add a partial-profit check AFTER the full-exit loop (~after the existing for-loop ends):

```ts
// --- Partial profit exits (50% at +3%) ---
const PARTIAL_PROFIT_TRIGGER = 0.03; // +3% unrealized gain
const PARTIAL_FRACTION = 0.5;

const refreshedState = await this.portfolio.load();
for (const pos of refreshedState.positions) {
  if (pos.partialTaken) continue; // already took partial
  const price = currentPrices[pos.tokenId];
  if (price === undefined) continue;

  const isShort = pos.side === 'short';
  const pnlPercent = isShort
    ? (pos.entryPrice - price) / (pos.entryPrice || 1)
    : (price - pos.entryPrice) / (pos.entryPrice || 1);

  if (pnlPercent >= PARTIAL_PROFIT_TRIGGER) {
    try {
      const partial = await this.portfolio.closePartial(
        pos.tokenId, PARTIAL_FRACTION, price, `Partial profit at ${(pnlPercent * 100).toFixed(1)}%`,
      );
      results.push({
        position: { ...pos, currentPrice: price },
        exitPrice: price,
        reason: `PARTIAL_PROFIT (${(pnlPercent * 100).toFixed(1)}%, closed ${(PARTIAL_FRACTION * 100).toFixed(0)}%)`,
        pnl: partial.pnl,
      });
    } catch (err) {
      console.error(chalk.red(`Failed partial close ${pos.symbol}: ${(err as Error).message}`));
    }
  }
}
```

- [ ] **Step 3: Write test for closePartial**

In `cli/src/agent/portfolio.test.ts`, add to the `addToPosition` describe block (or a new one):

```ts
it("closePartial reduces quantity and records trade", async () => {
  const backing = setupBacking();
  const { writeFile } = await import("node:fs/promises");
  vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
    backing.state = typeof data === "string" ? data : data.toString();
  });
  const tracker = new PortfolioTracker();

  await tracker.openPosition({
    tokenId: "bitcoin", symbol: "BTC", side: "long",
    entryPrice: 100, currentPrice: 120, quantity: 10,
    entryTimestamp: Date.now(),
    stopLoss: 97, takeProfit: 130, strategy: "test",
  });

  const result = await tracker.closePartial("bitcoin", 0.5, 120, "Partial profit");
  expect(result.quantityClosed).toBe(5);
  expect(result.pnlPercent).toBeCloseTo(0.20, 2); // (120-100)/100
  expect(result.pnl).toBeCloseTo(100, 0); // 20 * 5
});
```

- [ ] **Step 4: Run tests**

```bash
cd cli && npm run typecheck && npm test -- src/agent/portfolio.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agent/portfolio.ts cli/src/agent/executor.ts cli/src/agent/portfolio.test.ts
git commit -m "feat(agent): partial exit at +3% gain — close 50%, trail remainder

When a position reaches +3% unrealized gain: close 50% (realized
profit), set partialTaken=true on the remainder. The trailing stop
(already activated in Task 5) protects the runner. Prevents giving
back all gains on mean reversion while letting winners run."
```

---

### Task 7: Mirror changes in backtest + build + version bump

**Files:**
- Modify: `cli/src/agent/backtest.ts` (ATR-based stops in simulate)
- Modify: `cli/package.json` (version bump)

- [ ] **Step 1: Update backtest exit constants to ATR-based**

In `cli/src/agent/backtest.ts`, replace the fixed exit constants (~lines 533-536) with ATR-derived values. The backtester has access to candles, so compute ATR from the window:

```ts
// Before
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;

// After — ATR-adaptive per candle, matching executor logic
const atrValues = calculateATR(windowCandles, 14);
const currentAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1]! : 0;
const atrPct = currentPrice > 0 && !isNaN(currentAtr) ? currentAtr / currentPrice : 0.03;
const STOP_LOSS_PCT = Math.min(0.10, Math.max(0.02, atrPct * 1.5));
const TAKE_PROFIT_PCT = STOP_LOSS_PCT * 2.0; // maintain 2:1 R:R
```

Add the import at the top if not already present:
```ts
import { calculateATR } from './technical.js';
```

Note: `calculateATR` is already imported via `getLatestSignals` dependency but confirm direct import works.

- [ ] **Step 2: Bump CLI version**

```ts
// cli/package.json
"version": "0.41.0"
```

Minor bump: new features (conviction sizing, ATR stops, partial exits, cooldown).

- [ ] **Step 3: Full test suite + build**

```bash
cd cli && npm run typecheck && npm test && npm run build
```

Expected: typecheck clean, only pre-existing network.test.ts failures, build success.

- [ ] **Step 4: Commit**

```bash
git add cli/src/agent/backtest.ts cli/package.json
git commit -m "feat(agent): mirror ATR-based stops in backtest + bump 0.40.4→0.41.0

Backtest exit logic now uses ATR-14 from the candle window instead of
fixed 3%/6% — matching the live executor's 1.5×ATR stop with 2-10%
clamp and 2:1 R:R TP. Ensures calibration results reflect the same
exit behavior as production."
```

---

### Task 8: Push + update PR

- [ ] **Step 1: Push branch**

```bash
git push origin fix/sentiment-contrarian-thresholds
```

- [ ] **Step 2: Update PR #223 description**

Add the new commits to PR #223 description or open a new PR if the scope has grown beyond the original title. Recommended: update the existing PR title to reflect the broader scope.

```bash
gh pr edit 223 --title "fix(agent): widen sentimentContrarian + smarter entries + adaptive exits"
```

- [ ] **Step 3: Verify deployed binary is current**

```bash
sherwood --version  # should show 0.41.0
```

The next 15-min cron tick will pick up the new code automatically.

---

## Summary of commits

| Task | Commit message | Key change |
|---|---|---|
| 1 | Raise ranging threshold + position limits | scoring.ts + risk.ts config |
| 2 | ATR-based stop/TP | executor.ts + loop.ts |
| 3 | Conviction-scaled sizing | executor.ts |
| 4 | Post-stop cooldown | risk.ts + portfolio.ts |
| 5 | Per-position ATR + trailing activation | risk.ts + executor.ts |
| 6 | Partial exit at +3% | portfolio.ts + executor.ts |
| 7 | Backtest mirror + version bump | backtest.ts + package.json |
| 8 | Push + PR update | git ops |
