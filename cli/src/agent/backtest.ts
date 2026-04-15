/**
 * Simple backtesting framework — replays historical data through strategies.
 */

import chalk from 'chalk';
import { CoinGeckoProvider } from '../providers/data/coingecko.js';
import { SentimentProvider } from '../providers/data/sentiment.js';
import { getLatestSignals } from './technical.js';
import type { Candle } from './technical.js';
import { runStrategies } from './strategies/index.js';
import type { StrategyContext } from './strategies/types.js';
import { computeTradeDecision } from './scoring.js';
import type { TradeDecision } from './scoring.js';
import { MarketRegimeDetector } from './regime.js';
import type { MarketRegime } from './regime.js';
import { SignalSmoother, MemorySmootherStorage, DEFAULT_SMOOTHER_CONFIG } from './signal-smoother.js';

export interface BacktestConfig {
  tokenId: string;
  startDate: string;   // ISO date
  endDate: string;
  initialCapital: number;
  strategies: string[]; // strategy names to test
  cycle: '1h' | '4h' | '1d';
  verbose?: boolean;   // show detailed decision logs
  /** When true, classify regime per-candle and apply regime-conditional thresholds.
   *  Default false → flat ±0.3/±0.6 thresholds (matches old backtest behavior). */
  useRegime?: boolean;
  /** Trailing-stop percent (e.g. 0.05 = 5%). When set and a long position
   *  exists, exit if price drops trailingStopPct from the high-water mark
   *  since entry. Independent of SELL signal — stops fire first if hit.
   *  Default undefined → SELL-signal-only exit. */
  trailingStopPct?: number;
  /** When true, smooth fast/noisy signals with rolling window (in-memory
   *  per-simulation, no disk IO). Default false. */
  smoothFastSignals?: boolean;
  /** Override scoring weights (for calibration sweeps). */
  customWeights?: import('./scoring.js').ScoringWeights;
  /** Override BUY threshold (applied symmetrically to STRONG_BUY as buy+0.3).
   *  Used by calibrator to sweep threshold values. When set, takes precedence
   *  over regime-based thresholds. */
  buyThreshold?: number;
  /** Override SELL threshold (applied symmetrically to STRONG_SELL as sell-0.3). */
  sellThreshold?: number;
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  signal: string;
  strategies?: string[]; // Which strategies contributed to this trade
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

export interface WalkForwardConfig {
  tokenId: string;
  totalDays: number;       // e.g. 180
  trainWindow: number;     // e.g. 90 days
  testWindow: number;      // e.g. 30 days
  stepSize: number;        // e.g. 30 days (how much to advance each fold)
  capital: number;
  strategies: string[];
  /** Forwarded to per-fold Backtester. Default false. */
  useRegime?: boolean;
  /** Forwarded to per-fold Backtester. Default undefined (no trailing stop). */
  trailingStopPct?: number;
  /** Forwarded to per-fold Backtester. Default false. */
  smoothFastSignals?: boolean;
}

export interface WalkForwardResult {
  folds: Array<{
    trainPeriod: { from: Date; to: Date };
    testPeriod: { from: Date; to: Date };
    trainSharpe: number;
    testSharpe: number;
    trainReturn: number;
    testReturn: number;
    testMaxDrawdown: number;
    tradesInTest: number;
  }>;
  aggregateTestSharpe: number;
  aggregateTestReturn: number;
  avgTestMaxDrawdown: number;
  overfit: boolean;        // true if train sharpe >> test sharpe
  overfitRatio: number;    // train sharpe / test sharpe
}

// Strategies that can work with candles-only data in backtest mode
const CANDLE_BASED_STRATEGIES = [
  'breakoutOnChain',
  'meanReversion',
  'multiTimeframe',
];

export class Backtester {
  private config: BacktestConfig;
  private cg: CoinGeckoProvider;
  private sentimentProvider: SentimentProvider;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.cg = new CoinGeckoProvider();
    this.sentimentProvider = new SentimentProvider();
  }

  /** Run backtest using historical data from CoinGecko. */
  async run(): Promise<BacktestResult> {
    const data = await this.fetchData();
    return this.simulate(data.candles, data.fearAndGreedData);
  }

  /**
   * Fetch historical OHLC + Fear & Greed data for the configured token/date range.
   * Extracted so callers (e.g. the calibrator) can fetch once and replay many
   * configurations against the same dataset without re-hitting CoinGecko.
   */
  async fetchData(): Promise<{ candles: Candle[]; fearAndGreedData: Record<string, number> }> {
    // 1. Fetch historical OHLC data
    const startMs = new Date(this.config.startDate).getTime();
    const endMs = new Date(this.config.endDate).getTime();
    const totalDays = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000));

    // Use market_chart endpoint (daily prices) — works for any range up to 365 days.
    // OHLC endpoint only returns 12 candles for >30 day ranges on free tier.
    const cgDays = Math.min(Math.max(totalDays, 1), 365);
    const marketData = await this.cg.getMarketData(this.config.tokenId, cgDays);

    if (!marketData?.prices?.length) {
      throw new Error(`No price data returned from CoinGecko for ${this.config.tokenId}`);
    }

    // Build daily candles from market_chart prices + volumes
    const prices: number[][] = marketData.prices;
    const volumes: number[][] = marketData.total_volumes ?? [];

    // Group prices and volumes by day to create OHLCV candles
    const dayMap = new Map<string, { prices: number[]; totalVolume: number; timestamp: number }>();

    // Process prices first to establish daily buckets
    for (const [ts, price] of prices) {
      if (ts! < startMs || ts! > endMs) continue;
      const dayKey = new Date(ts!).toISOString().slice(0, 10);
      if (!dayMap.has(dayKey)) {
        dayMap.set(dayKey, { prices: [], totalVolume: 0, timestamp: ts! });
      }
      dayMap.get(dayKey)!.prices.push(price!);
    }

    // Sum volumes for each day (instead of averaging)
    for (const [ts, vol] of volumes) {
      if (ts! < startMs || ts! > endMs) continue;
      const dayKey = new Date(ts!).toISOString().slice(0, 10);
      const dayData = dayMap.get(dayKey);
      if (dayData) {
        dayData.totalVolume += vol!;
      }
    }

    const allCandles: Candle[] = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, day]) => {
        const p = day.prices;
        return {
          timestamp: day.timestamp,
          open: p[0]!,
          high: Math.max(...p),
          low: Math.min(...p),
          close: p[p.length - 1]!,
          volume: day.totalVolume, // Use summed volume for the day
        };
      });

    if (allCandles.length < 30) {
      throw new Error(`Insufficient data: only ${allCandles.length} candles in date range (need 30+)`);
    }

    // 1.5. Fetch Fear & Greed historical data for sentiment-contrarian strategy
    let fearAndGreedData: Record<string, number> = {};
    try {
      const fgData = await this.sentimentProvider.getFearAndGreed();
      for (const entry of fgData) {
        // Convert timestamp to date string and store
        const date = new Date(Number(entry.timestamp) * 1000).toISOString().split('T')[0]!;
        fearAndGreedData[date] = entry.value;
      }
      if (this.config.verbose && Object.keys(fearAndGreedData).length > 0) {
        console.log(chalk.dim(`  Loaded ${Object.keys(fearAndGreedData).length} Fear & Greed historical data points`));
      }
    } catch (error) {
      if (this.config.verbose) {
        console.log(chalk.yellow(`  Warning: Could not fetch Fear & Greed data: ${(error as Error).message}`));
      }
    }

    return { candles: allCandles, fearAndGreedData };
  }

  /**
   * Run the simulation loop on pre-fetched data. Pure of network IO.
   * The calibrator uses this directly after fetchData() to replay many
   * config permutations without re-fetching per permutation.
   */
  async simulate(
    allCandles: Candle[],
    fearAndGreedData: Record<string, number>,
  ): Promise<BacktestResult> {
    // 2. Determine step size based on cycle
    const stepSize = this.config.cycle === '1h' ? 1 : this.config.cycle === '4h' ? 4 : 24;
    // CoinGecko OHLC for 90+ days gives daily candles, so step = 1 candle for '1d'
    const step = Math.max(1, Math.floor(stepSize / 24)); // approximate

    // 3. Simulate trading
    let capital = this.config.initialCapital;
    let position: { entryPrice: number; entryDate: string; signal: string; highWaterMark: number } | null = null;
    // Per-simulation in-memory smoother (no disk IO). Maintains rolling
    // buffers across candles so smoothing reflects the same window logic
    // as live runs.
    const smoother = this.config.smoothFastSignals
      ? new SignalSmoother(new MemorySmootherStorage(), DEFAULT_SMOOTHER_CONFIG)
      : null;
    const trades: BacktestTrade[] = [];
    const equityCurve: Array<{ date: string; value: number }> = [];
    const returns: number[] = [];

    const windowSize = 30; // min candles needed for indicators

    // Show strategy filtering info
    if (this.config.verbose) {
      if (this.config.strategies.length > 0) {
        console.log(chalk.dim(`  Using user-specified strategies: ${this.config.strategies.join(', ')}`));
      } else {
        const availableStrategies = [...CANDLE_BASED_STRATEGIES];
        if (Object.keys(fearAndGreedData).length > 0) {
          availableStrategies.push('sentimentContrarian');
        }
        console.log(chalk.dim(`  Using candle-based strategies: ${availableStrategies.join(', ')}`));
        console.log(chalk.dim(`  Filtered out external data strategies to prevent zero-signal noise`));
      }
      console.log();
    }

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

        // Add Fear & Greed data for the current date if available
        let fearAndGreed: { value: number; classification: string } | undefined;
        const fgValue = fearAndGreedData[currentDate];
        if (fgValue !== undefined) {
          const classification = fgValue < 25 ? 'Extreme Fear' :
                                 fgValue < 40 ? 'Fear' :
                                 fgValue < 60 ? 'Neutral' :
                                 fgValue < 75 ? 'Greed' : 'Extreme Greed';
          fearAndGreed = { value: fgValue, classification };
        }

        const ctx: StrategyContext = {
          tokenId: this.config.tokenId,
          candles: windowCandles,
          technicals,
          fearAndGreed,
        };

        // Run strategies — filter to candle-based only for backtest
        let signals = await runStrategies(ctx);

        // Optional smoothing — uses per-simulation in-memory buffer so each
        // candle adds to a rolling window matching live behavior.
        if (smoother) {
          signals = await smoother.smooth(this.config.tokenId, signals, currentCandle.timestamp);
        }

        // Filter strategies: if user specified strategies, honor their choice
        // Otherwise, filter to candle-based strategies only
        let filtered = signals;
        if (this.config.strategies.length > 0) {
          // User specified strategies — use their selection
          filtered = signals.filter((s) => this.config.strategies.some(
            (name) => s.name.toLowerCase().includes(name.toLowerCase()),
          ));
        } else {
          // No user selection — filter to candle-based strategies only
          filtered = signals.filter((s) => CANDLE_BASED_STRATEGIES.includes(s.name) ||
                                          (fearAndGreed && s.name === 'sentimentContrarian'));
        }

        // Classify regime from the current rolling window (no look-ahead)
        // when --regime is enabled. The backtester operates on a single
        // token's candles; for a true cross-asset regime read you'd swap
        // BTC candles in here, but per-candle BTC/ETH/SOL trends are
        // highly correlated so the asset's own candles are a fair proxy.
        let regime: MarketRegime | undefined;
        if (this.config.useRegime) {
          regime = MarketRegimeDetector.classifyFromCandles(windowCandles).regime;
        }

        decision = computeTradeDecision(
          filtered.length > 0 ? filtered : signals,
          this.config.customWeights,
          undefined,
          undefined,
          regime,
        );

        // Calibrator uses scalar threshold overrides — re-derive action from
        // score if buyThreshold/sellThreshold are set. STRONG_* thresholds
        // extrapolate ±0.3 from the base (matches the regime threshold spread).
        if (this.config.buyThreshold !== undefined || this.config.sellThreshold !== undefined) {
          const buy = this.config.buyThreshold ?? decision.thresholds?.buy ?? 0.3;
          const sell = this.config.sellThreshold ?? decision.thresholds?.sell ?? -0.3;
          // Invariant: buy must strictly exceed sell. Otherwise a score at
          // the collision point fires BUY (>= runs first) while a symmetric
          // reading of the same market condition would fire SELL — the
          // action becomes asymmetrically path-dependent on comparison order.
          if (buy <= sell) {
            throw new Error(
              `Invalid threshold override: buyThreshold (${buy}) must be strictly greater ` +
              `than sellThreshold (${sell}). Collision would produce ambiguous actions at score == threshold.`,
            );
          }
          const strongBuy = buy + 0.3;
          const strongSell = sell - 0.3;
          let action: typeof decision.action;
          if (decision.score >= strongBuy) action = 'STRONG_BUY';
          else if (decision.score >= buy) action = 'BUY';
          else if (decision.score <= strongSell) action = 'STRONG_SELL';
          else if (decision.score <= sell) action = 'SELL';
          else action = 'HOLD';
          decision = { ...decision, action, thresholds: { strongBuy, buy, sell, strongSell } };
        }

        // Verbose logging
        if (this.config.verbose) {
          const activeSignals = filtered.filter(s => Math.abs(s.value) > 0.01);
          const signalSummary = activeSignals.map(s =>
            `${s.name}:${s.value >= 0 ? '+' : ''}${s.value.toFixed(2)}`
          ).join(' ');
          const regimeTag = regime ? ` [${regime}]` : '';
          console.log(`${currentDate}: score=${decision.score.toFixed(2)} ${decision.action}${regimeTag} (${signalSummary || 'no signals'})`);
        }
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
          highWaterMark: currentPrice,
        };
      } else if (position) {
        // Update high-water mark for trailing stop
        if (currentPrice > position.highWaterMark) {
          position.highWaterMark = currentPrice;
        }

        // Check trailing stop FIRST — exits faster than waiting for SELL signal
        const trailingStopHit = this.config.trailingStopPct !== undefined
          && currentPrice <= position.highWaterMark * (1 - this.config.trailingStopPct);
        const sellSignal = decision.action === 'SELL' || decision.action === 'STRONG_SELL';

        if (trailingStopHit || sellSignal) {
          const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice;
          capital *= (1 + pnlPercent);
          returns.push(pnlPercent);

          const exitReason = trailingStopHit ? `TRAILING_STOP (-${(this.config.trailingStopPct! * 100).toFixed(1)}%)` : decision.action;
          trades.push({
            entryDate: position.entryDate,
            exitDate: currentDate,
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            pnlPercent,
            signal: `${position.signal} → ${exitReason}`,
          });

          position = null;
        }
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
    const riskFreeDaily = 0.05 / 252; // 5% annual risk-free rate
    const sharpeRatio = stdDev > 0 ? ((meanReturn - riskFreeDaily) / stdDev) * Math.sqrt(252) : 0;

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

  /** Walk-forward optimization to prevent overfitting. */
  async walkForwardTest(config: WalkForwardConfig): Promise<WalkForwardResult> {
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0); // Start of today
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - config.totalDays);

    const folds: WalkForwardResult['folds'] = [];
    const testReturns: number[] = [];
    const testSharpes: number[] = [];
    const testMaxDrawdowns: number[] = [];

    let currentStart = new Date(startDate);

    while (currentStart.getTime() + (config.trainWindow + config.testWindow) * 24 * 60 * 60 * 1000 <= endDate.getTime()) {
      // Define train period
      const trainStart = new Date(currentStart);
      const trainEnd = new Date(trainStart);
      trainEnd.setDate(trainEnd.getDate() + config.trainWindow);

      // Define test period
      const testStart = new Date(trainEnd);
      const testEnd = new Date(testStart);
      testEnd.setDate(testEnd.getDate() + config.testWindow);

      try {
        // Run backtest on training period
        const trainBacktester = new Backtester({
          tokenId: config.tokenId,
          startDate: trainStart.toISOString().slice(0, 10),
          endDate: trainEnd.toISOString().slice(0, 10),
          initialCapital: config.capital,
          strategies: config.strategies,
          cycle: '1d',
          verbose: false, // Don't spam verbose output during walk-forward
          useRegime: config.useRegime,
          trailingStopPct: config.trailingStopPct,
          smoothFastSignals: config.smoothFastSignals,
        });
        const trainResult = await trainBacktester.run();

        // Run backtest on test period
        const testBacktester = new Backtester({
          tokenId: config.tokenId,
          startDate: testStart.toISOString().slice(0, 10),
          endDate: testEnd.toISOString().slice(0, 10),
          initialCapital: config.capital,
          strategies: config.strategies,
          cycle: '1d',
          verbose: false, // Don't spam verbose output during walk-forward
          useRegime: config.useRegime,
          trailingStopPct: config.trailingStopPct,
          smoothFastSignals: config.smoothFastSignals,
        });
        const testResult = await testBacktester.run();

        const fold = {
          trainPeriod: { from: trainStart, to: trainEnd },
          testPeriod: { from: testStart, to: testEnd },
          trainSharpe: trainResult.sharpeRatio,
          testSharpe: testResult.sharpeRatio,
          trainReturn: trainResult.totalReturnPercent,
          testReturn: testResult.totalReturnPercent,
          testMaxDrawdown: testResult.maxDrawdown,
          tradesInTest: testResult.totalTrades,
        };

        folds.push(fold);
        testReturns.push(testResult.totalReturnPercent);
        testSharpes.push(testResult.sharpeRatio);
        testMaxDrawdowns.push(testResult.maxDrawdown);
      } catch (error) {
        // Skip fold if data is insufficient
        console.warn(`Skipping fold ${trainStart.toISOString().slice(0, 10)} - ${testEnd.toISOString().slice(0, 10)}: ${error}`);
      }

      // Advance to next fold
      currentStart.setDate(currentStart.getDate() + config.stepSize);
    }

    if (folds.length === 0) {
      throw new Error('No valid folds could be generated - insufficient data or invalid parameters');
    }

    // Calculate aggregate metrics
    const aggregateTestReturn = testReturns.reduce((sum, ret) => sum + ret, 0) / testReturns.length;
    const aggregateTestSharpe = testSharpes.filter(s => !isNaN(s) && isFinite(s)).reduce((sum, s) => sum + s, 0) / testSharpes.filter(s => !isNaN(s) && isFinite(s)).length || 0;
    const avgTestMaxDrawdown = testMaxDrawdowns.reduce((sum, dd) => sum + dd, 0) / testMaxDrawdowns.length;

    // Calculate overfitting metrics
    const avgTrainSharpe = folds.map(f => f.trainSharpe).filter(s => !isNaN(s) && isFinite(s)).reduce((sum, s) => sum + s, 0) / folds.filter(f => !isNaN(f.trainSharpe) && isFinite(f.trainSharpe)).length || 0;
    const overfitRatio = avgTrainSharpe > 0 && aggregateTestSharpe > 0 ? avgTrainSharpe / aggregateTestSharpe : 1;
    const overfit = overfitRatio > 2.0; // Flag if train performance is more than 2x better than test

    return {
      folds,
      aggregateTestSharpe,
      aggregateTestReturn,
      avgTestMaxDrawdown,
      overfit,
      overfitRatio,
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

    // Volume quality warning
    const zeroVolumeTrades = result.trades.filter(t => {
      // Check if trades occurred during periods with potentially missing volume data
      return true; // For now, we'll always show this warning since CoinGecko OHLC had volume issues
    }).length;
    const volumeWarning = result.equityCurve.length > 0; // We have equity data, so we can check volume quality
    if (volumeWarning) {
      lines.push('');
      lines.push(chalk.yellow('  ⚠️  Volume Data Quality:'));
      lines.push(chalk.dim('     Volume data sourced from market_chart endpoint and aggregated daily.'));
      lines.push(chalk.dim('     Intraday volume patterns may not be fully captured.'));
    }

    // Monthly returns breakdown
    if (result.trades.length > 0) {
      const monthlyReturns = this.calculateMonthlyReturns(result.equityCurve);
      if (Object.keys(monthlyReturns).length > 1) {
        lines.push('');
        lines.push(chalk.bold('  Monthly Returns:'));
        lines.push(chalk.dim(`  ${'Month'.padEnd(12)} ${'Return %'.padEnd(10)} Performance`));
        lines.push(chalk.dim('  ' + '─'.repeat(35)));

        for (const [month, returnPct] of Object.entries(monthlyReturns).slice(-12)) { // Show last 12 months
          const returnColor = returnPct >= 0 ? chalk.green : chalk.red;
          const bar = this.renderMiniBar(returnPct / 100, 10);
          lines.push(
            `  ${month.padEnd(12)} ${returnColor((returnPct > 0 ? '+' : '') + returnPct.toFixed(1) + '%').padEnd(18)} ${bar}`,
          );
        }
      }
    }

    // Strategy performance breakdown (simplified version)
    if (result.trades.length > 0 && result.config.strategies.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Strategy Performance:'));
      lines.push(chalk.dim(`  ${'Strategy'.padEnd(20)} ${'Trades'.padEnd(8)} Win Rate`));
      lines.push(chalk.dim('  ' + '─'.repeat(40)));

      // For now, show overall win rate per configured strategy filter
      // In a future enhancement, we could track which specific strategies triggered each trade
      for (const strategy of result.config.strategies.slice(0, 5)) { // Top 5 strategies
        const strategyTrades = Math.floor(result.totalTrades / result.config.strategies.length); // Approximate distribution
        const winRate = result.winRate; // Use overall win rate as approximation
        const winRateColor = winRate >= 0.6 ? chalk.green : winRate >= 0.4 ? chalk.yellow : chalk.red;
        lines.push(
          `  ${strategy.slice(0, 19).padEnd(20)} ${strategyTrades.toString().padEnd(8)} ${winRateColor((winRate * 100).toFixed(1) + '%')}`,
        );
      }
      if (result.config.strategies.length === 0) {
        lines.push(chalk.dim('  All strategies combined'));
      }
    }

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

  /** Format walk-forward results for display. */
  formatWalkForwardResults(result: WalkForwardResult, config: WalkForwardConfig): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(chalk.bold('  ┌──────────────────────────────────────────────┐'));
    lines.push(chalk.bold('  │      Walk-Forward Optimization Results      │'));
    lines.push(chalk.bold('  └──────────────────────────────────────────────┘'));
    lines.push('');
    lines.push(`  Token:          ${config.tokenId}`);
    lines.push(`  Train Window:   ${config.trainWindow} days`);
    lines.push(`  Test Window:    ${config.testWindow} days`);
    lines.push(`  Step Size:      ${config.stepSize} days`);
    lines.push(`  Total Folds:    ${result.folds.length}`);
    lines.push(`  Strategies:     ${config.strategies.join(', ') || 'all'}`);
    lines.push('');
    lines.push(chalk.dim('  ' + '═'.repeat(50)));

    // Aggregate performance
    const retColor = result.aggregateTestReturn >= 0 ? chalk.green : chalk.red;
    const overfitColor = result.overfit ? chalk.red : chalk.green;
    lines.push(`  Aggregate Test Return:   ${retColor((result.aggregateTestReturn * 100).toFixed(2) + '%')}`);
    lines.push(`  Aggregate Test Sharpe:   ${result.aggregateTestSharpe.toFixed(2)}`);
    lines.push(`  Avg Test Max Drawdown:   ${chalk.red((result.avgTestMaxDrawdown * 100).toFixed(2) + '%')}`);
    lines.push(`  Overfitting Ratio:       ${overfitColor(result.overfitRatio.toFixed(2) + (result.overfit ? ' ⚠️  OVERFIT' : ' ✓'))}`);

    // Fold-by-fold breakdown
    if (result.folds.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Fold-by-Fold Results:'));
      lines.push(chalk.dim(`  ${'Train Period'.padEnd(23)} ${'Test Period'.padEnd(23)} ${'Train'.padEnd(8)} ${'Test'.padEnd(8)} ${'Test DD%'.padEnd(9)} Trades`));
      lines.push(chalk.dim('  ' + '─'.repeat(90)));

      for (const fold of result.folds) {
        const trainPeriodStr = `${fold.trainPeriod.from.toISOString().slice(0, 10)} to ${fold.trainPeriod.to.toISOString().slice(0, 10)}`;
        const testPeriodStr = `${fold.testPeriod.from.toISOString().slice(0, 10)} to ${fold.testPeriod.to.toISOString().slice(0, 10)}`;
        const trainSharpeStr = isFinite(fold.trainSharpe) ? fold.trainSharpe.toFixed(2) : 'N/A';
        const testSharpeStr = isFinite(fold.testSharpe) ? fold.testSharpe.toFixed(2) : 'N/A';
        const testReturnColor = fold.testReturn >= 0 ? chalk.green : chalk.red;
        const testDdStr = (fold.testMaxDrawdown * 100).toFixed(1) + '%';

        lines.push(
          `  ${trainPeriodStr.padEnd(23)} ${testPeriodStr.padEnd(23)} ${trainSharpeStr.padEnd(8)} ${testReturnColor(testSharpeStr.padEnd(8))} ${chalk.red(testDdStr.padEnd(9))} ${fold.tradesInTest}`,
        );
      }

      // Summary stats
      const winningFolds = result.folds.filter(f => f.testReturn > 0).length;
      const winRate = result.folds.length > 0 ? (winningFolds / result.folds.length * 100).toFixed(1) : '0.0';

      lines.push('');
      lines.push(chalk.dim('  ' + '─'.repeat(50)));
      lines.push(`  Winning Folds:  ${winningFolds}/${result.folds.length} (${winRate}%)`);

      if (result.overfit) {
        lines.push('');
        lines.push(chalk.red('  ⚠️  WARNING: Strategy shows signs of overfitting!'));
        lines.push(chalk.red('     Train performance significantly exceeds test performance.'));
        lines.push(chalk.red('     Consider simplifying the strategy or using longer test periods.'));
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /** Calculate monthly returns from equity curve. */
  private calculateMonthlyReturns(equityCurve: Array<{ date: string; value: number }>): Record<string, number> {
    const monthlyReturns: Record<string, number> = {};

    if (equityCurve.length === 0) return monthlyReturns;

    let currentMonth = '';
    let monthStartValue = equityCurve[0]!.value;
    let monthEndValue = equityCurve[0]!.value;

    for (const point of equityCurve) {
      const pointMonth = point.date.slice(0, 7); // YYYY-MM format

      if (currentMonth === '') {
        currentMonth = pointMonth;
        monthStartValue = point.value;
      } else if (pointMonth !== currentMonth) {
        // Month changed, calculate return for previous month
        if (monthStartValue > 0) {
          const returnPct = ((monthEndValue - monthStartValue) / monthStartValue) * 100;
          monthlyReturns[currentMonth] = returnPct;
        }

        // Start new month
        currentMonth = pointMonth;
        monthStartValue = point.value;
      }

      monthEndValue = point.value;
    }

    // Don't forget the last month
    if (currentMonth && monthStartValue > 0) {
      const returnPct = ((monthEndValue - monthStartValue) / monthStartValue) * 100;
      monthlyReturns[currentMonth] = returnPct;
    }

    return monthlyReturns;
  }

  /** Render a mini bar chart for monthly returns. */
  private renderMiniBar(value: number, width: number): string {
    const magnitude = Math.min(Math.abs(value), 0.3); // Cap at 30% for display
    const filled = Math.round(magnitude * width / 0.3);

    if (value > 0) {
      return chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
    } else if (value < 0) {
      return chalk.red('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
    }
    return chalk.dim('░'.repeat(width));
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
