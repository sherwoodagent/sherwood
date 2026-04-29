/**
 * Dynamic token selection from Hyperliquid market data.
 * Selects the most interesting tokens to analyze based on volume, funding rates, and other criteria.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeNumber } from '../providers/data/hyperliquid.js';

const HYPERLIQUID_BASE = 'https://api.hyperliquid.xyz/info';

export interface TokenSelection {
  tokens: string[];           // CoinGecko IDs for the agent to analyze
  reason: Record<string, string>; // why each token was selected
  totalMarketsScanned: number;
  timestamp: number;
}

export interface SelectionCriteria {
  minVolume24h: number;       // minimum 24h volume in USD (default: $5M)
  topByVolume: number;        // take top N by volume (default: 10)
  fundingExtremes: number;    // take N tokens with most extreme funding (default: 5)
  minFundingRate: number;     // absolute funding rate threshold (default: 0.03%)
}

interface MetaAndAssetCtxs {
  universe: Array<{
    name: string;
    szDecimals: number;
  }>;
}

interface AssetCtx {
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  markPx: string;
  oraclePx: string;
  prevDayPx: string;
}

interface MarketInfo {
  name: string;
  volume24h: number;
  funding: number;
  openInterest: number;
  markPrice: number;
  coingeckoId?: string;
}

// Comprehensive mapping from Hyperliquid coin names to CoinGecko IDs
const HYPERLIQUID_TO_COINGECKO: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  HYPE: 'hyperliquid',  // May not exist on CG, but try
  XRP: 'ripple',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  SUI: 'sui',
  NEAR: 'near',
  AAVE: 'aave',
  ARB: 'arbitrum',
  TAO: 'bittensor',
  TRUMP: 'official-trump',
  ZEC: 'zcash',
  BNB: 'binancecoin',
  OP: 'optimism',
  DOT: 'polkadot',
  ADA: 'cardano',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  MKR: 'maker',
  INJ: 'injective-protocol',
  PENDLE: 'pendle',
  PEPE: 'pepe',
  ENA: 'ethena',
  TIA: 'celestia',
  SEI: 'sei-network',
  APT: 'aptos',
  FIL: 'filecoin',
  RENDER: 'render-token',
  JUP: 'jupiter-exchange-solana',
  STX: 'blockstack',
  WLD: 'worldcoin-wld',
  FET: 'fetch-ai',
  ONDO: 'ondo-finance',
  LDO: 'lido-dao',
  CRV: 'curve-dao-token',
  BLUR: 'blur',
  EIGEN: 'eigenlayer',
  POL: 'polygon-ecosystem-token',
  FARTCOIN: 'fartcoin',
  LTC: 'litecoin',
  MATIC: 'polygon-ecosystem-token', // POL is the new MATIC
  TNSR: 'tensor',
  GRASS: 'grass',
  MOVE: 'move-network',
  GOAT: 'goatseus-maximus',
  PNUT: 'peanut-the-squirrel',
  POPCAT: 'popcat',
  NEIRO: 'neiro',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FLOKI: 'floki',
  SHIB: 'shiba-inu',
  MEW: 'cat-in-a-dogs-world',
  MEME: 'memecoin',
  AI16Z: 'ai16z',
  VIRTUAL: 'virtual-protocol',
  AIXBT: 'aixbt-by-virtuals',
  ZEREBRO: 'zerebro',
  arc: 'arc',
  HYPURR: 'hypurr',
  ELIZA: 'eliza',
  GRIFFAIN: 'griffain',
  LUNA: 'ai-analysis-token',
  DEEP: 'deep-worm',
  POLY: 'polyhedra-network',
  VANA: 'vana',
  VELODROME: 'velodrome-finance',
  ACX: 'across-protocol',
  COOKIE: 'cookie-dao',
  USUAL: 'usual',
  PENGU: 'pudgy-penguins',
  ETHFi: 'ether-fi',
  ETHFI: 'ether-fi',  // Alternative spelling
  RSR: 'reserve-rights',
  CKB: 'nervos-network',
  RUNE: 'thorchain',
  MANA: 'decentraland',
  SAND: 'the-sandbox',
  ENS: 'ethereum-name-service',
  LRC: 'loopring',
  IMX: 'immutable-x',
  GALA: 'gala',
  CHZ: 'chiliz',
  BAT: 'basic-attention-token',
  ZRX: '0x',
  COMP: 'compound-governance-token',
  SUSHI: 'sushi',
  SNX: 'havven',
  DYDX: 'dydx',
  GMX: 'gmx',
  GRT: 'the-graph',
  FLOW: 'flow',
  KAVA: 'kava',
  ROSE: 'oasis-network',
  ONE: 'harmony',
  ALGO: 'algorand',
  XTZ: 'tezos',
  EGLD: 'elrond-erd-2',
  FTM: 'fantom',
  CAKE: 'pancakeswap-token',
  CVX: 'convex-finance',
  SPELL: 'spell-token',
  ALPHA: 'alpha-finance',
  BADGER: 'badger-dao',
  STKETH: 'lido-staked-ether',
  RETH: 'rocket-pool-eth',
  WSTETH: 'wrapped-steth',
  STETH: 'staked-ether',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  FRAX: 'frax',
  USDD: 'usdd',
  TUSD: 'trueusd',
  LUSD: 'liquity-usd',
  MIM: 'magic-internet-money',
  GUSD: 'gemini-dollar',
  PYUSD: 'paypal-usd',
  USDP: 'paxos-standard',
};

export class DynamicTokenSelector {
  private cacheDir: string;
  private cacheTTL = 30 * 60 * 1000; // 30 minutes

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
  }

  /** Get dynamic token selection based on Hyperliquid market data. */
  async selectTokens(criteria?: Partial<SelectionCriteria>): Promise<TokenSelection> {
    const config: SelectionCriteria = {
      minVolume24h: 5_000_000,    // $5M minimum
      topByVolume: 18,            // bumped 10 → 18 for more shots on goal per cycle
      fundingExtremes: 5,
      minFundingRate: 0.0003,     // 0.03%
      ...criteria
    };

    // Check cache first
    const cached = await this.readCache();
    if (cached) {
      console.log(`Using cached token selection (${cached.tokens.length} tokens)`);
      return cached;
    }

    try {
      // Fetch all Hyperliquid markets
      const marketData = await this.fetchHyperliquidMarkets();
      if (!marketData) {
        console.warn('Failed to fetch Hyperliquid data, using default tokens');
        return this.getDefaultSelection();
      }

      // Apply selection algorithm
      const selection = this.applySelectionCriteria(marketData, config);

      // Cache the results
      await this.writeCache(selection);

      return selection;
    } catch (error) {
      console.error(`Token selection failed: ${(error as Error).message}`);
      return this.getDefaultSelection();
    }
  }

  /** Fetch all Hyperliquid market data. */
  private async fetchHyperliquidMarkets(): Promise<MarketInfo[] | null> {
    try {
      const response = await fetch(HYPERLIQUID_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!response.ok) return null;

      const [meta, assetCtxs] = await response.json() as [MetaAndAssetCtxs, AssetCtx[]];

      const markets: MarketInfo[] = [];

      for (let i = 0; i < meta.universe.length && i < assetCtxs.length; i++) {
        const coin = meta.universe[i]!;
        const ctx = assetCtxs[i]!;

        const name = coin.name;
        // Reject rows with any non-finite field — a single NaN would otherwise
        // corrupt selection criteria downstream (volume filters, funding sort).
        const volume24h = safeNumber(ctx.dayNtlVlm);
        const funding = safeNumber(ctx.funding);
        const openInterest = safeNumber(ctx.openInterest);
        const markPrice = safeNumber(ctx.markPx);
        if (volume24h === null || funding === null || openInterest === null || markPrice === null) {
          continue;
        }
        const coingeckoId = HYPERLIQUID_TO_COINGECKO[name];

        markets.push({
          name,
          volume24h,
          funding,
          openInterest,
          markPrice,
          coingeckoId,
        });
      }

      return markets;
    } catch (error) {
      console.error(`Failed to fetch Hyperliquid markets: ${(error as Error).message}`);
      return null;
    }
  }

  /** Apply selection criteria to market data. */
  private applySelectionCriteria(markets: MarketInfo[], criteria: SelectionCriteria): TokenSelection {
    const selectedTokens = new Set<string>();
    const reasons: Record<string, string> = {};

    // Filter markets that have CoinGecko mappings and minimum volume
    const validMarkets = markets.filter(m =>
      m.coingeckoId &&
      m.volume24h >= 1_000_000 // At least $1M for any consideration
    );

    // 1. Always include BTC and ETH (macro indicators)
    const btc = validMarkets.find(m => m.name === 'BTC');
    const eth = validMarkets.find(m => m.name === 'ETH');

    if (btc?.coingeckoId) {
      selectedTokens.add(btc.coingeckoId);
      reasons[btc.coingeckoId] = 'Always included: macro indicator';
    }

    if (eth?.coingeckoId) {
      selectedTokens.add(eth.coingeckoId);
      reasons[eth.coingeckoId] = 'Always included: macro indicator';
    }

    // 2. Top N by volume (meeting minimum threshold)
    const topByVolume = validMarkets
      .filter(m => m.volume24h >= criteria.minVolume24h)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, criteria.topByVolume);

    for (const market of topByVolume) {
      if (market.coingeckoId) {
        selectedTokens.add(market.coingeckoId);
        if (!reasons[market.coingeckoId]) {
          const volumeStr = market.volume24h >= 1_000_000_000
            ? `$${(market.volume24h / 1_000_000_000).toFixed(1)}B`
            : `$${(market.volume24h / 1_000_000).toFixed(0)}M`;
          reasons[market.coingeckoId] = `Top volume: ${volumeStr} 24h`;
        }
      }
    }

    // 3. Extreme funding rates
    const extremeFunding = validMarkets
      .filter(m => Math.abs(m.funding) >= criteria.minFundingRate && m.volume24h >= 1_000_000)
      .sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
      .slice(0, criteria.fundingExtremes);

    for (const market of extremeFunding) {
      if (market.coingeckoId) {
        selectedTokens.add(market.coingeckoId);
        if (!reasons[market.coingeckoId] || reasons[market.coingeckoId]?.startsWith('Always')) {
          const fundingPercent = (market.funding * 100).toFixed(3);
          const direction = market.funding > 0 ? 'longs paying' : 'shorts paying';
          reasons[market.coingeckoId] = `Extreme funding: ${fundingPercent}% (${direction})`;
        }
      }
    }

    // Cap at 25 tokens — bumped from 20 to fit the wider topByVolume sweep
    // while staying under CoinGecko's free-tier rate limit (~30 req/min).
    const tokens = Array.from(selectedTokens).slice(0, 25);

    return {
      tokens,
      reason: Object.fromEntries(
        tokens.map(token => [token, reasons[token] || 'Selected by criteria'])
      ),
      totalMarketsScanned: markets.length,
      timestamp: Date.now(),
    };
  }

  /** Get default token selection when Hyperliquid is unavailable. */
  private getDefaultSelection(): TokenSelection {
    const defaultTokens = ['bitcoin', 'ethereum', 'solana', 'arbitrum', 'chainlink', 'aave', 'uniswap'];
    const reasons = Object.fromEntries(
      defaultTokens.map(token => [token, 'Fallback: Hyperliquid unavailable'])
    );

    return {
      tokens: defaultTokens,
      reason: reasons,
      totalMarketsScanned: 0,
      timestamp: Date.now(),
    };
  }

  /** Read cached token selection. */
  private async readCache(): Promise<TokenSelection | null> {
    try {
      const cacheFile = join(this.cacheDir, 'token-selection.json');
      const raw = await readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as TokenSelection;

      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached;
      }
    } catch {
      // No cache or invalid cache
    }
    return null;
  }

  /** Write token selection to cache. */
  private async writeCache(selection: TokenSelection): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const cacheFile = join(this.cacheDir, 'token-selection.json');
      await writeFile(cacheFile, JSON.stringify(selection, null, 2), 'utf-8');
    } catch {
      // Cache write failure is non-fatal
    }
  }

  /** Format token selection summary for display. */
  formatSelectionSummary(selection: TokenSelection): string {
    const lines: string[] = [];

    lines.push(`Dynamic Token Selection (${selection.tokens.length} tokens from ${selection.totalMarketsScanned} HL markets)`);
    lines.push('──────────────────────────────────────────');

    // Group tokens by reason type
    const topVolume: string[] = [];
    const fundingPlays: string[] = [];
    const always: string[] = [];
    const other: string[] = [];

    for (const token of selection.tokens) {
      const reason = selection.reason[token] || '';
      if (reason.includes('Top volume')) {
        topVolume.push(token.toUpperCase());
      } else if (reason.includes('Extreme funding')) {
        const match = reason.match(/(-?\d+\.\d+)%/);
        const rate = match ? ` (${match[1]}%)` : '';
        fundingPlays.push(`${token.toUpperCase()}${rate}`);
      } else if (reason.includes('Always included')) {
        always.push(token.toUpperCase());
      } else {
        other.push(token.toUpperCase());
      }
    }

    if (topVolume.length > 0) {
      lines.push(`Top volume: ${topVolume.join(', ')}`);
    }
    if (fundingPlays.length > 0) {
      lines.push(`Funding plays: ${fundingPlays.join(', ')}`);
    }
    if (always.length > 0) {
      lines.push(`Always: ${always.join(', ')}`);
    }
    if (other.length > 0) {
      lines.push(`Other: ${other.join(', ')}`);
    }

    return lines.join('\n');
  }
}