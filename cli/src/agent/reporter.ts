/**
 * Reporting module — formats cycle results, portfolio summaries, trade alerts, and metrics.
 */

import chalk from 'chalk';
import type { CycleResult } from './loop.js';
import type { PortfolioState, Position } from './risk.js';
import type { TradeRecord } from './portfolio.js';

export class Reporter {
  /** Format a cycle result as a nicely-formatted console report */
  formatCycleReport(result: CycleResult): string {
    const lines: string[] = [];
    const ts = new Date(result.timestamp).toLocaleTimeString();

    lines.push('');
    lines.push(chalk.bold(`  ┌─ Cycle #${result.cycleNumber} ─ ${ts} ─────────────────────────────┐`));
    lines.push(`  │ Duration: ${result.duration}ms | Tokens analyzed: ${result.tokensAnalyzed}`);
    lines.push(`  │ Trades executed: ${result.tradesExecuted} | Exits processed: ${result.exitsProcessed}`);
    if (result.longsOpened !== undefined || result.shortsOpened !== undefined) {
      lines.push(`  │ Longs opened: ${result.longsOpened ?? 0} | Shorts opened: ${result.shortsOpened ?? 0}`);
    }
    lines.push(chalk.dim('  ├──────────────────────────────────────────────────┤'));

    // Signals
    if (result.signals.length > 0) {
      lines.push(chalk.bold('  │ Signals:'));
      for (const sig of result.signals) {
        const color = sig.action.includes('BUY')
          ? chalk.green
          : sig.action.includes('SELL')
            ? chalk.red
            : chalk.yellow;
        const scoreStr = sig.score >= 0 ? `+${sig.score.toFixed(3)}` : sig.score.toFixed(3);
        lines.push(`  │   ${sig.token.padEnd(14)} ${color(sig.action.padEnd(12))} ${scoreStr}`);
      }
    } else {
      lines.push('  │ No actionable signals this cycle.');
    }

    lines.push(chalk.dim('  ├──────────────────────────────────────────────────┤'));

    // Portfolio — show total PnL% since inception + realized (drawdown-gate driver) + unrealized (mark-to-market).
    const realized = result.dailyRealizedPnl;
    const unrealized = result.unrealizedPnl;
    const total = result.totalPnlUsd;
    const totalPct = result.totalPnlPct;
    const fmt = (v: number) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    const fmtPct = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const rColor = realized >= 0 ? chalk.green : chalk.red;
    const uColor = unrealized >= 0 ? chalk.green : chalk.red;
    const tColor = total >= 0 ? chalk.green : chalk.red;
    lines.push(`  │ Portfolio: $${result.portfolioValue.toFixed(2)}  Total: ${tColor(fmt(total) + ' (' + fmtPct(totalPct) + ')')}`);
    lines.push(`  │ Realized: ${rColor(fmt(realized))}  Unrealized: ${uColor(fmt(unrealized))}`);

    // Errors
    if (result.errors.length > 0) {
      lines.push(chalk.dim('  ├──────────────────────────────────────────────────┤'));
      lines.push(chalk.red(`  │ Errors (${result.errors.length}):`));
      for (const err of result.errors.slice(0, 3)) {
        lines.push(chalk.red(`  │   ${err.slice(0, 60)}`));
      }
    }

    lines.push(chalk.bold('  └──────────────────────────────────────────────────┘'));
    lines.push('');

    return lines.join('\n');
  }

  /** Format portfolio state as a detailed summary */
  formatPortfolioReport(state: PortfolioState): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(chalk.bold('  Portfolio Summary'));
    lines.push(chalk.dim('  ' + '═'.repeat(60)));
    lines.push(`  Total Value:  $${state.totalValue.toFixed(2)}`);
    lines.push(`  Cash:         $${state.cash.toFixed(2)}`);
    lines.push(`  Positions:    ${state.positions.length}`);
    lines.push('');

    if (state.positions.length > 0) {
      lines.push(chalk.bold('  Open Positions:'));
      lines.push(chalk.dim(`  ${'Symbol'.padEnd(10)} ${'Qty'.padEnd(12)} ${'Entry'.padEnd(12)} ${'Current'.padEnd(12)} ${'PnL %'.padEnd(10)} PnL $`));
      lines.push(chalk.dim('  ' + '─'.repeat(68)));

      for (const p of state.positions) {
        const pnlColor = p.pnlUsd >= 0 ? chalk.green : chalk.red;
        const pctStr = `${(p.pnlPercent * 100).toFixed(1)}%`;
        const usdStr = `${p.pnlUsd >= 0 ? '+' : ''}$${p.pnlUsd.toFixed(2)}`;
        lines.push(
          `  ${p.symbol.padEnd(10)} ${p.quantity.toFixed(4).padEnd(12)} $${p.entryPrice.toFixed(2).padEnd(11)} $${p.currentPrice.toFixed(2).padEnd(11)} ${pnlColor(pctStr.padEnd(10))} ${pnlColor(usdStr)}`,
        );
      }
      lines.push('');
    }

    const dailyColor = state.dailyPnl >= 0 ? chalk.green : chalk.red;
    const weeklyColor = state.weeklyPnl >= 0 ? chalk.green : chalk.red;
    const monthlyColor = state.monthlyPnl >= 0 ? chalk.green : chalk.red;

    lines.push(`  Daily PnL:    ${dailyColor((state.dailyPnl >= 0 ? '+' : '') + '$' + state.dailyPnl.toFixed(2))}`);
    lines.push(`  Weekly PnL:   ${weeklyColor((state.weeklyPnl >= 0 ? '+' : '') + '$' + state.weeklyPnl.toFixed(2))}`);
    lines.push(`  Monthly PnL:  ${monthlyColor((state.monthlyPnl >= 0 ? '+' : '') + '$' + state.monthlyPnl.toFixed(2))}`);
    lines.push('');

    return lines.join('\n');
  }

  /** Format a trade execution alert */
  formatTradeAlert(trade: {
    token: string;
    side: string;
    price: number;
    amount: number;
    strategy: string;
  }): string {
    const emoji = trade.side === 'buy' ? '🟢' : '🔴';
    const sideStr = trade.side.toUpperCase();
    const lines: string[] = [];

    lines.push(`${emoji} ${sideStr} ${trade.token.toUpperCase()}`);
    lines.push(`   Price: $${trade.price.toFixed(4)}`);
    lines.push(`   Amount: $${trade.amount.toFixed(2)}`);
    lines.push(`   Strategy: ${trade.strategy}`);
    lines.push(`   Time: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /** Format performance metrics */
  formatMetrics(metrics: {
    totalTrades: number;
    winRate: number;
    avgPnlPercent: number;
    totalPnlUsd: number;
    sharpeRatio: number;
    maxDrawdown: number;
    bestTrade: TradeRecord;
    worstTrade: TradeRecord;
  }): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(chalk.bold('  Performance Metrics'));
    lines.push(chalk.dim('  ' + '═'.repeat(50)));

    lines.push(`  Total Trades:    ${metrics.totalTrades}`);

    // Win rate with bar
    const winPct = (metrics.winRate * 100).toFixed(1);
    const winBarLen = Math.round(metrics.winRate * 20);
    const winBar = chalk.green('█'.repeat(winBarLen)) + chalk.dim('░'.repeat(20 - winBarLen));
    const winColor = metrics.winRate >= 0.5 ? chalk.green : chalk.red;
    lines.push(`  Win Rate:        ${winBar} ${winColor(winPct + '%')}`);

    // Avg PnL
    const avgColor = metrics.avgPnlPercent >= 0 ? chalk.green : chalk.red;
    lines.push(`  Avg PnL:         ${avgColor((metrics.avgPnlPercent * 100).toFixed(2) + '%')}`);

    // Total PnL
    const totalColor = metrics.totalPnlUsd >= 0 ? chalk.green : chalk.red;
    lines.push(`  Total PnL:       ${totalColor('$' + metrics.totalPnlUsd.toFixed(2))}`);

    // Sharpe
    const sharpeColor = metrics.sharpeRatio >= 1 ? chalk.green : metrics.sharpeRatio >= 0 ? chalk.yellow : chalk.red;
    lines.push(`  Sharpe Ratio:    ${sharpeColor(metrics.sharpeRatio.toFixed(2))}`);

    // Max Drawdown
    const ddBar = chalk.red('█'.repeat(Math.round(Math.min(metrics.maxDrawdown, 1) * 20))) +
      chalk.dim('░'.repeat(20 - Math.round(Math.min(metrics.maxDrawdown, 1) * 20)));
    lines.push(`  Max Drawdown:    ${ddBar} ${chalk.red((metrics.maxDrawdown * 100).toFixed(1) + '%')}`);

    lines.push('');

    // Best/worst trade
    if (metrics.bestTrade?.tokenId) {
      const best = metrics.bestTrade;
      lines.push(chalk.green(`  Best Trade:      ${best.symbol || best.tokenId} ${best.pnlUsd >= 0 ? '+' : ''}$${best.pnlUsd.toFixed(2)} (${(best.pnlPercent * 100).toFixed(1)}%)`));
    }
    if (metrics.worstTrade?.tokenId) {
      const worst = metrics.worstTrade;
      lines.push(chalk.red(`  Worst Trade:     ${worst.symbol || worst.tokenId} ${worst.pnlUsd >= 0 ? '+' : ''}$${worst.pnlUsd.toFixed(2)} (${(worst.pnlPercent * 100).toFixed(1)}%)`));
    }

    lines.push('');

    return lines.join('\n');
  }
}
