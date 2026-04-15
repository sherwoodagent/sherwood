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
  new SmartMoneyStrategy(),
  new TokenUnlockStrategy(),
  new SentimentContrarianStrategy(),
  new BreakoutOnChainStrategy(),
  new TvlMomentumStrategy(),
  new FundingRateStrategy(),
  new DexFlowStrategy(),
  new MeanReversionStrategy(),
  // TwitterSentimentStrategy disabled — Twitter API returns 402 (paid tier
  // required) for most token queries. Re-enable when we have an API path
  // that doesn't break. The class is still exported so it can be reinstated
  // by appending `new TwitterSentimentStrategy()` here.
  new HyperliquidFlowStrategy(),
  new MultiTimeframeStrategy(),
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
