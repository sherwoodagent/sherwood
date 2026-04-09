/**
 * CLI commands for the autonomous trading agent.
 * sherwood agent <analyze|signals|start|status|history|config>
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import ora from "ora";
import { TradingAgent } from "../agent/index.js";
import type { AgentConfig, TokenAnalysis } from "../agent/index.js";
import { getLatestSignals } from "../agent/technical.js";
import type { Candle } from "../agent/technical.js";
import { CoinGeckoProvider } from "../providers/data/coingecko.js";
import { SentimentProvider } from "../providers/data/sentiment.js";
import {
  scoreTechnical,
  scoreSentiment,
  scoreOnChain,
  scoreFundamental,
  scoreEvent,
} from "../agent/scoring.js";
import { AgentLoop } from "../agent/loop.js";
import type { LoopConfig } from "../agent/loop.js";
import { PortfolioTracker } from "../agent/portfolio.js";
import { RiskManager, DEFAULT_RISK_CONFIG } from "../agent/risk.js";
import type { RiskConfig } from "../agent/risk.js";
import { Reporter } from "../agent/reporter.js";
import { Backtester } from "../agent/backtest.js";
import type { BacktestConfig } from "../agent/backtest.js";

const DEFAULT_TOKENS = ["ethereum", "bitcoin", "solana", "aave", "uniswap"];

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    tokens: DEFAULT_TOKENS,
    cycle: "4h",
    dryRun: true,
    maxPositionPct: 5,
    maxRiskPct: 20,
    ...overrides,
  };
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Autonomous trading agent");

  // ── analyze ──
  agent
    .command("analyze")
    .description("Analyze token(s) using multi-signal scoring")
    .argument("[tokens...]", "Token IDs to analyze (e.g., ethereum bitcoin)")
    .option("--all", "Analyze full watchlist")
    .option("--json", "Output as JSON")
    .action(async (tokens: string[], options: { all?: boolean; json?: boolean }) => {
      const tokenList = options.all ? DEFAULT_TOKENS : tokens.length > 0 ? tokens : DEFAULT_TOKENS;
      const config = makeConfig({ tokens: tokenList });
      const tradingAgent = new TradingAgent(config);
      const spinner = ora("Analyzing tokens...").start();

      try {
        const results: TokenAnalysis[] = [];
        for (const token of tokenList) {
          spinner.text = `Analyzing ${token}...`;
          const result = await tradingAgent.analyzeToken(token);
          results.push(result);
        }
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(results.map((r) => ({ token: r.token, decision: r.decision })), null, 2));
        } else {
          console.log(tradingAgent.formatAnalysis(results));

          // Detailed signal breakdown
          for (const r of results) {
            console.log(chalk.bold(`\n  ${r.token.toUpperCase()} — Signal Breakdown`));
            console.log(chalk.dim("  " + "─".repeat(50)));
            for (const signal of r.decision.signals) {
              const bar = renderBar(signal.value);
              const color =
                signal.value > 0.1
                  ? chalk.green
                  : signal.value < -0.1
                    ? chalk.red
                    : chalk.yellow;
              console.log(
                `  ${signal.source.padEnd(22)} ${bar} ${color(
                  (signal.value >= 0 ? "+" : "") + signal.value.toFixed(3),
                )}  ${chalk.dim(signal.details.slice(0, 60))}`,
              );
            }
          }
          console.log();
        }
      } catch (err) {
        spinner.fail(`Analysis failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ── signals ──
  agent
    .command("signals")
    .description("Show current signal scores for a token")
    .argument("<token>", "Token ID")
    .action(async (token: string) => {
      const spinner = ora(`Fetching signals for ${token}...`).start();

      try {
        const cg = new CoinGeckoProvider();
        const sentimentProvider = new SentimentProvider();

        // Fetch OHLC
        spinner.text = "Fetching OHLC data...";
        const ohlcRaw = await cg.getOHLC(token, 30);
        const candles: Candle[] = ohlcRaw.map((c: number[]) => ({
          timestamp: c[0]!,
          open: c[1]!,
          high: c[2]!,
          low: c[3]!,
          close: c[4] ?? c[3]!,
          volume: 0,
        }));

        // Get volume data
        try {
          spinner.text = "Fetching volume data...";
          const marketData = await cg.getMarketData(token, 30);
          if (marketData?.total_volumes) {
            for (const candle of candles) {
              const nearest = marketData.total_volumes.reduce(
                (best: number[], v: number[]) =>
                  Math.abs(v[0]! - candle.timestamp) < Math.abs(best[0]! - candle.timestamp)
                    ? v
                    : best,
                marketData.total_volumes[0]!,
              );
              candle.volume = nearest[1] ?? 0;
            }
          }
        } catch {
          // optional
        }

        const techSignals = getLatestSignals(candles);

        // Fetch sentiment
        spinner.text = "Fetching sentiment...";
        let fgValue = 50;
        let zScore = 0;
        try {
          const fgData = await sentimentProvider.getFearAndGreed();
          if (fgData.length > 0) {
            fgValue = fgData[0]!.value;
            zScore = sentimentProvider.computeSentimentZScore(fgData.map((d) => d.value));
          }
        } catch {
          // default values
        }

        spinner.stop();

        // Display
        console.log();
        console.log(chalk.bold(`  ${token.toUpperCase()} — Detailed Signals`));
        console.log(chalk.dim("  " + "═".repeat(55)));

        // Technical
        console.log(chalk.bold.cyan("\n  Technical Indicators"));
        console.log(`    RSI(14):       ${formatValue(techSignals.rsi, 30, 70, true)}`);
        console.log(`    MACD:          ${techSignals.macd.value.toFixed(4)}`);
        console.log(`    MACD Signal:   ${techSignals.macd.signal.toFixed(4)}`);
        console.log(`    MACD Hist:     ${formatValue(techSignals.macd.histogram, 0, 0, false)}`);
        console.log(`    BB Upper:      ${techSignals.bb.upper.toFixed(2)}`);
        console.log(`    BB Middle:     ${techSignals.bb.middle.toFixed(2)}`);
        console.log(`    BB Lower:      ${techSignals.bb.lower.toFixed(2)}`);
        console.log(`    BB Width:      ${techSignals.bb.width.toFixed(4)}`);
        console.log(`    BB Squeeze:    ${techSignals.bb.squeeze ? chalk.yellow("YES") : "No"}`);
        console.log(`    EMA(8):        ${techSignals.ema.ema8.toFixed(2)}`);
        console.log(`    EMA(21):       ${techSignals.ema.ema21.toFixed(2)}`);
        console.log(`    EMA(50):       ${isNaN(techSignals.ema.ema50) ? chalk.dim("N/A") : techSignals.ema.ema50.toFixed(2)}`);
        console.log(`    EMA(200):      ${isNaN(techSignals.ema.ema200) ? chalk.dim("N/A") : techSignals.ema.ema200.toFixed(2)}`);
        console.log(`    ATR(14):       ${techSignals.atr.toFixed(2)}`);
        console.log(`    VWAP:          ${techSignals.vwap.toFixed(2)}`);
        console.log(`    Vol Ratio:     ${techSignals.volume.ratio.toFixed(2)}x avg`);

        // Sentiment
        console.log(chalk.bold.cyan("\n  Sentiment"));
        console.log(`    Fear & Greed:  ${formatFearGreed(fgValue)}`);
        console.log(`    Z-Score:       ${zScore.toFixed(2)}`);

        // Signal scores
        const techScore = scoreTechnical(techSignals);
        const sentScore = scoreSentiment(fgValue, zScore);
        const onchainScore = scoreOnChain({});
        const fundScore = scoreFundamental({});
        const eventScore = scoreEvent({});

        console.log(chalk.bold.cyan("\n  Signal Scores"));
        console.log(`    Technical:     ${renderBar(techScore.value)} ${colorValue(techScore.value)}`);
        console.log(`    Sentiment:     ${renderBar(sentScore.value)} ${colorValue(sentScore.value)}`);
        console.log(`    On-Chain:      ${renderBar(onchainScore.value)} ${colorValue(onchainScore.value)}`);
        console.log(`    Fundamental:   ${renderBar(fundScore.value)} ${colorValue(fundScore.value)}`);
        console.log(`    Event:         ${renderBar(eventScore.value)} ${colorValue(eventScore.value)}`);
        console.log();
      } catch (err) {
        spinner.fail(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ── start ──
  agent
    .command("start")
    .description("Start autonomous trading loop")
    .option("--cycle <interval>", "Cycle interval (15m, 1h, 4h)", "4h")
    .option("--dry-run", "Paper trading mode", true)
    .option("--tokens <tokens>", "Comma-separated token list")
    .option("--log <path>", "Path to write cycle logs")
    .option("--mode <mode>", "Execution mode: dry-run (default), hyperliquid-perp", "dry-run")
    .option("--strategy-clone <address>", "Strategy clone address on HyperEVM (required for hyperliquid-perp)")
    .option("--chain <chain>", "Chain for live execution (hyperevm, hyperevm-testnet)", "ethereum")
    .action(async (options: { cycle?: string; dryRun?: boolean; tokens?: string; log?: string; mode?: string; strategyClone?: string; chain?: string }) => {
      const tokenList = options.tokens ? options.tokens.split(",").map((t) => t.trim()) : DEFAULT_TOKENS;
      const cycle = (options.cycle ?? "4h") as AgentConfig["cycle"];

      // Load persisted risk config from disk (written by `agent config --set`)
      let savedRiskConfig: Partial<RiskConfig> = {};
      try {
        const configPath = join(homedir(), '.sherwood', 'agent', 'config.json');
        const data = await readFile(configPath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, unknown>;
        // Only pick known risk keys with valid numeric values
        for (const [k, v] of Object.entries(parsed)) {
          if (k in DEFAULT_RISK_CONFIG && typeof v === 'number' && Number.isFinite(v)) {
            (savedRiskConfig as Record<string, number>)[k] = v;
          }
        }
        if (Object.keys(savedRiskConfig).length > 0) {
          console.log(chalk.dim(`  Loaded ${Object.keys(savedRiskConfig).length} risk config overrides from ~/.sherwood/agent/config.json`));
        }
      } catch {
        // No saved config — use defaults
      }

      const isLive = options.mode === 'hyperliquid-perp';
      if (isLive && !options.strategyClone) {
        console.error(chalk.red('  --strategy-clone is required for hyperliquid-perp mode'));
        process.exitCode = 1;
        return;
      }
      const proposerKey = process.env.SHERWOOD_PROPOSER_KEY as `0x${string}` | undefined;
      if (isLive && !proposerKey) {
        console.error(chalk.red('  SHERWOOD_PROPOSER_KEY env var is required for live execution'));
        process.exitCode = 1;
        return;
      }

      const loopConfig: LoopConfig = {
        agent: makeConfig({ tokens: tokenList, cycle, dryRun: !isLive }),
        execution: {
          dryRun: !isLive,
          mode: (options.mode ?? 'dry-run') as 'dry-run' | 'hyperliquid-perp',
          mevProtection: false,
          chain: options.chain ?? 'ethereum',
          strategyClone: options.strategyClone as `0x${string}` | undefined,
          proposerPrivateKey: proposerKey,
        },
        riskConfig: savedRiskConfig,
        logPath: options.log,
      };

      const loop = new AgentLoop(loopConfig);

      // Graceful shutdown
      const shutdown = () => {
        console.log(chalk.yellow("\n  Shutting down gracefully..."));
        loop.stop();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await loop.start();
    });

  // ── status ──
  agent
    .command("status")
    .description("Show current portfolio, open positions, daily PnL")
    .action(async () => {
      const portfolio = new PortfolioTracker();
      const reporter = new Reporter();

      try {
        const state = await portfolio.load();

        // Try to update prices for open positions
        if (state.positions.length > 0) {
          try {
            const cg = new CoinGeckoProvider();
            const tokenIds = state.positions.map(p => p.tokenId);
            const priceData = await cg.getPrice(tokenIds, ['usd']);
            const prices: Record<string, number> = {};
            for (const id of tokenIds) {
              const price = priceData?.[id]?.usd;
              if (typeof price === 'number') prices[id] = price;
            }
            if (Object.keys(prices).length > 0) {
              const updated = await portfolio.updatePrices(prices);
              console.log(reporter.formatPortfolioReport(updated));
              return;
            }
          } catch {
            // Fall through to show cached state
          }
        }

        console.log(reporter.formatPortfolioReport(state));
      } catch (err) {
        console.error(chalk.red(`Failed to load portfolio: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // ── history ──
  agent
    .command("history")
    .description("Show trade history and performance metrics")
    .option("--days <n>", "Number of days to look back", "30")
    .action(async (options: { days?: string }) => {
      const portfolio = new PortfolioTracker();
      const reporter = new Reporter();
      const days = Math.max(1, parseInt(options.days ?? "30", 10) || 30);

      try {
        const trades = await portfolio.getHistory(days);
        const metrics = await portfolio.getMetrics(days);

        console.log('');
        console.log(chalk.bold(`  Trade History (last ${days} days)`));
        console.log(chalk.dim('  ' + '═'.repeat(70)));

        if (trades.length === 0) {
          console.log(chalk.dim('  No trades recorded in this period.'));
          console.log('');
          return;
        }

        // Table header
        console.log(chalk.dim(`  ${'Symbol'.padEnd(10)} ${'Side'.padEnd(6)} ${'Entry'.padEnd(12)} ${'Exit'.padEnd(12)} ${'PnL $'.padEnd(12)} ${'PnL %'.padEnd(10)} Exit Reason`));
        console.log(chalk.dim('  ' + '─'.repeat(70)));

        for (const t of trades) {
          const pnlColor = t.pnlUsd >= 0 ? chalk.green : chalk.red;
          console.log(
            `  ${t.symbol.padEnd(10)} ${t.side.padEnd(6)} $${t.entryPrice.toFixed(2).padEnd(11)} $${t.exitPrice.toFixed(2).padEnd(11)} ${pnlColor(('$' + t.pnlUsd.toFixed(2)).padEnd(12))} ${pnlColor(((t.pnlPercent * 100).toFixed(1) + '%').padEnd(10))} ${t.exitReason.slice(0, 20)}`,
          );
        }

        // Performance metrics
        console.log(reporter.formatMetrics(metrics));
      } catch (err) {
        console.error(chalk.red(`Failed to load history: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // ── config ──
  agent
    .command("config")
    .description("Show or set risk parameters")
    .option("--set <key=value>", "Set a config value (e.g. --set maxSinglePosition=0.15)")
    .action(async (options: { set?: string }) => {
      const riskConfig = { ...DEFAULT_RISK_CONFIG };

      // Bounds for risk config values to prevent disabling guardrails
      const RISK_BOUNDS: Record<string, [number, number]> = {
        maxPortfolioRisk: [0.01, 0.50],
        maxSinglePosition: [0.01, 0.25],
        maxCorrelatedExposure: [0.05, 0.50],
        maxConcurrentTrades: [1, 20],
        hardStopPercent: [0.01, 0.30],
        trailingStopAtr: [0.5, 5.0],
        dailyLossLimit: [0.01, 0.30],
        weeklyLossLimit: [0.01, 0.50],
        monthlyLossLimit: [0.01, 0.60],
        riskPerTrade: [0.005, 0.05],
      };

      if (options.set) {
        const [key, value] = options.set.split('=');
        if (key && value && key in riskConfig) {
          if (key === 'maxSlippage') {
            console.log(chalk.red(`  maxSlippage must be set per tier (not supported via --set)`));
            console.log('');
            return;
          }
          const numVal = parseFloat(value);
          if (!isNaN(numVal)) {
            // Integer-type fields must not be fractional
            const INTEGER_KEYS = new Set(['maxConcurrentTrades']);
            if (INTEGER_KEYS.has(key) && !Number.isInteger(numVal)) {
              console.log(chalk.red(`  ${key} must be a whole number (got ${numVal})`));
              console.log('');
              return;
            }
            const bounds = RISK_BOUNDS[key];
            if (bounds && (numVal < bounds[0] || numVal > bounds[1])) {
              console.log(chalk.red(`  Value ${numVal} out of bounds for ${key}: [${bounds[0]}, ${bounds[1]}]`));
              console.log('');
              return;
            }
            (riskConfig as Record<string, unknown>)[key] = numVal;
            console.log(chalk.green(`  Set ${key} = ${numVal}`));

            // Persist to disk
            const configDir = join(homedir(), '.sherwood', 'agent');
            const configPath = join(configDir, 'config.json');
            let existingConfig: Record<string, unknown> = {};
            try {
              const data = await readFile(configPath, 'utf-8');
              existingConfig = JSON.parse(data);
            } catch {
              // No existing config file
            }
            existingConfig[key] = numVal;
            await mkdir(configDir, { recursive: true });
            await writeFile(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');
            console.log(chalk.dim(`  Saved to ${configPath}`));
          } else {
            console.log(chalk.red(`  Invalid value: ${value}`));
          }
        } else {
          console.log(chalk.red(`  Unknown config key: ${key}`));
          console.log(chalk.dim(`  Available keys: ${Object.keys(riskConfig).join(', ')}`));
        }
        console.log('');
        return;
      }

      // Display current config
      console.log('');
      console.log(chalk.bold('  Risk Configuration'));
      console.log(chalk.dim('  ' + '═'.repeat(50)));
      console.log(`  Max Portfolio Risk:      ${(riskConfig.maxPortfolioRisk * 100).toFixed(0)}%`);
      console.log(`  Max Single Position:     ${(riskConfig.maxSinglePosition * 100).toFixed(0)}%`);
      console.log(`  Max Correlated Exposure: ${(riskConfig.maxCorrelatedExposure * 100).toFixed(0)}%`);
      console.log(`  Max Concurrent Trades:   ${riskConfig.maxConcurrentTrades}`);
      console.log(`  Hard Stop:               ${(riskConfig.hardStopPercent * 100).toFixed(0)}%`);
      console.log(`  Trailing Stop ATR:       ${riskConfig.trailingStopAtr}x`);
      console.log(chalk.dim('  ' + '─'.repeat(50)));
      console.log(`  Daily Loss Limit:        ${(riskConfig.dailyLossLimit * 100).toFixed(0)}%`);
      console.log(`  Weekly Loss Limit:       ${(riskConfig.weeklyLossLimit * 100).toFixed(0)}%`);
      console.log(`  Monthly Loss Limit:      ${(riskConfig.monthlyLossLimit * 100).toFixed(0)}%`);
      console.log(chalk.dim('  ' + '─'.repeat(50)));
      console.log(`  Max Slippage (large):    ${(riskConfig.maxSlippage.large! * 100).toFixed(1)}%`);
      console.log(`  Max Slippage (mid):      ${(riskConfig.maxSlippage.mid! * 100).toFixed(1)}%`);
      console.log(`  Max Slippage (small):    ${(riskConfig.maxSlippage.small! * 100).toFixed(1)}%`);
      console.log('');
    });

  // ── backtest ──
  agent
    .command("backtest")
    .description("Backtest strategies on historical data")
    .argument("<token>", "Token ID (e.g., bitcoin, ethereum)")
    .option("--from <date>", "Start date (YYYY-MM-DD)", "2024-01-01")
    .option("--to <date>", "End date (YYYY-MM-DD)", "2024-12-31")
    .option("--strategies <list>", "Comma-separated strategy names", "")
    .option("--capital <amount>", "Initial capital in USD", "10000")
    .option("--cycle <interval>", "Candle interval (1h, 4h, 1d)", "1d")
    .action(async (token: string, options: { from: string; to: string; strategies: string; capital: string; cycle: string }) => {
      const config: BacktestConfig = {
        tokenId: token,
        startDate: options.from,
        endDate: options.to,
        initialCapital: parseFloat(options.capital),
        strategies: options.strategies ? options.strategies.split(",").map((s) => s.trim()) : [],
        cycle: (options.cycle as BacktestConfig["cycle"]) || "1d",
      };

      const spinner = ora(`Backtesting ${token} from ${config.startDate} to ${config.endDate}...`).start();

      try {
        const backtester = new Backtester(config);
        const result = await backtester.run();
        spinner.stop();
        console.log(backtester.formatResults(result));
      } catch (err) {
        spinner.fail(`Backtest failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

// ── Display Helpers ──

function renderBar(value: number): string {
  const width = 20;
  const mid = Math.floor(width / 2);
  const bar = new Array(width).fill("░");

  const magnitude = Math.min(Math.abs(value), 1.0);
  const filled = Math.round(magnitude * mid);

  if (value > 0) {
    for (let i = mid; i < mid + filled; i++) bar[i] = "█";
    return chalk.dim(bar.slice(0, mid).join("")) + chalk.green(bar.slice(mid).join(""));
  } else if (value < 0) {
    for (let i = mid - filled; i < mid; i++) bar[i] = "█";
    return chalk.red(bar.slice(0, mid).join("")) + chalk.dim(bar.slice(mid).join(""));
  }
  return chalk.dim(bar.join(""));
}

function colorValue(value: number): string {
  const str = (value >= 0 ? "+" : "") + value.toFixed(3);
  if (value > 0.1) return chalk.green(str);
  if (value < -0.1) return chalk.red(str);
  return chalk.yellow(str);
}

function formatValue(value: number, low: number, high: number, invertColors: boolean): string {
  const str = isNaN(value) ? "N/A" : value.toFixed(2);
  if (isNaN(value)) return chalk.dim(str);
  if (invertColors) {
    if (value < low) return chalk.green(str);
    if (value > high) return chalk.red(str);
  } else {
    if (value > high) return chalk.green(str);
    if (value < low) return chalk.red(str);
  }
  return chalk.yellow(str);
}

function formatFearGreed(value: number): string {
  const str = `${value}`;
  if (value < 25) return chalk.green(str + " (Extreme Fear)");
  if (value < 40) return chalk.green(str + " (Fear)");
  if (value < 60) return chalk.yellow(str + " (Neutral)");
  if (value < 75) return chalk.red(str + " (Greed)");
  return chalk.red(str + " (Extreme Greed)");
}
