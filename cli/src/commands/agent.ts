/**
 * CLI commands for the autonomous trading agent.
 * sherwood agent <analyze|signals|start|status|history|config|backtest>
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import ora from "ora";
import { TradingAgent } from "../agent/index.js";
import type { AgentConfig, TokenAnalysis, Alert } from "../agent/index.js";
import { getLatestSignals } from "../agent/technical.js";
import type { Candle } from "../agent/technical.js";
import { CoinGeckoProvider } from "../providers/data/coingecko.js";
import { DynamicTokenSelector } from "../agent/token-selector.js";
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
import type { BacktestConfig, WalkForwardConfig } from "../agent/backtest.js";
import { runCalibration, formatCalibrationTable, DEFAULT_CALIBRATION_TOKENS } from "../agent/calibrator.js";
import { runHistoryReplay } from "../agent/replay-calibrator.js";
import { AlertFormatter } from "../agent/alert-formatter.js";
import { ExecutionPipeline, DEFAULT_SCALED_SIZING } from "../agent/execution-pipeline.js";
import { auditSignalHistory, suggestRenormalizedWeights, diffAudits } from "../agent/signal-audit.js";
import type { AuditResult } from "../agent/signal-audit.js";
import { DEFAULT_WEIGHTS } from "../agent/scoring.js";

// Expanded default universe — covers majors, L1/L2s, DeFi blue-chips, top
// memes, and HL-listed alts so the scanner has more shots on goal each cycle.
// Every token here has Hyperliquid perp coverage (executor.ts TOKEN_TO_ASSET_INDEX)
// and CoinGecko OHLC. Use --auto for fully dynamic selection from HL volume.
const DEFAULT_TOKENS = [
  "bitcoin", "ethereum", "solana",                               // majors
  "ripple", "dogecoin", "avalanche-2", "polkadot", "near",       // L1s
  "arbitrum",                                                    // L2
  "aave", "uniswap", "chainlink",                                // DeFi
  "hyperliquid", "bittensor", "fartcoin",                        // HL natives / themes
];

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    tokens: DEFAULT_TOKENS,
    cycle: "4h",
    dryRun: true,
    maxPositionPct: 5,
    maxRiskPct: 20,
    useX402: true, // Paid signals (Nansen + Messari) on by default — opt out with --no-x402
    x402TopN: 3,   // Only run x402 on top 3 tokens by free-signal score — saves ~$1.12/run
    smoothFastSignals: true, // Rolling-window smoothing for noisy signals — prevents single-scan flicker
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
    .option("--auto", "Use dynamic token selection from Hyperliquid market data")
    .option("--json", "Output as JSON")
    .option("--no-x402", "Skip paid x402 data (Nansen smart-money, Messari fundamentals) — on by default")
    .option("--telegram", "Output formatted summary for Telegram")
    .option("--proposals", "Generate trade proposals for high-confidence opportunities")
    .option("--weight-profile <name>", "Weight profile: default | majors | altcoin | sentHeavy | techHeavy (auto: majors for BTC/ETH/SOL)")
    .option("--scaled-sizing", "Score-weighted position sizing (smaller positions for marginal scores)")
    .option("--smooth", "Smooth fast signals with rolling 3-reading window")
    .action(async (tokens: string[], options: { all?: boolean; auto?: boolean; json?: boolean; x402: boolean; telegram?: boolean; proposals?: boolean; weightProfile?: string; scaledSizing?: boolean; smooth?: boolean }) => {
      let tokenList: string[];
      let selectionSummary: string | undefined;

      if (options.auto) {
        const spinner = ora("Fetching dynamic token selection from Hyperliquid...").start();
        try {
          const selector = new DynamicTokenSelector();
          const selection = await selector.selectTokens();
          tokenList = selection.tokens;
          selectionSummary = selector.formatSelectionSummary(selection);
          spinner.stop();

          // Show selection summary
          console.log();
          console.log(selectionSummary);
          console.log();
        } catch (error) {
          spinner.fail(`Dynamic selection failed: ${(error as Error).message}`);
          console.log("Falling back to default tokens...");
          tokenList = DEFAULT_TOKENS;
        }
      } else {
        tokenList = options.all ? DEFAULT_TOKENS : tokens.length > 0 ? tokens : DEFAULT_TOKENS;
      }

      const scaledSizing = options.scaledSizing
        ? { ...DEFAULT_SCALED_SIZING, enabled: true }
        : undefined;
      const config = makeConfig({ tokens: tokenList, useX402: options.x402, weightProfile: options.weightProfile, smoothFastSignals: options.smooth });
      const tradingAgent = new TradingAgent(config);
      const spinner = ora("Analyzing tokens...").start();

      try {
        spinner.text = "Analyzing tokens and checking for alerts...";
        const { analyses: results, alerts } = await tradingAgent.analyzeAllWithAlerts();
        spinner.stop();

        if (options.telegram) {
          // Output Telegram-formatted summary
          const regime = results[0]?.regime?.regime;
          const summary = AlertFormatter.formatScanSummary(results, alerts, regime);
          console.log(summary);
          return;
        }

        if (options.proposals) {
          // Output trade proposals
          const proposals = ExecutionPipeline.generateProposals(results, { scaledSizing });
          const formatted = ExecutionPipeline.formatProposals(proposals);
          console.log(formatted);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(results.map((r) => ({ token: r.token, decision: r.decision })), null, 2));
        } else {
          console.log(tradingAgent.formatAnalysis(results));

          // Show alerts if any
          if (alerts.length > 0) {
            console.log(chalk.bold("\n" + tradingAgent.formatAlerts(alerts)));
            console.log();
          }

          // Detailed signal breakdown
          for (const r of results) {
            console.log(chalk.bold(`\n  ${r.token.toUpperCase()} — Signal Breakdown`));
            console.log(chalk.dim("  " + "─".repeat(50)));

            // Show regime info if available
            if (r.regime) {
              const regimeColor = r.regime.regime === "trending-up" ? chalk.green :
                                  r.regime.regime === "trending-down" ? chalk.red :
                                  r.regime.regime === "ranging" ? chalk.yellow :
                                  r.regime.regime === "high-volatility" ? chalk.magenta :
                                  chalk.cyan;
              console.log(
                `  ${"Market Regime".padEnd(22)} ${regimeColor("▮".repeat(10))} ${regimeColor(r.regime.regime.replace('-', ' '))}  ${chalk.dim(r.regime.details.slice(0, 60))}`
              );
            }

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
    .option("--auto", "Use dynamic token selection from Hyperliquid market data")
    .option("--log <path>", "Path to write cycle logs")
    .option("--mode <mode>", "Execution mode: dry-run (default), hyperliquid-perp", "dry-run")
    .option("--strategy-clone <address>", "Strategy clone address on HyperEVM (required for hyperliquid-perp)")
    .option("--chain <chain>", "Chain for live execution (hyperevm, hyperevm-testnet)", "ethereum")
    .option("--asset-index <n>", "HyperCore perp asset index (default: 3 = ETH)")
    .option("--no-x402", "Skip paid x402 data (Nansen smart-money, Messari fundamentals) — on by default")
    .option("--weight-profile <name>", "Weight profile: default | majors | altcoin | sentHeavy | techHeavy (auto: majors for BTC/ETH/SOL)")
    .option("--scaled-sizing", "Score-weighted position sizing (smaller positions for marginal scores)")
    .option("--smooth", "Smooth fast signals with rolling 3-reading window")
    .action(async (options: { cycle?: string; dryRun?: boolean; tokens?: string; auto?: boolean; log?: string; mode?: string; strategyClone?: string; chain?: string; assetIndex?: string; x402: boolean; weightProfile?: string; scaledSizing?: boolean; smooth?: boolean }) => {
      let tokenList: string[];

      if (options.auto) {
        console.log(chalk.dim("  Using dynamic token selection from Hyperliquid (refreshes every 30 min)"));
        // For the loop, we'll create a placeholder list that gets replaced dynamically
        // The actual selection happens in the loop itself to allow periodic refresh
        tokenList = ['bitcoin', 'ethereum']; // Minimal list, will be replaced
      } else {
        tokenList = options.tokens ? options.tokens.split(",").map((t) => t.trim()) : DEFAULT_TOKENS;
      }

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
      // NOTE: options.scaledSizing is currently a no-op here because the loop
      // does not call ExecutionPipeline.generateProposals. If that changes,
      // pass { scaledSizing } through LoopConfig and into the proposal call.
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
        agent: makeConfig({ tokens: tokenList, cycle, dryRun: !isLive, useX402: options.x402, weightProfile: options.weightProfile, smoothFastSignals: options.smooth }),
        execution: {
          dryRun: !isLive,
          mode: (options.mode ?? 'dry-run') as 'dry-run' | 'hyperliquid-perp',
          mevProtection: false,
          chain: options.chain ?? 'ethereum',
          strategyClone: options.strategyClone as `0x${string}` | undefined,
          proposerPrivateKey: proposerKey,
          assetIndex: options.assetIndex ? (() => {
            const idx = parseInt(options.assetIndex!, 10);
            if (isNaN(idx) || idx < 0) {
              console.error(chalk.red(`  Invalid --asset-index: ${options.assetIndex}`));
              process.exit(1);
            }
            return idx;
          })() : undefined,
        },
        riskConfig: savedRiskConfig,
        logPath: options.log,
        autoDynamicSelection: options.auto ?? false,
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
    .option("--walk-forward", "Enable walk-forward optimization")
    .option("--train <days>", "Training window in days for walk-forward", "90")
    .option("--test <days>", "Test window in days for walk-forward", "30")
    .option("--verbose", "Show detailed decision logs for each candle")
    .option("--regime", "Apply regime-conditional thresholds per-candle (matches live behavior)")
    .option("--trailing-stop <pct>", "Trailing stop as decimal (e.g. 0.05 = 5%) — exits if price drops X% from high-water mark")
    .option("--scaled-sizing", "Score-weighted position sizing (smaller positions for marginal scores)")
    .option("--weight-profile <name>", "Named weight profile: default | majors | altcoin | sentHeavy | techHeavy")
    .option("--smooth", "Smooth fast signals (HL flow, smartMoney, dexFlow, fundingRate) with rolling 3-reading window")
    .action(async (token: string, options: { from: string; to: string; strategies: string; capital: string; cycle: string; walkForward?: boolean; train: string; test: string; verbose?: boolean; regime?: boolean; trailingStop?: string; scaledSizing?: boolean; weightProfile?: string; smooth?: boolean }) => {
      const capital = parseFloat(options.capital);
      const strategies = options.strategies ? options.strategies.split(",").map((s) => s.trim()) : [];
      const trailingStopPct = options.trailingStop ? parseFloat(options.trailingStop) : undefined;
      if (trailingStopPct !== undefined && (!Number.isFinite(trailingStopPct) || trailingStopPct <= 0 || trailingStopPct > 0.5)) {
        console.error(chalk.red("--trailing-stop must be between 0 and 0.5 (e.g. 0.05 = 5%)"));
        process.exitCode = 1;
        return;
      }
      // NOTE: options.scaledSizing is currently a no-op in backtest because
      // the backtester doesn't generate TradeProposals — it simulates its own
      // BUY/SELL directly from decision.action. Flag is parsed but unused.

      if (options.walkForward) {
        // Walk-forward optimization mode
        const trainWindow = parseInt(options.train, 10);
        const testWindow = parseInt(options.test, 10);
        const stepSize = Math.min(testWindow, 30); // Default step size to test window or 30 days, whichever is smaller
        const totalDays = trainWindow + (testWindow * 3); // Ensure we have enough data for multiple folds

        const walkConfig: WalkForwardConfig = {
          tokenId: token,
          totalDays,
          trainWindow,
          testWindow,
          stepSize,
          capital,
          strategies,
          useRegime: options.regime,
          trailingStopPct,
          smoothFastSignals: options.smooth,
        };

        const spinner = ora(`Walk-forward testing ${token} (${trainWindow}d train, ${testWindow}d test)...`).start();

        try {
          const backtester = new Backtester({
            tokenId: token,
            startDate: options.from,
            endDate: options.to,
            initialCapital: capital,
            strategies,
            cycle: (options.cycle as BacktestConfig["cycle"]) || "1d",
            verbose: options.verbose,
            useRegime: options.regime,
            trailingStopPct,
            smoothFastSignals: options.smooth,
          });
          const result = await backtester.walkForwardTest(walkConfig);
          spinner.stop();
          console.log(backtester.formatWalkForwardResults(result, walkConfig));
        } catch (err) {
          spinner.fail(`Walk-forward test failed: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      } else {
        // Regular backtest mode
        const config: BacktestConfig = {
          tokenId: token,
          startDate: options.from,
          endDate: options.to,
          initialCapital: capital,
          strategies,
          cycle: (options.cycle as BacktestConfig["cycle"]) || "1d",
          verbose: options.verbose,
          useRegime: options.regime,
          trailingStopPct,
          smoothFastSignals: options.smooth,
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
      }
    });

  // ── calibrate ──
  agent
    .command("calibrate")
    .description("Sweep weight profiles × BUY/SELL thresholds against historical data; ranks by Sharpe")
    .option("--tokens <list>", "Comma-separated CoinGecko IDs (default: bitcoin,ethereum,solana,aave,uniswap,chainlink,arbitrum)")
    .option("--days <n>", "Lookback window in days", "60")
    .option("--capital <amount>", "Initial capital per token in USD", "10000")
    .option("--top <n>", "Show top N configs in the ranked table", "20")
    .option("--from-history [path]", "Replay against signal-history.jsonl (true production signal stack including HL/funding/dexFlow). Path defaults to ~/.sherwood/agent/signal-history.jsonl")
    .option("--last <days>", "Replay only rows captured within the last N days (use after a scoring change to ignore stale captures). Replay path only.")
    .option("--no-regime", "When using --from-history, ignore the regime field on each row (use DEFAULT_THRESHOLDS instead)")
    .action(async (options: { tokens?: string; days: string; capital: string; top: string; fromHistory?: string | boolean; last?: string; regime: boolean }) => {
      const topN = parseInt(options.top, 10);

      // ── Replay path: signal-history.jsonl ──
      if (options.fromHistory) {
        const historyPath = typeof options.fromHistory === 'string' ? options.fromHistory : undefined;
        const tokens = options.tokens
          ? options.tokens.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined; // default = all tokens in dataset

        let lastDays: number | undefined;
        if (options.last !== undefined) {
          lastDays = parseFloat(options.last);
          if (!Number.isFinite(lastDays) || lastDays <= 0) {
            console.error(chalk.red(`Invalid --last: ${options.last} (expected positive number of days)`));
            process.exitCode = 1;
            return;
          }
        }

        console.log(chalk.bold(`\n  Replaying calibration against signal-history.jsonl${lastDays ? ` (last ${lastDays}d)` : ''}...\n`));
        try {
          const results = await runHistoryReplay({
            historyPath,
            tokens,
            lastDays,
            useRegime: options.regime,
            onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
          });
          console.log(formatCalibrationTable(results, topN));
          console.log(chalk.dim(`  Source: signal-history replay (production signal stack)`));
          console.log(chalk.dim(`  Saved: ~/.sherwood/agent/replay-calibration-results.json\n`));
        } catch (err) {
          console.error(chalk.red(`\n  Replay calibration failed: ${(err as Error).message}\n`));
          process.exitCode = 1;
        }
        return;
      }

      // ── Candle path: re-fetch from CoinGecko, recompute signals ──
      const tokens = options.tokens
        ? options.tokens.split(",").map((t) => t.trim()).filter(Boolean)
        : DEFAULT_CALIBRATION_TOKENS;
      const days = parseInt(options.days, 10);
      const capital = parseFloat(options.capital);

      if (!Number.isFinite(days) || days <= 0) {
        console.error(chalk.red(`Invalid --days: ${options.days}`));
        process.exitCode = 1;
        return;
      }
      if (!Number.isFinite(capital) || capital <= 0) {
        console.error(chalk.red(`Invalid --capital: ${options.capital}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.bold(`\n  Calibrating ${tokens.length} tokens over ${days}d (candle-based, 200 configs per token)...\n`));
      try {
        const results = await runCalibration({
          tokens,
          days,
          capital,
          onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
        });
        console.log(formatCalibrationTable(results, topN));
      } catch (err) {
        console.error(chalk.red(`\n  Calibration failed: ${(err as Error).message}\n`));
        process.exitCode = 1;
      }
    });

  // ── signal-audit ──
  agent
    .command("signal-audit")
    .description("Audit signal history — which signal categories actually fire?")
    .option("--drop-threshold <rate>", "Fire-rate below which a category is flagged for dropping", "0.1")
    .option("--json", "Emit raw JSON instead of formatted table")
    .option("--save <path>", "Save current audit as a baseline JSON snapshot")
    .option("--baseline <path>", "Diff current audit against a saved baseline")
    .action(async (options: { dropThreshold?: string; json?: boolean; save?: string; baseline?: string }) => {
      const dropThreshold = parseFloat(options.dropThreshold ?? "0.1");
      const result = await auditSignalHistory();

      // --save: write snapshot and exit
      if (options.save) {
        await mkdir(join(homedir(), '.sherwood', 'agent'), { recursive: true });
        await writeFile(options.save, JSON.stringify(result, null, 2), 'utf-8');
        console.log(chalk.green(`  Saved baseline snapshot to ${options.save}`));
        console.log(chalk.dim(`  ${result.totalEntries} entries, ${result.perSignal.length} signals`));
        return;
      }

      // --baseline: load and diff
      if (options.baseline) {
        let baseline: AuditResult;
        try {
          const raw = await readFile(options.baseline, 'utf-8');
          baseline = JSON.parse(raw) as AuditResult;
        } catch (err) {
          console.error(chalk.red(`  Failed to load baseline: ${(err as Error).message}`));
          process.exitCode = 1;
          return;
        }

        const diff = diffAudits(baseline, result);

        if (options.json) {
          console.log(JSON.stringify(diff, null, 2));
          return;
        }

        console.log("");
        console.log(chalk.bold("  Signal Audit Diff"));
        console.log(chalk.dim("  " + "═".repeat(72)));
        if (baseline.dateRange && result.dateRange) {
          console.log(chalk.dim(`  Baseline: ${baseline.dateRange.from.slice(0, 10)} → ${baseline.dateRange.to.slice(0, 10)} (${baseline.totalEntries} entries)`));
          console.log(chalk.dim(`  Current:  ${result.dateRange.from.slice(0, 10)} → ${result.dateRange.to.slice(0, 10)} (${result.totalEntries} entries)`));
        }
        console.log("");

        // Per-category diff
        console.log(chalk.bold("  Per Category"));
        console.log(chalk.dim(`  ${"Category".padEnd(14)} ${"Was".padEnd(7)} ${"Now".padEnd(7)} ${"Δ".padEnd(8)} Status`));
        console.log(chalk.dim("  " + "─".repeat(72)));
        for (const c of diff.perCategory) {
          const arrow = c.status === "improved" ? chalk.green("↑") :
            c.status === "regressed" ? chalk.red("↓") :
            c.status === "new" ? chalk.cyan("✦") :
            c.status === "removed" ? chalk.red("✗") : chalk.dim("=");
          const deltaStr = (c.fireRateDelta >= 0 ? "+" : "") + (c.fireRateDelta * 100).toFixed(0) + "pp";
          const deltaColor = c.status === "improved" ? chalk.green : c.status === "regressed" ? chalk.red : chalk.dim;
          console.log(
            `  ${c.category.padEnd(14)} ${(c.baseline.fireRate * 100).toFixed(0).padStart(5)}%  ${(c.current.fireRate * 100).toFixed(0).padStart(5)}%  ${deltaColor(deltaStr.padEnd(7))} ${arrow} ${c.status}`,
          );
        }

        // Per-signal diff (only show changes)
        const changedSignals = diff.perSignal.filter((s) => s.status !== "stable");
        if (changedSignals.length > 0) {
          console.log("");
          console.log(chalk.bold("  Changed Signals"));
          console.log(chalk.dim(`  ${"Signal".padEnd(22)} ${"Was".padEnd(7)} ${"Now".padEnd(7)} ${"Δ".padEnd(8)} Status`));
          console.log(chalk.dim("  " + "─".repeat(72)));
          for (const s of changedSignals) {
            const arrow = s.status === "improved" ? chalk.green("↑") :
              s.status === "regressed" ? chalk.red("↓") :
              s.status === "new" ? chalk.cyan("✦") :
              s.status === "removed" ? chalk.red("✗") : chalk.dim("=");
            const deltaStr = (s.fireRateDelta >= 0 ? "+" : "") + (s.fireRateDelta * 100).toFixed(0) + "pp";
            const deltaColor = s.status === "improved" ? chalk.green : s.status === "regressed" ? chalk.red : chalk.dim;
            console.log(
              `  ${s.name.padEnd(22)} ${(s.baseline.fireRate * 100).toFixed(0).padStart(5)}%  ${(s.current.fireRate * 100).toFixed(0).padStart(5)}%  ${deltaColor(deltaStr.padEnd(7))} ${arrow} ${s.status}`,
            );
          }
        } else {
          console.log("");
          console.log(chalk.dim("  No per-signal changes above 5pp threshold."));
        }
        console.log("");
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("");
      console.log(chalk.bold("  Signal Activity Audit"));
      console.log(chalk.dim("  " + "═".repeat(72)));

      if (result.totalEntries === 0) {
        console.log(chalk.dim(`  No signal history yet at ${result.filePath}`));
        console.log(chalk.dim("  Run 'sherwood agent analyze' a few times to populate it."));
        console.log("");
        return;
      }

      console.log(chalk.dim(`  Source:  ${result.filePath}`));
      console.log(chalk.dim(`  Entries: ${result.totalEntries}`));
      if (result.dateRange) {
        console.log(
          chalk.dim(
            `  Range:   ${result.dateRange.from.slice(0, 10)} → ${result.dateRange.to.slice(0, 10)}`,
          ),
        );
      }
      console.log("");

      // Per-category summary
      console.log(chalk.bold("  Per Category"));
      console.log(
        chalk.dim(
          `  ${"Category".padEnd(14)} ${"Fire%".padEnd(7)} ${"Obs".padEnd(6)} ${"Mean|v|".padEnd(9)} Signals`,
        ),
      );
      console.log(chalk.dim("  " + "─".repeat(72)));
      for (const c of result.perCategory) {
        const color =
          c.recommendation === "keep"
            ? chalk.green
            : c.recommendation === "drop"
              ? chalk.red
              : chalk.yellow;
        const rec = `[${c.recommendation.toUpperCase()}]`;
        console.log(
          `  ${c.category.padEnd(14)} ${(c.fireRate * 100).toFixed(0).padStart(5)}%  ${String(c.observations).padEnd(6)} ${c.meanAbsValue.toFixed(3).padEnd(9)} ${c.signalNames.join(", ")} ${color(rec)}`,
        );
      }

      // Per-signal detail
      console.log("");
      console.log(chalk.bold("  Per Signal"));
      console.log(
        chalk.dim(
          `  ${"Signal".padEnd(22)} ${"Category".padEnd(12)} ${"Fire%".padEnd(7)} ${"Obs".padEnd(6)} ${"Mean|v|".padEnd(9)} ${"Bias".padEnd(8)} Conf`,
        ),
      );
      console.log(chalk.dim("  " + "─".repeat(72)));
      for (const s of result.perSignal) {
        const biasColor = s.directionalBias >= 0 ? chalk.green : chalk.red;
        console.log(
          `  ${s.name.padEnd(22)} ${s.category.padEnd(12)} ${(s.fireRate * 100).toFixed(0).padStart(5)}%  ${String(s.observations).padEnd(6)} ${s.meanAbsValue.toFixed(3).padEnd(9)} ${biasColor((s.directionalBias >= 0 ? "+" : "") + s.directionalBias.toFixed(3)).padEnd(17)} ${s.meanConfidence.toFixed(2)}`,
        );
      }

      // Renormalized weight suggestion
      const current = DEFAULT_WEIGHTS as unknown as Record<string, number>;
      const suggested = suggestRenormalizedWeights(current, result.perCategory, dropThreshold);
      const changed = Object.keys(current).some(
        (k) => Math.abs((suggested[k] ?? 0) - (current[k] ?? 0)) > 0.001,
      );

      if (changed) {
        console.log("");
        console.log(chalk.bold("  Suggested Weight Renormalization"));
        console.log(chalk.dim(`  (Dropping categories below ${(dropThreshold * 100).toFixed(0)}% fire rate)`));
        console.log(chalk.dim("  " + "─".repeat(72)));
        console.log(
          chalk.dim(
            `  ${"Category".padEnd(14)} ${"Current".padEnd(10)} ${"Suggested"}`,
          ),
        );
        for (const [cat, w] of Object.entries(current)) {
          const newW = suggested[cat] ?? 0;
          const tag =
            newW === 0 ? chalk.red(" ← drop") : newW > w ? chalk.green(" ← boost") : "";
          console.log(
            `  ${cat.padEnd(14)} ${w.toFixed(3).padEnd(10)} ${newW.toFixed(3)}${tag}`,
          );
        }
      } else {
        console.log("");
        console.log(chalk.dim("  All categories above drop threshold — no renormalization suggested."));
      }
      console.log("");
    });

  // ── alerts ──
  const alerts = agent.command("alerts").description("Manage trading alerts");

  alerts
    .command("list")
    .alias("")
    .description("Show recent alerts")
    .option("--hours <n>", "Look back N hours", "24")
    .action(async (options: { hours?: string }) => {
      try {
        const tradingAgent = new TradingAgent(makeConfig());
        const hours = parseInt(options.hours ?? "24", 10) || 24;
        const maxAge = hours * 60 * 60 * 1000;

        const recentAlerts = await tradingAgent.getRecentAlerts(maxAge);

        if (recentAlerts.length === 0) {
          console.log(chalk.dim("  No alerts in the last " + hours + " hours."));
          return;
        }

        console.log('');
        console.log(chalk.bold(`  Recent Alerts (last ${hours} hours)`));
        console.log(chalk.dim('  ' + '═'.repeat(60)));

        for (const alert of recentAlerts.slice(0, 20)) {
          const icon = alert.priority === "critical" ? "🔴" :
                       alert.priority === "high" ? "🟡" :
                       alert.priority === "medium" ? "🔵" : "⚫";

          const timeStr = new Date(alert.timestamp).toLocaleString();
          const priorityColor = alert.priority === "critical" ? chalk.red :
                                alert.priority === "high" ? chalk.yellow :
                                alert.priority === "medium" ? chalk.blue : chalk.gray;

          console.log(`  ${icon} ${priorityColor(alert.priority.toUpperCase())} — ${alert.title}`);
          console.log(chalk.dim(`     ${alert.details.slice(0, 80)}${alert.details.length > 80 ? '...' : ''}`));
          console.log(chalk.dim(`     Token: ${alert.tokenId}, ${timeStr}`));
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Failed to load alerts: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  alerts
    .command("clear")
    .description("Clear all alerts")
    .action(async () => {
      try {
        const tradingAgent = new TradingAgent(makeConfig());
        await tradingAgent.clearAlerts();
        console.log(chalk.green("  All alerts cleared."));
      } catch (err) {
        console.error(chalk.red(`Failed to clear alerts: ${(err as Error).message}`));
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
