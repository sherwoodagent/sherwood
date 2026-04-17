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
 *   - BUY  rejected if 1h velocity < BUY_MIN_PCT  (default -0.3%)
 *   - SELL rejected if 1h velocity > SELL_MAX_PCT (default +0.3%)
 *   - HOLD never gated.
 *
 * When velocity data is unavailable (no Hyperliquid fields, insufficient candle
 * history), the gate skips — never reject blindly.
 */
import type { Candle } from "./technical.js";
import type { TokenAnalysis } from "./index.js";

// ── Configurable constants (easy to calibrate) ──

/** BUY rejected if 1h velocity is below this (fraction, not percent). */
export const VELOCITY_GATE_BUY_MIN_PCT = -0.003;

/** SELL rejected if 1h velocity is above this (fraction, not percent). */
export const VELOCITY_GATE_SELL_MAX_PCT = 0.003;

/** EntryGate configuration — exposed on AgentConfig for easy calibration. */
export interface EntryGateConfig {
  /** Master toggle. When false, the gate is skipped entirely. Default true. */
  velocityGateEnabled: boolean;
  /** BUY is rejected when 1h velocity is strictly less than this. Default -0.003. */
  velocityGateBuyMinPct: number;
  /** SELL is rejected when 1h velocity is strictly greater than this. Default +0.003. */
  velocityGateSellMaxPct: number;
}

export const DEFAULT_ENTRY_GATE_CONFIG: EntryGateConfig = {
  velocityGateEnabled: true,
  velocityGateBuyMinPct: VELOCITY_GATE_BUY_MIN_PCT,
  velocityGateSellMaxPct: VELOCITY_GATE_SELL_MAX_PCT,
};

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
