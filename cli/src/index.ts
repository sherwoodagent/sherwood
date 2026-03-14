#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { parseUnits } from "viem";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { MoonwellProvider } from "./providers/moonwell.js";
import { UniswapProvider } from "./providers/uniswap.js";
import { runLeveredSwap } from "./commands/strategy-run.js";
import * as vaultLib from "./lib/vault.js";

const program = new Command();

program
  .name("sherwood")
  .description("CLI for agent-managed investment syndicates")
  .version("0.1.0");

// ── Vault commands ──
const vaultCmd = program.command("vault");

vaultCmd
  .command("create")
  .description("Deploy a new syndicate vault")
  .option("--asset <address>", "Underlying asset (default: USDC on Base)")
  .option("--name <name>", "Vault name")
  .action(async (opts) => {
    console.log("Creating vault...", opts);
    // TODO: Deploy SyndicateVault via proxy
  });

vaultCmd
  .command("deposit")
  .description("Deposit USDC into a vault")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--amount <amount>", "Amount of USDC to deposit")
  .action(async (opts) => {
    process.env.VAULT_ADDRESS = opts.vault;
    const amount = parseUnits(opts.amount, 6);
    const spinner = ora(`Depositing ${opts.amount} USDC...`).start();
    try {
      const hash = await vaultLib.deposit(amount);
      spinner.succeed(`Deposited: ${hash}`);
      console.log(chalk.dim(`  https://basescan.org/tx/${hash}`));
    } catch (err) {
      spinner.fail("Deposit failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("ragequit")
  .description("Withdraw all shares from a vault")
  .requiredOption("--vault <address>", "Vault address")
  .action(async (opts) => {
    process.env.VAULT_ADDRESS = opts.vault;
    const spinner = ora("Ragequitting...").start();
    try {
      const hash = await vaultLib.ragequit();
      spinner.succeed(`Ragequit: ${hash}`);
      console.log(chalk.dim(`  https://basescan.org/tx/${hash}`));
    } catch (err) {
      spinner.fail("Ragequit failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("info")
  .description("Display vault state")
  .requiredOption("--vault <address>", "Vault address")
  .action(async (opts) => {
    process.env.VAULT_ADDRESS = opts.vault;
    const spinner = ora("Loading vault info...").start();
    try {
      const info = await vaultLib.getVaultInfo();
      spinner.stop();
      console.log();
      console.log(chalk.bold("Vault Info"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Address:        ${info.address}`);
      console.log(`  Total Assets:   ${info.totalAssets} USDC`);
      console.log(`  Agent Count:    ${info.agentCount}`);
      console.log(`  Daily Spend:    ${info.dailySpendTotal} USDC`);
      console.log();
      console.log(chalk.bold("  Syndicate Caps"));
      console.log(`    Max Per Tx:     ${info.syndicateCaps.maxPerTx} USDC`);
      console.log(`    Max Daily:      ${info.syndicateCaps.maxDailyTotal} USDC`);
      console.log(`    Max Borrow:     ${info.syndicateCaps.maxBorrowRatio}`);
      console.log();
    } catch (err) {
      spinner.fail("Failed to load vault info");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("register-agent")
  .description("Register an agent (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--pkp <address>", "Agent PKP address")
  .requiredOption("--eoa <address>", "Operator EOA address")
  .requiredOption("--max-per-tx <amount>", "Max USDC per transaction")
  .requiredOption("--daily-limit <amount>", "Daily USDC limit")
  .action(async (opts) => {
    process.env.VAULT_ADDRESS = opts.vault;
    const maxPerTx = parseUnits(opts.maxPerTx, 6);
    const dailyLimit = parseUnits(opts.dailyLimit, 6);
    const spinner = ora("Registering agent...").start();
    try {
      const hash = await vaultLib.registerAgent(
        opts.pkp as Address,
        opts.eoa as Address,
        maxPerTx,
        dailyLimit,
      );
      spinner.succeed(`Agent registered: ${hash}`);
    } catch (err) {
      spinner.fail("Registration failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── Strategy commands ──
const strategy = program.command("strategy");

strategy
  .command("list")
  .description("List registered strategies")
  .option("--type <id>", "Filter by strategy type")
  .action(async (opts) => {
    console.log("Listing strategies...", opts);
    // TODO: Read from StrategyRegistry contract
  });

strategy
  .command("register")
  .description("Register a new strategy on-chain")
  .requiredOption("--implementation <address>", "Strategy contract address")
  .requiredOption("--type <id>", "Strategy type ID")
  .requiredOption("--name <name>", "Strategy name")
  .option("--metadata <uri>", "Metadata URI (IPFS/Arweave)")
  .action(async (opts) => {
    console.log("Registering strategy...", opts);
    // TODO: Wire with StrategyRegistry contract
  });

strategy
  .command("run")
  .description("Execute the levered swap strategy")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--collateral <amount>", "WETH collateral amount (e.g. 1.0)")
  .requiredOption("--borrow <amount>", "USDC to borrow against collateral")
  .requiredOption("--token <address>", "Target token address to buy")
  .option("--fee <tier>", "Uniswap fee tier in bps (500, 3000, 10000)", "500")
  .option("--slippage <bps>", "Slippage tolerance in bps", "100")
  .option("--execute", "Actually execute on-chain (default: simulate only)", false)
  .action(async (opts) => {
    process.env.VAULT_ADDRESS = opts.vault;
    await runLeveredSwap(opts);
  });

// ── Provider info ──
program
  .command("providers")
  .description("List available DeFi providers")
  .action(() => {
    const providers = [new MoonwellProvider(), new UniswapProvider()];
    for (const p of providers) {
      const info = p.info();
      console.log(`\n${info.name} (${info.type})`);
      console.log(`  Capabilities: ${info.capabilities.join(", ")}`);
      console.log(`  Chains: ${info.supportedChains.map((c) => c.name).join(", ")}`);
    }
  });

program.parse();
