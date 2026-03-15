#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { parseUnits } from "viem";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { setNetwork } from "./lib/network.js";
import { getExplorerUrl, isTestnet } from "./lib/network.js";
import { TOKENS } from "./lib/addresses.js";
import { MoonwellProvider } from "./providers/moonwell.js";
import { UniswapProvider } from "./providers/uniswap.js";
import { runLeveredSwap } from "./commands/strategy-run.js";
import * as vaultLib from "./lib/vault.js";
import * as factoryLib from "./lib/factory.js";
import * as subgraphLib from "./lib/subgraph.js";
import * as registryLib from "./lib/registry.js";

const program = new Command();

program
  .name("sherwood")
  .description("CLI for agent-managed investment syndicates")
  .version("0.1.0")
  .option("--testnet", "Use Base Sepolia testnet instead of Base mainnet", false)
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    setNetwork(opts.testnet ? "base-sepolia" : "base");
    if (opts.testnet) {
      console.log(chalk.yellow("[testnet] Base Sepolia"));
    }
  });

// ── Syndicate commands ──
const syndicate = program.command("syndicate");

syndicate
  .command("create")
  .description("Create a new syndicate via the factory")
  .requiredOption("--name <name>", "Vault token name")
  .requiredOption("--symbol <symbol>", "Vault token symbol")
  .option("--asset <address>", "Underlying asset address")
  .option("--max-per-tx <amount>", "Max USDC per transaction", "10000")
  .option("--max-daily <amount>", "Max daily combined USDC spend", "50000")
  .option("--borrow-ratio <bps>", "Max borrow ratio in basis points", "7500")
  .option("--targets <addresses>", "Comma-separated allowlisted target addresses")
  .option("--metadata-uri <uri>", "IPFS metadata URI", "")
  .option("--open-deposits", "Allow anyone to deposit (no whitelist)", false)
  .action(async (opts) => {
    const spinner = ora("Creating syndicate...").start();
    try {
      const targets: Address[] = opts.targets
        ? opts.targets.split(",").map((a: string) => a.trim() as Address)
        : [];

      const asset = (opts.asset || TOKENS().USDC) as Address;

      const hash = await factoryLib.createSyndicate({
        metadataURI: opts.metadataUri,
        asset,
        name: opts.name,
        symbol: opts.symbol,
        maxPerTx: parseUnits(opts.maxPerTx, 6),
        maxDailyTotal: parseUnits(opts.maxDaily, 6),
        maxBorrowRatio: BigInt(opts.borrowRatio),
        initialTargets: targets,
        openDeposits: opts.openDeposits,
      });
      spinner.succeed(`Syndicate created: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Syndicate creation failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("list")
  .description("List active syndicates (queries subgraph, falls back to on-chain)")
  .option("--creator <address>", "Filter by creator address")
  .action(async (opts) => {
    const spinner = ora("Loading syndicates...").start();
    try {
      // Try subgraph first (fast, indexed), fall back to on-chain
      let syndicates: { id: string | bigint; vault: string; creator: string; metadataURI: string; createdAt: string | bigint; totalDeposits?: string; totalWithdrawals?: string }[];

      if (process.env.SUBGRAPH_URL) {
        const result = await subgraphLib.getActiveSyndicates(opts.creator);
        syndicates = result;
      } else {
        const result = await factoryLib.getActiveSyndicates();
        syndicates = result.map((s) => ({
          id: s.id.toString(),
          vault: s.vault,
          creator: s.creator,
          metadataURI: s.metadataURI,
          createdAt: s.createdAt.toString(),
        }));
      }

      spinner.stop();

      if (syndicates.length === 0) {
        console.log(chalk.dim("No active syndicates found."));
        return;
      }

      console.log();
      console.log(chalk.bold(`Active Syndicates (${syndicates.length})`));
      if (!process.env.SUBGRAPH_URL) {
        console.log(chalk.dim("  (Set SUBGRAPH_URL for faster indexed queries)"));
      }
      console.log(chalk.dim("─".repeat(70)));

      for (const s of syndicates) {
        const ts = typeof s.createdAt === "string" ? Number(s.createdAt) : Number(s.createdAt);
        const date = new Date(ts * 1000).toLocaleDateString();
        console.log(`  #${s.id}  ${chalk.cyan(String(s.vault))}`);
        console.log(`    Creator: ${s.creator}`);
        console.log(`    Created: ${date}`);
        if (s.totalDeposits) {
          console.log(`    Deposits: ${s.totalDeposits} USDC`);
        }
        if (s.metadataURI) {
          console.log(`    Metadata: ${chalk.dim(s.metadataURI)}`);
        }
        console.log();
      }
    } catch (err) {
      spinner.fail("Failed to load syndicates");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("info")
  .description("Display syndicate details by ID")
  .argument("<id>", "Syndicate ID")
  .action(async (idStr) => {
    const spinner = ora("Loading syndicate info...").start();
    try {
      const id = BigInt(idStr);
      const info = await factoryLib.getSyndicate(id);
      spinner.stop();

      if (!info.vault || info.vault === "0x0000000000000000000000000000000000000000") {
        console.log(chalk.red(`Syndicate #${id} not found.`));
        process.exit(1);
      }

      const date = new Date(Number(info.createdAt) * 1000).toLocaleDateString();
      console.log();
      console.log(chalk.bold(`Syndicate #${info.id}`));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Vault:      ${chalk.cyan(info.vault)}`);
      console.log(`  Creator:    ${info.creator}`);
      console.log(`  Created:    ${date}`);
      console.log(`  Active:     ${info.active ? chalk.green("yes") : chalk.red("no")}`);
      if (info.metadataURI) {
        console.log(`  Metadata:   ${chalk.dim(info.metadataURI)}`);
      }

      // Also show vault info
      const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
      process.env[envKey] = info.vault;
      const vaultInfo = await vaultLib.getVaultInfo();
      console.log();
      console.log(chalk.bold("  Vault Stats"));
      console.log(`    Total Assets: ${vaultInfo.totalAssets} USDC`);
      console.log(`    Agent Count:  ${vaultInfo.agentCount}`);
      console.log(`    Daily Spend:  ${vaultInfo.dailySpendTotal} USDC`);
      console.log(`    Max Per Tx:   ${vaultInfo.syndicateCaps.maxPerTx} USDC`);
      console.log(`    Max Daily:    ${vaultInfo.syndicateCaps.maxDailyTotal} USDC`);
      console.log(`    Max Borrow:   ${vaultInfo.syndicateCaps.maxBorrowRatio}`);
      console.log();
    } catch (err) {
      spinner.fail("Failed to load syndicate info");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("approve-depositor")
  .description("Approve an address to deposit (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--depositor <address>", "Address to approve")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Approving depositor...").start();
    try {
      const hash = await vaultLib.approveDepositor(opts.depositor as Address);
      spinner.succeed(`Depositor approved: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Approval failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("remove-depositor")
  .description("Remove an address from the depositor whitelist (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--depositor <address>", "Address to remove")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Removing depositor...").start();
    try {
      const hash = await vaultLib.removeDepositor(opts.depositor as Address);
      spinner.succeed(`Depositor removed: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Removal failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── Vault commands ──
const vaultCmd = program.command("vault");

vaultCmd
  .command("deposit")
  .description("Deposit USDC into a vault")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--amount <amount>", "Amount of USDC to deposit")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const amount = parseUnits(opts.amount, 6);
    const spinner = ora(`Depositing ${opts.amount} USDC...`).start();
    try {
      const hash = await vaultLib.deposit(amount);
      spinner.succeed(`Deposited: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
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
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Ragequitting...").start();
    try {
      const hash = await vaultLib.ragequit();
      spinner.succeed(`Ragequit: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
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
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
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
  .command("balance")
  .description("Show LP share balance and USDC value")
  .requiredOption("--vault <address>", "Vault address")
  .option("--address <address>", "Address to check (default: your wallet)")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Loading balance...").start();
    try {
      const balance = await vaultLib.getBalance(opts.address as Address | undefined);
      spinner.stop();
      console.log();
      console.log(chalk.bold("LP Position"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Shares:       ${balance.shares.toString()}`);
      console.log(`  USDC Value:   ${balance.assetsValue} USDC`);
      console.log(`  % of Vault:   ${balance.percentOfVault}`);
      console.log();
    } catch (err) {
      spinner.fail("Failed to load balance");
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
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
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
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Registration failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("add-target")
  .description("Add a target to the vault allowlist (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--target <address>", "Target address to allow")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Adding target...").start();
    try {
      const hash = await vaultLib.addTarget(opts.target as Address);
      spinner.succeed(`Target added: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Failed to add target");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("remove-target")
  .description("Remove a target from the vault allowlist (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--target <address>", "Target address to remove")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Removing target...").start();
    try {
      const hash = await vaultLib.removeTarget(opts.target as Address);
      spinner.succeed(`Target removed: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Failed to remove target");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

vaultCmd
  .command("targets")
  .description("List allowed targets for a vault")
  .requiredOption("--vault <address>", "Vault address")
  .action(async (opts) => {
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
    const spinner = ora("Loading targets...").start();
    try {
      const targets = await vaultLib.getAllowedTargets();
      spinner.stop();
      console.log();
      console.log(chalk.bold(`Allowed Targets (${targets.length})`));
      console.log(chalk.dim("─".repeat(50)));
      for (const t of targets) {
        console.log(`  ${t}`);
      }
      console.log();
    } catch (err) {
      spinner.fail("Failed to load targets");
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
    const spinner = ora("Loading strategies...").start();
    try {
      const strategies = await registryLib.listStrategies(
        opts.type ? BigInt(opts.type) : undefined,
      );
      spinner.stop();

      if (strategies.length === 0) {
        console.log(chalk.dim("No strategies registered."));
        return;
      }

      console.log();
      console.log(chalk.bold(`Strategies (${strategies.length})`));
      console.log(chalk.dim("─".repeat(70)));
      for (const s of strategies) {
        const status = s.active ? chalk.green("active") : chalk.red("inactive");
        console.log(`  #${s.id}  ${chalk.bold(s.name)}  [type: ${s.strategyTypeId}]  ${status}`);
        console.log(`    Creator:        ${s.creator}`);
        console.log(`    Implementation: ${s.implementation}`);
        if (s.metadataURI) {
          console.log(`    Metadata:       ${chalk.dim(s.metadataURI)}`);
        }
        console.log();
      }
    } catch (err) {
      spinner.fail("Failed to load strategies");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

strategy
  .command("info")
  .description("Show strategy details")
  .argument("<id>", "Strategy ID")
  .action(async (idStr) => {
    const spinner = ora("Loading strategy...").start();
    try {
      const s = await registryLib.getStrategy(BigInt(idStr));
      spinner.stop();

      console.log();
      console.log(chalk.bold(`Strategy #${s.id}`));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Name:           ${s.name}`);
      console.log(`  Type:           ${s.strategyTypeId}`);
      console.log(`  Active:         ${s.active ? chalk.green("yes") : chalk.red("no")}`);
      console.log(`  Creator:        ${s.creator}`);
      console.log(`  Implementation: ${s.implementation}`);
      if (s.metadataURI) {
        console.log(`  Metadata:       ${chalk.dim(s.metadataURI)}`);
      }
      console.log();
    } catch (err) {
      spinner.fail("Failed to load strategy");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

strategy
  .command("register")
  .description("Register a new strategy on-chain")
  .requiredOption("--implementation <address>", "Strategy contract address")
  .requiredOption("--type <id>", "Strategy type ID")
  .requiredOption("--name <name>", "Strategy name")
  .option("--metadata <uri>", "Metadata URI (IPFS/Arweave)", "")
  .action(async (opts) => {
    const spinner = ora("Registering strategy...").start();
    try {
      const hash = await registryLib.registerStrategy(
        opts.implementation as Address,
        BigInt(opts.type),
        opts.name,
        opts.metadata,
      );
      spinner.succeed(`Strategy registered: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Registration failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
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
    const envKey = isTestnet() ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
    process.env[envKey] = opts.vault;
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
