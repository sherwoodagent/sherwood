/**
 * TradingView MCP data provider — spawns a local TradingView MCP server
 * (JSON-RPC over stdio) and exposes coin analysis + multi-timeframe alignment.
 *
 * The MCP server is spawned once on first call and kept alive for the process
 * lifetime. If it dies, it is respawned on the next call.
 *
 * Results are cached for 5 minutes per (symbol, tool, timeframe) key.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Symbol mapping — CoinGecko token IDs → TradingView BINANCE symbols
// ---------------------------------------------------------------------------

const TV_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  solana: 'SOLUSDT',
  arbitrum: 'ARBUSDT',
  chainlink: 'LINKUSDT',
  aave: 'AAVEUSDT',
  uniswap: 'UNIUSDT',
  dogecoin: 'DOGEUSDT',
  avalanche: 'AVAXUSDT',
  'avalanche-2': 'AVAXUSDT',
  near: 'NEARUSDT',
  sui: 'SUIUSDT',
  aptos: 'APTUSDT',
  injective: 'INJUSDT',
  pendle: 'PENDLEUSDT',
  pepe: 'PEPEUSDT',
  polygon: 'MATICUSDT',
  optimism: 'OPUSDT',
  litecoin: 'LTCUSDT',
  cosmos: 'ATOMUSDT',
  filecoin: 'FILUSDT',
  maker: 'MKRUSDT',
  cardano: 'ADAUSDT',
  polkadot: 'DOTUSDT',
  render: 'RENDERUSDT',
  jupiter: 'JUPUSDT',
  hyperliquid: 'HYPEUSDT',
  ethena: 'ENAUSDT',
  zcash: 'ZECUSDT',
  ripple: 'XRPUSDT',
  bittensor: 'TAOUSDT',
  fartcoin: 'FARTCOINUSDT',
  binancecoin: 'BNBUSDT',
  blur: 'BLURUSDT',
  'worldcoin-wld': 'WLDUSDT',
  'pudgy-penguins': 'PENGUUSDT',
  'fetch-ai': 'FETUSDT',
};

const DEFAULT_EXCHANGE = 'BINANCE';
const MCP_BIN = '/home/ana/.local/tradingview-mcp/bin/tradingview-mcp';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TVAnalysis {
  symbol: string;
  timeframe: string;
  /** Overall recommendation: -1 (Strong Sell) to +1 (Strong Buy). */
  recommendAll: number;
  /** Buy/sell signal string from market_sentiment. */
  buySellSignal: string;
  /** Number of buy indicators. */
  buyCount: number;
  /** Number of sell indicators. */
  sellCount: number;
  /** Number of neutral indicators. */
  neutralCount: number;
  /** Total indicator count. */
  totalIndicators: number;
  /** Raw response payload for debugging. */
  raw: any;
}

export interface TVAlignment {
  symbol: string;
  /** Per-timeframe recommendation (-1 to +1). */
  timeframes: Record<string, number>;
  /** Number of timeframes agreeing on direction. */
  agreeing: number;
  /** Total timeframes analysed. */
  total: number;
  raw: any;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  ts: number;
  data: T;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry<any>>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T): void {
  cache.set(key, { ts: Date.now(), data });
}

// ---------------------------------------------------------------------------
// MCP process management (singleton)
// ---------------------------------------------------------------------------

let mcpProcess: ChildProcess | null = null;
let mcpReadline: ReadlineInterface | null = null;
let mcpReady = false;
let nextId = 1;

/** Pending JSON-RPC responses keyed by request id. */
const pending = new Map<number, {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const RPC_TIMEOUT_MS = 15_000;

function ensureProcess(): ChildProcess {
  if (mcpProcess && !mcpProcess.killed && mcpProcess.exitCode === null) {
    return mcpProcess;
  }

  // Reset state on respawn
  mcpReady = false;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('MCP process died — respawning'));
  }
  pending.clear();

  mcpProcess = spawn(MCP_BIN, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  mcpReadline = createInterface({ input: mcpProcess.stdout! });
  mcpReadline.on('line', (line: string) => {
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      if (id !== undefined && pending.has(id)) {
        const p = pending.get(id)!;
        clearTimeout(p.timer);
        pending.delete(id);
        if (msg.error) {
          p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      }
    } catch {
      // Non-JSON line or notification — ignore
    }
  });

  mcpProcess.on('exit', () => {
    mcpProcess = null;
    mcpReady = false;
  });

  mcpProcess.stderr?.on('data', () => {
    // Swallow stderr to prevent backpressure
  });

  return mcpProcess;
}

function rpcSend(method: string, params: any): Promise<any> {
  const proc = ensureProcess();
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP RPC timeout for ${method} (${RPC_TIMEOUT_MS}ms)`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });

    proc.stdin!.write(msg, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

async function ensureInitialized(): Promise<void> {
  if (mcpReady) return;

  ensureProcess();

  // Send initialize
  await rpcSend('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sherwood', version: '1.0' },
  });

  // Send initialized notification (no id, fire-and-forget)
  const proc = ensureProcess();
  proc.stdin!.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
  );

  mcpReady = true;
}

async function callTool(name: string, args: Record<string, any>): Promise<any> {
  await ensureInitialized();
  const result = await rpcSend('tools/call', { name, arguments: args });
  // MCP tool results come as { content: [{ type: "text", text: "..." }] }
  if (result?.content?.[0]?.text) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a buy/sell signal string to a numeric value (-1 to +1).
 */
function signalToValue(signal: string): number {
  const s = (signal || '').toLowerCase().trim();
  if (s === 'strong buy') return 1.0;
  if (s === 'buy') return 0.5;
  if (s === 'neutral') return 0.0;
  if (s === 'sell') return -0.5;
  if (s === 'strong sell') return -1.0;
  return 0.0;
}

/**
 * Get coin analysis from TradingView MCP.
 * Returns null if the token is unmapped or the MCP call fails.
 */
export async function getCoinAnalysis(
  tokenId: string,
  timeframe: string = '4h',
): Promise<TVAnalysis | null> {
  const symbol = TV_SYMBOLS[tokenId];
  if (!symbol) return null;

  const cacheKey = `tv:coin:${symbol}:${timeframe}`;
  const cached = cacheGet<TVAnalysis>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await callTool('coin_analysis', {
      symbol,
      exchange: DEFAULT_EXCHANGE,
      timeframe,
    });

    // Parse the response — structure varies, extract what we need
    const recommendAll = typeof raw?.recommend_all === 'number'
      ? raw.recommend_all
      : typeof raw?.summary?.RECOMMENDATION === 'string'
        ? signalToValue(raw.summary.RECOMMENDATION)
        : 0;

    const buySellSignal: string =
      raw?.market_sentiment?.buy_sell_signal
      ?? raw?.summary?.RECOMMENDATION
      ?? 'Neutral';

    const buyCount = raw?.summary?.BUY ?? raw?.buy_count ?? 0;
    const sellCount = raw?.summary?.SELL ?? raw?.sell_count ?? 0;
    const neutralCount = raw?.summary?.NEUTRAL ?? raw?.neutral_count ?? 0;

    const result: TVAnalysis = {
      symbol,
      timeframe,
      recommendAll: Math.max(-1, Math.min(1, recommendAll)),
      buySellSignal,
      buyCount,
      sellCount,
      neutralCount,
      totalIndicators: buyCount + sellCount + neutralCount,
      raw,
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`TradingView MCP coin_analysis failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Get multi-timeframe alignment from TradingView MCP.
 * Returns null if the token is unmapped or the MCP call fails.
 */
export async function getMultiTimeframeAlignment(
  tokenId: string,
): Promise<TVAlignment | null> {
  const symbol = TV_SYMBOLS[tokenId];
  if (!symbol) return null;

  const cacheKey = `tv:mtf:${symbol}`;
  const cached = cacheGet<TVAlignment>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await callTool('multi_timeframe_analysis', {
      symbol,
      exchange: DEFAULT_EXCHANGE,
    });

    // Parse per-timeframe recommendations
    const timeframes: Record<string, number> = {};
    const tfKeys = ['15m', '1h', '4h', 'daily', 'weekly'];

    for (const tf of tfKeys) {
      const tfData = raw?.[tf] ?? raw?.timeframes?.[tf];
      if (tfData) {
        const rec =
          typeof tfData.recommend_all === 'number'
            ? tfData.recommend_all
            : typeof tfData.RECOMMENDATION === 'string'
              ? signalToValue(tfData.RECOMMENDATION)
              : typeof tfData.recommendation === 'string'
                ? signalToValue(tfData.recommendation)
                : null;
        if (rec !== null) {
          timeframes[tf] = Math.max(-1, Math.min(1, rec));
        }
      }
    }

    const values = Object.values(timeframes);
    const majoritySign = values.reduce((s, v) => s + Math.sign(v), 0);
    const direction = majoritySign > 0 ? 1 : majoritySign < 0 ? -1 : 0;
    const agreeing = values.filter((v) => Math.sign(v) === direction).length;

    const result: TVAlignment = {
      symbol,
      timeframes,
      agreeing,
      total: values.length,
      raw,
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`TradingView MCP multi_timeframe failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Check if the TradingView MCP binary exists.
 */
export function isTradingViewAvailable(): boolean {
  try {
    require('node:fs').accessSync(MCP_BIN, require('node:fs').constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully shut down the MCP process (call on agent exit).
 */
export function shutdownTradingView(): void {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill('SIGTERM');
    mcpProcess = null;
    mcpReady = false;
  }
}
