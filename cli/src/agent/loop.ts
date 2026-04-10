/**
 * Autonomous agent loop — runs analysis + execution cycles on a timer.
 */

import chalk from 'chalk';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TradingAgent } from './index.js';
import type { AgentConfig } from './index.js';
import { TradeExecutor } from './executor.js';
import type { ExecutionConfig } from './executor.js';
import { PortfolioTracker, resetPnlCounters } from './portfolio.js';
import { RiskManager, DEFAULT_RISK_CONFIG } from './risk.js';
import type { RiskConfig } from './risk.js';
import { CoinGeckoProvider } from '../providers/data/coingecko.js';
import { Reporter } from './reporter.js';
import { DynamicTokenSelector } from './token-selector.js';

export interface LoopConfig {
  agent: AgentConfig;
  execution: ExecutionConfig;
  riskConfig?: Partial<RiskConfig>;
  reportToTelegram?: boolean;
  logPath?: string;
  autoDynamicSelection?: boolean;
}

export interface CycleResult {
  cycleNumber: number;
  timestamp: number;
  duration: number;
  tokensAnalyzed: number;
  signals: Array<{ token: string; score: number; action: string }>;
  tradesExecuted: number;
  exitsProcessed: number;
  portfolioValue: number;
  dailyPnl: number;
  errors: string[];
}

export class AgentLoop {
  private running = false;
  private cycleCount = 0;
  private config: LoopConfig;
  private agent: TradingAgent;
  private executor: TradeExecutor;
  private portfolio: PortfolioTracker;
  private riskManager: RiskManager;
  private coingecko: CoinGeckoProvider;
  private reporter: Reporter;

  constructor(config: LoopConfig) {
    this.config = config;
    this.agent = new TradingAgent(config.agent);
    this.portfolio = new PortfolioTracker();
    this.riskManager = new RiskManager(config.riskConfig);
    this.executor = new TradeExecutor(config.execution, this.riskManager, this.portfolio);
    this.coingecko = new CoinGeckoProvider();
    this.reporter = new Reporter();
  }

  /** Start the autonomous loop */
  async start(): Promise<void> {
    this.running = true;

    // Ensure state directory exists
    const stateDir = join(homedir(), '.sherwood', 'agent');
    await mkdir(stateDir, { recursive: true });

    // Startup banner
    const cfg = this.config.agent;
    console.log('');
    console.log(chalk.bold('  ┌──────────────────────────────────────────────┐'));
    console.log(chalk.bold('  │        Sherwood Trading Agent — Loop         │'));
    console.log(chalk.bold('  └──────────────────────────────────────────────┘'));
    console.log(`  Mode:     ${cfg.dryRun ? chalk.yellow('DRY RUN (paper trading)') : chalk.red('LIVE')}`);
    console.log(`  Cycle:    ${cfg.cycle}`);
    console.log(`  Tokens:   ${cfg.tokens.join(', ')}`);
    console.log(`  Risk:     max ${(this.config.riskConfig?.maxSinglePosition ?? DEFAULT_RISK_CONFIG.maxSinglePosition) * 100}% per position`);
    console.log(`  Log:      ${this.config.logPath ?? 'console only'}`);
    console.log(chalk.dim('\n  Press Ctrl+C to stop.\n'));

    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        console.error(chalk.red(`  Cycle failed: ${(err as Error).message}`));
      }

      if (!this.running) break;

      const ms = parseCycleInterval(this.config.agent.cycle);
      console.log(chalk.dim(`  Next cycle in ${this.config.agent.cycle}. Sleeping...`));
      await this.sleepInterruptible(ms);
    }

    console.log(chalk.bold('\n  Agent loop stopped.\n'));
  }

  /** Run a single analysis + execution cycle */
  async runCycle(): Promise<CycleResult> {
    this.cycleCount++;
    const startTime = Date.now();
    const errors: string[] = [];
    let tradesExecuted = 0;
    let exitsProcessed = 0;

    // 1. Load portfolio and check drawdown limits
    const state = await this.portfolio.load();

    // Reset PnL counters if time boundaries crossed
    const resetState = resetPnlCounters(state);
    if (resetState.dailyPnl !== state.dailyPnl || resetState.weeklyPnl !== state.weeklyPnl || resetState.monthlyPnl !== state.monthlyPnl) {
      await this.portfolio.save(resetState);
    }

    this.riskManager.updatePortfolio(resetState);
    const drawdown = this.riskManager.isDrawdownLimitHit();
    if (drawdown.paused) {
      console.log(chalk.red(`  ⚠ Trading paused: ${drawdown.message}`));
      const result: CycleResult = {
        cycleNumber: this.cycleCount,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        tokensAnalyzed: 0,
        signals: [],
        tradesExecuted: 0,
        exitsProcessed: 0,
        portfolioValue: state.totalValue,
        dailyPnl: state.dailyPnl,
        errors: [drawdown.message],
      };
      await this.logCycle(result);
      return result;
    }

    // 2. Update prices for existing positions and process exits
    if (state.positions.length > 0) {
      try {
        const tokenIds = state.positions.map(p => p.tokenId);
        const priceData = await this.coingecko.getPrice(tokenIds, ['usd']);
        const currentPrices: Record<string, number> = {};

        for (const id of tokenIds) {
          const price = priceData?.[id]?.usd;
          if (typeof price === 'number') {
            currentPrices[id] = price;
          }
        }

        if (Object.keys(currentPrices).length > 0) {
          await this.portfolio.updatePrices(currentPrices);

          // Process exits (stop losses, take profits)
          const exits = await this.executor.processExits(currentPrices);
          exitsProcessed = exits.length;

          for (const exit of exits) {
            const pnlColor = exit.pnl >= 0 ? chalk.green : chalk.red;
            console.log(
              `  ${exit.reason}: ${exit.position.symbol} @ $${exit.exitPrice.toFixed(4)} ${pnlColor(`PnL: $${exit.pnl.toFixed(2)}`)}`,
            );
          }
        }
      } catch (err) {
        errors.push(`Price update failed: ${(err as Error).message}`);
      }
    }

    // 3. Update token list if using dynamic selection
    if (this.config.autoDynamicSelection) {
      try {
        const selector = new DynamicTokenSelector();
        const selection = await selector.selectTokens();

        // Update token list without recreating the agent (preserves OI cache, provider state)
        this.config.agent.tokens = selection.tokens;
        this.agent.updateTokens(selection.tokens);

        if (this.cycleCount % 6 === 1) { // Show selection summary every 6th cycle (~30min for 5min cycles)
          console.log(chalk.dim(`  Updated tokens: ${selection.tokens.length} from ${selection.totalMarketsScanned} HL markets`));
        }
      } catch (err) {
        errors.push(`Dynamic selection failed: ${(err as Error).message}`);
        console.log(chalk.yellow(`  Warning: Dynamic selection failed, using existing tokens`));
      }
    }

    // 4. Analyze all watchlist tokens
    console.log(chalk.dim(`  Analyzing ${this.config.agent.tokens.length} tokens...`));
    const results = await this.agent.analyzeAll();

    // 5. Collect signals and execute trades for actionable ones
    const signals: CycleResult['signals'] = [];

    for (const result of results) {
      const { action, score } = result.decision;
      signals.push({ token: result.token, score, action });

      // Only execute on BUY/SELL signals
      if (action === 'STRONG_BUY' || action === 'BUY' || action === 'SELL' || action === 'STRONG_SELL') {
        try {
          // Get current price for the token
          const priceData = await this.coingecko.getPrice([result.token], ['usd']);
          const currentPrice = priceData?.[result.token]?.usd;

          if (typeof currentPrice === 'number' && currentPrice > 0) {
            const execResult = await this.executor.execute(result.decision, result.token, currentPrice);
            if (execResult.success) {
              tradesExecuted++;
              console.log(this.executor.formatExecution(execResult));
            } else if (execResult.error && !execResult.error.includes('does not trigger')) {
              errors.push(`${result.token}: ${execResult.error}`);
            }
          } else {
            errors.push(`No price data for ${result.token}`);
          }
        } catch (err) {
          errors.push(`Execution failed for ${result.token}: ${(err as Error).message}`);
        }
      }
    }

    // 5. Reload portfolio after trades
    const updatedState = await this.portfolio.load();

    // 6. Build cycle result
    const cycleResult: CycleResult = {
      cycleNumber: this.cycleCount,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      tokensAnalyzed: results.length,
      signals,
      tradesExecuted,
      exitsProcessed,
      portfolioValue: updatedState.totalValue,
      dailyPnl: updatedState.dailyPnl,
      errors,
    };

    // 7. Log and report
    await this.logCycle(cycleResult);
    this.reportCycle(cycleResult);

    return cycleResult;
  }

  /** Stop the loop gracefully */
  stop(): void {
    this.running = false;
  }

  /** Whether the loop is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  /** Log cycle result to a JSONL file */
  private async logCycle(result: CycleResult): Promise<void> {
    const logPath = this.config.logPath ?? join(homedir(), '.sherwood', 'agent', 'cycles.jsonl');
    try {
      await mkdir(join(homedir(), '.sherwood', 'agent'), { recursive: true });
      await appendFile(logPath, JSON.stringify(result) + '\n', 'utf-8');
    } catch (err) {
      console.error(chalk.dim(`  Failed to write cycle log: ${(err as Error).message}`));
    }
  }

  /** Display cycle report to console */
  private reportCycle(result: CycleResult): void {
    console.log(this.reporter.formatCycleReport(result));
  }

  /** Sleep that can be interrupted by stop() */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const check = setInterval(() => {
        if (!this.running) done();
      }, 1000);
    });
  }

}

/** Parse cycle interval string to milliseconds */
function parseCycleInterval(cycle: string): number {
  const match = cycle.match(/^(\d+)(m|h)$/);
  if (!match) return 4 * 60 * 60 * 1000; // default 4h

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return 4 * 60 * 60 * 1000;
}
