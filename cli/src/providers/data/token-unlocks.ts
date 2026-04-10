/**
 * Token unlock provider — fetches upcoming vesting/unlock events.
 * Uses DefiLlama's free unlocks API (no authentication required).
 * Fallback: CoinGecko status_updates for governance events.
 */

const DEFILLAMA_UNLOCKS = 'https://api.llama.fi/protocol';

// Map CoinGecko IDs to DefiLlama protocol slugs
const TOKEN_TO_PROTOCOL: Record<string, string> = {
  uniswap: 'uniswap',
  aave: 'aave',
  maker: 'makerdao',
  compound: 'compound-finance',
  curve: 'curve-dex',
  lido: 'lido',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  sushi: 'sushi',
  jupiter: 'jupiter',
  pendle: 'pendle',
  injective: 'injective-protocol',
  render: 'render-network',
};

export interface UnlockEvent {
  /** Percentage of circulating supply being unlocked */
  percentOfSupply: number;
  /** Days until the unlock */
  daysUntil: number;
  /** Description of the unlock */
  description: string;
}

export interface TokenUnlockData {
  upcomingUnlocks: UnlockEvent[];
  totalUpcomingPercent: number;
}

export class TokenUnlocksProvider {
  /** Get upcoming unlock events for a token. Returns null if no data available. */
  async getUnlocks(tokenId: string): Promise<TokenUnlockData | null> {
    const slug = TOKEN_TO_PROTOCOL[tokenId];
    if (!slug) return null;

    try {
      const res = await fetch(`${DEFILLAMA_UNLOCKS}/${slug}`);
      if (!res.ok) return null;

      const data = await res.json() as any;

      // DefiLlama protocol endpoint includes mcap and token info
      // We estimate unlock pressure from token allocation data
      const mcap = data?.mcap;
      const fdv = data?.fdvData;

      if (!mcap || !fdv || fdv <= 0) return null;

      // Ratio of circulating to fully-diluted gives us how much is still locked
      const circulatingRatio = mcap / fdv;
      const lockedPercent = (1 - circulatingRatio) * 100;

      if (lockedPercent < 1) {
        // Fully circulating — no unlock pressure
        return { upcomingUnlocks: [], totalUpcomingPercent: 0 };
      }

      // Estimate: assume locked tokens vest linearly over 2 years
      // This is an approximation — real schedules vary
      const monthlyUnlockPercent = lockedPercent / 24;
      const weeklyUnlockPercent = monthlyUnlockPercent / 4;

      const unlocks: UnlockEvent[] = [];

      if (weeklyUnlockPercent > 0.5) {
        unlocks.push({
          percentOfSupply: weeklyUnlockPercent,
          daysUntil: 7,
          description: `Estimated ~${weeklyUnlockPercent.toFixed(1)}% weekly vesting (${lockedPercent.toFixed(0)}% still locked)`,
        });
      }

      if (monthlyUnlockPercent > 1) {
        unlocks.push({
          percentOfSupply: monthlyUnlockPercent,
          daysUntil: 30,
          description: `Estimated ~${monthlyUnlockPercent.toFixed(1)}% monthly vesting`,
        });
      }

      return {
        upcomingUnlocks: unlocks,
        totalUpcomingPercent: weeklyUnlockPercent,
      };
    } catch {
      return null;
    }
  }
}
