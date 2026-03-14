/**
 * `sherwood strategy run` command — executes the levered swap strategy.
 *
 * Flow:
 *   1. Agent sends WETH to executor (prerequisite)
 *   2. Quote: get USDC → target token price from Uniswap
 *   3. Build batch: deposit WETH → borrow USDC → swap to target
 *   4. Simulate via vault (authorization check)
 *   5. Execute on-chain (if --execute flag)
 *
 * The vault acts as authorization layer only (assetAmount=0).
 * Agent provides their own WETH as collateral.
 */

import type { Address } from "viem";
import { parseUnits, formatUnits, isAddress } from "viem";
import chalk from "chalk";
import ora from "ora";
import { buildEntryBatch, type LeveredSwapConfig } from "../strategies/levered-swap.js";
import { getQuote, applySlippage } from "../lib/quote.js";
import { encodeBatchExecute, formatBatch } from "../lib/batch.js";
import { executeStrategy, simulateStrategy } from "../lib/vault.js";
import { getPublicClient } from "../lib/client.js";
import { ERC20_ABI } from "../lib/abis.js";
import { TOKENS } from "../lib/addresses.js";

const VALID_FEES = [500, 3000, 10000] as const;

export async function runLeveredSwap(opts: {
  vault: string;
  collateral: string; // WETH amount (e.g. "1.0")
  borrow: string; // USDC amount (e.g. "1000")
  token: string; // target token address
  fee: string;
  slippage: string;
  execute: boolean;
}): Promise<void> {
  // ── Validate inputs ──

  const vaultAddress = opts.vault as Address;
  const executorAddress = process.env.BATCH_EXECUTOR_ADDRESS as Address;
  if (!executorAddress) {
    console.error(chalk.red("BATCH_EXECUTOR_ADDRESS env var is required"));
    process.exit(1);
  }

  if (!isAddress(opts.token)) {
    console.error(chalk.red(`Invalid token address: ${opts.token}`));
    process.exit(1);
  }
  const targetToken = opts.token as Address;

  const feeTier = Number(opts.fee);
  if (!VALID_FEES.includes(feeTier as 500 | 3000 | 10000)) {
    console.error(chalk.red(`Invalid fee tier: ${opts.fee}. Valid: ${VALID_FEES.join(", ")}`));
    process.exit(1);
  }

  const slippageBps = Number(opts.slippage);

  // Fetch target token decimals on-chain
  const client = getPublicClient();
  let targetDecimals: number;
  try {
    targetDecimals = await client.readContract({
      address: targetToken,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as number;
  } catch {
    console.error(chalk.red(`Could not read decimals for ${targetToken} — is it a valid ERC20?`));
    process.exit(1);
  }

  // ── Display config ──

  console.log();
  console.log(chalk.bold("Levered Swap Strategy"));
  console.log(chalk.dim("─".repeat(40)));
  console.log(`  Collateral:  ${opts.collateral} WETH (agent-provided)`);
  console.log(`  Borrow:      ${opts.borrow} USDC (from Moonwell)`);
  console.log(`  Buy:         ${targetToken} (${targetDecimals} decimals)`);
  console.log(`  Fee tier:    ${(feeTier / 10000 * 100).toFixed(2)}%`);
  console.log(`  Slippage:    ${(slippageBps / 100).toFixed(2)}%`);
  console.log(`  Vault:       ${vaultAddress}`);
  console.log(`  Executor:    ${executorAddress}`);
  console.log();

  // ── Get Uniswap quote (USDC → target token) ──

  const spinner = ora("Fetching Uniswap quote...").start();
  let amountOut: bigint;
  let minOut: bigint;

  try {
    const borrowAmount = parseUnits(opts.borrow, 6);
    const quote = await getQuote({
      tokenIn: TOKENS.USDC,
      tokenOut: targetToken,
      amountIn: borrowAmount,
      fee: feeTier,
    });
    amountOut = quote.amountOut;
    minOut = applySlippage(amountOut, slippageBps);
    spinner.succeed(
      `Quote: ${formatUnits(amountOut, targetDecimals)} tokens ` +
      `(min: ${formatUnits(minOut, targetDecimals)}, gas est: ${quote.gasEstimate})`
    );
  } catch (err) {
    spinner.fail("Failed to fetch quote");
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // ── Build entry batch ──

  const config: LeveredSwapConfig = {
    collateralAmount: opts.collateral,
    borrowAmount: opts.borrow,
    targetToken,
    fee: feeTier as 500 | 3000 | 10000,
    slippageBps,
    profitTargetBps: 2000, // 20% default
    stopLossBps: 1000, // 10% default
  };

  const calls = buildEntryBatch(config, executorAddress, minOut);

  console.log();
  console.log(chalk.bold("Batch calls (6):"));
  console.log(formatBatch(calls));
  console.log();

  // ── Encode for vault ──

  const batchCalldata = encodeBatchExecute(calls);
  // assetAmount=0: no vault capital at risk, agent provides own WETH
  const assetAmount = 0n;

  // ── Simulate ──

  const simSpinner = ora("Simulating via vault...").start();
  try {
    await simulateStrategy(executorAddress, batchCalldata, assetAmount);
    simSpinner.succeed("Simulation passed");
  } catch (err) {
    simSpinner.fail("Simulation failed");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(msg));
    if (!opts.execute) {
      process.exit(1);
    }
    console.log(chalk.yellow("Continuing to execution despite simulation failure..."));
  }

  // ── Execute ──

  if (!opts.execute) {
    console.log();
    console.log(chalk.yellow("Dry run complete. Add --execute to submit on-chain."));
    console.log(chalk.dim("  Prerequisite: send WETH to executor before executing."));
    return;
  }

  const execSpinner = ora("Executing strategy via vault...").start();
  try {
    const txHash = await executeStrategy(executorAddress, batchCalldata, assetAmount);
    execSpinner.succeed(`Strategy executed: ${txHash}`);
    console.log(chalk.dim(`  https://basescan.org/tx/${txHash}`));
  } catch (err) {
    execSpinner.fail("Execution failed");
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
