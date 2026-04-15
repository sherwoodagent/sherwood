/**
 * Sentiment data provider — delegates to FearGreedProvider for API access,
 * adds z-score utilities and Provider interface compliance.
 */

import type { Provider, ProviderInfo } from "../../types.js";
import { FearGreedProvider, type FearGreedEntry } from "./feargreed.js";

/** @deprecated Use FearGreedEntry from feargreed.ts instead. */
export type FearAndGreedData = FearGreedEntry;

const fearGreed = new FearGreedProvider();

export class SentimentProvider implements Provider {
  info(): ProviderInfo {
    return {
      name: "Sentiment",
      type: "research",
      capabilities: ["fear-and-greed", "sentiment-zscore"],
      supportedChains: [],
    };
  }

  /** Fetch last 30 days of Fear & Greed index data (delegates to FearGreedProvider). */
  async getFearAndGreed(): Promise<FearGreedEntry[]> {
    return fearGreed.getHistory(30);
  }

  /** Get just the latest Fear & Greed value (delegates to FearGreedProvider). */
  async getFearAndGreedCurrent(): Promise<FearGreedEntry> {
    return fearGreed.getCurrent();
  }

  /**
   * Compute z-score of the latest value compared to the array.
   * z = (latest - mean) / stddev
   */
  computeSentimentZScore(values: number[]): number {
    if (values.length < 2) return 0;
    const latest = values[0]!;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    if (stddev === 0) return 0;
    return (latest - mean) / stddev;
  }
}
