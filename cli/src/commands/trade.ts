/**
 * Trade commands — sherwood trade <subcommand>
 *
 * Memecoin trading via the Uniswap Trading API on Base, driven by signal-based
 * analysis (on-chain flows, social sentiment, fundamentals).
 *
 * Trades execute from the agent's own EOA wallet using USDC as quote currency.
 * Requires a Uniswap API key: `sherwood config set --uniswap-api-key <key>`
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm } from "@inquirer/prompts";
import type { Address } from "viem";
import { isAddress, parseUnits, formatUnits } from "viem";

import { getPublicClient, getAccount } from "../lib/client.js";
import { getExplorerUrl } from "../lib/network.js";
import { TOKENS } from "../lib/addresses.js";
import { ERC20_ABI } from "../lib/abis.js";
import { UniswapProvider } from "../providers/uniswap.js";
import { analyzeToken } from "../lib/signals.js";
import type { SignalResult } from "../lib/signals.js";
import { checkExit, DEFAULT_EXIT_CONFIG } from "../lib/exit-strategy.js";
import type { ExitConfig } from "../lib/exit-strategy.js";
import {
  getOpenPositions,
  addPosition,
  closePosition,
  updateHighWater,
  getCurrentPrice,
} from "../lib/positions.js";
import type { MessageType } from "../lib/types.js";

const uniswap = new UniswapProvider();

// Lazy-load XMTP to avoid breaking non-chat environments
async function loadXmtp() {
  return import("../lib/xmtp.js");
}

// ── Token resolution ──

const KNOWN_MEMECOINS: Record<string, Address> = {
  DEGEN: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" as Address,
  TOSHI: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" as Address,
  BRETT: "0x532f27101965dd16442E59d40670FaF5eBB142E4" as Address,
  HIGHER: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe" as Address,
};

async function resolveToken(
  symbolOrAddress: string,
): Promise<{ address: Address; symbol: string; decimals: number }> {
  let address: Address;
  let symbol: string;

  if (isAddress(symbolOrAddress)) {
    address = symbolOrAddress as Address;
    const client = getPublicClient();
    try {
      symbol = (await client.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "symbol",
      })) as string;
    } catch {
      symbol = address.slice(0, 8);
    }
  } else {
    const upper = symbolOrAddress.toUpperCase();
    const tokens = TOKENS();
    const tokenMap: Record<string, Address> = {
      USDC: tokens.USDC,
      WETH: tokens.WETH,
      ...KNOWN_MEMECOINS,
    };
    address = tokenMap[upper];
    if (!address) {
      throw new Error(
        `Unknown token: ${symbolOrAddress}. Use a contract address or known symbol (${Object.keys(tokenMap).join(", ")}).`,
      );
    }
    symbol = upper;
  }

  const client = getPublicClient();
  const decimals = (await client.readContract({
    address,
    abi: ERC20_ABI,
    functionName: "decimals",
  })) as number;

  return { address, symbol, decimals };
}

// ── Chat posting ──

async function postToChat(
  syndicate: string,
  type: MessageType,
  text: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", syndicate);
    await xmtp.sendEnvelope(group, {
      type,
      from: getAccount().address,
      text,
      data,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch {
    // Chat posting is best-effort
  }
}

// ── Formatting ──

function formatSignalTable(results: { symbol: string; address: Address; result: SignalResult }[]): void {
  console.log();
  console.log(chalk.bold("  Token          Score   Action   Conf.  On-chain  Social  Fundmtl"));
  console.log(chalk.dim("  " + "─".repeat(72)));

  for (const { symbol, address, result } of results) {
    const scoreColor = result.compositeScore > 0 ? chalk.green : result.compositeScore < 0 ? chalk.red : chalk.dim;
    const actionColor =
      result.action === "buy" ? chalk.green.bold :
      result.action === "sell" ? chalk.red.bold :
      chalk.dim;

    const onChain = result.signals.find((s) => s.source === "onchain");
    const social = result.signals.find((s) => s.source === "social");
    const fundamental = result.signals.find((s) => s.source === "fundamental");

    const shortAddr = `${address.slice(0, 6)}..`;
    const label = `${symbol.padEnd(6)} (${shortAddr})`;

    console.log(
      `  ${label.padEnd(16)} ` +
      `${scoreColor(result.compositeScore.toFixed(2).padStart(6))}  ` +
      `${actionColor(result.action.toUpperCase().padEnd(6))}  ` +
      `${(result.confidence * 100).toFixed(0).padStart(4)}%  ` +
      `${formatSignalValue(onChain?.value).padStart(8)}  ` +
      `${formatSignalValue(social?.value).padStart(6)}  ` +
      `${formatSignalValue(fundamental?.value).padStart(7)}`,
    );
  }
  console.log();
}

function formatSignalValue(v: number | undefined): string {
  if (v === undefined) return chalk.dim("n/a");
  const s = (v >= 0 ? "+" : "") + v.toFixed(2);
  return v > 0 ? chalk.green(s) : v < 0 ? chalk.red(s) : chalk.dim(s);
}

// ── Commands ──

export function registerTradeCommands(program: Command): void {
  const trade = program
    .command("trade")
    .description("Memecoin trading — scan, buy, sell, monitor positions (Uniswap Trading API on Base)");

  // ── trade scan ──

  trade
    .command("scan")
    .description("Analyze token(s) using on-chain, social, and fundamental signals")
    .option("--token <addr|symbol>", "Specific token to analyze (otherwise scans known memecoins)")
    .option("--syndicate <name>", "Post results to syndicate chat")
    .option("--yes", "Skip cost confirmation", false)
    .action(async (opts: { token?: string; syndicate?: string; yes: boolean }) => {
      const targets: { symbol: string; address: Address }[] = [];

      if (opts.token) {
        const resolved = await resolveToken(opts.token);
        targets.push({ symbol: resolved.symbol, address: resolved.address });
      } else {
        for (const [symbol, address] of Object.entries(KNOWN_MEMECOINS)) {
          targets.push({ symbol, address });
        }
      }

      const estCost = targets.length * 0.26;
      console.log();
      console.log(chalk.bold("Memecoin Alpha Scan"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Tokens:    ${targets.map((t) => t.symbol).join(", ")}`);
      console.log(`  Est. cost: ${chalk.yellow(`~$${estCost.toFixed(2)} USDC`)} (x402 research) + Venice inference`);
      console.log();

      if (!opts.yes) {
        const ok = await confirm({
          message: `Proceed with signal analysis?`,
          default: true,
        });
        if (!ok) {
          console.log(chalk.dim("Cancelled."));
          return;
        }
      }

      const spinner = ora("Analyzing signals...").start();
      const results: { symbol: string; address: Address; result: SignalResult }[] = [];

      for (const target of targets) {
        try {
          spinner.text = `Analyzing ${target.symbol}...`;
          const result = await analyzeToken(target.address, target.symbol);
          results.push({ ...target, result });
        } catch {
          results.push({
            ...target,
            result: {
              action: "hold",
              confidence: 0,
              compositeScore: 0,
              signals: [],
              costUsdc: "0",
              timestamp: Math.floor(Date.now() / 1000),
            },
          });
        }
      }

      spinner.succeed("Scan complete");
      formatSignalTable(results);

      const totalCost = results.reduce((sum, r) => sum + Number(r.result.costUsdc), 0);
      console.log(chalk.dim(`  Total research cost: $${totalCost.toFixed(4)} USDC`));
      console.log();

      if (opts.syndicate) {
        await postToChat(opts.syndicate, "TRADE_SIGNAL" as MessageType,
          `Scanned ${results.length} tokens: ${results.filter((r) => r.result.action === "buy").map((r) => r.symbol).join(", ") || "no buys"}`,
          { results: results.map((r) => ({ symbol: r.symbol, action: r.result.action, score: r.result.compositeScore })) },
        );
      }
    });

  // ── trade buy ──

  trade
    .command("buy")
    .description("Buy a token with USDC via Uniswap Trading API")
    .requiredOption("--token <addr|symbol>", "Token to buy")
    .requiredOption("--amount <usdc>", "USDC amount to spend")
    .option("--slippage <pct>", "Slippage tolerance % (default: 0.5)", "0.5")
    .option("--stop-loss <pct>", "Stop loss percentage (default: 10)", "10")
    .option("--trailing-stop <pct>", "Trailing stop percentage (0 = disabled)", "0")
    .option("--deadline <hours>", "Force exit after N hours (0 = none)", "0")
    .option("--syndicate <name>", "Post trade to syndicate chat")
    .action(async (opts) => {
      const { address: tokenAddr, symbol, decimals } = await resolveToken(opts.token as string);
      const usdc = TOKENS().USDC;
      const usdcAmount = parseUnits(opts.amount as string, 6);
      const slippage = Number(opts.slippage);

      // Check USDC balance
      const client = getPublicClient();
      const account = getAccount();
      const balance = (await client.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;

      if (balance < usdcAmount) {
        console.error(chalk.red(
          `Insufficient USDC. Have ${formatUnits(balance, 6)}, need ${opts.amount}`,
        ));
        process.exit(1);
      }

      // Get quote via Uniswap Trading API (handles routing automatically)
      const quoteSpinner = ora("Getting quote from Uniswap API...").start();
      let expectedOut: bigint;

      try {
        const result = await uniswap.fullQuote({
          tokenIn: usdc,
          tokenOut: tokenAddr,
          amountIn: usdcAmount,
          slippageTolerance: slippage,
        });
        expectedOut = result.amountOut;
        const routing = result.routing;
        quoteSpinner.succeed(
          `Quote: ${formatUnits(result.amountOut, decimals)} ${symbol} (${routing} route)`,
        );
      } catch (err) {
        quoteSpinner.fail("Quote failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Execute swap (check_approval + quote + swap + sign + broadcast)
      const swapSpinner = ora("Executing swap via Uniswap API...").start();
      let txHash: string;
      try {
        const result = await uniswap.swap({
          tokenIn: usdc,
          tokenOut: tokenAddr,
          amountIn: usdcAmount,
          amountOutMinimum: 0n, // slippage handled by API
          fee: 3000, // unused in API mode
        });
        txHash = result.hash;

        if (!result.success) {
          swapSpinner.fail("Swap reverted");
          process.exit(1);
        }
        swapSpinner.succeed("Swap executed");
      } catch (err) {
        swapSpinner.fail("Swap failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Read actual token balance received
      const tokenBalance = (await client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;

      const tokensReceived = tokenBalance > 0n ? tokenBalance : expectedOut;
      const entryPrice = Number(opts.amount) / Number(formatUnits(tokensReceived, decimals));

      // Build exit config
      const exitConfig: ExitConfig = {
        stopLossPct: Number(opts.stopLoss) || DEFAULT_EXIT_CONFIG.stopLossPct,
        trailingStopPct: Number(opts.trailingStop) || DEFAULT_EXIT_CONFIG.trailingStopPct,
        takeProfitPct: DEFAULT_EXIT_CONFIG.takeProfitPct,
        deadlineUnix: Number(opts.deadline) > 0
          ? Math.floor(Date.now() / 1000) + Number(opts.deadline) * 3600
          : 0,
        signalExitEnabled: true,
      };

      // Save position
      addPosition({
        tokenAddress: tokenAddr,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        amountIn: opts.amount as string,
        amountOut: tokensReceived.toString(),
        entryPrice,
        highWaterPrice: entryPrice,
        feeTier: 3000, // stored for price lookups via QuoterV2
        openedAt: Math.floor(Date.now() / 1000),
        txHash,
        exitConfig,
      });

      console.log();
      console.log(chalk.bold("Trade Executed"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Token:    ${symbol} (${tokenAddr})`);
      console.log(`  Spent:    ${opts.amount} USDC`);
      console.log(`  Received: ${formatUnits(tokensReceived, decimals)} ${symbol}`);
      console.log(`  Entry:    $${entryPrice.toFixed(8)} per ${symbol}`);
      console.log(`  Stop:     -${exitConfig.stopLossPct}%`);
      if (exitConfig.trailingStopPct > 0) {
        console.log(`  Trailing: ${exitConfig.trailingStopPct}%`);
      }
      if (exitConfig.deadlineUnix > 0) {
        console.log(`  Deadline: ${new Date(exitConfig.deadlineUnix * 1000).toISOString()}`);
      }
      console.log(`  Tx:       ${chalk.dim(getExplorerUrl(txHash as `0x${string}`))}`);

      // EAS attestation (best-effort)
      try {
        const { createTradeAttestation, getEasScanUrl } = await import("../lib/eas.js");
        const { uid } = await createTradeAttestation(
          usdc, tokenAddr, usdcAmount,
          formatUnits(tokensReceived, decimals),
          txHash, "BUY",
        );
        if (uid !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
          console.log(`  Attested: ${chalk.dim(getEasScanUrl(uid))}`);
        }
      } catch {
        // Attestation is best-effort
      }

      console.log();

      if (opts.syndicate) {
        await postToChat(opts.syndicate, "TRADE_EXECUTED" as MessageType,
          `Bought ${formatUnits(tokensReceived, decimals)} ${symbol} for ${opts.amount} USDC via Uniswap`,
          { token: symbol, address: tokenAddr, amountUsdc: opts.amount, txHash },
        );
      }
    });

  // ── trade sell ──

  trade
    .command("sell")
    .description("Sell a token position back to USDC via Uniswap Trading API")
    .requiredOption("--token <addr|symbol>", "Token to sell")
    .option("--amount <n>", "Token amount to sell (default: entire position)")
    .option("--slippage <pct>", "Slippage tolerance % (default: 0.5)", "0.5")
    .option("--syndicate <name>", "Post trade to syndicate chat")
    .action(async (opts) => {
      const { address: tokenAddr, symbol, decimals } = await resolveToken(opts.token as string);
      const usdc = TOKENS().USDC;
      const slippage = Number(opts.slippage);

      // Find open position
      const positions = getOpenPositions();
      const pos = positions.find(
        (p) => p.tokenAddress.toLowerCase() === tokenAddr.toLowerCase(),
      );

      // Determine sell amount
      const client = getPublicClient();
      const account = getAccount();
      let sellAmount: bigint;

      if (opts.amount) {
        sellAmount = parseUnits(opts.amount as string, decimals);
      } else {
        sellAmount = (await client.readContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })) as bigint;
      }

      if (sellAmount === 0n) {
        console.error(chalk.red("No tokens to sell."));
        process.exit(1);
      }

      // Quote via Uniswap Trading API
      const quoteSpinner = ora("Getting quote from Uniswap API...").start();
      let expectedUsdc: bigint;

      try {
        const result = await uniswap.fullQuote({
          tokenIn: tokenAddr,
          tokenOut: usdc,
          amountIn: sellAmount,
          slippageTolerance: slippage,
        });
        expectedUsdc = result.amountOut;
        const routing = result.routing;
        quoteSpinner.succeed(
          `Quote: ${formatUnits(result.amountOut, 6)} USDC (${routing} route)`,
        );
      } catch (err) {
        quoteSpinner.fail("Quote failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Execute sell
      const swapSpinner = ora("Executing sell via Uniswap API...").start();
      let txHash: string;
      try {
        const result = await uniswap.swap({
          tokenIn: tokenAddr,
          tokenOut: usdc,
          amountIn: sellAmount,
          amountOutMinimum: 0n,
          fee: 3000,
        });
        txHash = result.hash;

        if (!result.success) {
          swapSpinner.fail("Sell reverted");
          process.exit(1);
        }
        swapSpinner.succeed("Sell executed");
      } catch (err) {
        swapSpinner.fail("Sell failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Calculate P&L
      const usdcReceived = Number(formatUnits(expectedUsdc, 6));
      const costBasis = pos ? Number(pos.amountIn) : 0;
      const pnlUsdc = costBasis > 0 ? usdcReceived - costBasis : 0;
      const pnlPct = costBasis > 0 ? (pnlUsdc / costBasis) * 100 : 0;
      const exitPrice = sellAmount > 0n
        ? usdcReceived / Number(formatUnits(sellAmount, decimals))
        : 0;

      if (pos) {
        closePosition(tokenAddr, {
          exitPrice,
          closedAt: Math.floor(Date.now() / 1000),
          exitTxHash: txHash,
          exitReason: "manual",
          pnlUsdc,
          pnlPct,
        });
      }

      const pnlColor = pnlUsdc >= 0 ? chalk.green : chalk.red;

      console.log();
      console.log(chalk.bold("Position Closed"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Token:    ${symbol}`);
      console.log(`  Sold:     ${formatUnits(sellAmount, decimals)} ${symbol}`);
      console.log(`  Received: ~${usdcReceived.toFixed(2)} USDC`);
      if (costBasis > 0) {
        console.log(`  Cost:     ${costBasis.toFixed(2)} USDC`);
        console.log(`  P&L:      ${pnlColor(`${pnlUsdc >= 0 ? "+" : ""}${pnlUsdc.toFixed(2)} USDC (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`)}`);
      }
      console.log(`  Tx:       ${chalk.dim(getExplorerUrl(txHash as `0x${string}`))}`);

      // EAS attestation (best-effort)
      try {
        const { createTradeAttestation, getEasScanUrl } = await import("../lib/eas.js");
        const { uid } = await createTradeAttestation(
          tokenAddr, usdc, sellAmount,
          usdcReceived.toFixed(6),
          txHash, "SELL",
        );
        if (uid !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
          console.log(`  Attested: ${chalk.dim(getEasScanUrl(uid))}`);
        }
      } catch {
        // Attestation is best-effort
      }

      console.log();

      if (opts.syndicate) {
        await postToChat(opts.syndicate, "TRADE_EXECUTED" as MessageType,
          `Sold ${formatUnits(sellAmount, decimals)} ${symbol} for ~${usdcReceived.toFixed(2)} USDC (P&L: ${pnlUsdc >= 0 ? "+" : ""}${pnlUsdc.toFixed(2)})`,
          { token: symbol, address: tokenAddr, usdcReceived, pnlUsdc, pnlPct, txHash },
        );
      }
    });

  // ── trade positions ──

  trade
    .command("positions")
    .description("Show open positions with current prices and unrealized P&L")
    .action(async () => {
      const positions = getOpenPositions();
      if (positions.length === 0) {
        console.log(chalk.dim("\n  No open positions.\n"));
        return;
      }

      console.log();
      console.log(chalk.bold("Open Positions"));
      console.log(chalk.dim("─".repeat(80)));
      console.log(chalk.dim(
        "  Token          Entry        Current      Qty                Cost      Value     P&L",
      ));

      for (const pos of positions) {
        try {
          const current = await getCurrentPrice(pos.tokenAddress, pos.tokenDecimals, pos.feeTier);
          const qty = Number(formatUnits(BigInt(pos.amountOut), pos.tokenDecimals));
          const cost = Number(pos.amountIn);
          const value = qty * current;
          const pnl = value - cost;
          const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
          const pnlColor = pnl >= 0 ? chalk.green : chalk.red;

          console.log(
            `  ${pos.tokenSymbol.padEnd(14)} ` +
            `$${pos.entryPrice.toFixed(6).padStart(10)}  ` +
            `$${current.toFixed(6).padStart(10)}  ` +
            `${qty.toFixed(2).padStart(15)}  ` +
            `$${cost.toFixed(2).padStart(8)}  ` +
            `$${value.toFixed(2).padStart(8)}  ` +
            pnlColor(`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`),
          );

          if (current > pos.highWaterPrice) {
            updateHighWater(pos.tokenAddress, current);
          }
        } catch {
          console.log(
            `  ${pos.tokenSymbol.padEnd(14)} ` +
            `$${pos.entryPrice.toFixed(6).padStart(10)}  ` +
            `${chalk.dim("price unavailable")}`,
          );
        }
      }
      console.log();
    });

  // ── trade monitor ──

  trade
    .command("monitor")
    .description("Monitor positions and auto-exit on signal triggers")
    .option("--interval <seconds>", "Check interval in seconds (default: 300)", "300")
    .option("--syndicate <name>", "Post updates to syndicate chat")
    .action(async (opts) => {
      const interval = Number(opts.interval) * 1000;

      console.log();
      console.log(chalk.bold("Position Monitor"));
      console.log(chalk.dim(`Checking every ${opts.interval}s. Press Ctrl-C to stop.`));
      console.log();

      const running = { value: true };
      process.on("SIGINT", () => {
        running.value = false;
        console.log(chalk.dim("\nStopping monitor..."));
      });

      while (running.value) {
        const positions = getOpenPositions();
        if (positions.length === 0) {
          console.log(chalk.dim("  No open positions. Waiting..."));
          await sleep(interval);
          continue;
        }

        for (const pos of positions) {
          if (!running.value) break;

          try {
            const current = await getCurrentPrice(pos.tokenAddress, pos.tokenDecimals, pos.feeTier);
            const hwPrice = Math.max(current, pos.highWaterPrice);
            if (current > pos.highWaterPrice) {
              updateHighWater(pos.tokenAddress, current);
            }

            // Run signal analysis for exit check
            let signalResult: SignalResult | undefined;
            if (pos.exitConfig.signalExitEnabled) {
              try {
                signalResult = await analyzeToken(pos.tokenAddress, pos.tokenSymbol);
              } catch {
                // Signal analysis can fail — continue with price-only checks
              }
            }

            const exit = checkExit(pos.entryPrice, current, hwPrice, pos.exitConfig, signalResult);
            const pnlPct = exit.currentPnlPct;
            const pnlColor = pnlPct >= 0 ? chalk.green : chalk.red;
            const ts = new Date().toLocaleTimeString();

            console.log(
              `  [${ts}] ${pos.tokenSymbol}: ` +
              `$${current.toFixed(6)} ` +
              pnlColor(`(${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`) +
              (exit.shouldExit ? chalk.red.bold(` → EXIT (${exit.reason})`) : ""),
            );

            if (exit.shouldExit) {
              console.log(chalk.yellow(`  Executing exit for ${pos.tokenSymbol}: ${exit.reason}`));

              if (opts.syndicate) {
                await postToChat(opts.syndicate, "RISK_ALERT" as MessageType,
                  `Exit triggered for ${pos.tokenSymbol}: ${exit.reason} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
                  { token: pos.tokenSymbol, reason: exit.reason, pnlPct },
                );
              }

              try {
                const sellAmount = BigInt(pos.amountOut);
                const usdc = TOKENS().USDC;

                // Get quote for P&L calculation
                const { amountOut: sellQuote } = await uniswap.fullQuote({
                  tokenIn: pos.tokenAddress,
                  tokenOut: usdc,
                  amountIn: sellAmount,
                  slippageTolerance: 0.5,
                });

                // Execute sell via Trading API
                const result = await uniswap.swap({
                  tokenIn: pos.tokenAddress,
                  tokenOut: usdc,
                  amountIn: sellAmount,
                  amountOutMinimum: 0n,
                  fee: 3000,
                });

                const usdcReceived = Number(formatUnits(sellQuote, 6));
                const costBasis = Number(pos.amountIn);
                const pnlUsdc = usdcReceived - costBasis;

                closePosition(pos.tokenAddress, {
                  exitPrice: current,
                  closedAt: Math.floor(Date.now() / 1000),
                  exitTxHash: result.hash,
                  exitReason: exit.reason,
                  pnlUsdc,
                  pnlPct,
                });

                const pnlStr = `${pnlUsdc >= 0 ? "+" : ""}${pnlUsdc.toFixed(2)} USDC`;
                console.log(chalk.green(`  Sold ${pos.tokenSymbol}: ${pnlStr}`));

                if (opts.syndicate) {
                  await postToChat(opts.syndicate, "TRADE_EXECUTED" as MessageType,
                    `Auto-sold ${pos.tokenSymbol}: ${pnlStr} (${exit.reason})`,
                    { token: pos.tokenSymbol, reason: exit.reason, pnlUsdc, pnlPct, txHash: result.hash },
                  );
                }
              } catch (err) {
                console.error(chalk.red(
                  `  Failed to sell ${pos.tokenSymbol}: ${err instanceof Error ? err.message : String(err)}`,
                ));
              }
            }
          } catch {
            console.error(chalk.dim(
              `  [${new Date().toLocaleTimeString()}] ${pos.tokenSymbol}: price check failed`,
            ));
          }
        }

        if (running.value) {
          await sleep(interval);
        }
      }

      console.log(chalk.dim("Monitor stopped."));
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
