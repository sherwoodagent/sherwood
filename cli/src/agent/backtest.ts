/**
 * Simple backtesting framework — replays historical data through strategies.
 */

import chalk from 'chalk';
import { CoinGeckoProvider } from '../providers/data/coingecko.js';
import { getLatestSignals } from './technical.js';
import type { Candle } from './technical.js';
import { runStrategies } from './strategies/index.js';
import type { StrategyContext } from './strategies/types.js';
import { computeTradeDecision } from './scoring.js';
import type { TradeDecision } from './scoring.js';

export interface BacktestConfig {
  tokenId: string;
  startDate: string;   // ISO date
  endDate: string;
  initialCapital: number;
  strategies: string[]; // strategy names to test
  cycle: '1h' | '4h' | '1d';
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  signal: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  totalReturn: number;
  totalReturnPercent: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  trades: BacktestTrade[];
  equityCurve: Array<{ date: string; value: number }>;
}

export class Backtester {
  private config: BacktestConfig;
  private cg: CoinGeckoProvider;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.cg = new CoinGeckoProvider();
  }

  /** Run backtest using historical data from CoinGecko. */
  async run(): Promise<BacktestResult> {
    // 1. Fetch historical OHLC data
    const startMs = new Date(this.config.startDate).getTime();
    const endMs = new Date(this.config.endDate).getTime();
    const totalDays = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000));

    // CoinGecko OHLC supports: 1, 7, 14, 30, 90, 180, 365, max
    // For longer ranges use market_chart
    const cgDays = Math.min(Math.max(totalDays, 1), 365);

    const ohlcRaw = await this.cg.getOHLC(this.config.tokenId, cgDays);
    const marketData = await this.cg.getMarketData(this.config.tokenId, cgDays);

    // Build candle array with volume
    const allCandles: Candle[] = ohlcRaw
      .filter((c: number[]) => c[0]! >= startMs && c[0]! <= endMs)
      .map((c: number[]) => {
        // Find nearest volume data
        let volume = 0;
        if (marketData?.total_volumes) {
          const nearest = marketData.total_volumes.reduce(
            (best: number[], v: number[]) =>
              Math.abs(v[0]! - c[0]!) < Math.abs(best[0]! - c[0]!) ? v : best,
            marketData.total_volumes[0]!,
          );
          volume = nearest[1] ?? 0;
        }
        return {
          timestamp: c[0]!,
          open: c[1]!,
          high: c[2]!,
          low: c[3]!,
          close: c[4] ?? c[3]!,
          volume,
        };
      });

    if (allCandles.length < 30) {
      throw new Error(`Insufficient data: only ${allCandles.length} candles in date range (need 30+)`);
    }

    // 2. Determine step size based on cycle
    const stepSize = this.config.cycle === '1h' ? 1 : this.config.cycle === '4h' ? 4 : 24;
    // CoinGecko OHLC for 90+ days gives daily candles, so step = 1 candle for '1d'
    const step = Math.max(1, Math.floor(stepSize / 24)); // approximate

    // 3. Simulate trading
    let capital = this.config.initialCapital;
    let position: { entryPrice: number; entryDate: string; signal: string } | null = null;
    const trades: BacktestTrade[] = [];
    const equityCurve: Array<{ date: string; value: number }> = [];
    const returns: number[] = [];

    const windowSize = 30; // min candles needed for indicators

    for (let i = windowSize; i < allCandles.length; i += step) {
      // Use historical data only (excluding current candle to avoid look-ahead bias)
      const windowCandles = allCandles.slice(Math.max(0, i - 200), i);
      const currentCandle = allCandles[i]!;
      const currentDate = new Date(currentCandle.timestamp).toISOString().split('T')[0]!;
      const currentPrice = currentCandle.close;

      // Skip if insufficient data for indicators
      if (windowCandles.length < windowSize) continue;

      // Track equity
      const equity = position
        ? capital * (currentPrice / position.entryPrice)
        : capital;
      equityCurve.push({ date: currentDate, value: equity });

      // Compute indicators using only historical data
      let decision: TradeDecision;
      try {
        const technicals = getLatestSignals(windowCandles);

        const ctx: StrategyContext = {
          tokenId: this.config.tokenId,
          candles: windowCandles,
          technicals,
        };

        // Run strategies (filtered by config)
        const signals = await runStrategies(ctx);
        const filtered = this.config.strategies.length > 0
          ? signals.filter((s) => this.config.strategies.some(
              (name) => s.name.toLowerCase().includes(name.toLowerCase()),
            ))
          : signals;

        decision = computeTradeDecision(filtered.length > 0 ? filtered : signals);
      } catch {
        continue; // skip candle if analysis fails
      }

      // Execute paper trades
      if (!position && (decision.action === 'BUY' || decision.action === 'STRONG_BUY')) {
        // Enter long
        position = {
          entryPrice: currentPrice,
          entryDate: currentDate,
          signal: decision.action,
        };
      } else if (position && (decision.action === 'SELL' || decision.action === 'STRONG_SELL')) {
        // Exit long
        const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice;
        capital *= (1 + pnlPercent);
        returns.push(pnlPercent);

        trades.push({
          entryDate: position.entryDate,
          exitDate: currentDate,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          pnlPercent,
          signal: `${position.signal} → ${decision.action}`,
        });

        position = null;
      }
    }

    // Close any remaining position at last price
    if (position && allCandles.length > 0) {
      const lastCandle = allCandles[allCandles.length - 1]!;
      const lastPrice = lastCandle.close;
      const lastDate = new Date(lastCandle.timestamp).toISOString().split('T')[0]!;
      const pnlPercent = (lastPrice - position.entryPrice) / position.entryPrice;
      capital *= (1 + pnlPercent);
      returns.push(pnlPercent);

      trades.push({
        entryDate: position.entryDate,
        exitDate: lastDate,
        entryPrice: position.entryPrice,
        exitPrice: lastPrice,
        pnlPercent,
        signal: `${position.signal} → CLOSE`,
      });
    }

    // 4. Compute metrics
    const totalReturn = capital - this.config.initialCapital;
    const totalReturnPercent = totalReturn / this.config.initialCapital;
    const winRate = returns.length > 0
      ? returns.filter((r) => r > 0).length / returns.length
      : 0;

    // Sharpe ratio (annualized from daily equity curve returns, not per-trade returns)
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1]!.value;
      if (prev > 0) {
        dailyReturns.push((equityCurve[i]!.value - prev) / prev);
      }
    }
    const meanReturn = dailyReturns.length > 0
      ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      : 0;
    const variance = dailyReturns.length > 1
      ? dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

    // Max drawdown
    let maxDrawdown = 0;
    let peak = this.config.initialCapital;
    for (const point of equityCurve) {
      if (point.value > peak) peak = point.value;
      const drawdown = (peak - point.value) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      config: this.config,
      totalReturn,
      totalReturnPercent,
      sharpeRatio,
      maxDrawdown,
      winRate,
      totalTrades: trades.length,
      trades,
      equityCurve,
    };
  }

  /** Format results for display. */
  formatResults(result: BacktestResult): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(chalk.bold('  ┌──────────────────────────────────────────────┐'));
    lines.push(chalk.bold('  │          Backtest Results                    │'));
    lines.push(chalk.bold('  └──────────────────────────────────────────────┘'));
    lines.push('');
    lines.push(`  Token:          ${result.config.tokenId}`);
    lines.push(`  Period:         ${result.config.startDate} → ${result.config.endDate}`);
    lines.push(`  Initial:        $${result.config.initialCapital.toLocaleString()}`);
    lines.push(`  Strategies:     ${result.config.strategies.join(', ') || 'all'}`);
    lines.push(`  Cycle:          ${result.config.cycle}`);
    lines.push('');
    lines.push(chalk.dim('  ' + '═'.repeat(50)));

    // Performance metrics
    const retColor = result.totalReturnPercent >= 0 ? chalk.green : chalk.red;
    lines.push(`  Total Return:   ${retColor('$' + result.totalReturn.toFixed(2))} (${retColor((result.totalReturnPercent * 100).toFixed(2) + '%')})`);
    lines.push(`  Final Capital:  $${(result.config.initialCapital + result.totalReturn).toFixed(2)}`);
    lines.push(`  Sharpe Ratio:   ${result.sharpeRatio.toFixed(2)}`);
    lines.push(`  Max Drawdown:   ${chalk.red((result.maxDrawdown * 100).toFixed(2) + '%')}`);
    lines.push(`  Win Rate:       ${(result.winRate * 100).toFixed(1)}%`);
    lines.push(`  Total Trades:   ${result.totalTrades}`);

    // Trade list
    if (result.trades.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Trades:'));
      lines.push(chalk.dim(`  ${'Entry'.padEnd(12)} ${'Exit'.padEnd(12)} ${'Entry$'.padEnd(10)} ${'Exit$'.padEnd(10)} ${'PnL%'.padEnd(10)} Signal`));
      lines.push(chalk.dim('  ' + '─'.repeat(65)));

      for (const t of result.trades.slice(-20)) { // show last 20
        const pnlColor = t.pnlPercent >= 0 ? chalk.green : chalk.red;
        lines.push(
          `  ${t.entryDate.padEnd(12)} ${t.exitDate.padEnd(12)} $${t.entryPrice.toFixed(2).padEnd(9)} $${t.exitPrice.toFixed(2).padEnd(9)} ${pnlColor((t.pnlPercent * 100).toFixed(2).padStart(7) + '%')}  ${t.signal}`,
        );
      }
      if (result.trades.length > 20) {
        lines.push(chalk.dim(`  ... and ${result.trades.length - 20} more trades`));
      }
    }

    // Equity curve ASCII art
    if (result.equityCurve.length > 2) {
      lines.push('');
      lines.push(chalk.bold('  Equity Curve:'));
      lines.push(this.renderEquityCurve(result.equityCurve, result.config.initialCapital));
    }

    lines.push('');
    return lines.join('\n');
  }

  /** Render a simple ASCII equity curve using box-drawing chars. */
  private renderEquityCurve(
    curve: Array<{ date: string; value: number }>,
    initialCapital: number,
  ): string {
    const width = 60;
    const height = 15;

    // Sample curve to fit width
    const sampled: number[] = [];
    const step = Math.max(1, Math.floor(curve.length / width));
    for (let i = 0; i < curve.length; i += step) {
      sampled.push(curve[i]!.value);
    }
    if (sampled.length > width) sampled.length = width;

    const minVal = Math.min(...sampled);
    const maxVal = Math.max(...sampled);
    const range = maxVal - minVal || 1;

    // Build grid
    const grid: string[][] = [];
    for (let row = 0; row < height; row++) {
      grid.push(new Array(sampled.length).fill(' '));
    }

    // Plot points
    for (let col = 0; col < sampled.length; col++) {
      const normalized = (sampled[col]! - minVal) / range;
      const row = height - 1 - Math.round(normalized * (height - 1));
      grid[row]![col] = sampled[col]! >= initialCapital ? '█' : '▓';
    }

    // Render with Y-axis labels
    const lines: string[] = [];
    for (let row = 0; row < height; row++) {
      const yVal = maxVal - (row / (height - 1)) * range;
      const label = `$${yVal.toFixed(0)}`.padStart(8);
      const lineStr = grid[row]!.join('');
      const rowColor = yVal >= initialCapital ? chalk.green : chalk.red;
      lines.push(`  ${chalk.dim(label)} │${rowColor(lineStr)}`);
    }
    lines.push(`  ${''.padStart(8)} └${'─'.repeat(sampled.length)}`);

    // X-axis labels
    const firstDate = curve[0]?.date ?? '';
    const lastDate = curve[curve.length - 1]?.date ?? '';
    const axisLabel = `  ${''.padStart(9)}${firstDate}${''.padStart(Math.max(0, sampled.length - firstDate.length - lastDate.length))}${lastDate}`;
    lines.push(chalk.dim(axisLabel));

    return lines.join('\n');
  }
}
