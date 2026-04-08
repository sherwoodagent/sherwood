/**
 * Portfolio tracking with JSON file persistence.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import type { Position, PortfolioState } from './risk.js';

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
};

export class PortfolioTracker {
  private statePath: string;
  private historyPath: string;
  private state: PortfolioState;

  constructor() {
    const base = join(homedir(), '.sherwood', 'agent');
    this.statePath = join(base, 'portfolio.json');
    this.historyPath = join(base, 'trades.json');
    this.state = { ...DEFAULT_PORTFOLIO };
  }

  /** Load portfolio state from disk */
  async load(): Promise<PortfolioState> {
    try {
      const data = await readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(data) as PortfolioState;
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.state = { ...DEFAULT_PORTFOLIO };
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
    await this.load();

    const fullPosition: Position = {
      ...position,
      pnlPercent: 0,
      pnlUsd: 0,
    };

    this.state.positions.push(fullPosition);
    this.state.cash -= position.quantity * position.entryPrice;
    this.state.totalValue = this.state.cash + this.state.positions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    );

    await this.save(this.state);
    return fullPosition;
  }

  /** Close a position and record trade */
  async closePosition(
    tokenId: string,
    exitPrice: number,
    reason: string,
  ): Promise<{ pnl: number; pnlPercent: number; duration: number }> {
    await this.load();

const idx = this.state.positions.findIndex((p) => p.tokenId === tokenId);
    if (idx === -1) {
      throw new Error(`No open position for ${tokenId}`);
    }

    const pos = this.state.positions[idx]!;
    const pnlUsd = (exitPrice - pos.entryPrice) * pos.quantity;
    const pnlPercent = (exitPrice - pos.entryPrice) / pos.entryPrice;
    const duration = Math.floor((Date.now() - pos.entryTimestamp) / 1000);

    // Record the trade
    const record: TradeRecord = {
      tokenId: pos.tokenId,
      symbol: pos.symbol,
      side: 'long',
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

    // Remove position and update cash
    this.state.positions.splice(idx, 1);
    this.state.cash += pos.quantity * exitPrice;
    this.state.dailyPnl += pnlUsd;
    this.state.weeklyPnl += pnlUsd;
    this.state.monthlyPnl += pnlUsd;
    this.state.totalValue = this.state.cash + this.state.positions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    );

    await this.save(this.state);

    return { pnl: pnlUsd, pnlPercent, duration };
  }

  /** Update current prices for all positions */
  async updatePrices(prices: Record<string, number>): Promise<PortfolioState> {
    await this.load();

    for (const pos of this.state.positions) {
      const price = prices[pos.tokenId];
      if (price !== undefined) {
        pos.currentPrice = price;
        pos.pnlUsd = (price - pos.entryPrice) * pos.quantity;
        pos.pnlPercent = (price - pos.entryPrice) / pos.entryPrice;
      }
    }

    this.state.totalValue = this.state.cash + this.state.positions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    );

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
    await writeFile(this.historyPath, JSON.stringify(records, null, 2), 'utf-8');
  }
}
