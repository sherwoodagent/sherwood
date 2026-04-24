/**
 * Portfolio tracking with JSON file persistence.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import type { Position, PortfolioState } from './risk.js';

/** Margin fraction for perp positions — both longs and shorts. */
const MARGIN_FRACTION = 0.33;

/**
 * Compute total portfolio value with margin-based position accounting.
 * For leveraged perp positions, the portfolio "owns" the margin + unrealized PnL,
 * not the full notional. This prevents phantom value when cash is debited at
 * margin rate but positions are counted at full notional.
 */
function computeTotalValue(cash: number, positions: Position[]): number {
  const positionEquity = positions.reduce((sum, p) => {
    const isShort = p.side === 'short';
    const pnl = isShort
      ? (p.entryPrice - p.currentPrice) * p.quantity
      : (p.currentPrice - p.entryPrice) * p.quantity;
    return sum + p.quantity * p.entryPrice * MARGIN_FRACTION + pnl;
  }, 0);
  return cash + positionEquity;
}

/** Check and reset PnL counters based on time boundaries */
export function resetPnlCounters(state: PortfolioState): PortfolioState {
  const now = Date.now();
  const updated = { ...state };

  // Reset daily PnL at midnight UTC
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayMs = todayMidnight.getTime();
  if (!updated.lastDailyReset || updated.lastDailyReset < todayMs) {
    updated.dailyPnl = 0;
    updated.lastDailyReset = now;
  }

  // Orca-inspired: PnL-aware daily cap, see README / PR #223.
  // Reset the daily-entry counter on the same UTC day boundary as dailyPnl.
  // Tracked independently (lastDailyEntriesReset) so legacy files missing
  // `dailyEntries` reset cleanly on first load.
  if (!updated.lastDailyEntriesReset || updated.lastDailyEntriesReset < todayMs) {
    updated.dailyEntries = 0;
    updated.lastDailyEntriesReset = now;
  }

  // Reset weekly PnL on Monday midnight UTC
  const dayOfWeek = new Date(now).getUTCDay(); // 0=Sun, 1=Mon
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mondayMidnight = new Date();
  mondayMidnight.setUTCHours(0, 0, 0, 0);
  mondayMidnight.setUTCDate(mondayMidnight.getUTCDate() - daysSinceMonday);
  const mondayMs = mondayMidnight.getTime();
  if (!updated.lastWeeklyReset || updated.lastWeeklyReset < mondayMs) {
    updated.weeklyPnl = 0;
    updated.lastWeeklyReset = now;
  }

  // Reset monthly PnL on 1st of month midnight UTC
  const firstOfMonth = new Date();
  firstOfMonth.setUTCHours(0, 0, 0, 0);
  firstOfMonth.setUTCDate(1);
  const firstMs = firstOfMonth.getTime();
  if (!updated.lastMonthlyReset || updated.lastMonthlyReset < firstMs) {
    updated.monthlyPnl = 0;
    updated.lastMonthlyReset = now;
  }

  return updated;
}

export interface TradeRecord {
  tokenId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
  pnlPercent: number;
  entryTimestamp: number;
  exitTimestamp: number;
  duration: number;
  strategy: string;
  exitReason: string;
}

const DEFAULT_PORTFOLIO: PortfolioState = {
  totalValue: 10000,
  positions: [],
  cash: 10000,
  dailyPnl: 0,
  weeklyPnl: 0,
  monthlyPnl: 0,
  dailyEntries: 0,
  initialValue: 10000,
};

function createDefaultPortfolio(): PortfolioState {
  return {
    ...DEFAULT_PORTFOLIO,
    positions: [],
    stopCooldowns: {},
    tokenConsecLosses: {},
    tokenLossCooldowns: {},
  };
}

export class PortfolioTracker {
  private statePath: string;
  private historyPath: string;
  private state: PortfolioState;
  /** In-process mutex — serializes load/modify/save sequences to prevent
   *  overlapping cycles from double-closing positions or double-debiting cash. */
  private _lock: Promise<void> = Promise.resolve();

  constructor() {
    const base = join(homedir(), '.sherwood', 'agent');
    this.statePath = join(base, 'portfolio.json');
    this.historyPath = join(base, 'trades.json');
    this.state = createDefaultPortfolio();
  }

  /** Acquire the in-process lock. Callers that perform load→modify→save
   *  should wrap their sequence: `const release = await this.acquireLock();`
   *  then `release()` in a finally block. */
  private acquireLock(): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this._lock;
    this._lock = next;
    return prev.then(() => release!);
  }

  /**
   * Initialize portfolio from on-chain vault balance instead of the
   * hardcoded $10k default. Reads totalAssets() from the vault that
   * the strategy clone is deployed to.
   *
   * Call once on startup (before the first cycle) when no persisted
   * portfolio.json exists. If a portfolio already exists on disk,
   * this is a no-op — we trust the persisted state.
   *
   * @param strategyClone - HyperliquidPerpStrategy clone address
   * @param chain - 'hyperevm' | 'hyperevm-testnet'
   */
  async initFromOnChain(strategyClone: string, chain: string): Promise<void> {
    // Only initialize if no persisted state exists
    try {
      await readFile(this.statePath, 'utf-8');
      return; // file exists — trust persisted state
    } catch {
      // No file — initialize from on-chain
    }

    try {
      const { createPublicClient, http } = await import('viem');
      const { hyperevm, hyperevmTestnet } = await import('../lib/network.js');
      const { BASE_STRATEGY_ABI, SYNDICATE_VAULT_ABI } = await import('../lib/abis.js');

      const selectedChain = chain === 'hyperevm-testnet' ? hyperevmTestnet : hyperevm;
      const client = createPublicClient({
        chain: selectedChain,
        transport: http(),
      });

      // Read vault address from the strategy clone
      const vaultAddr = await client.readContract({
        address: strategyClone as `0x${string}`,
        abi: BASE_STRATEGY_ABI,
        functionName: 'vault',
      }) as `0x${string}`;

      if (!vaultAddr || vaultAddr === '0x0000000000000000000000000000000000000000') {
        console.error('[portfolio] Strategy clone has no vault — using default portfolio');
        return;
      }

      // Read total assets from the vault (USDC, 6 decimals)
      const totalAssets = await client.readContract({
        address: vaultAddr,
        abi: SYNDICATE_VAULT_ABI,
        functionName: 'totalAssets',
      }) as bigint;

      const vaultValueUsd = Number(totalAssets) / 1e6; // USDC 6 decimals

      if (vaultValueUsd > 0) {
        this.state = {
          ...createDefaultPortfolio(),
          totalValue: vaultValueUsd,
          cash: vaultValueUsd,
          initialValue: vaultValueUsd, // anchor cumulative PnL% to the on-chain starting balance
        };
        await this.save(this.state);
        console.error(`[portfolio] Initialized from on-chain vault: $${vaultValueUsd.toFixed(2)} USDC`);
      } else {
        console.error('[portfolio] Vault has 0 assets — using default portfolio');
      }
    } catch (err) {
      console.error(`[portfolio] Failed to read on-chain balance: ${(err as Error).message} — using default`);
    }
  }

  /**
   * Force-refresh portfolio value from on-chain vault balance.
   * Unlike initFromOnChain(), this runs even if portfolio.json exists.
   * Call via `sherwood agent config --sync-vault` or on explicit user request.
   */
  async syncFromOnChain(strategyClone: string, chain: string): Promise<void> {
    // Temporarily remove the file so initFromOnChain doesn't short-circuit
    try { await import('node:fs/promises').then(fs => fs.unlink(this.statePath)); } catch { /* ok */ }
    await this.initFromOnChain(strategyClone, chain);
  }

  /** Load portfolio state from disk with validation */
  async load(): Promise<PortfolioState> {
    try {
      const data = await readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(data) as PortfolioState;

      // Validate critical numeric fields are finite and non-negative
      if (
        !Number.isFinite(parsed.totalValue) || parsed.totalValue < 0
        || !Number.isFinite(parsed.cash) || parsed.cash < 0
        || !Number.isFinite(parsed.dailyPnl)
        || !Number.isFinite(parsed.weeklyPnl)
        || !Number.isFinite(parsed.monthlyPnl)
        || !Array.isArray(parsed.positions)
      ) {
        console.error('Portfolio file has invalid data — resetting to defaults');
        this.state = createDefaultPortfolio();
        return this.state;
      }

      // Validate each position
      for (const p of parsed.positions) {
        if (
          !Number.isFinite(p.entryPrice) || p.entryPrice <= 0
          || !Number.isFinite(p.quantity) || p.quantity <= 0
          || !Number.isFinite(p.currentPrice) || p.currentPrice <= 0
          || !Number.isFinite(p.stopLoss) || p.stopLoss <= 0
          || !Number.isFinite(p.takeProfit) || p.takeProfit <= 0
        ) {
          console.error(`Invalid position data for ${p.tokenId} — resetting portfolio`);
          this.state = createDefaultPortfolio();
          return this.state;
        }
      }

      // Legacy portfolios pre-dating the `initialValue` field get the default
      // $10k anchor — safe because paper-trading always started there. Live
      // syndicates that went through `initFromOnChain` already have this set.
      if (!Number.isFinite(parsed.initialValue) || (parsed.initialValue ?? 0) <= 0) {
        parsed.initialValue = DEFAULT_PORTFOLIO.initialValue;
      }

      this.state = parsed;
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.state = createDefaultPortfolio();
    }
    return this.state;
  }

  /** Save portfolio state to disk (atomic write to prevent corruption) */
  async save(state: PortfolioState): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmpPath = this.statePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmpPath, this.statePath);
  }

  /** Open a new position */
  async openPosition(position: Omit<Position, 'pnlPercent' | 'pnlUsd'>): Promise<Position> {
    if (position.quantity <= 0) {
      throw new Error(`Invalid position quantity: ${position.quantity}`);
    }
    if (position.entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${position.entryPrice}`);
    }
    const release = await this.acquireLock();
    try {
    await this.load();

    const fullPosition: Position = {
      ...position,
      addCount: position.addCount ?? 0,
      lastAddTimestamp: position.lastAddTimestamp ?? position.entryTimestamp,
      // Orca-inspired HWM profit-lock, see README / PR #223.
      // Seed peakPrice at entry so subsequent cycles can ratchet from
      // the first favorable move.
      peakPrice: position.peakPrice ?? position.entryPrice,
      pnlPercent: 0,
      pnlUsd: 0,
    };

    this.state.positions.push(fullPosition);
    // Both longs and shorts on perp venues only require margin, not full notional.
    // With 3x directional leverage, a $3,500 notional position only locks $1,167
    // margin (33%). Prior code debited full notional for longs, depleting cash 3x
    // faster than reality and blocking subsequent trades.
    const cashDebit = position.quantity * position.entryPrice * MARGIN_FRACTION;
    this.state.cash -= cashDebit;
    this.state.totalValue = computeTotalValue(this.state.cash, this.state.positions);

    // Orca-inspired: PnL-aware daily cap, see README / PR #223.
    // Count this NEW entry against the day's turnover budget.
    // Pyramid adds go through addToPosition and do NOT count.
    const prior = Number.isFinite(this.state.dailyEntries) ? (this.state.dailyEntries ?? 0) : 0;
    this.state.dailyEntries = prior + 1;

    await this.save(this.state);
    return fullPosition;
    } finally { release(); }
  }

  /**
   * Pyramid into an existing position.
   * Computes a quantity-weighted average entry price and increments `addCount`.
   * Cash is debited at the new fill price. Stops/take-profits stay anchored to
   * the prior values (caller is free to widen them after).
   *
   * Throws if no existing position exists or the side disagrees.
   */
  async addToPosition(
    tokenId: string,
    addPrice: number,
    addQuantity: number,
    side: 'long' | 'short',
  ): Promise<Position> {
    if (addQuantity <= 0) throw new Error(`Invalid add quantity: ${addQuantity}`);
    if (addPrice <= 0) throw new Error(`Invalid add price: ${addPrice}`);
    const release = await this.acquireLock();
    try {
    await this.load();

    const idx = this.state.positions.findIndex((p) => p.tokenId === tokenId);
    if (idx === -1) throw new Error(`No open position for ${tokenId} to pyramid into`);

    const pos = this.state.positions[idx]!;
    const existingSide = pos.side ?? 'long';
    if (existingSide !== side) {
      throw new Error(`Cannot pyramid ${side} on existing ${existingSide} position in ${tokenId}`);
    }

    // Weighted-average entry price across the combined quantity
    const newQty = pos.quantity + addQuantity;
    const weightedEntry = (pos.entryPrice * pos.quantity + addPrice * addQuantity) / newQty;

    const updated: Position = {
      ...pos,
      entryPrice: weightedEntry,
      quantity: newQty,
      currentPrice: addPrice,
      addCount: (pos.addCount ?? 0) + 1,
      lastAddTimestamp: Date.now(),
      pnlPercent: 0, // recomputed on next price update
      pnlUsd: 0,
    };

    this.state.positions[idx] = updated;
    // Both longs and shorts use margin-based cash debit (33% = 3x leverage).
    this.state.cash -= addPrice * addQuantity * MARGIN_FRACTION;
    this.state.totalValue = computeTotalValue(this.state.cash, this.state.positions);

    await this.save(this.state);
    return updated;
    } finally { release(); }
  }

  /** Close a position and record trade */
  async closePosition(
    tokenId: string,
    exitPrice: number,
    reason: string,
  ): Promise<{ pnl: number; pnlPercent: number; duration: number }> {
    const release = await this.acquireLock();
    try {
    await this.load();

    const idx = this.state.positions.findIndex((p) => p.tokenId === tokenId);
    if (idx === -1) {
      throw new Error(`No open position for ${tokenId}`);
    }

    const pos = this.state.positions[idx]!;
    const isShort = pos.side === 'short';
    const pnlUsd = isShort
      ? (pos.entryPrice - exitPrice) * pos.quantity
      : (exitPrice - pos.entryPrice) * pos.quantity;
    const pnlPercent = isShort
      ? (pos.entryPrice - exitPrice) / (pos.entryPrice || 1)
      : (exitPrice - pos.entryPrice) / (pos.entryPrice || 1);
    const duration = Math.floor((Date.now() - pos.entryTimestamp) / 1000);

    // Record the trade
    const record: TradeRecord = {
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      side: pos.side ?? 'long',
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      pnlUsd,
      pnlPercent,
      entryTimestamp: pos.entryTimestamp,
      exitTimestamp: Date.now(),
      duration,
      strategy: pos.strategy,
      exitReason: reason,
    };

    await this.appendTradeRecord(record);

    // Remove position and update cash.
    // Both longs and shorts return margin (33% of notional) + PnL.
    this.state.positions.splice(idx, 1);
    const cashCredit = pos.quantity * pos.entryPrice * MARGIN_FRACTION + pnlUsd;
    this.state.cash += cashCredit;
    this.state.dailyPnl += pnlUsd;
    this.state.weeklyPnl += pnlUsd;
    this.state.monthlyPnl += pnlUsd;
    this.state.totalValue = computeTotalValue(this.state.cash, this.state.positions);

    // Record stop-loss cooldown to prevent rapid re-entry
    if (reason.toLowerCase().includes('stop')) {
      if (!this.state.stopCooldowns) this.state.stopCooldowns = {};
      this.state.stopCooldowns[tokenId] = Date.now();
    }

    // Track per-token consecutive losses for the serial-loser gate.
    // A losing trade increments the counter; a winning trade resets it to 0.
    // When the counter hits TOKEN_CONSEC_LOSS_LIMIT, record the cooldown timestamp.
    if (!this.state.tokenConsecLosses) this.state.tokenConsecLosses = {};
    if (!this.state.tokenLossCooldowns) this.state.tokenLossCooldowns = {};
    if (pnlUsd < 0) {
      this.state.tokenConsecLosses[tokenId] = (this.state.tokenConsecLosses[tokenId] ?? 0) + 1;
      if (this.state.tokenConsecLosses[tokenId]! >= 2) {
        this.state.tokenLossCooldowns[tokenId] = Date.now();
      }
    } else {
      // Win or breakeven — reset consecutive loss counter
      this.state.tokenConsecLosses[tokenId] = 0;
      delete this.state.tokenLossCooldowns[tokenId];
    }

    await this.save(this.state);

    return { pnl: pnlUsd, pnlPercent, duration };
    } finally { release(); }
  }

  /**
   * Close a fraction of a position. Records a partial trade and reduces
   * the position's quantity. Entry price and stops are preserved.
   */
  async closePartial(
    tokenId: string,
    fraction: number,
    exitPrice: number,
    reason: string,
  ): Promise<{ pnl: number; pnlPercent: number; quantityClosed: number }> {
    if (fraction <= 0 || fraction >= 1) {
      throw new Error(`Invalid fraction: ${fraction} (must be between 0 and 1 exclusive)`);
    }
    const release = await this.acquireLock();
    try {
    await this.load();

    const idx = this.state.positions.findIndex((p) => p.tokenId === tokenId);
    if (idx === -1) throw new Error(`No open position for ${tokenId}`);

    const pos = this.state.positions[idx]!;
    const isShort = pos.side === 'short';
    const quantityClosed = pos.quantity * fraction;
    const pnlUsd = isShort
      ? (pos.entryPrice - exitPrice) * quantityClosed
      : (exitPrice - pos.entryPrice) * quantityClosed;
    const pnlPercent = isShort
      ? (pos.entryPrice - exitPrice) / (pos.entryPrice || 1)
      : (exitPrice - pos.entryPrice) / (pos.entryPrice || 1);

    // Record partial trade
    const record: TradeRecord = {
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      side: pos.side ?? 'long',
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: quantityClosed,
      pnlUsd,
      pnlPercent,
      entryTimestamp: pos.entryTimestamp,
      exitTimestamp: Date.now(),
      duration: Math.floor((Date.now() - pos.entryTimestamp) / 1000),
      strategy: pos.strategy,
      exitReason: reason,
    };
    await this.appendTradeRecord(record);

    // Reduce position, mark partial taken
    pos.quantity -= quantityClosed;
    pos.partialTaken = true;
    // Return margin fraction (33%) + PnL for both longs and shorts.
    const partialCashCredit = pos.entryPrice * quantityClosed * MARGIN_FRACTION + pnlUsd;
    this.state.cash += partialCashCredit;
    this.state.dailyPnl += pnlUsd;
    this.state.weeklyPnl += pnlUsd;
    this.state.monthlyPnl += pnlUsd;
    this.state.totalValue = computeTotalValue(this.state.cash, this.state.positions);

    await this.save(this.state);
    return { pnl: pnlUsd, pnlPercent, quantityClosed };
    } finally { release(); }
  }

  /** Update current prices for all positions */
  async updatePrices(prices: Record<string, number>): Promise<PortfolioState> {
    await this.load();

    for (const pos of this.state.positions) {
      const price = prices[pos.tokenId];
      if (price !== undefined) {
        // Guard against NaN/Infinity — a bad price update would corrupt PnL
        // calculations and make stops evaluate to false (NaN <= X is always false),
        // permanently trapping positions.
        if (!Number.isFinite(price) || price <= 0) {
          console.error(`[portfolio] Skipping invalid price for ${pos.tokenId}: ${price}`);
          continue;
        }
        pos.currentPrice = price;
        const isShort = pos.side === 'short';
        pos.pnlUsd = isShort
          ? (pos.entryPrice - price) * pos.quantity
          : (price - pos.entryPrice) * pos.quantity;
        pos.pnlPercent = isShort
          ? (pos.entryPrice - price) / (pos.entryPrice || 1)
          : (price - pos.entryPrice) / (pos.entryPrice || 1);
      }
    }

    this.state.totalValue = computeTotalValue(this.state.cash, this.state.positions);

    await this.save(this.state);
    return this.state;
  }

  /** Get trade history */
  async getHistory(days?: number): Promise<TradeRecord[]> {
    let records: TradeRecord[] = [];
    try {
      const data = await readFile(this.historyPath, 'utf-8');
      records = JSON.parse(data) as TradeRecord[];
    } catch {
      return [];
    }

    if (days !== undefined) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      records = records.filter((r) => r.exitTimestamp >= cutoff);
    }

    return records;
  }

  /** Get performance metrics */
  async getMetrics(days?: number): Promise<{
    totalTrades: number;
    winRate: number;
    avgPnlPercent: number;
    totalPnlUsd: number;
    sharpeRatio: number;
    maxDrawdown: number;
    bestTrade: TradeRecord;
    worstTrade: TradeRecord;
  }> {
    const trades = await this.getHistory(days);

    if (trades.length === 0) {
      const empty: TradeRecord = {
        tokenId: '', symbol: '', side: 'long', entryPrice: 0, exitPrice: 0,
        quantity: 0, pnlUsd: 0, pnlPercent: 0, entryTimestamp: 0,
        exitTimestamp: 0, duration: 0, strategy: '', exitReason: '',
      };
      return {
        totalTrades: 0, winRate: 0, avgPnlPercent: 0, totalPnlUsd: 0,
        sharpeRatio: 0, maxDrawdown: 0, bestTrade: empty, worstTrade: empty,
      };
    }

    const wins = trades.filter((t) => t.pnlUsd > 0);
    const pnls = trades.map((t) => t.pnlPercent);
    const totalPnlUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const avgPnlPercent = pnls.reduce((s, p) => s + p, 0) / pnls.length;

    // Sharpe ratio: annualize returns based on average holding period
    // Standard formula: (mean return - risk-free rate) / stddev of returns
    const avgHoldingDays = trades.length > 0
      ? trades.reduce((sum, t) => sum + t.duration, 0) / trades.length / (24 * 60 * 60)
      : 1;
    const tradesPerYear = Math.max(252 / Math.max(avgHoldingDays, 1), 1);

    const riskFreePerTrade = 0.05 / tradesPerYear; // Risk-free rate per trade
    const mean = avgPnlPercent;
    const excessMean = mean - riskFreePerTrade;
    const variance = pnls.length > 1
      ? pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (pnls.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (excessMean / stdDev) * Math.sqrt(tradesPerYear) : 0;

    // Max drawdown from cumulative equity curve (peak-to-trough)
    // Start with a reasonable initial portfolio value
    const initialValue = 10000; // Start with default $10k portfolio
    let equityPeak = initialValue;
    let equity = initialValue;
    let maxDrawdown = 0;

    for (const t of trades) {
      equity += t.pnlUsd;
      if (equity > equityPeak) {
        equityPeak = equity;
      }
      if (equityPeak > 0 && equity < equityPeak) {
        const drawdown = (equityPeak - equity) / equityPeak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }
    }

    const sorted = [...trades].sort((a, b) => a.pnlUsd - b.pnlUsd);
    const worstTrade = sorted[0]!;
    const bestTrade = sorted[sorted.length - 1]!;

    return {
      totalTrades: trades.length,
      winRate: wins.length / trades.length,
      avgPnlPercent,
      totalPnlUsd,
      sharpeRatio,
      maxDrawdown,
      bestTrade,
      worstTrade,
    };
  }

  /** Format portfolio summary for display */
  formatSummary(): string {
    const s = this.state;
    const lines: string[] = [];

    lines.push('');
    lines.push(chalk.bold('  Portfolio Summary'));
    lines.push(chalk.dim('  ' + '─'.repeat(50)));
    lines.push(`  Total Value: $${s.totalValue.toFixed(2)}`);
    lines.push(`  Cash: $${s.cash.toFixed(2)}`);
    lines.push(`  Positions: ${s.positions.length}`);
    lines.push('');

    if (s.positions.length > 0) {
      lines.push(chalk.bold('  Open Positions:'));
      for (const p of s.positions) {
        const pnlColor = p.pnlUsd >= 0 ? chalk.green : chalk.red;
        const pnlStr = pnlColor(
          `${p.pnlUsd >= 0 ? '+' : ''}$${p.pnlUsd.toFixed(2)} (${(p.pnlPercent * 100).toFixed(1)}%)`,
        );
        lines.push(
          `  ${p.symbol.padEnd(10)} ${p.quantity.toFixed(4)} @ $${p.entryPrice.toFixed(4)}  PnL: ${pnlStr}  [${p.strategy}]`,
        );
      }
      lines.push('');
    }

    const dailyColor = s.dailyPnl >= 0 ? chalk.green : chalk.red;
    lines.push(`  Daily PnL:   ${dailyColor((s.dailyPnl >= 0 ? '+' : '') + '$' + s.dailyPnl.toFixed(2))}`);
    lines.push(`  Weekly PnL:  ${s.weeklyPnl >= 0 ? '+' : ''}$${s.weeklyPnl.toFixed(2)}`);
    lines.push(`  Monthly PnL: ${s.monthlyPnl >= 0 ? '+' : ''}$${s.monthlyPnl.toFixed(2)}`);
    lines.push('');

    return lines.join('\n');
  }

  /** Append a trade record to history file */
  private async appendTradeRecord(record: TradeRecord): Promise<void> {
    let records: TradeRecord[] = [];
    try {
      const data = await readFile(this.historyPath, 'utf-8');
      records = JSON.parse(data) as TradeRecord[];
    } catch {
      // Start fresh
    }

    records.push(record);
    await mkdir(dirname(this.historyPath), { recursive: true });
    const tmpPath = this.historyPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
    await rename(tmpPath, this.historyPath);
  }
}
