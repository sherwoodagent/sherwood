/**
 * DEX Flow Analysis Strategy
 * Uses buy/sell transaction ratios from DEXScreener to gauge on-chain momentum.
 *
 * If buy txns significantly > sell txns (ratio > 1.5): bullish +0.3 to +0.6
 * If sell txns > buy txns (ratio > 1.5): bearish -0.3 to -0.6
 * Volume spike (24h volume > 3x liquidity): signal amplified
 * Combines 1h (reactive) and 24h (trend confirmation) data
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { DexScreenerProvider } from '../../providers/data/dexscreener.js';
import type { DexPair } from '../../providers/data/dexscreener.js';
import { clamp } from '../utils.js';

/** Well-known CoinGecko ID → ticker symbol mapping. */
const TOKEN_SYMBOL_MAP: Record<string, string> = {
  ethereum: 'ETH',
  bitcoin: 'BTC',
  solana: 'SOL',
  uniswap: 'UNI',
  chainlink: 'LINK',
  aave: 'AAVE',
  ripple: 'XRP',
  cardano: 'ADA',
  polkadot: 'DOT',
  avalanche: 'AVAX',
  polygon: 'MATIC',
  arbitrum: 'ARB',
  optimism: 'OP',
  litecoin: 'LTC',
  dogecoin: 'DOGE',
  'shiba-inu': 'SHIB',
  pepe: 'PEPE',
  celestia: 'TIA',
  sui: 'SUI',
  aptos: 'APT',
  sei: 'SEI',
  injective: 'INJ',
  jupiter: 'JUP',
  render: 'RENDER',
  maker: 'MKR',
  compound: 'COMP',
  lido: 'LDO',
  'wrapped-bitcoin': 'WBTC',
  'staked-ether': 'STETH',
};

/** Allowed chains — only EVM mainnet + major L2s. */
const ALLOWED_CHAINS = new Set([
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon',
]);

const MIN_LIQUIDITY_USD = 100_000;

/** Well-known token addresses so we can search by address instead of name. */
const KNOWN_TOKENS: Record<string, { address: string; chain: string }> = {
  ETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' },
  BTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', chain: 'ethereum' },
  WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', chain: 'ethereum' },
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: 'ethereum' },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: 'ethereum' },
  UNI: { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', chain: 'ethereum' },
  AAVE: { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', chain: 'ethereum' },
  LINK: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', chain: 'ethereum' },
  SOL: { address: '0xD31a59c85aE9D8edEFec411186437e05Ce3a1d82', chain: 'ethereum' },
  MKR: { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', chain: 'ethereum' },
  CRV: { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', chain: 'ethereum' },
  LDO: { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', chain: 'ethereum' },
  PENDLE: { address: '0x808507121B80c02388fAd14726482e061B8da827', chain: 'ethereum' },
  ARB: { address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', chain: 'arbitrum' },
  OP: { address: '0x4200000000000000000000000000000000000042', chain: 'optimism' },
};

/**
 * Resolve a CoinGecko tokenId to a ticker symbol for DEXScreener search.
 */
function resolveSymbol(tokenId: string, ctx: StrategyContext): string {
  if (TOKEN_SYMBOL_MAP[tokenId]) return TOKEN_SYMBOL_MAP[tokenId]!;
  if (ctx.tokenSymbol) return ctx.tokenSymbol.toUpperCase();
  return tokenId.toUpperCase();
}

/**
 * Filter and rank DEXScreener pairs:
 * 1. ONLY allowed EVM chains
 * 2. Require liquidity >= $100K
 * 3. Sort by liquidity descending
 */
function pickBestPair(pairs: DexPair[]): DexPair | undefined {
  const viable = pairs
    .filter((p) => ALLOWED_CHAINS.has(p.chainId))
    .filter((p) => (p.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD)
    .filter((p) => p.volume?.h24 > 0 && p.txns);

  if (viable.length === 0) return undefined;

  // Sort by liquidity descending
  viable.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return viable[0];
}

export class DexFlowStrategy implements Strategy {
  name = 'dexFlow';
  description = 'Analyzes DEX buy/sell transaction ratios and volume for on-chain momentum';
  requiredData = ['marketData'];

  private dex = new DexScreenerProvider();

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const details: string[] = [];
    let value = 0;
    let confidence = 0.3;

    // Try to find DEX pairs for the token
    let pairs: DexPair[] = [];
    try {
      if (ctx.dexData && Array.isArray(ctx.dexData) && ctx.dexData.length > 0) {
        pairs = ctx.dexData as DexPair[];
      } else {
        const symbol = resolveSymbol(ctx.tokenId, ctx);
        const known = KNOWN_TOKENS[symbol];
        if (known) {
          // Use address-based lookup for known tokens — much more precise
          const allPairs = await this.dex.getTokenPairs(known.address);
          pairs = allPairs.filter((p) => p.chainId === known.chain);
        } else {
          // Fallback: search by symbol
          pairs = await this.dex.searchPairs(symbol);
        }
      }
    } catch (err) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'DEX Flow Analysis',
        details: `Failed to fetch DEX data: ${(err as Error).message}`,
      };
    }

    if (pairs.length === 0) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'DEX Flow Analysis',
        details: `No DEX pairs found for ${ctx.tokenId}`,
      };
    }

    // Pick best pair: filter by liquidity, prefer EVM chains, sort by liquidity
    const pair = pickBestPair(pairs);

    if (!pair || !pair.txns) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'DEX Flow Analysis',
        details: 'No DEX pairs with transaction data',
      };
    }

    details.push(`Pair: ${pair.baseToken.symbol}/${pair.quoteToken.symbol} on ${pair.dexId}`);

    // 1h transaction ratio analysis (more reactive, weighted higher).
    // Guard: require two-sided activity. Thin-liquidity tokens with 5 buys / 0 sells
    // would otherwise fire BULLISH on absence of selling (5 / max(0,1) = 5), not on
    // genuine buy-pressure. Symmetric guard prevents the reverse false-bearish signal.
    // 10 trades/hr on a tracked DEX pair is already low activity — keep as floor.
    const h1Buys = pair.txns.h1?.buys ?? 0;
    const h1Sells = pair.txns.h1?.sells ?? 0;
    const h1Total = h1Buys + h1Sells;

    let h1Signal = 0;
    if (h1Total >= 10 && h1Buys > 0 && h1Sells > 0) {
      const h1Ratio = h1Buys / h1Sells;
      if (h1Ratio > 1.5) {
        // Bullish: scale from +0.3 (ratio=1.5) to +0.6 (ratio=3.0+)
        h1Signal = 0.3 + Math.min((h1Ratio - 1.5) / 1.5, 1.0) * 0.3;
        details.push(`1h: ${h1Buys} buys / ${h1Sells} sells (ratio ${h1Ratio.toFixed(2)}, bullish)`);
      } else if (h1Ratio < 1 / 1.5) {
        // Bearish: inverse ratio
        const invRatio = h1Sells / h1Buys;
        h1Signal = -(0.3 + Math.min((invRatio - 1.5) / 1.5, 1.0) * 0.3);
        details.push(`1h: ${h1Buys} buys / ${h1Sells} sells (ratio ${h1Ratio.toFixed(2)}, bearish)`);
      } else {
        details.push(`1h: ${h1Buys} buys / ${h1Sells} sells (balanced)`);
      }
      confidence += 0.1;
    } else if (h1Total > 0) {
      details.push(`1h: ${h1Buys} buys / ${h1Sells} sells (insufficient two-sided activity)`);
    }

    // 24h transaction ratio analysis (trend confirmation). Same guard applies:
    // one-sided flow is not a signal — require both buys and sells to avoid
    // false bullish/bearish on absence-of-counter-flow.
    const h24Buys = pair.txns.h24?.buys ?? 0;
    const h24Sells = pair.txns.h24?.sells ?? 0;
    const h24Total = h24Buys + h24Sells;

    let h24Signal = 0;
    if (h24Total >= 50 && h24Buys > 0 && h24Sells > 0) {
      const h24Ratio = h24Buys / h24Sells;
      if (h24Ratio > 1.5) {
        h24Signal = 0.3 + Math.min((h24Ratio - 1.5) / 1.5, 1.0) * 0.3;
        details.push(`24h: ${h24Buys} buys / ${h24Sells} sells (ratio ${h24Ratio.toFixed(2)}, bullish)`);
      } else if (h24Ratio < 1 / 1.5) {
        const invRatio = h24Sells / h24Buys;
        h24Signal = -(0.3 + Math.min((invRatio - 1.5) / 1.5, 1.0) * 0.3);
        details.push(`24h: ${h24Buys} buys / ${h24Sells} sells (ratio ${h24Ratio.toFixed(2)}, bearish)`);
      } else {
        details.push(`24h: ${h24Buys} buys / ${h24Sells} sells (balanced)`);
      }
      confidence += 0.1;
    } else if (h24Total > 0) {
      details.push(`24h: ${h24Buys} buys / ${h24Sells} sells (insufficient two-sided activity)`);
    }

    // Combine: 60% weight on 1h (reactive), 40% on 24h (trend)
    value = h1Signal * 0.6 + h24Signal * 0.4;

    // Volume spike amplifier: if 24h volume > 3x liquidity, signal is amplified
    const volume24h = pair.volume?.h24 ?? 0;
    const liquidity = pair.liquidity?.usd ?? 0;
    if (liquidity > 0 && volume24h > liquidity * 3) {
      const amplifier = Math.min(volume24h / liquidity / 3, 2.0); // cap at 2x
      value = clamp(value * amplifier);
      confidence += 0.1;
      details.push(`Volume spike: $${(volume24h / 1e6).toFixed(1)}M vol vs $${(liquidity / 1e6).toFixed(1)}M liq (${(volume24h / liquidity).toFixed(1)}x)`);
    }

    // Agreement bonus: if 1h and 24h agree in direction, boost confidence
    if ((h1Signal > 0 && h24Signal > 0) || (h1Signal < 0 && h24Signal < 0)) {
      confidence += 0.1;
      details.push('1h and 24h signals agree');
    } else if ((h1Signal > 0 && h24Signal < 0) || (h1Signal < 0 && h24Signal > 0)) {
      confidence -= 0.1;
      details.push('1h and 24h signals diverge');
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(Math.max(confidence, 0.1), 1.0),
      source: 'DEX Flow Analysis',
      details: details.join('; '),
    };
  }
}
