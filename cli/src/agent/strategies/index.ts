/**
 * Strategy registry — runs all enabled strategies and collects signals.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext, StrategyConfig } from './types.js';
import { SmartMoneyStrategy } from './smart-money.js';
import { TokenUnlockStrategy } from './token-unlock.js';
import { SentimentContrarianStrategy } from './sentiment-contrarian.js';
import { BreakoutOnChainStrategy } from './breakout-onchain.js';
import { TvlMomentumStrategy } from './tvl-momentum.js';
import { FundingRateStrategy } from './funding-rate.js';
import { DexFlowStrategy } from './dex-flow.js';
import { MeanReversionStrategy } from './mean-reversion.js';
import { TwitterSentimentStrategy } from './twitter-sentiment.js';
import { HyperliquidFlowStrategy } from './hyperliquid-flow.js';
import { MultiTimeframeStrategy } from './multi-timeframe.js';

export type { Strategy, StrategyContext, StrategyConfig };
export { SmartMoneyStrategy, TokenUnlockStrategy, SentimentContrarianStrategy };
export { BreakoutOnChainStrategy, TvlMomentumStrategy, FundingRateStrategy };
export { DexFlowStrategy, MeanReversionStrategy, TwitterSentimentStrategy, HyperliquidFlowStrategy };
export { MultiTimeframeStrategy };

export const DEFAULT_STRATEGIES: Strategy[] = [
  // ── Active signals (fire rate >25% in production) ──
  new SentimentContrarianStrategy(),  // 100% fire rate — F&G based
  new BreakoutOnChainStrategy(),      // 95% fire rate
  new FundingRateStrategy(),          // 52% fire rate — HL native
  new DexFlowStrategy(),              // 18% fire rate
  new HyperliquidFlowStrategy(),      // 57% fire rate
  new MultiTimeframeStrategy(),       // 78% fire rate

  // ── Disabled: zero or near-zero fire rate in production ──
  // SmartMoneyStrategy — replaced by Nansen HL perp-trades in index.ts
  // TwitterSentimentStrategy — Twitter API returns 402
  // TokenUnlockStrategy — 0% fire rate, no data source
  // TvlMomentumStrategy — 0% fire rate for majors (no TVL on BTC/SOL)
  // MeanReversionStrategy — 0% fire rate, BB conditions never met
];

/**
 * Run all enabled strategies and collect signals.
 * Each strategy runs independently — one failure doesn't break others.
 */
export async function runStrategies(
  ctx: StrategyContext,
  configs?: Record<string, StrategyConfig>,
): Promise<Signal[]> {
  const signals: Signal[] = [];

  const tasks = DEFAULT_STRATEGIES.map(async (strategy) => {
    // Check if strategy is explicitly disabled
    const config = configs?.[strategy.name];
    if (config && !config.enabled) return null;

    try {
      const signal = await strategy.analyze(ctx);

      // Apply weight override if configured
      if (config?.weight !== undefined) {
        // Weight override is handled at the scoring layer, but we tag it
        (signal as any)._weightOverride = config.weight;
      }

      return signal;
    } catch (err) {
      // Strategy failed — return a zero-confidence signal so scoring isn't affected
      console.error(`Strategy ${strategy.name} failed: ${(err as Error).message}`);
      return {
        name: strategy.name,
        value: 0.0,
        confidence: 0.0,
        source: strategy.description,
        details: `Error: ${(err as Error).message}`,
      } satisfies Signal;
    }
  });

  const results = await Promise.allSettled(tasks);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      signals.push(result.value);
    }
  }

  return signals;
}
