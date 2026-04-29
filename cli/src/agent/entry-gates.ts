/**
 * Entry gates — post-scoring filters that can downgrade an action before the
 * executor sees it. Adjacent in spirit to the LLM judge: the score + action
 * can still fire, but a cross-check against fresh market data may veto it.
 *
 * ── Velocity gate (Orca-inspired "signal-velocity freshness") ──
 *
 * Multi-signal stacks can fire BUY/SELL the moment the composite score crosses
 * a threshold — but if the underlying price move is already exhausted (flat or
 * reversing over the last ~1h), we're buying local tops (or shorting bottoms).
 * Orca's fix: refuse the entry if the most recent short-term velocity is not
 * aligned with the direction.
 *
 *   - BUY  rejected if 1h velocity < BUY_MIN_PCT  (default -1.0%)
 *   - SELL rejected if 1h velocity > SELL_MAX_PCT (default +1.0%)
 *   - HOLD never gated.
 *
 * When velocity data is unavailable (no Hyperliquid fields, insufficient candle
 * history), the gate skips — never reject blindly.
 */
import type { Candle } from "./technical.js";
import type { TokenAnalysis } from "./index.js";
import type { MarketRegime } from "./regime.js";

// ── Configurable constants (easy to calibrate) ──

/** BUY rejected if 1h velocity is below this (fraction, not percent).
 *  Relaxed from ±0.3% to ±1.0% — on 4h candles the velocity proxy covers
 *  a 4h window, where ±0.3% is normal noise even in trending markets. */
export const VELOCITY_GATE_BUY_MIN_PCT = -0.01;

/** SELL rejected if 1h velocity is above this (fraction, not percent). */
export const VELOCITY_GATE_SELL_MAX_PCT = 0.01;

/** Regimes where short entries are allowed. Shorts are blocked in all other
 *  regimes to prevent counter-trend fading — trade log analysis showed 25%
 *  short WR in non-bearish regimes vs 67% long WR. */
export const SHORT_ALLOWED_REGIMES: Set<MarketRegime> = new Set([
  "trending-down",
  "high-volatility",
]);

/** EntryGate configuration — exposed on AgentConfig for easy calibration. */
export interface EntryGateConfig {
  /** Master toggle. When false, the gate is skipped entirely. Default true. */
  velocityGateEnabled: boolean;
  /** BUY is rejected when 1h velocity is strictly less than this. Default -0.01 (-1%). */
  velocityGateBuyMinPct: number;
  /** SELL is rejected when 1h velocity is strictly greater than this. Default +0.01 (+1%). */
  velocityGateSellMaxPct: number;
  /** When true, SELL/STRONG_SELL signals are blocked in non-bearish regimes
   *  (trending-up, ranging, low-volatility). Default true. */
  regimeGateEnabled: boolean;
  /** When true, actionable entries must be backed by at least one aligned
   *  high-quality signal, not just noisy/lagging components. Default true. */
  realAlphaGateEnabled: boolean;
}

export const DEFAULT_ENTRY_GATE_CONFIG: EntryGateConfig = {
  velocityGateEnabled: true,
  velocityGateBuyMinPct: VELOCITY_GATE_BUY_MIN_PCT,   // -1.0%
  velocityGateSellMaxPct: VELOCITY_GATE_SELL_MAX_PCT,  // +1.0%
  regimeGateEnabled: true,
  realAlphaGateEnabled: true,
};

/** Signals allowed to justify an entry after the noisy-signal score filter.
 *  Only includes signals that are actually populated by active strategies —
 *  dexFlow / meanReversion / sentimentContrarian were removed when their
 *  strategies were disabled. */
const REAL_ALPHA_THRESHOLDS: Record<string, number> = {
  smartMoney: 0.15,
  whaleIntent: 0.15,
  fundamental: 0.15,
  narrativeVacuum: 0.25,
};

function hasAlignedRealAlpha(result: TokenAnalysis, direction: 1 | -1): boolean {
  for (const signal of result.decision.signals) {
    const threshold = REAL_ALPHA_THRESHOLDS[signal.name];
    if (threshold === undefined) continue;
    if (direction > 0 && signal.value >= threshold) return true;
    if (direction < 0 && signal.value <= -threshold) return true;
  }
  return false;
}

/**
 * Derive a short-term velocity (fractional change) from candles.
 *
 * CoinGecko's /ohlc endpoint at days=30 returns 4h candles; at days=1 returns
 * 30m candles. Since the agent currently fetches days=30, the best proxy for
 * "recent 1h-ish velocity" is the last candle's close-over-previous-close
 * change (a 4h window — tight enough to capture fresh moves while respecting
 * the data we actually have).
 *
 * Returns undefined if we don't have enough data.
 */
export function deriveVelocityFromCandles(candles: Candle[] | undefined): number | undefined {
  if (!candles || candles.length < 2) return undefined;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  if (!prev.close || prev.close <= 0) return undefined;
  return last.close / prev.close - 1;
}

/**
 * Resolve the velocity to use for the gate:
 *   1. Prefer an explicit Hyperliquid 1h price change when available.
 *      (Units: decimal fraction, e.g. 0.012 for +1.2%. If the provider returns
 *      a percent instead, callers must divide by 100 before passing it in.)
 *   2. Fall back to the most-recent candle-over-candle change.
 *   3. Otherwise undefined — gate will skip.
 */
export function resolveVelocity(
  priceChg1h: number | undefined,
  candles: Candle[] | undefined,
): number | undefined {
  if (typeof priceChg1h === "number" && Number.isFinite(priceChg1h)) {
    return priceChg1h;
  }
  return deriveVelocityFromCandles(candles);
}

/**
 * Post-scoring hook that downgrades BUY/SELL → HOLD when recent price
 * velocity is not aligned with the proposed direction. Preserves the original
 * action/score on `result.preVelocity` (mirrors the `preJudge` pattern).
 *
 * Rules:
 *   - BUY / STRONG_BUY:   downgrade if velocity <= buyMinPct (flat or falling)
 *   - SELL / STRONG_SELL: downgrade if velocity >= sellMaxPct (flat or rising)
 *   - HOLD: never gated
 *   - If velocity is undefined (no data): skip gate, return unchanged
 *   - If !config.velocityGateEnabled: skip gate, return unchanged
 *
 * Edge case: exactly 0 velocity on a BUY downgrades (strict <=). Same on SELL
 * for >=. This is intentional — "flat" price action is not confirmation.
 */
export function applyVelocityGate(
  result: TokenAnalysis,
  velocity: number | undefined,
  config: EntryGateConfig = DEFAULT_ENTRY_GATE_CONFIG,
  logger: (msg: string) => void = () => {},
): TokenAnalysis {
  if (!config.velocityGateEnabled) return result;
  if (velocity === undefined || !Number.isFinite(velocity)) return result;

  const action = result.decision.action;
  const isBuy = action === "BUY" || action === "STRONG_BUY";
  const isSell = action === "SELL" || action === "STRONG_SELL";

  if (!isBuy && !isSell) return result;

  const rejectBuy = isBuy && velocity <= config.velocityGateBuyMinPct;
  const rejectSell = isSell && velocity >= config.velocityGateSellMaxPct;

  if (!rejectBuy && !rejectSell) return result;

  const direction = isBuy ? "BUY" : "SELL";
  const threshold = isBuy ? config.velocityGateBuyMinPct : config.velocityGateSellMaxPct;
  const pct = (velocity * 100).toFixed(2);
  const thresholdPct = (threshold * 100).toFixed(2);
  logger(
    `  [velocity] DOWNGRADE ${result.token}: ${direction} ${action} blocked — 1h velocity ${pct}% ` +
      `vs threshold ${thresholdPct}% (signal stale / exhausted)`,
  );

  return {
    ...result,
    preVelocity: { action: result.decision.action, score: result.decision.score },
    decision: { ...result.decision, action: "HOLD" },
  };
}

/**
 * Post-scoring gate that blocks SELL/STRONG_SELL when the market regime does
 * not support shorting. Trade log analysis (32 trades): shorts had 25% WR
 * (-$194) while longs had 67% WR (+$279). Most short losses came from fading
 * a recovery trend — the regime was ranging or trending-up, not bearish.
 *
 * Only allows shorts in:
 *   - trending-down: confirmed bearish regime
 *   - high-volatility: directional moves can go either way
 *
 * Blocks shorts in:
 *   - trending-up: counter-trend fade, historically destructive
 *   - ranging: choppy, no directional edge for shorts
 *   - low-volatility: not enough movement to profit from shorts
 *
 * When regime is undefined (no BTC data), the gate skips — never reject blindly.
 */
export function applyRegimeGate(
  result: TokenAnalysis,
  regime: MarketRegime | undefined,
  config: EntryGateConfig = DEFAULT_ENTRY_GATE_CONFIG,
  logger: (msg: string) => void = () => {},
): TokenAnalysis {
  if (!config.regimeGateEnabled) return result;
  if (regime === undefined) return result;

  const action = result.decision.action;
  const isSell = action === "SELL" || action === "STRONG_SELL";

  if (!isSell) return result;

  if (SHORT_ALLOWED_REGIMES.has(regime)) return result;

  logger(
    `  [regime] DOWNGRADE ${result.token}: ${action} blocked — regime "${regime}" ` +
      `does not support shorts (allowed: ${[...SHORT_ALLOWED_REGIMES].join(", ")})`,
  );

  return {
    ...result,
    preRegime: { action: result.decision.action, score: result.decision.score },
    decision: { ...result.decision, action: "HOLD" },
  };
}

/**
 * Blocks entries whose score is created only by noisy/lagging signals. Recent
 * signal analysis showed momentum, TradingView, funding, and HL flow were
 * negative-edge inputs; this gate requires a separate aligned alpha source.
 */
export function applyRealAlphaGate(
  result: TokenAnalysis,
  config: EntryGateConfig = DEFAULT_ENTRY_GATE_CONFIG,
  logger: (msg: string) => void = () => {},
): TokenAnalysis {
  if (!config.realAlphaGateEnabled) return result;

  const action = result.decision.action;
  const isBuy = action === "BUY" || action === "STRONG_BUY";
  const isSell = action === "SELL" || action === "STRONG_SELL";
  if (!isBuy && !isSell) return result;

  const direction = isBuy ? 1 : -1;
  if (hasAlignedRealAlpha(result, direction)) return result;

  logger(
    `  [alpha] DOWNGRADE ${result.token}: ${action} blocked — no aligned real-alpha ` +
      `signal (requires smartMoney, fundamental, narrativeVacuum, or whaleIntent)`,
  );

  return {
    ...result,
    preAlpha: { action: result.decision.action, score: result.decision.score },
    decision: { ...result.decision, action: "HOLD" },
  };
}
