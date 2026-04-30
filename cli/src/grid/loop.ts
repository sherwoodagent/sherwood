/**
 * Standalone grid event loop — runs the grid strategy independently
 * from the directional agent loop on 1-minute cycles.
 *
 * Usage:
 *   const loop = new GridLoop({ capital: 5000, cycle: 60_000 });
 *   await loop.start();
 */

import chalk from 'chalk';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { GridManager } from './manager.js';
import { GridPortfolio } from './portfolio.js';
import { DEFAULT_GRID_CONFIG } from './config.js';
import type { GridConfig } from './config.js';
import { HyperliquidProvider } from '../providers/data/hyperliquid.js';
import { GridHedgeManager } from './hedge.js';
import { GridExecutor } from './executor.js';
import { OnchainGridExecutor } from './onchain-executor.js';
import type { Address } from 'viem';

const GRID_CYCLES_PATH = join(homedir(), '.sherwood', 'grid', 'cycles.jsonl');

export interface GridLoopConfig {
  /** Starting capital in USD. */
  capital: number;
  /** Cycle interval in milliseconds. */
  cycle: number;
  /** Optional overrides for the default grid config. */
  config?: Partial<GridConfig>;
  /** Live execution mode — when true, places real orders on Hyperliquid. */
  live?: boolean;
  /** HL asset indices per token (required when live=true). */
  assetIndices?: Record<string, number>;
  /** When set, use on-chain executor (calls strategy contract). */
  strategyAddress?: Address;
}

export class GridLoop {
  private cfg: GridLoopConfig;
  private gridConfig: GridConfig;
  private manager: GridManager;
  private hedge: GridHedgeManager;
  private hl: HyperliquidProvider;
  private executor: GridExecutor | OnchainGridExecutor | null = null;
  private running = false;
  private cycleCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: GridLoopConfig) {
    this.cfg = cfg;
    this.gridConfig = { ...DEFAULT_GRID_CONFIG, ...cfg.config };
    this.manager = new GridManager(this.gridConfig);
    this.hedge = new GridHedgeManager();
    this.hl = new HyperliquidProvider();

    if (cfg.live) {
      if (!cfg.assetIndices) {
        throw new Error('assetIndices required when live=true');
      }
      if (cfg.strategyAddress) {
        this.executor = new OnchainGridExecutor({
          strategyAddress: cfg.strategyAddress,
          assetIndices: cfg.assetIndices,
        });
      } else {
        this.executor = new GridExecutor({ assetIndices: cfg.assetIndices });
      }
    }
  }

  /** Start the grid loop. Resolves when shut down via SIGINT/SIGTERM. */
  async start(): Promise<void> {
    this.running = true;

    // Graceful shutdown
    const shutdown = () => {
      console.error(chalk.yellow('\n  [grid-loop] Shutting down…'));
      this.running = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Initialize grid if no state exists
    await this.manager.init(this.cfg.capital);

    if (this.executor instanceof OnchainGridExecutor) {
      await this.executor.load();
    }

    // Startup banner
    console.error(chalk.cyan(
      `\n  [grid-loop] Started — capital=$${this.cfg.capital.toFixed(0)} ` +
      `cycle=${(this.cfg.cycle / 1000).toFixed(0)}s ` +
      `tokens=[${this.gridConfig.tokens.join(', ')}] ` +
      `leverage=${this.gridConfig.leverage}x ` +
      `levels=${this.gridConfig.levelsPerSide}/side\n`
    ));

    // Main loop
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error(chalk.red(`  [grid-loop] Tick error: ${(err as Error).message}`));
      }

      // Wait for next cycle (interruptible via shutdown)
      if (this.running) {
        await new Promise<void>(resolve => {
          this.timer = setTimeout(resolve, this.cfg.cycle);
        });
      }
    }

    // Cleanup listeners
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    console.error(chalk.yellow('  [grid-loop] Stopped.'));
  }

  /** Execute one grid cycle. */
  private async tick(): Promise<void> {
    this.cycleCount++;
    const start = Date.now();

    // Fetch mark prices from Hyperliquid
    const prices: Record<string, number> = {};
    for (const token of this.gridConfig.tokens) {
      const data = await this.hl.getHyperliquidData(token);
      if (data?.markPrice && data.markPrice > 0) {
        prices[token] = data.markPrice;
      }
    }

    if (Object.keys(prices).length === 0) {
      console.error(chalk.dim(`  [grid-loop] #${this.cycleCount} — no prices, skipping`));
      return;
    }

    const result = await this.manager.tick(prices);
    const elapsed = Date.now() - start;

    // Live mode: submit real orders via executor
    if (this.executor) {
      const plan = this.manager.computeOrders(prices);
      if (plan.ordersToPlace.length > 0 || plan.assetsToCancel.length > 0) {
        const res = await this.executor.execute(plan);
        if (res.errors.length > 0) {
          console.error(chalk.yellow(`  [grid-loop] Executor errors: ${res.errors.join('; ')}`));
        }
        if (res.placed > 0 || res.cancelled > 0) {
          console.error(chalk.cyan(`  [grid-loop] Live: placed=${res.placed} cancelled=${res.cancelled}`));
        }
      }
    }

    // Log round trips when they happen
    if (result.roundTrips > 0) {
      console.error(chalk.green(
        `  [grid-loop] #${this.cycleCount} — ${result.roundTrips} RT(s), ` +
        `+$${result.pnlUsd.toFixed(2)} PnL, ${result.fills} fill(s) [${elapsed}ms]`
      ));
    }

    // Log fills (without round trips)
    if (result.fills > 0 && result.roundTrips === 0) {
      console.error(chalk.dim(
        `  [grid-loop] #${this.cycleCount} — ${result.fills} fill(s), 0 RTs [${elapsed}ms]`
      ));
    }

    // Delta hedge — adjust short positions to offset underwater grid longs
    const openExposure = this.manager.getOpenFillExposure();
    const hedgeResult = await this.hedge.tick(openExposure, prices);
    if (hedgeResult.adjustments > 0) {
      console.error(chalk.magenta(
        `  [hedge] ${hedgeResult.adjustments} adjustment(s), ` +
        `unrealized: $${hedgeResult.unrealizedPnl.toFixed(2)}, ` +
        `total realized: $${hedgeResult.totalRealizedPnl.toFixed(2)}`
      ));
    }

    // Write cycle log for cron monitor
    const stats = this.manager.getStats();
    const cycleEntry = {
      cycleNumber: this.cycleCount,
      timestamp: Date.now(),
      gridFills: result.fills,
      gridRoundTrips: result.roundTrips,
      gridPnlUsd: result.pnlUsd,
      totalPnlUsd: stats?.totalPnlUsd ?? 0,
      todayPnlUsd: stats?.todayPnlUsd ?? 0,
      totalRoundTrips: stats?.totalRoundTrips ?? 0,
      allocation: stats?.allocation ?? 0,
      paused: stats?.paused ?? false,
      hedgeUnrealizedPnl: hedgeResult.unrealizedPnl,
      hedgeTotalRealizedPnl: hedgeResult.totalRealizedPnl,
    };
    try {
      await mkdir(join(homedir(), '.sherwood', 'grid'), { recursive: true });
      await appendFile(GRID_CYCLES_PATH, JSON.stringify(cycleEntry) + '\n');
    } catch { /* non-critical */ }

    // Periodic status every ~60 cycles
    if (this.cycleCount % 60 === 0) {
      const stats = this.manager.getStats();
      if (stats) {
        const hedgeStatus = this.hedge.getStatus();
        const hedgeInfo = hedgeStatus && hedgeStatus.positions.length > 0
          ? ` hedge=$${hedgeResult.unrealizedPnl.toFixed(2)}unr/$${hedgeStatus.totalRealizedPnl.toFixed(2)}real`
          : '';
        console.error(chalk.cyan(
          `  [grid-loop] Status #${this.cycleCount} — ` +
          `totalPnL=$${stats.totalPnlUsd.toFixed(2)} ` +
          `todayPnL=$${stats.todayPnlUsd.toFixed(2)} ` +
          `RTs=${stats.totalRoundTrips} ` +
          `alloc=$${stats.allocation.toFixed(0)}` +
          `${hedgeInfo}` +
          `${stats.paused ? ' (PAUSED)' : ''}`
        ));
      }
    }
  }
}
