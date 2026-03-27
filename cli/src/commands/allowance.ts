/**
 * Allowance commands — sherwood allowance <subcommand>
 *
 * Disburses vault profits as USDC to agent operator wallets for
 * operational expenses (gas, x402 API payments, etc.).
 */

import { Command } from "commander";
import type { Address } from "viem";
import { parseUnits, formatUnits, isAddress } from "viem";
import chalk from "chalk";
import ora from "ora";
import { getPublicClient, getAccount, formatContractError } from "../lib/client.js";
import { getExplorerUrl } from "../lib/network.js";
import { TOKENS } from "../lib/addresses.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI } from "../lib/abis.js";
import { getQuote, getMultiHopQuote, encodeSwapPath, applySlippage } from "../lib/quote.js";
import { formatBatch } from "../lib/batch.js";
import { executeBatch } from "../lib/vault.js";
import { buildDisburseBatch, type AllowanceDisbursConfig } from "../strategies/allowance-disburse.js";

const VALID_FEES = [500, 3000, 10000] as const;

export function registerAllowanceCommands(program: Command): void {
  const allowance = program.command("allowance").description("Disburse vault profits to agent wallets");

  // ── allowance disburse ──

  allowance
    .command("disburse")
    .description("Swap vault profits → USDC → distribute to all agent operator wallets")
    .requiredOption("--vault <address>", "Vault address")
    .requiredOption("--amount <amount>", "Deposit token amount to convert & distribute (e.g. 500)")
    .option("--fee <tier>", "Fee tier for asset → USDC swap (500, 3000, 10000)", "3000")
    .option("--slippage <bps>", "Slippage tolerance in bps", "100")
    .option("--execute", "Execute on-chain (default: simulate only)", false)
    .action(async (opts) => {
      const vaultAddress = opts.vault as Address;
      if (!isAddress(vaultAddress)) {
        console.error(chalk.red(`Invalid vault address: ${opts.vault}`));
        process.exit(1);
      }

      const fee = Number(opts.fee);
      if (!VALID_FEES.includes(fee as 500 | 3000 | 10000)) {
        console.error(chalk.red(`Invalid fee tier. Valid: ${VALID_FEES.join(", ")}`));
        process.exit(1);
      }
      const slippageBps = Number(opts.slippage);

      const client = getPublicClient();

      // ── Read vault state ──

      const spinner = ora("Reading vault state...").start();
      let assetAddress: Address;
      let assetDecimals: number;
      let assetSymbol: string;
      let totalDeposited: bigint;
      let assetBalance: bigint;
      let agents: Address[];

      try {
        [assetAddress, totalDeposited, agents] = await Promise.all([
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "asset" }) as Promise<Address>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "totalDeposited" }) as Promise<bigint>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "getAgentAddresses" }) as Promise<Address[]>,
        ]);

        [assetDecimals, assetSymbol, assetBalance] = await Promise.all([
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail("Failed to read vault state");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

      if (agents.length === 0) {
        console.error(chalk.red("No agents registered in vault. Register agents first."));
        process.exit(1);
      }

      const requestedAmount = parseUnits(opts.amount, assetDecimals);
      const profit = assetBalance > totalDeposited ? assetBalance - totalDeposited : 0n;

      // ── Display config ──

      const isUsdc = assetAddress.toLowerCase() === TOKENS().USDC.toLowerCase();
      const isWeth = assetAddress.toLowerCase() === TOKENS().WETH.toLowerCase();

      console.log();
      console.log(chalk.bold("Allowance Disburse"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Asset:         ${assetSymbol} (${assetDecimals} decimals)`);
      console.log(`  Amount:        ${opts.amount} ${assetSymbol}`);
      console.log(`  Vault balance: ${formatUnits(assetBalance, assetDecimals)} ${assetSymbol}`);
      console.log(`  Deposited:     ${formatUnits(totalDeposited, assetDecimals)} ${assetSymbol}`);
      console.log(`  Profit:        ${formatUnits(profit, assetDecimals)} ${assetSymbol}`);
      console.log(`  Agents:        ${agents.length} (USDC will be split equally)`);
      if (!isUsdc) {
        console.log(`  Routing:       ${isWeth ? `WETH → USDC (fee ${fee})` : `${assetSymbol} → WETH → USDC (fee ${fee})`}`);
        console.log(`  Slippage:      ${(slippageBps / 100).toFixed(2)}%`);
      }
      console.log(`  Vault:         ${vaultAddress}`);
      console.log();

      if (requestedAmount > profit) {
        console.warn(chalk.yellow(`  Warning: amount (${opts.amount}) exceeds available profit (${formatUnits(profit, assetDecimals)})`));
        console.warn(chalk.yellow("  This will use deposited capital, not just profits."));
        console.log();
      }

      // ── Get USDC amount (quote or direct) ──

      let minUsdc: bigint;
      let swapPath: `0x${string}` | null = null;

      if (isUsdc) {
        // No swap needed — distribute the asset directly
        minUsdc = requestedAmount;
      } else {
        const quoteSpinner = ora("Fetching Uniswap quote...").start();
        try {
          let amountOut: bigint;

          if (isWeth) {
            // Single-hop: WETH → USDC
            const quote = await getQuote({
              tokenIn: TOKENS().WETH,
              tokenOut: TOKENS().USDC,
              amountIn: requestedAmount,
              fee,
            });
            amountOut = quote.amountOut;
          } else {
            // Multi-hop: asset → WETH → USDC
            swapPath = encodeSwapPath(
              [assetAddress, TOKENS().WETH, TOKENS().USDC],
              [fee, 500], // WETH→USDC typically uses 500 (0.05%) fee tier
            );
            const quote = await getMultiHopQuote({
              path: swapPath,
              amountIn: requestedAmount,
            });
            amountOut = quote.amountOut;
          }

          minUsdc = applySlippage(amountOut, slippageBps);

          quoteSpinner.succeed(
            `Quote: ${formatUnits(amountOut, 6)} USDC ` +
            `(min: ${formatUnits(minUsdc, 6)}, per agent: ${formatUnits(minUsdc / BigInt(agents.length), 6)})`
          );
        } catch (err) {
          quoteSpinner.fail("Failed to fetch quote");
          console.error(chalk.red(formatContractError(err)));
          process.exit(1);
        }
      }

      // ── Per-agent display ──

      const perAgent = minUsdc / BigInt(agents.length);
      if (isUsdc) {
        console.log(chalk.dim(`  Per agent: ${formatUnits(perAgent, 6)} USDC`));
        console.log();
      }

      // ── Build batch ──

      const config: AllowanceDisbursConfig = {
        amount: opts.amount,
        fee,
        slippageBps,
      };

      const calls = buildDisburseBatch(config, vaultAddress, agents, assetAddress, assetDecimals, minUsdc, swapPath);

      console.log();
      console.log(chalk.bold(`Batch calls (${calls.length}):`));
      console.log(formatBatch(calls));
      console.log();

      // ── Execute ──

      if (!opts.execute) {
        console.log();
        console.log(chalk.yellow("Dry run complete. Add --execute to submit on-chain."));
        return;
      }

      const execSpinner = ora("Executing batch via vault...").start();
      try {
        const txHash = await executeBatch(calls);
        execSpinner.succeed(`Batch executed: ${txHash}`);
        console.log(chalk.dim(`  ${getExplorerUrl(txHash)}`));
      } catch (err) {
        execSpinner.fail("Execution failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── allowance status ──

  allowance
    .command("status")
    .description("Show vault profit and agent USDC balances")
    .requiredOption("--vault <address>", "Vault address")
    .action(async (opts) => {
      const vaultAddress = opts.vault as Address;
      if (!isAddress(vaultAddress)) {
        console.error(chalk.red(`Invalid vault address: ${opts.vault}`));
        process.exit(1);
      }

      const client = getPublicClient();
      const spinner = ora("Loading allowance status...").start();

      try {
        // Read vault state
        const [assetAddress, totalDeposited, agents] = await Promise.all([
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "asset" }) as Promise<Address>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "totalDeposited" }) as Promise<bigint>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "getAgentAddresses" }) as Promise<Address[]>,
        ]);

        const [assetDecimals, assetSymbol, assetBalance] = await Promise.all([
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
        ]);

        // Read per-agent USDC balances
        const agentBalances = await Promise.all(
          agents.map(async (agent) => {
            const bal = await client.readContract({
              address: TOKENS().USDC,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [agent],
            }) as bigint;
            return { agent, balance: bal };
          })
        );

        spinner.stop();

        const profit = assetBalance > totalDeposited ? assetBalance - totalDeposited : 0n;
        const account = getAccount();

        console.log();
        console.log(chalk.bold("Allowance Status"));
        console.log(chalk.dim("─".repeat(50)));

        console.log(chalk.bold("\n  Vault"));
        console.log(`    Asset:           ${assetSymbol}`);
        console.log(`    Balance:         ${formatUnits(assetBalance, assetDecimals)} ${assetSymbol}`);
        console.log(`    Deposited:       ${formatUnits(totalDeposited, assetDecimals)} ${assetSymbol}`);
        console.log(`    Profit:          ${formatUnits(profit, assetDecimals)} ${assetSymbol}`);

        console.log(chalk.bold("\n  Agent USDC Balances"));
        for (const { agent, balance } of agentBalances) {
          const isMe = agent.toLowerCase() === account.address.toLowerCase();
          const label = isMe ? chalk.green(`${agent} (you)`) : agent;
          console.log(`    ${label}: ${formatUnits(balance, 6)} USDC`);
        }
        console.log();
      } catch (err) {
        spinner.fail("Failed to load status");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });
}
