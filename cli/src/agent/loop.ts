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
import type { RiskConfig, PortfolioState } from './risk.js';
import { CoinGeckoProvider } from '../providers/data/coingecko.js';
import { Reporter } from './reporter.js';
import { DynamicTokenSelector } from './token-selector.js';
import { PriceValidator } from './price-validator.js';
import type { RiskGateConfig } from './risk-gate.js';

export interface LoopConfig {
  agent: AgentConfig;
  execution: ExecutionConfig;
  riskConfig?: Partial<RiskConfig>;
  riskGateConfig?: Partial<RiskGateConfig>;
  reportToTelegram?: boolean;
  logPath?: string;
  autoDynamicSelection?: boolean;
}

export interface CycleResult {
  cycleNumber: number;
  timestamp: number;
  duration: number;
  tokensAnalyzed: number;
  signals: Array<{ token: string; score: number; action: string; regime?: string }>;
  tradesExecuted: number;
  exitsProcessed: number;
  portfolioValue: number;
  /** Realized PnL since UTC day start (closed trades only). */
  dailyRealizedPnl: number;
  /** Sum of mark-to-market pnlUsd across all open positions at cycle end. */
  unrealizedPnl: number;
  /** @deprecated Alias for dailyRealizedPnl — retained for downstream consumers of cycles.jsonl. */
  dailyPnl: number;
  /** Cumulative PnL in USD since the portfolio was initialized
   *  (`portfolioValue - portfolio.initialValue`). Includes both realized
   *  closes and open-position mark-to-market. */
  totalPnlUsd: number;
  /** Cumulative PnL as a fraction of initial value (e.g. +0.0162 = +1.62%). */
  totalPnlPct: number;
  /** Number of long positions opened this cycle */
  longsOpened?: number;
  /** Number of short positions opened this cycle */
  shortsOpened?: number;
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
  /** Rejects bad-price ticks (floor + 20% delta cap). Persisted to disk so
   *  anchors survive across cron invocations. */
  private priceValidator: PriceValidator;
  /** Last portfolio state loaded by runCycle(). Exposed to the judge via
   *  agent.setPortfolioStateGetter() so portfolio-veto branches can fire. */
  private lastPortfolioState: PortfolioState | undefined;

  constructor(config: LoopConfig) {
    this.config = config;
    this.agent = new TradingAgent(config.agent);
    this.portfolio = new PortfolioTracker();
    this.riskManager = new RiskManager(config.riskConfig);

    // Pass risk gate config to execution config
    const executionConfig = {
      ...config.execution,
      riskGateConfig: config.riskGateConfig,
    };
    this.executor = new TradeExecutor(executionConfig, this.riskManager, this.portfolio);

    this.coingecko = new CoinGeckoProvider();
    this.reporter = new Reporter();
    this.priceValidator = new PriceValidator();
    // Wire real portfolio state into the judge (replaces hardcoded zeros).
    this.agent.setPortfolioStateGetter(() => this.lastPortfolioState);
  }

  /** Start the autonomous loop */
  async start(): Promise<void> {
    this.running = true;

    // Ensure state directory exists
    const stateDir = join(homedir(), '.sherwood', 'agent');
    await mkdir(stateDir, { recursive: true });

    // Initialize portfolio from on-chain vault balance if no persisted state.
    // This replaces the $10k default with the actual vault USDC balance so
    // position sizing and risk management reflect real capital.
    if (this.config.execution.strategyClone && this.config.execution.chain) {
      await this.portfolio.initFromOnChain(
        this.config.execution.strategyClone,
        this.config.execution.chain,
      );
    }

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

    // Force-exit after a short grace period. XMTP client, CoinGecko HTTP
    // agents, and other async handles can keep the Node event loop alive
    // indefinitely. In cron mode (single cycle) this manifests as the
    // process hanging after "Shutting down gracefully..." until hermes
    // kills it at script_timeout_seconds. 500ms is enough for any pending
    // file writes (portfolio.json, cycles.jsonl) to flush.
    setTimeout(() => process.exit(0), 500);
  }

  /** Run a single analysis + execution cycle */
  async runCycle(): Promise<CycleResult> {
    this.cycleCount++;
    const startTime = Date.now();
    const errors: string[] = [];
    let tradesExecuted = 0;
    let exitsProcessed = 0;

    // Update risk gate cycle state
    this.executor.updateRiskGateCycle(this.cycleCount);

    // 1. Load portfolio and check drawdown limits
    const state = await this.portfolio.load();

    // Reset PnL counters if time boundaries crossed
    const resetState = resetPnlCounters(state);
    if (resetState.dailyPnl !== state.dailyPnl || resetState.weeklyPnl !== state.weeklyPnl || resetState.monthlyPnl !== state.monthlyPnl) {
      await this.portfolio.save(resetState);
    }

    // Publish the refreshed state to the judge (via getter set in the ctor).
    this.lastPortfolioState = resetState;
    this.riskManager.updatePortfolio(resetState);
    const drawdown = this.riskManager.isDrawdownLimitHit();
    if (drawdown.paused) {
      console.log(chalk.red(`  ⚠ Trading paused: ${drawdown.message}`));
      const unrealizedPnlAtPause = state.positions.reduce((sum, p) => sum + p.pnlUsd, 0);
      const initValPause = state.initialValue && state.initialValue > 0 ? state.initialValue : 10_000;
      const totalPnlUsdPause = state.totalValue - initValPause;
      const result: CycleResult = {
        cycleNumber: this.cycleCount,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        tokensAnalyzed: 0,
        signals: [],
        tradesExecuted: 0,
        exitsProcessed: 0,
        portfolioValue: state.totalValue,
        dailyRealizedPnl: state.dailyPnl,
        unrealizedPnl: unrealizedPnlAtPause,
        dailyPnl: state.dailyPnl,
        totalPnlUsd: totalPnlUsdPause,
        totalPnlPct: totalPnlUsdPause / initValPause,
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
          if (typeof price !== 'number') continue;
          const check = this.priceValidator.check(id, price);
          if (!check.ok) {
            // Skip this token for the cycle — no MTM, no exit check, no trades.
            console.warn(
              chalk.yellow(
                `  ⚠ Bad price tick rejected: ${id} → $${price} (${check.reason})`,
              ),
            );
            errors.push(`Bad price rejected for ${id}: ${check.reason}`);
            continue;
          }
          currentPrices[id] = check.price;
        }

        if (Object.keys(currentPrices).length > 0) {
          const priceState = await this.portfolio.updatePrices(currentPrices);

          // Ratchet stops (breakeven + profit-lock + percent-trail) before
          // checking exits. This activates trailing-stop logic that was
          // previously dead code (updateStopLosses was defined but never
          // called). Stops only move up — never loosened.
          const tightened = this.riskManager.updateTrailingStops(priceState.positions);
          const anyChanged = tightened.some(
            (p, i) => p.stopLoss !== priceState.positions[i]!.stopLoss,
          );
          if (anyChanged) {
            for (let i = 0; i < tightened.length; i++) {
              const before = priceState.positions[i]!;
              const after = tightened[i]!;
              if (after.stopLoss > before.stopLoss) {
                console.log(
                  chalk.dim(
                    `  Stop tightened: ${after.symbol} $${before.stopLoss.toFixed(4)} → $${after.stopLoss.toFixed(4)}`,
                  ),
                );
              }
            }
            priceState.positions = tightened;
            await this.portfolio.save(priceState);
          }

          // Process exits (stop losses, take profits)
          const exits = await this.executor.processExits(currentPrices);
          exitsProcessed = exits.length;

          for (const exit of exits) {
            const pnlColor = exit.pnl >= 0 ? chalk.green : chalk.red;
            console.log(
              `  ${exit.reason}: ${exit.position.symbol} @ $${exit.exitPrice.toFixed(4)} ${pnlColor(`PnL: $${exit.pnl.toFixed(2)}`)}`,
            );
            // Record position closed with risk gate
            this.executor.recordPositionClosed(exit.position.tokenId);
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
      signals.push({ token: result.token, score, action, regime: result.regime?.regime });

      // Only execute on BUY/SELL signals
      if (action === 'STRONG_BUY' || action === 'BUY' || action === 'SELL' || action === 'STRONG_SELL') {
        try {
          // Get current price for the token
          const priceData = await this.coingecko.getPrice([result.token], ['usd']);
          const rawPrice = priceData?.[result.token]?.usd;

          if (typeof rawPrice !== 'number' || rawPrice <= 0) {
            errors.push(`No price data for ${result.token}`);
            continue;
          }

          const check = this.priceValidator.check(result.token, rawPrice);
          if (!check.ok) {
            console.warn(
              chalk.yellow(
                `  ⚠ Bad price tick rejected (entry): ${result.token} → $${rawPrice} (${check.reason})`,
              ),
            );
            errors.push(`Bad price rejected for ${result.token}: ${check.reason}`);
            continue;
          }

          const currentPrice = check.price;
          const atr = result.data?.technicalSignals?.atr;

          // Prepare market data for risk gate
          const marketData = {
            volume24hUsd: result.data?.volume24hUsd,
            marketCapUsd: result.data?.marketCapUsd,
            volatility: result.data?.technicalSignals?.atr ?
              (result.data.technicalSignals.atr / currentPrice) : undefined,
            // Add bid/ask if available in result.data
            bid: result.data?.bid,
            ask: result.data?.ask,
          };

          const execResult = await this.executor.execute(
            result.decision,
            result.token,
            currentPrice,
            atr,
            marketData
          );

          if (execResult.success) {
            tradesExecuted++;
            console.log(this.executor.formatExecution(execResult));

            // Record position opened with risk gate
            if (execResult.position) {
              const side = execResult.position.side ?? 'long';
              const isReplacement = false; // TODO: detect if this replaces an existing position
              this.executor.recordPositionOpened(result.token, side, isReplacement);
            }
          } else if (execResult.error && !execResult.error.includes('does not trigger')) {
            errors.push(`${result.token}: ${execResult.error}`);
          }
        } catch (err) {
          errors.push(`Execution failed for ${result.token}: ${(err as Error).message}`);
        }
      }
    }

    // 5. Reload portfolio after trades
    const updatedState = await this.portfolio.load();

    // 6. Build cycle result
    const unrealizedPnl = updatedState.positions.reduce((sum, p) => sum + p.pnlUsd, 0);
    const initVal = updatedState.initialValue && updatedState.initialValue > 0 ? updatedState.initialValue : 10_000;
    const totalPnlUsd = updatedState.totalValue - initVal;
    const riskGateCounters = this.executor.getRiskGateCycleCounters();
    const cycleResult: CycleResult = {
      cycleNumber: this.cycleCount,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      tokensAnalyzed: results.length,
      signals,
      tradesExecuted,
      exitsProcessed,
      portfolioValue: updatedState.totalValue,
      dailyRealizedPnl: updatedState.dailyPnl,
      unrealizedPnl,
      dailyPnl: updatedState.dailyPnl,
      totalPnlUsd,
      totalPnlPct: totalPnlUsd / initVal,
      longsOpened: riskGateCounters.longsOpened,
      shortsOpened: riskGateCounters.shortsOpened,
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

/** Parse cycle interval string to milliseconds.
 *  Accepts: "15m", "4h", or bare number "1" (treated as minutes). */
function parseCycleInterval(cycle: string): number {
  // Try with explicit unit first
  const match = cycle.match(/^(\d+)(m|h)$/);
  if (match) {
    const value = parseInt(match[1]!, 10);
    if (match[2] === 'h') return value * 60 * 60 * 1000;
    return value * 60 * 1000; // minutes
  }
  // Bare number → treat as minutes (common in cron: --cycle 1 = 1 minute)
  const bare = parseInt(cycle, 10);
  if (!isNaN(bare) && bare > 0) return bare * 60 * 1000;
  return 4 * 60 * 60 * 1000; // default 4h
}
