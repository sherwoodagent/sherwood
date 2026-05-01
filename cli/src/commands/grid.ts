/**
 * Grid commands — sherwood grid start|status
 *
 * Runs the ATR-based grid trading strategy as a standalone loop,
 * parallel to the directional agent. Isolated capital and portfolio.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { GridLoop } from '../grid/loop.js';
import { GridPortfolio } from '../grid/portfolio.js';
import { DEFAULT_GRID_CONFIG } from '../grid/config.js';
import { runBacktest } from '../grid/backtest.js';
import type { BacktestResult } from '../grid/backtest.js';
import type { GridConfig } from '../grid/config.js';
import { runSweep, type SweepResult, type SweepableField } from '../grid/sweep.js';

const DIM = chalk.gray;
const G = chalk.green;
const BOLD = chalk.white.bold;
const W = chalk.white;
const SEP = () => console.log(DIM('─'.repeat(60)));

function printSummary(r: BacktestResult): void {
  const dd = r.drawdown;
  const days = r.window.days;
  const rtPerDay = (r.totals.roundTrips / Math.max(days, 1)).toFixed(1);
  const fillPerDay = (r.totals.fills / Math.max(days, 1)).toFixed(1);
  const pnlSign = r.capital.pnlUsd >= 0 ? '+' : '-';
  const pnlAbs = Math.abs(r.capital.pnlUsd).toFixed(2);
  const pnlPctStr = (r.capital.pnlPct * 100).toFixed(2);

  console.log();
  console.log(G.bold(`  Grid Backtest — ${r.runId}`));
  console.log(DIM('─'.repeat(64)));
  console.log(W(`  Window:        ${r.window.fromIso.slice(0, 10)} → ${r.window.toIso.slice(0, 10)}  (${days.toFixed(0)} days)`));
  console.log(W(`  Capital:       $${r.capital.initialUsd.toLocaleString()} → $${r.capital.finalUsd.toFixed(2)}  (${pnlSign}$${pnlAbs}, ${pnlSign}${pnlPctStr}%)`));
  console.log(W(`  Gross PnL:     $${r.capital.grossPnlUsd.toFixed(2)} (before fees)`));
  console.log(W(`  Fees (${r.fees.bps}bps): -$${r.fees.totalUsd.toFixed(2)}  ($${r.fees.perFill.toFixed(4)}/fill)`));
  if (r.hedge.enabled) {
    const hedgeNet = r.hedge.realizedPnlUsd + r.hedge.unrealizedPnlUsd;
    const hedgeSign = hedgeNet >= 0 ? '+' : '-';
    const hedgeAbs = Math.abs(hedgeNet).toFixed(2);
    console.log(W(`  Hedge:         ${hedgeSign}$${hedgeAbs} (realized $${r.hedge.realizedPnlUsd.toFixed(2)} + unrealized $${r.hedge.unrealizedPnlUsd.toFixed(2)}, ${r.hedge.adjustments} adj)`));
  } else {
    console.log(W(`  Hedge:         disabled`));
  }
  console.log(W(`  Round trips:   ${r.totals.roundTrips}  (${rtPerDay}/day)`));
  console.log(W(`  Fills:         ${r.totals.fills}  (${fillPerDay}/day)`));
  console.log(W(`  Rebuilds:      ${r.totals.rebuilds}`));
  console.log(W(`  Max drawdown:  -$${dd.maxUsd.toFixed(2)} (-${(dd.maxPct * 100).toFixed(2)}%)`));
  console.log(W(`  Paused:        ${r.totals.pausedSteps} steps (${((r.totals.pausedSteps / Math.max(r.totals.totalSteps, 1)) * 100).toFixed(1)}%)`));
  console.log(W(`  Skipped:       ${r.totals.skippedSteps} steps`));
  console.log();
  console.log(BOLD('  Per token:'));
  for (const t of r.perToken) {
    const tokPnl = t.pnlUsd >= 0 ? G(`+$${t.pnlUsd.toFixed(2)}`) : chalk.red(`-$${Math.abs(t.pnlUsd).toFixed(2)}`);
    console.log(W(`    ${t.token.padEnd(10)} $${t.allocation.initial.toFixed(0).padStart(6)} → $${t.allocation.final.toFixed(0).padStart(6)}  ${tokPnl}  RTs=${t.roundTrips}  fills=${t.fills}`));
  }
  if (r.liquidations.events.length > 0) {
    console.log();
    console.log(BOLD('  Liquidations:'));
    for (const ev of r.liquidations.events) {
      const date = new Date(ev.timestamp).toISOString().slice(0, 10);
      console.log(W(`    ${ev.token.padEnd(10)} ${date}  unrealized=$${ev.unrealizedPnlAtLiquidation.toFixed(0)}  threshold=$${ev.thresholdUsd.toFixed(0)}`));
    }
    if (r.liquidations.haltedAt !== null) {
      const haltDate = new Date(r.liquidations.haltedAt).toISOString().slice(0, 10);
      console.log(chalk.red.bold(`    RUN HALTED on ${haltDate} — all tokens liquidated.`));
    }
  }
  console.log();
  console.log(W(`  Wall time:     ${(r.durationMs / 1000).toFixed(1)}s`));
  console.log(DIM('─'.repeat(64)));
}

function printSweepSummary(s: SweepResult): void {
  const days = s.window.days;
  console.log();
  console.log(G.bold(`  Grid Sweep — ${s.sweepId}`));
  console.log(DIM('─'.repeat(96)));
  console.log(W(`  Window:    ${new Date(s.window.fromMs).toISOString().slice(0, 10)} → ${new Date(s.window.toMs).toISOString().slice(0, 10)}  (${days.toFixed(0)} days)`));
  console.log(W(`  Tokens:    ${s.tokens.join(', ')}`));
  console.log(W(`  Capital:   $${s.capital.toLocaleString()}`));
  console.log(W(`  Fees:      ${s.feeBps} bps/fill`));
  console.log(W(`  Runs:      ${s.runs.length}`));
  console.log(W(`  Wall:      ${(s.durationMs / 1000).toFixed(1)}s`));
  console.log(DIM('─'.repeat(96)));
  console.log();
  console.log(BOLD('  Rank  Surv  Lev  Levels  ATR×  Drift  RTs    NetPnL$       NetPnL%   DD%      Risk-Adj'));
  console.log(DIM('  ' + '─'.repeat(102)));
  for (let i = 0; i < s.runs.length; i++) {
    const r = s.runs[i]!;
    const rank = String(i + 1).padStart(4);
    const surv = r.survived ? G(' ✓ ') : chalk.red(' ✗ ');
    const lev = String(r.config.leverage ?? '').padStart(3);
    const lvls = String(r.config.levelsPerSide ?? '').padStart(6);
    const atr = String(r.config.atrMultiplier ?? '').padStart(4);
    const drift = String(r.config.rebalanceDriftPct ?? '').padStart(5);
    const rts = String(r.totals.roundTrips).padStart(5);
    const netPnl = `$${r.capital.pnlUsd.toFixed(0)}`.padStart(11);
    const netPct = `${(r.capital.pnlPct * 100).toFixed(1)}%`.padStart(8);
    const ddPct = `${(r.drawdown.maxPct * 100).toFixed(1)}%`.padStart(8);
    const ra = r.riskAdjusted.toFixed(2).padStart(8);
    const pnlColor = r.capital.pnlUsd >= 0 ? G : chalk.red;
    console.log(`  ${rank}  ${surv}  ${lev}  ${lvls}  ${atr}  ${drift}  ${rts}  ${pnlColor(netPnl)}  ${pnlColor(netPct)}  ${ddPct}  ${ra}`);
  }
  console.log(DIM('  ' + '─'.repeat(102)));
  console.log();
  console.log(W(`  Saved: ${s.sweepId}/sweep.json + per-run JSONs in ~/.sherwood/grid/sweeps/`));
  console.log();
}

export function registerGridCommand(program: Command): void {
  const grid = program
    .command('grid')
    .description('Grid trading strategy — ATR-based grid on BTC/ETH/SOL');

  // ── grid start ──
  grid
    .command('start')
    .description('Start the grid trading loop')
    .option('--capital <usd>', 'Starting capital in USD', '5000')
    .option('--cycle <seconds>', 'Cycle interval in seconds', '60')
    .option('--tokens <list>', 'Comma-separated token list', 'bitcoin,ethereum,solana')
    .option('--leverage <n>', 'Leverage multiplier', '5')
    .option('--levels <n>', 'Grid levels per side', '15')
    .option('--live', 'enable live execution (places real orders on Hyperliquid)')
    .option('--asset-indices <pairs>', 'comma-separated token=index pairs (e.g. bitcoin=3,ethereum=4,solana=5)')
    .option('--strategy <address>', 'on-chain strategy contract address (enables on-chain executor)')
    .action(async (opts) => {
      const capital = parseFloat(opts.capital);
      const cycleMs = parseInt(opts.cycle, 10) * 1000;
      const tokens = opts.tokens.split(',').map((t: string) => t.trim());
      const leverage = parseFloat(opts.leverage);
      const levels = parseInt(opts.levels, 10);

      const live = !!opts.live;
      let assetIndices: Record<string, number> | undefined;
      if (live) {
        if (!opts.assetIndices) {
          throw new Error('--asset-indices required when --live (e.g. --asset-indices bitcoin=3,ethereum=4,solana=5)');
        }
        assetIndices = {};
        for (const pair of (opts.assetIndices as string).split(',')) {
          const [tok, idx] = pair.split('=');
          if (!tok || !idx) throw new Error(`Bad asset-indices pair: ${pair}`);
          assetIndices[tok.trim()] = Number(idx);
        }
      }

      const strategyAddress = opts.strategy as `0x${string}` | undefined;
      if (strategyAddress && !live) {
        throw new Error('--strategy requires --live');
      }

      // Build equal-weight token split
      const weight = 1 / tokens.length;
      const tokenSplit: Record<string, number> = {};
      for (const t of tokens) {
        tokenSplit[t] = weight;
      }

      console.log();
      console.log(G.bold('  Grid Strategy'));
      SEP();
      console.log(W(`  Capital:   $${capital.toLocaleString()}`));
      console.log(W(`  Cycle:     ${opts.cycle}s`));
      console.log(W(`  Tokens:    ${tokens.join(', ')}`));
      console.log(W(`  Leverage:  ${leverage}x`));
      console.log(W(`  Levels:    ${levels}/side`));
      SEP();

      const loop = new GridLoop({
        capital,
        cycle: cycleMs,
        live,
        assetIndices,
        strategyAddress,
        config: {
          ...DEFAULT_GRID_CONFIG,
          tokens,
          leverage,
          levelsPerSide: levels,
          tokenSplit,
        },
      });

      await loop.start();
    });

  // ── grid status ──
  grid
    .command('status')
    .description('Show current grid portfolio status')
    .action(async () => {
      const portfolio = new GridPortfolio();
      const state = await portfolio.load();

      if (!state) {
        console.log(DIM('\n  No grid portfolio found. Run `sherwood grid start` first.\n'));
        return;
      }

      // Reset daily stats if needed before display
      portfolio.resetDailyStats(state);
      const agg = portfolio.aggregateStats(state);

      console.log();
      console.log(G.bold('  Grid Portfolio'));
      SEP();
      console.log(W(`  Allocation:    $${state.totalAllocation.toLocaleString()}`));
      console.log(W(`  Status:        ${state.paused ? chalk.red('PAUSED — ' + state.pauseReason) : G('Active')}`));
      console.log(W(`  Initialized:   ${new Date(state.initializedAt).toLocaleString()}`));
      SEP();

      // Per-token table
      console.log();
      console.log(BOLD('  Token          Alloc       RTs    PnL         Today PnL   Fills'));
      console.log(DIM('  ' + '─'.repeat(72)));

      for (const g of state.grids) {
        const name = g.token.padEnd(13);
        const alloc = `$${g.allocation.toFixed(0)}`.padStart(8);
        const rts = String(g.stats.totalRoundTrips).padStart(6);
        const pnl = `$${g.stats.totalPnlUsd.toFixed(2)}`.padStart(10);
        const todayPnl = `$${g.stats.todayPnlUsd.toFixed(2)}`.padStart(10);
        const fills = String(g.stats.totalFills).padStart(6);
        const pnlColor = g.stats.totalPnlUsd >= 0 ? G : chalk.red;
        const todayColor = g.stats.todayPnlUsd >= 0 ? G : chalk.red;

        console.log(`  ${W(name)}  ${alloc}  ${rts}  ${pnlColor(pnl)}  ${todayColor(todayPnl)}  ${fills}`);
      }

      console.log(DIM('  ' + '─'.repeat(72)));

      // Totals
      const totalPnlColor = agg.totalPnlUsd >= 0 ? G : chalk.red;
      const todayTotalColor = agg.todayPnlUsd >= 0 ? G : chalk.red;
      console.log(`  ${BOLD('TOTAL'.padEnd(13))}  ${`$${state.totalAllocation.toFixed(0)}`.padStart(8)}  ${String(agg.totalRoundTrips).padStart(6)}  ${totalPnlColor(`$${agg.totalPnlUsd.toFixed(2)}`.padStart(10))}  ${todayTotalColor(`$${agg.todayPnlUsd.toFixed(2)}`.padStart(10))}  ${String(agg.todayFills).padStart(6)}`);
      console.log();
    });

  // ── grid backtest ──
  grid
    .command('backtest')
    .description('Replay historical Hyperliquid prices through the grid strategy')
    .option('--from <iso>', 'Window start (ISO date). Default: 30d ago.')
    .option('--to <iso>', 'Window end (ISO date). Default: now.')
    .option('--capital <usd>', 'Starting capital in USD', '5000')
    .option('--tokens <list>', 'Comma-separated token list', 'bitcoin,ethereum,solana')
    .option('--leverage <n>', 'Override leverage')
    .option('--levels <n>', 'Override levels per side')
    .option('--atr-multiplier <n>', 'Override ATR multiplier')
    .option('--rebalance-drift <n>', 'Override rebalanceDriftPct')
    .option('--snapshot-every <min>', 'Equity-curve snapshot cadence (minutes)', '60')
    .option('--verbose', 'Print manager fill logs during replay')
    .option('--no-cache', 'Skip cache; always fetch fresh data')
    .option('--out <path>', 'Override output path')
    .option('--fee-bps <n>', 'Trading fee in basis points per fill (default 5 = 0.05%)', '5')
    .option('--no-hedge', 'Disable hedge simulation (hedge is ON by default to match live grid)')
    .option('--maintenance-pct <n>', 'Per-token maintenance margin fraction (default 0.02 = 2%, typical Hyperliquid)', '0.02')
    .action(async (opts) => {
      const now = Date.now();
      const toMs = opts.to ? Date.parse(opts.to) : now;
      const fromMs = opts.from ? Date.parse(opts.from) : (now - 30 * 24 * 3600_000);
      if (Number.isNaN(toMs) || Number.isNaN(fromMs)) {
        throw new Error('--from / --to must be ISO dates (e.g. 2026-04-01)');
      }

      const tokens = (opts.tokens as string).split(',').map(t => t.trim());
      const weight = 1 / tokens.length;
      const tokenSplit: Record<string, number> = {};
      for (const t of tokens) tokenSplit[t] = weight;

      const config: GridConfig = {
        ...DEFAULT_GRID_CONFIG,
        tokens,
        tokenSplit,
        leverage: opts.leverage ? Number(opts.leverage) : DEFAULT_GRID_CONFIG.leverage,
        levelsPerSide: opts.levels ? Number(opts.levels) : DEFAULT_GRID_CONFIG.levelsPerSide,
        atrMultiplier: opts.atrMultiplier ? Number(opts.atrMultiplier) : DEFAULT_GRID_CONFIG.atrMultiplier,
        rebalanceDriftPct: opts.rebalanceDrift ? Number(opts.rebalanceDrift) : DEFAULT_GRID_CONFIG.rebalanceDriftPct,
        maintenanceMarginPct: opts.maintenancePct ? Number(opts.maintenancePct) : DEFAULT_GRID_CONFIG.maintenanceMarginPct,
      };

      const capital = Number(opts.capital);
      const snapshotEveryMinutes = Number(opts.snapshotEvery);

      console.log();
      console.log(G.bold('  Grid Backtest'));
      SEP();
      console.log(W(`  Window:    ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`));
      console.log(W(`  Capital:   $${capital.toLocaleString()}`));
      console.log(W(`  Tokens:    ${tokens.join(', ')}`));
      console.log(W(`  Leverage:  ${config.leverage}x`));
      console.log(W(`  Levels:    ${config.levelsPerSide}/side`));
      SEP();

      const result = await runBacktest({
        fromMs,
        toMs,
        capital,
        config,
        snapshotEveryMinutes,
        verbose: !!opts.verbose,
        noCache: opts.cache === false,
        outPath: opts.out,
        feeBps: Number(opts.feeBps),
        hedge: opts.hedge !== false,
      });

      printSummary(result);
    });

  // ── grid sweep ──
  grid
    .command('sweep')
    .description('Run a parameter sweep over multiple grid configurations')
    .option('--from <iso>', 'Window start (ISO date). Default: 30d ago.')
    .option('--to <iso>', 'Window end (ISO date). Default: now.')
    .option('--capital <usd>', 'Starting capital in USD', '5000')
    .option('--tokens <list>', 'Comma-separated token list', 'bitcoin,ethereum,solana')
    .option('--leverage <list>', 'Comma-separated leverage values to sweep')
    .option('--levels <list>', 'Comma-separated levels-per-side values to sweep')
    .option('--atr-multiplier <list>', 'Comma-separated ATR multiplier values to sweep')
    .option('--rebalance-drift <list>', 'Comma-separated rebalance drift values to sweep')
    .option('--fee-bps <n>', 'Trading fee in basis points per fill (default 5)', '5')
    .option('--no-cache', 'Skip cache; always fetch fresh data')
    .action(async (opts) => {
      const now = Date.now();
      const toMs = opts.to ? Date.parse(opts.to) : now;
      const fromMs = opts.from ? Date.parse(opts.from) : (now - 30 * 24 * 3600_000);
      if (Number.isNaN(toMs) || Number.isNaN(fromMs)) {
        throw new Error('--from / --to must be ISO dates (e.g. 2026-04-01)');
      }
      const tokens = (opts.tokens as string).split(',').map(t => t.trim());

      const parseList = (s: string | undefined): number[] | undefined => {
        if (!s) return undefined;
        return s.split(',').map(v => Number(v.trim())).filter(n => Number.isFinite(n));
      };

      const sweep: Partial<Record<SweepableField, number[]>> = {
        leverage: parseList(opts.leverage),
        levelsPerSide: parseList(opts.levels),
        atrMultiplier: parseList(opts.atrMultiplier),
        rebalanceDriftPct: parseList(opts.rebalanceDrift),
      };

      const result = await runSweep({
        fromMs,
        toMs,
        capital: Number(opts.capital),
        tokens,
        sweep,
        feeBps: Number(opts.feeBps),
        noCache: opts.cache === false,
      });

      printSweepSummary(result);
    });
}
