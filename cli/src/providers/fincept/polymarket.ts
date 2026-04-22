/**
 * Polymarket/Manifold prediction market wrapper.
 *
 * Fetches crypto-relevant prediction markets via the Fincept Python bridge
 * and exposes them as typed PredictionMarket objects.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface PredictionMarket {
  question: string;
  probability: number;
  volume: number;
}

const CRYPTO_KEYWORDS = [
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "crypto",
  "sec",
  "etf",
  "fed",
  "rate",
  "inflation",
  "regulation",
  "stablecoin",
  "defi",
];

interface RawMarket {
  question: string;
  outcomePrices: string[];
  probability: number;
  volume: number;
  active: boolean;
  closed: boolean;
}

/**
 * Fetch crypto-relevant prediction markets from Polymarket/Manifold.
 * Returns up to 10 active markets whose question matches a crypto keyword.
 */
export async function getCryptoPredictions(): Promise<PredictionMarket[]> {
  try {
    const result = await callFincept<RawMarket[]>(
      "polymarket.py",
      ["markets", "50"],
      30_000,
      CACHE_TTL,
    );

    if (!result.ok || !result.data) {
      return [];
    }

    const markets = result.data
      .filter((m) => {
        if (!m.active || m.closed) return false;
        const q = m.question.toLowerCase();
        return CRYPTO_KEYWORDS.some((kw) => q.includes(kw));
      })
      .map((m): PredictionMarket => {
        const probability =
          m.outcomePrices && m.outcomePrices.length > 0
            ? parseFloat(m.outcomePrices[0])
            : m.probability;
        return {
          question: m.question,
          probability: isNaN(probability) ? m.probability : probability,
          volume: m.volume,
        };
      })
      .slice(0, 10);

    return markets;
  } catch {
    return [];
  }
}
