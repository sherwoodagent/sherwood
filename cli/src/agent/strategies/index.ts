/**
 * Strategy registry — runs all enabled strategies and collects signals.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext, StrategyConfig } from './types.js';
import { SentimentContrarianStrategy } from './sentiment-contrarian.js';
import { BreakoutOnChainStrategy } from './breakout-onchain.js';
import { FundingRateStrategy } from './funding-rate.js';
import { DexFlowStrategy } from './dex-flow.js';
import { HyperliquidFlowStrategy } from './hyperliquid-flow.js';
import { MultiTimeframeStrategy } from './multi-timeframe.js';
import { CrossSectionalMomentumStrategy } from './cross-sectional-momentum.js';
import { TradingViewSignalStrategy } from './tradingview-signal.js';
import { BtcNetworkHealthStrategy } from './btc-network-health.js';
import { PredictionMarketStrategy } from './prediction-market.js';
import { SocialVolumeStrategy } from './social-volume.js';
import { KronosVolForecastStrategy } from './kronos-vol-forecast.js';

export type { Strategy, StrategyContext, StrategyConfig };
export { SentimentContrarianStrategy, BreakoutOnChainStrategy, FundingRateStrategy };
export { DexFlowStrategy, HyperliquidFlowStrategy };
export { MultiTimeframeStrategy, CrossSectionalMomentumStrategy };
export { TradingViewSignalStrategy };
export { BtcNetworkHealthStrategy };
export { PredictionMarketStrategy, SocialVolumeStrategy };
export { KronosVolForecastStrategy };

export const DEFAULT_STRATEGIES: Strategy[] = [
  new SentimentContrarianStrategy(),    // sentiment — F&G contrarian
  new BreakoutOnChainStrategy(),        // technical — breakout + volume
  new FundingRateStrategy(),            // onchain — HL funding rates
  new DexFlowStrategy(),                // onchain — DEX activity
  new HyperliquidFlowStrategy(),        // onchain — HL flow/OI/orderbook
  new MultiTimeframeStrategy(),         // technical — multi-TF EMA alignment
  new CrossSectionalMomentumStrategy(), // technical — relative strength ranking
  new TradingViewSignalStrategy(),      // technical — TradingView MCP indicators
  new BtcNetworkHealthStrategy(),       // technical — BTC network health
  new PredictionMarketStrategy(),       // event — prediction market catalysts
  new SocialVolumeStrategy(),           // sentiment — social volume contrarian
  new KronosVolForecastStrategy(),      // technical — ML volatility forecast
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
