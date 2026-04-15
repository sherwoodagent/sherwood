/**
 * Signal tracker — reads signal history and computes hypothetical P&L
 * by fetching current prices from Hyperliquid.
 */

import { readFile } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSignalFilePath, getSignalDir } from './signal-logger.js';
import type { SignalLogEntry } from './signal-logger.js';

const HYPERLIQUID_BASE = 'https://api.hyperliquid.xyz/info';

// Map CoinGecko token IDs to Hyperliquid coin names
const TOKEN_TO_HL: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  arbitrum: 'ARB',
  chainlink: 'LINK',
  aave: 'AAVE',
  uniswap: 'UNI',
  dogecoin: 'DOGE',
  avalanche: 'AVAX',
  near: 'NEAR',
  sui: 'SUI',
  aptos: 'APT',
  injective: 'INJ',
  pendle: 'PENDLE',
  pepe: 'PEPE',
  polygon: 'MATIC',
  optimism: 'OP',
  litecoin: 'LTC',
  cosmos: 'ATOM',
  filecoin: 'FIL',
  maker: 'MKR',
  cardano: 'ADA',
  polkadot: 'DOT',
  render: 'RENDER',
  jupiter: 'JUP',
};

interface HLAssetCtx {
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  markPx: string;
  oraclePx: string;
  prevDayPx: string;
}

interface PriceMap {
  [symbol: string]: number;
}

/** Fetch all current prices from Hyperliquid in one call. */
async function fetchHLPrices(): Promise<PriceMap> {
  const resp = await fetch(HYPERLIQUID_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });

  if (!resp.ok) {
    throw new Error(`Hyperliquid API error: ${resp.status}`);
  }

  const data = await resp.json() as [
    { universe: Array<{ name: string }> },
    HLAssetCtx[]
  ];

  const [meta, assetCtxs] = data;
  const prices: PriceMap = {};

  for (let i = 0; i < meta.universe.length; i++) {
    const name = meta.universe[i]!.name;
    const ctx = assetCtxs[i];
    if (ctx) {
      prices[name] = parseFloat(ctx.markPx);
    }
  }

  return prices;
}

/** Read all signal entries from JSONL files within the given time range. */
async function readSignals(days: number, tokenFilter?: string): Promise<SignalLogEntry[]> {
  const entries: SignalLogEntry[] = [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = getSignalDir();

  if (!existsSync(dir)) return entries;

  // Collect all signal history files
  const files: string[] = [];
  const mainFile = getSignalFilePath();
  if (existsSync(mainFile)) {
    files.push(mainFile);
  }

  // Also read rotated files
  try {
    const dirEntries = readdirSync(dir);
    for (const entry of dirEntries) {
      if (entry.startsWith('signal-history-') && entry.endsWith('.jsonl')) {
        files.push(join(dir, entry));
      }
    }
  } catch {
    // dir doesn't exist
  }

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SignalLogEntry;
          const ts = new Date(entry.timestamp).getTime();
          if (ts >= cutoff) {
            if (!tokenFilter || entry.tokenId === tokenFilter || entry.tokenSymbol.toLowerCase() === tokenFilter.toLowerCase()) {
              entries.push(entry);
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return entries;
}

export interface TokenStats {
  token: string;
  signalCount: number;
  avgPnl: number;
  winRate: number;
  bestSignalType: string;
  bestSignalPnl: number;
}

export interface SignalTypeStats {
  signalType: string;
  count: number;
  avgPnl: number;
  winRate: number;
}

export interface RegimeStats {
  regime: string;
  count: number;
  avgPnl: number;
  winRate: number;
}

export interface TrackingReport {
  days: number;
  totalSignals: number;
  byToken: TokenStats[];
  bySignalType: SignalTypeStats[];
  byRegime: RegimeStats[];
}

/** Compute the P&L for a signal entry given the current price. */
function computePnl(entry: SignalLogEntry, currentPrice: number): number | null {
  if (!entry.price || entry.price <= 0 || !currentPrice || currentPrice <= 0) return null;

  const pctChange = ((currentPrice - entry.price) / entry.price) * 100;

  // For SELL/STRONG_SELL, invert (short position would profit from price drops)
  if (entry.decision === 'SELL' || entry.decision === 'STRONG_SELL') {
    return -pctChange;
  }
  // For BUY/STRONG_BUY, long position profits from price increases
  if (entry.decision === 'BUY' || entry.decision === 'STRONG_BUY') {
    return pctChange;
  }
  // HOLD — no position
  return null;
}

/** Generate a full tracking report. */
export async function generateReport(days: number = 7, tokenFilter?: string): Promise<TrackingReport> {
  const signals = await readSignals(days, tokenFilter);
  const prices = await fetchHLPrices();

  // Map token IDs to HL symbols and get current prices
  const tokenPriceMap: Record<string, number> = {};
  for (const [cgId, hlSymbol] of Object.entries(TOKEN_TO_HL)) {
    if (prices[hlSymbol] !== undefined) {
      tokenPriceMap[cgId] = prices[hlSymbol]!;
    }
  }

  // Filter to actionable signals only (not HOLD)
  const actionableSignals = signals.filter(
    (s) => s.decision !== 'HOLD'
  );

  // Compute P&L for each signal
  const signalsWithPnl: Array<{ entry: SignalLogEntry; pnl: number }> = [];
  for (const entry of actionableSignals) {
    const currentPrice = tokenPriceMap[entry.tokenId];
    if (currentPrice === undefined) continue;
    const pnl = computePnl(entry, currentPrice);
    if (pnl !== null) {
      signalsWithPnl.push({ entry, pnl });
    }
  }

  // Group by token
  const tokenGroups: Record<string, Array<{ entry: SignalLogEntry; pnl: number }>> = {};
  for (const sp of signalsWithPnl) {
    const key = sp.entry.tokenId;
    if (!tokenGroups[key]) tokenGroups[key] = [];
    tokenGroups[key]!.push(sp);
  }

  const byToken: TokenStats[] = [];
  for (const [token, group] of Object.entries(tokenGroups)) {
    const pnls = group.map((g) => g.pnl);
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const wins = pnls.filter((p) => p > 0).length;
    const winRate = (wins / pnls.length) * 100;

    // Best signal type
    const byType: Record<string, number[]> = {};
    for (const g of group) {
      const t = g.entry.decision;
      if (!byType[t]) byType[t] = [];
      byType[t]!.push(g.pnl);
    }
    let bestType = '';
    let bestTypePnl = -Infinity;
    for (const [type, typePnls] of Object.entries(byType)) {
      const avg = typePnls.reduce((a, b) => a + b, 0) / typePnls.length;
      if (avg > bestTypePnl) {
        bestType = type;
        bestTypePnl = avg;
      }
    }

    byToken.push({
      token,
      signalCount: group.length,
      avgPnl,
      winRate,
      bestSignalType: bestType,
      bestSignalPnl: bestTypePnl,
    });
  }

  // Sort by avg P&L descending
  byToken.sort((a, b) => b.avgPnl - a.avgPnl);

  // Group by signal type
  const signalTypeGroups: Record<string, number[]> = {};
  for (const sp of signalsWithPnl) {
    const key = sp.entry.decision;
    if (!signalTypeGroups[key]) signalTypeGroups[key] = [];
    signalTypeGroups[key]!.push(sp.pnl);
  }

  const bySignalType: SignalTypeStats[] = [];
  for (const [signalType, pnls] of Object.entries(signalTypeGroups)) {
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const wins = pnls.filter((p) => p > 0).length;
    bySignalType.push({
      signalType,
      count: pnls.length,
      avgPnl,
      winRate: (wins / pnls.length) * 100,
    });
  }

  // Group by regime
  const regimeGroups: Record<string, number[]> = {};
  for (const sp of signalsWithPnl) {
    const key = sp.entry.regime || 'unknown';
    if (!regimeGroups[key]) regimeGroups[key] = [];
    regimeGroups[key]!.push(sp.pnl);
  }

  const byRegime: RegimeStats[] = [];
  for (const [regime, pnls] of Object.entries(regimeGroups)) {
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const wins = pnls.filter((p) => p > 0).length;
    byRegime.push({
      regime,
      count: pnls.length,
      avgPnl,
      winRate: (wins / pnls.length) * 100,
    });
  }

  return {
    days,
    totalSignals: signalsWithPnl.length,
    byToken,
    bySignalType,
    byRegime,
  };
}

/** Format the tracking report as a readable table string. */
export function formatReport(report: TrackingReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`SIGNAL ACCURACY REPORT (Last ${report.days} Days)`);
  lines.push('='.repeat(70));

  if (report.totalSignals === 0) {
    lines.push('');
    lines.push('No actionable signals found in the given time range.');
    lines.push('Run `sherwood agent analyze` to generate signals first.');
    lines.push('');
    return lines.join('\n');
  }

  // By Token
  lines.push('');
  const tokenHeader = `${'Token'.padEnd(14)} | ${'Signals'.padEnd(8)} | ${'Avg P&L'.padEnd(10)} | ${'Win Rate'.padEnd(10)} | Best Signal`;
  lines.push(tokenHeader);
  lines.push('-'.repeat(70));

  for (const t of report.byToken) {
    const pnlStr = (t.avgPnl >= 0 ? '+' : '') + t.avgPnl.toFixed(1) + '%';
    const winStr = t.winRate.toFixed(1) + '%';
    const bestStr = `${t.bestSignalType} (${t.bestSignalPnl >= 0 ? '+' : ''}${t.bestSignalPnl.toFixed(1)}%)`;
    lines.push(
      `${t.token.padEnd(14)} | ${String(t.signalCount).padEnd(8)} | ${pnlStr.padEnd(10)} | ${winStr.padEnd(10)} | ${bestStr}`
    );
  }

  // By Signal Type
  lines.push('');
  lines.push('By Signal Type:');
  for (const s of report.bySignalType) {
    const pnlStr = (s.avgPnl >= 0 ? '+' : '') + s.avgPnl.toFixed(1) + '%';
    const shortNote = s.signalType === 'SELL' || s.signalType === 'STRONG_SELL' ? ' (short)' : '';
    lines.push(
      `${s.signalType.padEnd(12)} | ${String(s.count)} signals | Avg ${pnlStr}${shortNote} | ${s.winRate.toFixed(1)}% win rate`
    );
  }

  // By Regime
  lines.push('');
  lines.push('By Regime:');
  for (const r of report.byRegime) {
    const pnlStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(1) + '%';
    lines.push(
      `${r.regime.padEnd(16)} | ${String(r.count)} signals | Avg ${pnlStr} | ${r.winRate.toFixed(1)}% win rate`
    );
  }

  lines.push('');
  return lines.join('\n');
}
