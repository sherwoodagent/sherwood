/**
 * `sherwood strategy run` command — executes the levered swap strategy.
 *
 * Flow:
 *   1. Agent sends WETH to vault (prerequisite)
 *   2. Quote: get USDC → target token price from Uniswap
 *   3. Build batch: deposit WETH → borrow USDC → swap to target
 *   4. Simulate via vault (caps + allowlist check)
 *   5. Execute on-chain (if --execute flag)
 *
 * The vault is the onchain identity — all positions live on the vault
 * via delegatecall to a shared executor lib. Agent provides their
 * own WETH (no LP capital deployed).
 */

import type { Address } from "viem";
import { parseUnits, formatUnits, isAddress } from "viem";
import chalk from "chalk";
import ora from "ora";
import { buildEntryBatch, type LeveredSwapConfig } from "../strategies/levered-swap.js";
import { getQuote, applySlippage } from "../lib/quote.js";
import { formatBatch } from "../lib/batch.js";
import { executeBatch } from "../lib/vault.js";
import { getPublicClient } from "../lib/client.js";
import { ERC20_ABI } from "../lib/abis.js";
import { TOKENS } from "../lib/addresses.js";
import { getExplorerUrl } from "../lib/network.js";

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

  // Fetch token decimals on-chain
  const client = getPublicClient();
  let targetDecimals: number;
  let borrowDecimals: number;
  try {
    [targetDecimals, borrowDecimals] = await Promise.all([
      client.readContract({
        address: targetToken,
        abi: ERC20_ABI,
        functionName: "decimals",
      }) as Promise<number>,
      client.readContract({
        address: TOKENS().USDC,
        abi: ERC20_ABI,
        functionName: "decimals",
      }) as Promise<number>,
    ]);
  } catch {
    console.error(chalk.red(`Could not read token decimals — are the addresses valid ERC20s?`));
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
  console.log();

  // ── Get Uniswap quote (USDC → target token) ──

  const spinner = ora("Fetching Uniswap quote...").start();
  let amountOut: bigint;
  let minOut: bigint;

  try {
    const borrowAmount = parseUnits(opts.borrow, borrowDecimals);
    const quote = await getQuote({
      tokenIn: TOKENS().USDC,
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

  const calls = buildEntryBatch(config, vaultAddress, minOut, borrowDecimals);

  console.log();
  console.log(chalk.bold("Batch calls (6):"));
  console.log(formatBatch(calls));
  console.log();

  // ── Execute ──

  if (!opts.execute) {
    console.log();
    console.log(chalk.yellow("Dry run complete. Add --execute to submit on-chain."));
    console.log(chalk.dim("  Prerequisite: send WETH to vault before executing."));
    return;
  }

  const execSpinner = ora("Executing batch via vault...").start();
  try {
    const txHash = await executeBatch(calls);
    execSpinner.succeed(`Batch executed: ${txHash}`);
    console.log(chalk.dim(`  ${getExplorerUrl(txHash)}`));
  } catch (err) {
    execSpinner.fail("Execution failed");
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
