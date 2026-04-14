# Sherwood Signal System Deep Analysis

**Date:** April 14, 2026
**Context:** BTC pumped Apr 13-14, agent scored max +0.23 but RANGING buy threshold is 0.40. System never fired a BUY across ANY token in 48+ hours of Extreme Fear + strong bullish signals.

---

## Executive Summary

The agent is **structurally incapable of generating BUY signals** under current conditions. Three root causes combine to cap scores at ~0.12–0.23 when the buy threshold is 0.40:

1. **Dead Weight Dilution**: smartMoney (weight=0.30 for majors) always returns value=0 with x402 offline, but still adds 0.30 to the denominator. This alone suppresses all scores by ~12%.
2. **Category Weight Duplication**: Each strategy signal gets the FULL category weight, not a share of it. Technical signals (4 strategies × 0.30 weight each = 1.20) dominate the denominator, overwhelming sentiment (2 × 0.20 = 0.40). The intended 30/30/20/20 split is actually 48/16/24/12.
3. **Wasted Signals for Majors**: fundingRate maps to `w.fundamental` (0.00 for majors), so BTC's negative funding (bullish +0.5) is completely ignored.

**Impact**: Even with F&G=12 (Extreme Fear), 51:0 DEX buy ratio, negative funding, and 2/3 bullish multi-timeframe, the maximum achievable score for BTC is ~0.23 — far below the 0.40 buy threshold.

---

## A) Per-Signal Analysis

### Signal Inventory (10 enabled strategies + 5 base signals)

| Signal | Category | Weight (Majors) | Data Source | Status | Typical Value Range | Typical Confidence | Fire Rate (48h) |
|--------|----------|-----------------|-------------|--------|--------------------|--------------------|-----------------|
| **technical** | technical | 0.30 | CoinGecko OHLC → RSI/MACD/BB/EMA | FREE ✅ | -1.0 to +1.0 | 0.50-0.70 | ~80% (usually mild) |
| **sentiment** | sentiment | 0.20 | Fear & Greed API | FREE ✅ | -1.0 to +1.0 | 0.60-0.80 | **100%** (always non-zero) |
| **onchain** | onchain | 0.20 | Nansen x402 → exchange flows | **DEAD** ❌ | 0.0 | 0.10 | 0% (x402 offline) |
| **fundamental** | fundamental | **0.00** | Messari x402 / DefiLlama TVL | Mixed | 0.0 | 0.10 | ~5% (only TVL tokens) |
| **event** | event | **0.00** | Messari x402 / DefiLlama FDV | **DEAD** ❌ | 0.0 | 0.10 | 0% |
| **smartMoney** | smartMoney | **0.30** | Nansen x402 → wallet flows | **DEAD** ❌ | **0.0** | **0.10** | **0% — BUT WEIGHT=0.30!** |
| breakoutOnChain | technical | 0.30 | CoinGecko candles + Nansen | FREE (partial) ✅ | -1.0 to +1.0 | 0.30-0.80 | ~70% (mostly mild ±0.10) |
| meanReversion | technical | 0.30 | CoinGecko candles + BB/RSI | FREE ✅ | -0.7 to +0.7 | 0.20-0.70 | ~30% (needs BB+RSI extremes) |
| multiTimeframe | technical | 0.30 | CoinGecko candles (daily+weekly) | FREE ✅ | -0.8 to +0.8 | 0.30-0.60 | ~90% (usually ±0.40) |
| dexFlow | onchain | 0.20 | DexScreener → buy/sell txns | FREE ✅ | -0.6 to +0.6 | 0.30-0.60 | ~60% (needs liquidity) |
| fundingRate | **fundamental** | **0.00** | Binance/Hyperliquid perps | FREE ✅ | -0.5 to +0.5 | 0.40-0.60 | **~80% — BUT WEIGHT=0.00 FOR MAJORS!** |
| tvlMomentum | **fundamental** | **0.00** | DefiLlama TVL history | FREE ✅ | -0.9 to +0.9 | 0.15-0.50 | ~20% (BTC/ETH have no TVL) |
| sentimentContrarian | sentiment | 0.20 | Fear & Greed + Z-score | FREE ✅ | -1.0 to +1.0 | 0.30-0.90 | **100%** (always fires with F&G) |
| twitterSentiment | sentiment | 0.20 | Twitter API v2 | **DISABLED** ❌ | N/A | N/A | 0% (disabled in code) |
| hyperliquidFlow | onchain | 0.20 | Hyperliquid orderbook/OI/whale | FREE ✅ | -0.8 to +0.8 | 0.60-0.80 | ~90% |
| tokenUnlock | event | **0.00** | Messari x402 / DefiLlama FDV | Partial ✅ | -1.0 to 0.0 | 0.10-0.80 | ~10% |

### Critical Findings

**Fire Rate Winners** (always producing signal):
- sentiment: +0.97 at F&G=12 (Extreme Fear), confidence 0.80
- sentimentContrarian: +0.76 at F&G=12, confidence 0.90
- hyperliquidFlow: typically ±0.10–0.30, confidence 0.60+
- multiTimeframe: ±0.40, confidence 0.30-0.50

**Dead/Wasted Signals**:
- smartMoney: **0.30 weight, 0 value, 0% fire rate** — the single biggest score killer
- fundingRate: FREE and working, but **mapped to fundamental (weight=0 for majors)** — BTC's bullish -0.0006% funding is ignored
- onchain (base): always value=0 without x402, adds 0.20 dead weight
- twitterSentiment: disabled entirely in DEFAULT_STRATEGIES

---

## B) Scoring Math Deep-Dive

### How `computeTradeDecision` Works (scoring.ts:442-545)

```
For each signal:
  signalWeight = weightMap[signal.name]  // category weight
  weightedSum += value * signalWeight
  totalWeight += signalWeight

score = weightedSum / totalWeight
```

**This is a weighted average, NOT a weighted sum.** The denominator grows with every signal, regardless of whether it contributes useful information.

### Worked Example: BTC at Apr 13 19:22 UTC (F&G=12, score=0.16)

Profile: **majors** → smartMoney:0.30, technical:0.30, sentiment:0.20, onchain:0.20, fundamental:0.00, event:0.00

| Signal | Value | Category Weight | Contribution (V×W) | Weight Added |
|--------|-------|----------------|--------------------:|-------------:|
| technical | -0.04 | 0.30 | -0.012 | 0.30 |
| sentiment | +0.97 | 0.20 | +0.194 | 0.20 |
| onchain | 0.00 | 0.20 | 0.000 | **0.20** |
| fundamental | 0.00 | 0.00 | 0.000 | 0.00 |
| event | 0.00 | 0.00 | 0.000 | 0.00 |
| **smartMoney** | **0.00** | **0.30** | **0.000** | **0.30** |
| breakoutOnChain | +0.10 | 0.30 | +0.030 | 0.30 |
| meanReversion | 0.00 | 0.30 | 0.000 | 0.30 |
| multiTimeframe | +0.40 | 0.30 | +0.120 | 0.30 |
| dexFlow | +0.36 | 0.20 | +0.072 | 0.20 |
| fundingRate | +0.50 | **0.00** | **0.000** | **0.00** |
| sentimentContrarian | +0.76 | 0.20 | +0.152 | 0.20 |
| hyperliquidFlow | -0.13 | 0.20 | -0.026 | 0.20 |
| tvlMomentum | 0.00 | 0.00 | 0.000 | 0.00 |
| tokenUnlock | 0.00 | 0.00 | 0.000 | 0.00 |

**Totals**: weightedSum = 0.530, totalWeight = **2.50**
**Score** = 0.530 / 2.50 = **0.212**

Then regime adjustment (ranging, strategyAdjustments applied to some):
- sentimentContrarian × 1.3 = adds more
- But dexFlow × 0.8 = reduces
- breakoutOnChain × 0.5 = halves
- multiTimeframe not in adjustment list = stays

After regime adjustments and rounding: **~0.16–0.21**

### The Dilution Problem Visualized

**Intended Category Weights (majors)**:
```
smartMoney: 30%  technical: 30%  sentiment: 20%  onchain: 20%
```

**Actual Effective Weights** (after all strategy signals add their category weight):
```
technical:  4 signals × 0.30 = 1.20 → 48% of denominator
onchain:    3 signals × 0.20 = 0.60 → 24%
sentiment:  2 signals × 0.20 = 0.40 → 16%
smartMoney: 1 signal  × 0.30 = 0.30 → 12% (DEAD!)
                                2.50 total
```

Technical category gets 4 voting slots but internal signals partially cancel (breakout bullish + MTF bearish = wash). Smart money gets 1 slot producing 0 — pure dilution.

### Why Confidence Doesn't Help

The code computes `weightedConfidence` alongside `weightedSum`, but **confidence is only used for display** — it does NOT scale signal values. Dead signals with confidence=0.10 contribute 0×0.30 = 0 to the numerator but still add 0.30 to the denominator.

---

## C) Regime Thresholds Analysis

### Current Thresholds

| Regime | Strong Buy | Buy | Sell | Strong Sell |
|--------|-----------|-----|------|-------------|
| trending-up | ≥0.55 | ≥0.25 | ≤-0.40 | ≤-0.70 |
| trending-down | ≥0.70 | ≥0.40 | ≤-0.25 | ≤-0.55 |
| **ranging** | **≥0.65** | **≥0.40** | **≤-0.40** | **≤-0.65** |
| high-volatility | ≥0.70 | ≥0.45 | ≤-0.45 | ≤-0.70 |
| low-volatility | ≥0.60 | ≥0.30 | ≤-0.30 | ≤-0.60 |

### Maximum Observed Scores (Apr 12-14, all tokens)

| Token | Max Score | When | Key Bullish Signals |
|-------|----------|------|---------------------|
| AAVE | **+0.23** | Apr 13 10:58 | sentiment +0.97, contrarian +0.76, breakout +0.50 |
| BTC | +0.17 | Apr 14 02:33 | sentiment +0.97, contrarian +0.76, MTF +0.40 |
| SOL | +0.19 | Apr 14 03:07 | sentiment +0.97, contrarian +0.76, HL flow mild |
| FARTCOIN | +0.15 | Apr 14 08:27 | sentiment +0.97, contrarian +0.76 |
| ETH | +0.16 | Apr 13 19:22 | sentiment +0.97, contrarian +0.76, MTF +0.40 |
| DOT | +0.13 | Apr 13 10:58 | sentiment +0.97, breakout -0.70, funding +0.50 |

**The maximum score ANY token achieved in 48+ hours was +0.23** — this is 43% below the ranging buy threshold of 0.40.

### Are Thresholds Too Conservative?

**YES, absolutely** — but the real problem is the scoring math, not the thresholds. The thresholds were calibrated assuming all weight categories would be active. With 42% of effective weight dead (smartMoney 12% + half of technical washing out + some onchain), the maximum achievable score is structurally limited to ~0.25.

**Theoretical max score with current system (ALL signals maximally bullish)**:
- sentiment=+1.0: 0.20, sentContrarian=+1.0: 0.20 → sentiment total: 0.40
- technical=+1.0: 0.30, breakout=+1.0: 0.30, meanRev=+0.7: 0.21, MTF=+0.8: 0.24 → technical total: 1.05
- dexFlow=+0.6: 0.12, hlFlow=+0.8: 0.16, onchain=+0.9: 0.18 → onchain total: 0.46
- smartMoney=0: 0 (dead)
- fundingRate, tvlMomentum, tokenUnlock → weight=0 for majors

weightedSum = 0.40 + 1.05 + 0.46 + 0 = 1.91
totalWeight = 0.40 + 1.20 + 0.60 + 0.30 = 2.50
**Theoretical max = 1.91 / 2.50 = 0.764**

So even in the absolute best case, the max is only 0.76. But in practice, signals never all align to max — the realistic ceiling is about 0.35-0.40. This means the buy threshold of 0.40 is right at the absolute practical ceiling.

### Recommended Threshold Adjustments

| Regime | Current Buy | Recommended Buy | Current Sell | Recommended Sell |
|--------|------------|-----------------|-------------|-----------------|
| trending-up | 0.25 | 0.20 | -0.40 | -0.35 |
| trending-down | 0.40 | 0.30 | -0.25 | -0.20 |
| **ranging** | **0.40** | **0.25** | **-0.40** | **-0.25** |
| high-volatility | 0.45 | 0.35 | -0.45 | -0.35 |
| low-volatility | 0.30 | 0.22 | -0.30 | -0.22 |

**BUT**: fixing the scoring math (Section F recommendations) is far more important than lowering thresholds. Lowering thresholds without fixing dilution will just produce false positives in normal markets.

---

## D) x402 Offline Impact

### Weight Categories Affected

| Category | Weight (Majors) | Primary Data Source | x402 Status | Impact |
|----------|----------------|--------------------|----|--------|
| **smartMoney** | **0.30** | Nansen wallet flows | **DEAD** (402 Payment Required) | **12% of denominator wasted** |
| onchain (base) | 0.20 | Nansen exchange flows | **DEAD** | 8% of denominator wasted |
| fundamental | 0.00 (majors) | Messari metrics | DEAD (403 Forbidden) | No impact for majors |
| event | 0.00 (majors) | Messari profile | DEAD | No impact for majors |

**For altcoins (default profile)**, the impact is even worse:
- smartMoney: 0.25 weight, dead → 10% wasted
- fundamental: 0.10 weight, mostly dead → 4% wasted
- event: 0.10 weight, dead → 4% wasted
- Total: ~18% of denominator produces nothing

### Current Behavior: Weight Goes to Waste

The code at `scoring.ts:480` does:
```typescript
const signalWeight = signal._weightOverride ?? weightMap[signal.name] ?? 0.1;
```

Dead signals still return a Signal object with `value: 0.0, confidence: 0.1`. These signals:
1. **DO** add to `totalWeight` (their category weight is non-zero)
2. **DO NOT** contribute to `weightedSum` (value × weight = 0 × weight = 0)
3. **Result**: Pure dilution of the denominator

**There is NO weight redistribution mechanism.** The signal-audit.ts module has `suggestRenormalizedWeights()` but it is never called automatically.

### Recommendation: Automatic Weight Redistribution

When a signal produces `confidence < 0.1`, its weight should be redistributed to other signals in the same category (or to the strongest remaining category). See Section F for implementation.

---

## E) Missed Opportunities

### BTC Price Movement vs. Scores

BTC moved from ~$79,500 (Apr 12) to ~$85,000+ (Apr 14) — approximately +7% in 48 hours.

**Signals during the pump that were CORRECT:**
- F&G = 12-21 (Extreme Fear) → sentiment +0.97, contrarian +0.76 ✅ **Correctly bullish**
- DEX flow: 51:0 buys in 1h at one scan, consistently bullish ✅ **Correctly bullish**
- Negative funding rate on HL → fundingRate +0.50 ✅ **Correctly bullish BUT IGNORED (weight=0 for majors)**
- Multi-timeframe: 2/3 bullish (short-term + weekly) ✅ **Correctly bullish**

**Signals that were WRONG or NEUTRAL:**
- technical (base RSI/MACD): neutral (RSI ~44, no extreme) → ~0 ❌ Didn't help
- HL orderbook: heavy asks at some scans → bearish ❌ **Wrong direction — orderbook was spoofed/filled**
- onchain (base): always 0 (x402 dead) → 0 ⚠️ Dead
- smartMoney: always 0 (x402 dead) → 0 ⚠️ Dead
- meanReversion: 0 (no BB/RSI extreme triggers) → 0 — not useful in this setup
- multiTimeframe: sometimes -0.40 (2/3 bearish) ❌ **Flipped direction between scans**

**Net result**: The system had 4 correct bullish signals (+0.97, +0.76, +0.50, +0.40) being diluted by 3 dead signals (0, 0, 0) and 2 mild bearish signals (-0.13, -0.04), producing a score of only +0.16.

### Other Tokens

| Token | Observed Score | Price Move (approx) | Should Have Caught? |
|-------|---------------|--------------------|--------------------|
| SOL | +0.12–0.19 | ~$110→$130 (+18%) | **YES — stronger move than BTC** |
| ETH | +0.14–0.16 | ~$1,500→$1,630 (+8.7%) | **YES** |
| HYPE | +0.15–0.17 | ~$14→$16 (+14%) | YES |
| AAVE | +0.23 (highest!) | Strong DeFi rally | YES — actually had breakout signal |
| FARTCOIN | +0.11–0.15 | Unknown | Probably |

**SOL was the biggest miss** — +18% move with strong bullish signals, but max score was only 0.19.

### Key Observation from Scanner Outputs

Many scans from Apr 13 00:00-10:00 returned "(No response generated)" — the scanner was failing silently during the early part of the pump. This means:
1. Many hours of the early pump had NO data at all
2. When data came back (~10:33), scores were already at +0.12-0.23 range
3. The pump continued for 24+ hours but scores never improved above +0.23

---

## F) Concrete Recommendations (Priority Ordered)

### P0 (Critical — Fix Immediately)

#### 1. Skip Dead Signals from Weight Calculation
**File:** `cli/src/agent/scoring.ts`, function `computeTradeDecision` (~line 479)
**Change:** Don't add weight for signals with confidence ≤ 0.1 (dead signals)

```typescript
// BEFORE (line 479-495):
for (const signal of signals) {
  const signalWeight = signal._weightOverride ?? weightMap[signal.name] ?? 0.1;
  // ... adjustments ...
  weightedSum += adjustedValue * signalWeight;
  weightedConfidence += adjustedConfidence * signalWeight;
  totalWeight += signalWeight;
}

// AFTER:
for (const signal of signals) {
  const signalWeight = signal._weightOverride ?? weightMap[signal.name] ?? 0.1;
  // Skip dead signals (confidence ≤ 0.1) from weight calculation
  // These are signals that returned "no data available" — they shouldn't
  // dilute the denominator.
  if (signal.confidence <= 0.1 && signalWeight > 0) {
    continue; // Don't add to numerator OR denominator
  }
  // ... rest of adjustments ...
  weightedSum += adjustedValue * signalWeight;
  weightedConfidence += adjustedConfidence * signalWeight;
  totalWeight += signalWeight;
}
```

**Expected Impact:** Removes ~0.50 from totalWeight for majors (smartMoney 0.30 + onchain base 0.20). Score jumps from 0.530/2.50=0.21 to 0.530/2.00=**0.265**. Still not enough alone but a huge improvement.

#### 2. Fix fundingRate Weight Mapping for Majors
**File:** `cli/src/agent/scoring.ts`, line 466
**Change:** Map fundingRate to onchain (not fundamental) since it's exchange-native data about market positioning, not fundamentals.

```typescript
// BEFORE:
fundingRate: w.fundamental,

// AFTER:
fundingRate: w.onchain,  // Funding rate is market-positioning data, not fundamental
```

**Expected Impact:** For majors, fundingRate now gets weight=0.20 instead of 0.00. BTC's bullish funding signal (+0.50 × 0.20 = +0.10) enters the numerator, and totalWeight increases only by 0.20.

Combined with P0-1: score becomes (0.530 + 0.10) / (2.00 + 0.20) = 0.630/2.20 = **0.286**

#### 3. Normalize Category Weights Per Category (Biggest Structural Fix)
**File:** `cli/src/agent/scoring.ts`, function `computeTradeDecision`
**Change:** Instead of giving each signal the FULL category weight, split the category weight evenly among signals in that category.

```typescript
// NEW: Count signals per category, then split weight
const categorySignalCounts = new Map<string, number>();
for (const signal of signals) {
  if (signal.confidence <= 0.1) continue; // skip dead signals
  const cat = signalToCategoryMap[signal.name] ?? 'unknown';
  categorySignalCounts.set(cat, (categorySignalCounts.get(cat) ?? 0) + 1);
}

for (const signal of signals) {
  if (signal.confidence <= 0.1) continue;
  const cat = signalToCategoryMap[signal.name] ?? 'unknown';
  const categoryWeight = w[cat] ?? 0.1;
  const signalCount = categorySignalCounts.get(cat) ?? 1;
  const signalWeight = signal._weightOverride ?? (categoryWeight / signalCount);
  // ... rest unchanged
}
```

**Expected Impact:** This is transformative. For BTC with majors:
- technical: 4 signals share 0.30 → each gets 0.075 (total: 0.30)
- sentiment: 2 signals share 0.20 → each gets 0.10 (total: 0.20)
- onchain: 3 signals share 0.20 → each gets 0.067 (total: 0.20)
- smartMoney: skipped (dead)

totalWeight = 0.30 + 0.20 + 0.20 = 0.70 (vs current 2.50!)

Now sentiment +0.97 contributes 0.097/0.70 = 13.9% (vs current 7.8%)
Score = ~0.530 equivalent / 0.70 = **much higher**

Let me recalculate properly:
| Signal | Value | New Weight | V×W |
|--------|-------|-----------|------|
| technical | -0.04 | 0.075 | -0.003 |
| sentiment | +0.97 | 0.10 | +0.097 |
| breakoutOnChain | +0.10 | 0.075 | +0.008 |
| meanReversion | 0.00 | 0.075 | 0.000 |
| multiTimeframe | +0.40 | 0.075 | +0.030 |
| dexFlow | +0.36 | 0.067 | +0.024 |
| fundingRate | +0.50 | 0.067 | +0.034 |
| sentimentContrarian | +0.76 | 0.10 | +0.076 |
| hyperliquidFlow | -0.13 | 0.067 | -0.009 |

weightedSum = 0.257, totalWeight = 0.70
**Score = 0.257 / 0.70 = 0.367**

This alone gets BTC close to the 0.40 threshold! With regime adjustments boosting sentimentContrarian (×1.3 in ranging), it would cross.

### P1 (High Priority — Fix This Week)

#### 4. Lower Ranging Buy Threshold to 0.30
**File:** `cli/src/agent/scoring.ts`, line 113
**Change:**
```typescript
// BEFORE:
"ranging": { strongBuy: 0.65, buy: 0.40, sell: -0.40, strongSell: -0.65 },

// AFTER:
"ranging": { strongBuy: 0.55, buy: 0.30, sell: -0.30, strongSell: -0.55 },
```

**Expected Impact:** After P0 fixes, realistic scores of 0.30-0.40 can now trigger BUY. Without P0 fixes, this creates false positive risk.

#### 5. Add "Extreme Fear Override" — Boost Score When F&G < 15
**File:** `cli/src/agent/scoring.ts`, function `computeTradeDecision`, after score calculation
**Change:** When F&G is at extreme (< 15), sentiment signals are historically high-conviction. Apply a small boost.

```typescript
// After score = weightedSum / totalWeight:
// Extreme Fear conviction boost — when F&G < 15, multiple sentiment
// signals firing at 0.7+ is a high-conviction setup. Historically,
// buying at F&G < 15 has positive expected value at 7d+ horizons.
const sentimentSignals = signals.filter(s =>
  ['sentiment', 'sentimentContrarian'].includes(s.name) && s.value > 0.5
);
if (sentimentSignals.length >= 2 && sentimentSignals.every(s => s.confidence >= 0.7)) {
  const avgSentValue = sentimentSignals.reduce((s, sig) => s + sig.value, 0) / sentimentSignals.length;
  const boost = avgSentValue * 0.15; // max ~0.13 boost
  score = Math.min(1.0, score + boost);
}
```

**Expected Impact:** When F&G < 15 and both sentiment signals are strongly bullish (value > 0.5, confidence > 0.7), adds ~0.10-0.13 to score. This is the "Extreme Fear = buy" rule.

#### 6. Enable Signal Smoothing by Default
**File:** `cli/src/agent/index.ts`, constructor or default config
**Change:** Set `smoothFastSignals: true` by default. The HL orderbook showed -99.9% asks in one scan and +95% bids in the next — single-scan flicker is destroying signal quality.

### P2 (Medium Priority — Fix This Sprint)

#### 7. Regime Detection Improvements
**Problem:** The regime detector classified BTC as "ranging" even as it began pumping, because ADX was < 25 and EMAs hadn't crossed yet (lagging indicators on CoinGecko daily candles).

**File:** `cli/src/agent/regime.ts`
**Change:** Add a momentum regime that detects early trend formation using shorter-term signals (rate of change over 3-7 days, volume expansion).

#### 8. Add F&G Signal Weighting Boost in Extreme Zones
**Problem:** At F&G=12, the sentiment signal outputs +0.97 but gets the same 0.20 weight as at F&G=35 (+0.23). The signal IS more predictive at extremes.
**File:** `cli/src/agent/scoring.ts`
**Change:** Allow signals to carry a `_weightBoost` field that scales their weight. Sentiment at F&G < 15 or > 85 gets 1.5× weight.

#### 9. Fix the Scanner Reliability Problem
**Observation:** Out of ~40 cron outputs from Apr 13 00:00-14:00, **over half returned "(No response generated)" or timed out**. The scanner was offline during much of the pump.
**Change:** Need to debug why the hermes cron agent fails to generate responses — likely CoinGecko 429 rate limiting. Consider:
- Caching CoinGecko data longer (currently 15min for regime)
- Reducing from 10 tokens to 5 per scan batch
- Adding retry logic in the cron prompt

### P3 (Lower Priority — Backlog)

#### 10. Top-up x402 Wallet
The 0xb4EC wallet needs USDC on Base for x402 payments. Nansen smart-money data is worth the 30% weight — it would add real signal quality.

#### 11. Enable Twitter Sentiment Strategy
When budget allows, re-enable TwitterSentimentStrategy. The LLM sentiment from one scan showed "+0.34 bullish for SOL" with 24x volume spike — useful signal that's currently wasted.

#### 12. Add Backtest Validation
Run the proposed changes through the backtester to validate that:
- The new scoring math produces BUY signals at F&G < 15 with confirming signals
- False positive rate doesn't spike in normal markets
- Threshold changes don't cause whipsaw in trending regimes

---

## Summary of Expected Impact

| Fix | Alone | Cumulative (approx BTC score) |
|-----|-------|-------------------------------|
| Current state | — | 0.16 |
| P0-1: Skip dead signals | +0.05 | 0.21 |
| P0-2: Fix fundingRate weight | +0.04 | 0.25 |
| P0-3: Normalize category weights | +0.12 | **0.37** |
| P1-4: Lower threshold to 0.30 | threshold → 0.30 | **BUY triggered!** |
| P1-5: Extreme Fear boost | +0.10 | **0.47 → STRONG BUY** |

With P0 fixes alone, the BTC score during the Apr 13-14 pump would have been ~0.37 — still below 0.40 but with P1-4 threshold adjustment, a clear BUY. With P1-5 added, it reaches 0.47, solidly in BUY territory.

---

## Appendix: Scanner Output Timeline (Apr 13-14)

| Time (UTC) | BTC Score | Best Token | Notes |
|------------|----------|------------|-------|
| Apr 13 00:00-09:00 | Unknown | Unknown | **Scanner failing — no output for ~10 runs** |
| Apr 13 10:33 | 0.17 | AAVE 0.23 | First good scan — F&G=12 |
| Apr 13 10:58 | 0.12 | AAVE 0.23 | All HOLD, F&G=12 |
| Apr 13 11:03 | — | — | Timeout — OpenAI API 400 |
| Apr 13 11:35 | — | — | Timeout again |
| Apr 13 12:14 | 0.16 | ??? 0.23 | Token symbols masked |
| Apr 13 13:02 | — | — | 429 rate limit |
| Apr 13 14:20 | — | — | 429 rate limit |
| Apr 13 16:07 | 0.09 | SOL 0.15 | BTC worst (heavy asks) |
| Apr 13 19:22 | 0.16 | ETH 0.16 | Contrarian +0.76, MTF +0.40, but HL asks heavy |
| Apr 14 02:33 | 0.17 | BTC 0.17 | Still HOLD, F&G=21 |
| Apr 14 03:07 | — | SOL 0.19 | All HOLD |
| Apr 14 08:27 | — | FARTCOIN 0.15 | All HOLD, F&G=21, x402 failing |

**In 48 hours, the system never exceeded +0.23 for any token. The buy threshold of 0.40 was never within reach.**
