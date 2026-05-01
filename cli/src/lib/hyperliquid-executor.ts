/**
 * Thin wrapper around the Hermes HL skill's hyperliquid.mjs script.
 * Shells out to `node ~/.hermes/skills/openclaw-imports/hyperliquid/scripts/hyperliquid.mjs`
 * so the CLI doesn't need the `hyperliquid` npm package as a dependency.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const HL_SCRIPT = resolve(
  homedir(),
  '.hermes/skills/openclaw-imports/hyperliquid/scripts/hyperliquid.mjs',
);

/** CoinGecko token ID → Hyperliquid ticker (used by the HL SDK script). */
const TOKEN_TO_HL_COIN: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  arbitrum: 'ARB',
  dogecoin: 'DOGE',
  chainlink: 'LINK',
  aave: 'AAVE',
  uniswap: 'UNI',
  ripple: 'XRP',
  polkadot: 'DOT',
  avalanche: 'AVAX',
  hyperliquid: 'HYPE',
  zcash: 'ZEC',
  bittensor: 'TAO',
  'worldcoin-wld': 'WLD',
  fartcoin: 'FARTCOIN',
  'fetch-ai': 'FET',
  pepe: 'PEPE',
  pendle: 'PENDLE',
  sui: 'SUI',
  near: 'NEAR',
  aptos: 'APT',
};

export interface HLOrderResult {
  success: boolean;
  orderId?: string;
  executedPrice?: number;
  executedSize?: number;
  error?: string;
}

/** Resolve a CoinGecko token ID to its Hyperliquid ticker symbol. */
export function resolveHLCoin(tokenId: string): string | undefined {
  return TOKEN_TO_HL_COIN[tokenId];
}

/**
 * Execute the HL script with the given command and args.
 * Passes HYPERLIQUID_PRIVATE_KEY and HYPERLIQUID_ADDRESS from process.env.
 */
function runHLScript(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };

    // Ensure required env vars are forwarded
    if (process.env.HYPERLIQUID_PRIVATE_KEY) {
      env.HYPERLIQUID_PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY;
    }
    if (process.env.HYPERLIQUID_ADDRESS) {
      env.HYPERLIQUID_ADDRESS = process.env.HYPERLIQUID_ADDRESS;
    }

    execFile(
      'node',
      [HL_SCRIPT, command, ...args],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          // The script writes errors to stderr and exits non-zero
          const msg = stderr?.trim() || error.message;
          reject(new Error(`HL script failed: ${msg}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Parse the placeOrder response from the HL SDK into a normalized result. */
function parseOrderResponse(raw: string): HLOrderResult {
  try {
    const data = JSON.parse(raw);

    // SDK response shape: { response: { type: "order", data: { statuses: [...] } } }
    const statuses = data?.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      // Might be a direct error
      if (data?.response?.type === 'error') {
        return { success: false, error: data.response.data || 'Unknown HL error' };
      }
      return { success: false, error: `Unexpected response: ${raw.slice(0, 200)}` };
    }

    const status = statuses[0];

    // Filled: { filled: { totalSz, avgPx, oid } }
    if (status.filled) {
      return {
        success: true,
        orderId: String(status.filled.oid),
        executedPrice: parseFloat(status.filled.avgPx),
        executedSize: parseFloat(status.filled.totalSz),
      };
    }

    // Resting (limit order placed but not filled): { resting: { oid } }
    if (status.resting) {
      return {
        success: true,
        orderId: String(status.resting.oid),
      };
    }

    // Error status: { error: "reason" }
    if (status.error) {
      return { success: false, error: status.error };
    }

    return { success: false, error: `Unrecognized status: ${JSON.stringify(status)}` };
  } catch {
    return { success: false, error: `Failed to parse HL response: ${raw.slice(0, 200)}` };
  }
}

/** Place a market buy order on Hyperliquid perps. */
export async function hlMarketBuy(coin: string, sizeInToken: number): Promise<HLOrderResult> {
  const raw = await runHLScript('market-buy', [coin, String(sizeInToken)]);
  return parseOrderResponse(raw);
}

/** Place a market sell order on Hyperliquid perps. */
export async function hlMarketSell(coin: string, sizeInToken: number): Promise<HLOrderResult> {
  const raw = await runHLScript('market-sell', [coin, String(sizeInToken)]);
  return parseOrderResponse(raw);
}

/** Get account balance from Hyperliquid. */
export async function hlGetBalance(): Promise<{ equity: number; availableBalance: number }> {
  const raw = await runHLScript('balance');
  const data = JSON.parse(raw);

  // clearinghouseState shape: { marginSummary: { accountValue, totalMarginUsed, ... }, ... }
  const summary = data?.marginSummary;
  if (!summary) {
    throw new Error(`Unexpected balance response: ${raw.slice(0, 200)}`);
  }

  return {
    equity: parseFloat(summary.accountValue),
    availableBalance: parseFloat(summary.accountValue) - parseFloat(summary.totalMarginUsed),
  };
}

/** Get open positions from Hyperliquid. */
export async function hlGetPositions(): Promise<
  Array<{ coin: string; size: number; entryPrice: number; unrealizedPnl: number; side: string }>
> {
  const raw = await runHLScript('positions');
  const positions = JSON.parse(raw) as Array<{ position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string } }>;

  return positions
    .filter((p) => parseFloat(p.position.szi) !== 0)
    .map((p) => {
      const size = parseFloat(p.position.szi);
      return {
        coin: p.position.coin,
        size: Math.abs(size),
        entryPrice: parseFloat(p.position.entryPx),
        unrealizedPnl: parseFloat(p.position.unrealizedPnl),
        side: size > 0 ? 'long' : 'short',
      };
    });
}

/**
 * Place a GTC limit order on Hyperliquid perps.
 * Returns oid (HyperCore order ID) on success.
 */
export async function hlPlaceLimitOrder(
  coin: string,
  isBuy: boolean,
  sizeInToken: number,
  limitPrice: number,
): Promise<HLOrderResult> {
  const cmd = isBuy ? 'limit-buy' : 'limit-sell';
  const raw = await runHLScript(cmd, [coin, String(sizeInToken), String(limitPrice)]);
  return parseOrderResponse(raw);
}

/**
 * Cancel all open orders, optionally scoped to a single coin.
 * Returns the raw response.
 */
export async function hlCancelAllOrders(coin?: string): Promise<string> {
  const args = coin ? [coin] : [];
  return runHLScript('cancel-all', args);
}

/** Validate that required env vars are set for live HL trading. */
export function validateHLEnv(): void {
  if (!process.env.HYPERLIQUID_PRIVATE_KEY) {
    throw new Error(
      'HYPERLIQUID_PRIVATE_KEY env var is required for hyperliquid-perp mode. ' +
      'Export it before running with --mode hyperliquid-perp.',
    );
  }
}

export interface HLAssetMeta {
  name: string;
  szDecimals: number;
  /**
   * USD price decimals = 6 - szDecimals (Hyperliquid convention).
   * E.g. BTC szDecimals=5 → pxDecimals=1; SOL szDecimals=2 → pxDecimals=4.
   */
  pxDecimals: number;
}

const META_TTL_MS = 60 * 60 * 1000; // 1 hour
let _metaCache: Map<string, HLAssetMeta> | null = null;
let _metaCachedAt = 0;

/**
 * Fetch HL perp universe metadata, returning per-coin szDecimals + pxDecimals.
 * Caches the result for {@link META_TTL_MS} so long-running daemons refresh
 * after universe additions without needing a restart.
 */
export async function hlGetMeta(): Promise<Map<string, HLAssetMeta>> {
  if (_metaCache && Date.now() - _metaCachedAt < META_TTL_MS) return _metaCache;
  const raw = await runHLScript('meta');
  const universe = JSON.parse(raw) as Array<{ name: string; szDecimals: number }>;
  const fresh = new Map<string, HLAssetMeta>();
  for (const u of universe) {
    // Hyperliquid convention: pxDecimals = 6 - szDecimals (so price * 10^pxDecimals fits uint64).
    // Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#perpetuals-metadata
    const pxDecimals = 6 - u.szDecimals;
    fresh.set(u.name, { name: u.name, szDecimals: u.szDecimals, pxDecimals });
  }
  _metaCache = fresh;
  _metaCachedAt = Date.now();
  return _metaCache;
}

/** Force refetch on next hlGetMeta() call. */
export function hlInvalidateMeta(): void {
  _metaCache = null;
  _metaCachedAt = 0;
}
