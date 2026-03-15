#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { parseUnits } from "viem";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { setNetwork } from "./lib/network.js";
import { getExplorerUrl, getChain } from "./lib/network.js";
import { TOKENS } from "./lib/addresses.js";
import { getPublicClient, getAccount } from "./lib/client.js";
import { ERC20_ABI } from "./lib/abis.js";
import { MoonwellProvider } from "./providers/moonwell.js";
import { UniswapProvider } from "./providers/uniswap.js";
import { runLeveredSwap } from "./commands/strategy-run.js";
import * as vaultLib from "./lib/vault.js";
import * as factoryLib from "./lib/factory.js";
import * as subgraphLib from "./lib/subgraph.js";
import * as registryLib from "./lib/registry.js";
import { registerVeniceCommands } from "./commands/venice.js";
import { registerAllowanceCommands } from "./commands/allowance.js";
import { registerIdentityCommands } from "./commands/identity.js";
import { setTextRecord, resolveVaultSyndicate } from "./lib/ens.js";

// XMTP has native bindings that crash on import if not installed correctly.
// Lazy-load to avoid breaking non-chat commands (config, identity, vault, etc.).
async function loadXmtp() {
  return import("./lib/xmtp.js");
}
import { cacheGroupId, setChainContract, getChainContracts, loadConfig, setPrivateKey } from "./lib/config.js";

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
  .requiredOption("--subdomain <name>", "ENS subdomain (e.g. alpha-seekers)")
  .requiredOption("--name <name>", "Syndicate name")
  .requiredOption("--agent-id <id>", "Your ERC-8004 agent identity token ID")
  .option("--asset <address>", "Underlying asset address")
  .option("--max-per-tx <amount>", "Max per transaction (in asset units)", "10000")
  .option("--max-daily <amount>", "Max daily combined spend (in asset units)", "50000")
  .option("--borrow-ratio <bps>", "Max borrow ratio in basis points", "7500")
  .option("--targets <addresses>", "Comma-separated allowlisted target addresses")
  .option("--metadata-uri <uri>", "IPFS metadata URI", "")
  .option("--open-deposits", "Allow anyone to deposit (no whitelist)", false)
  .option("--public-chat", "Enable dashboard spectator mode (adds read-only observer to chat)", false)
  .action(async (opts) => {
    const spinner = ora("Creating syndicate...").start();
    try {
      const targets: Address[] = opts.targets
        ? opts.targets.split(",").map((a: string) => a.trim() as Address)
        : [];

      const asset = (opts.asset || TOKENS().USDC) as Address;

      const publicClient = getPublicClient();

      // Read decimals and symbol from the asset ERC-20
      const [decimals, assetSymbol] = await Promise.all([
        publicClient.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: "decimals",
        }) as Promise<number>,
        publicClient.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: "symbol",
        }) as Promise<string>,
      ]);

      // Auto-generate vault share symbol: sw + asset symbol (e.g. swWETH, swUSDC)
      const symbol = `sw${assetSymbol}`;

      spinner.text = "Deploying vault via factory...";
      const result = await factoryLib.createSyndicate({
        creatorAgentId: BigInt(opts.agentId),
        metadataURI: opts.metadataUri,
        asset,
        name: opts.name,
        symbol,
        maxPerTx: parseUnits(opts.maxPerTx, decimals),
        maxDailyTotal: parseUnits(opts.maxDaily, decimals),
        maxBorrowRatio: BigInt(opts.borrowRatio),
        initialTargets: targets,
        openDeposits: opts.openDeposits,
        subdomain: opts.subdomain,
      });

      // Auto-save vault address to config
      setChainContract(getChain().id, "vault", result.vault);

      spinner.text = "Creating XMTP chat group...";

      // Create XMTP group for syndicate chat
      try {
        const xmtp = await loadXmtp();
        const xmtpClient = await xmtp.getXmtpClient();
        const groupId = await xmtp.createSyndicateGroup(xmtpClient, opts.subdomain, opts.publicChat);

        // Store group ID on-chain as ENS text record
        await setTextRecord(opts.subdomain, "xmtpGroupId", groupId);

        // Cache locally
        cacheGroupId(opts.subdomain, groupId);
      } catch (chatErr) {
        // Non-fatal — syndicate was created, chat setup failed
        console.warn(chalk.yellow(`  ⚠ Chat setup failed: ${chatErr instanceof Error ? chatErr.message : String(chatErr)}`));
      }

      spinner.succeed(`Syndicate #${result.syndicateId} created`);
      console.log(chalk.dim(`  Vault: ${result.vault}`));
      console.log(chalk.dim(`  ENS: ${opts.subdomain}.sherwoodagent.eth`));
      console.log(chalk.dim(`  ${getExplorerUrl(result.hash)}`));
      console.log(chalk.dim(`  Chat: sherwood chat ${opts.subdomain}`));
      console.log(chalk.dim(`  Vault saved to ~/.sherwood/config.json`));
      if (opts.publicChat) {
        console.log(chalk.dim("  Spectator mode: enabled"));
      }
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
      let syndicates: { id: string | bigint; vault: string; creator: string; metadataURI: string; createdAt: string | bigint; totalDeposits?: string; totalWithdrawals?: string; subdomain?: string }[];

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
          subdomain: s.subdomain,
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
        const ensName = s.subdomain ? `${s.subdomain}.sherwoodagent.eth` : "";
        console.log(`  #${s.id}  ${chalk.bold(ensName || String(s.vault))}`);
        if (ensName) console.log(`    Vault:   ${chalk.cyan(String(s.vault))}`);
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
      if (info.subdomain) {
        console.log(`  ENS:        ${chalk.bold(`${info.subdomain}.sherwoodagent.eth`)}`);
      }
      console.log(`  Vault:      ${chalk.cyan(info.vault)}`);
      console.log(`  Creator:    ${info.creator}`);
      console.log(`  Created:    ${date}`);
      console.log(`  Active:     ${info.active ? chalk.green("yes") : chalk.red("no")}`);
      if (info.metadataURI) {
        console.log(`  Metadata:   ${chalk.dim(info.metadataURI)}`);
      }

      // Also show vault info
      vaultLib.setVaultAddress(info.vault);
      const vaultInfo = await vaultLib.getVaultInfo();
      console.log();
      console.log(chalk.bold("  Vault Stats"));
      console.log(`    Total Assets: ${vaultInfo.totalAssets}`);
      console.log(`    Agent Count:  ${vaultInfo.agentCount}`);
      console.log(`    Daily Spend:  ${vaultInfo.dailySpendTotal}`);
      console.log(`    Max Per Tx:   ${vaultInfo.syndicateCaps.maxPerTx}`);
      console.log(`    Max Daily:    ${vaultInfo.syndicateCaps.maxDailyTotal}`);
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
    vaultLib.setVaultAddress(opts.vault as Address);
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
    vaultLib.setVaultAddress(opts.vault as Address);
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

syndicate
  .command("add")
  .description("Register an agent on a syndicate vault (creator only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--agent-id <id>", "Agent's ERC-8004 identity token ID")
  .requiredOption("--pkp <address>", "Agent PKP address")
  .requiredOption("--eoa <address>", "Operator EOA address")
  .requiredOption("--max-per-tx <amount>", "Max per transaction (in asset units)")
  .requiredOption("--daily-limit <amount>", "Daily limit (in asset units)")
  .action(async (opts) => {
    const spinner = ora("Verifying creator...").start();
    try {
      // Verify caller is the syndicate creator
      const { creator, subdomain } = await resolveVaultSyndicate(opts.vault as Address);
      const callerAddress = getAccount().address.toLowerCase();
      if (creator.toLowerCase() !== callerAddress) {
        spinner.fail("Only the syndicate creator can add agents");
        process.exit(1);
      }

      vaultLib.setVaultAddress(opts.vault as Address);
      const decimals = await vaultLib.getAssetDecimals();
      const maxPerTx = parseUnits(opts.maxPerTx, decimals);
      const dailyLimit = parseUnits(opts.dailyLimit, decimals);

      spinner.text = "Registering agent...";
      const hash = await vaultLib.registerAgent(
        BigInt(opts.agentId),
        opts.pkp as Address,
        opts.eoa as Address,
        maxPerTx,
        dailyLimit,
      );
      spinner.succeed(`Agent registered: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));

      // Auto-add agent to XMTP chat group
      try {
        const xmtp = await loadXmtp();
        const xmtpClient = await xmtp.getXmtpClient();
        const group = await xmtp.getGroup(xmtpClient, subdomain);
        await xmtp.addMember(group, opts.pkp);
        await xmtp.sendEnvelope(group, {
          type: "AGENT_REGISTERED",
          agent: { erc8004Id: Number(opts.agentId), address: opts.pkp },
          syndicate: subdomain,
          timestamp: Math.floor(Date.now() / 1000),
        });
        console.log(chalk.dim(`  Added to chat: ${subdomain}`));
      } catch {
        console.warn(chalk.yellow("  ⚠ Could not add agent to chat group"));
      }
    } catch (err) {
      spinner.fail("Registration failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("spectator")
  .description("Toggle dashboard spectator mode for a syndicate chat")
  .argument("<subdomain>", "Syndicate subdomain")
  .option("--on", "Add spectator bot")
  .option("--off", "Remove spectator bot")
  .action(async (subdomain: string, opts: { on?: boolean; off?: boolean }) => {
    if (!opts.on && !opts.off) {
      console.error(chalk.red("Specify --on or --off"));
      process.exit(1);
    }

    const spectatorAddress = process.env.DASHBOARD_SPECTATOR_ADDRESS;
    if (!spectatorAddress) {
      console.error(chalk.red("DASHBOARD_SPECTATOR_ADDRESS env var is required"));
      process.exit(1);
    }

    const spinner = ora(`${opts.on ? "Enabling" : "Disabling"} spectator mode...`).start();
    try {
      const xmtp = await loadXmtp();
      const xmtpClient = await xmtp.getXmtpClient();
      const group = await xmtp.getGroup(xmtpClient, subdomain);

      if (opts.on) {
        await xmtp.addMember(group, spectatorAddress);
        spinner.succeed("Spectator mode enabled");
      } else {
        await xmtp.removeMember(group, spectatorAddress);
        spinner.succeed("Spectator mode disabled");
      }
    } catch (err) {
      spinner.fail("Failed to toggle spectator mode");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── Vault commands ──
const vaultCmd = program.command("vault");

vaultCmd
  .command("deposit")
  .description("Deposit into a vault")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--amount <amount>", "Amount to deposit (in asset units)")
  .action(async (opts) => {
    vaultLib.setVaultAddress(opts.vault as Address);
    const decimals = await vaultLib.getAssetDecimals();
    const amount = parseUnits(opts.amount, decimals);
    const spinner = ora(`Depositing ${opts.amount}...`).start();
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
    vaultLib.setVaultAddress(opts.vault as Address);
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
    vaultLib.setVaultAddress(opts.vault as Address);
    const spinner = ora("Loading vault info...").start();
    try {
      const info = await vaultLib.getVaultInfo();
      spinner.stop();
      console.log();
      console.log(chalk.bold("Vault Info"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Address:        ${info.address}`);
      console.log(`  Total Assets:   ${info.totalAssets}`);
      console.log(`  Agent Count:    ${info.agentCount}`);
      console.log(`  Daily Spend:    ${info.dailySpendTotal}`);
      console.log();
      console.log(chalk.bold("  Syndicate Caps"));
      console.log(`    Max Per Tx:     ${info.syndicateCaps.maxPerTx}`);
      console.log(`    Max Daily:      ${info.syndicateCaps.maxDailyTotal}`);
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
  .description("Show LP share balance and asset value")
  .requiredOption("--vault <address>", "Vault address")
  .option("--address <address>", "Address to check (default: your wallet)")
  .action(async (opts) => {
    vaultLib.setVaultAddress(opts.vault as Address);
    const spinner = ora("Loading balance...").start();
    try {
      const balance = await vaultLib.getBalance(opts.address as Address | undefined);
      spinner.stop();
      console.log();
      console.log(chalk.bold("LP Position"));
      console.log(chalk.dim("─".repeat(40)));
      console.log(`  Shares:       ${balance.shares.toString()}`);
      console.log(`  Asset Value:  ${balance.assetsValue}`);
      console.log(`  % of Vault:   ${balance.percentOfVault}`);
      console.log();
    } catch (err) {
      spinner.fail("Failed to load balance");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// register-agent removed — use "syndicate add" instead

vaultCmd
  .command("add-target")
  .description("Add a target to the vault allowlist (owner only)")
  .requiredOption("--vault <address>", "Vault address")
  .requiredOption("--target <address>", "Target address to allow")
  .action(async (opts) => {
    vaultLib.setVaultAddress(opts.vault as Address);
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
    vaultLib.setVaultAddress(opts.vault as Address);
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
    vaultLib.setVaultAddress(opts.vault as Address);
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
    vaultLib.setVaultAddress(opts.vault as Address);
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

// ── Chat commands (lazy-loaded — XMTP has native bindings that may not be available) ──
try {
  const { registerChatCommands } = await import("./commands/chat.js");
  registerChatCommands(program);
} catch {
  program
    .command("chat")
    .description("Syndicate chat (XMTP) — requires native bindings")
    .action(() => {
      console.error(chalk.red("XMTP native bindings not available."));
      console.error(chalk.dim("Try: cd cli && rm -rf node_modules package-lock.json && npm i"));
      process.exit(1);
    });
}

// ── Venice commands ──
registerVeniceCommands(program);

// ── Allowance commands ──
registerAllowanceCommands(program);

// ── Identity commands ──
registerIdentityCommands(program);

// ── Config commands ──
const configCmd = program.command("config");

configCmd
  .command("set")
  .description("Save settings to ~/.sherwood/config.json (persists across sessions)")
  .option("--private-key <key>", "Wallet private key (0x-prefixed)")
  .option("--vault <address>", "Default SyndicateVault address")
  .action((opts) => {
    let saved = false;

    if (opts.privateKey) {
      setPrivateKey(opts.privateKey);
      const account = getAccount();
      console.log(chalk.green("Private key saved to ~/.sherwood/config.json"));
      console.log(chalk.dim(`  Wallet: ${account.address}`));
      saved = true;
    }

    if (opts.vault) {
      const chainId = getChain().id;
      setChainContract(chainId, "vault", opts.vault);
      console.log(chalk.green(`Vault saved to ~/.sherwood/config.json (chain ${chainId})`));
      console.log(chalk.dim(`  Vault: ${opts.vault}`));
      saved = true;
    }

    if (!saved) {
      console.log(chalk.red("Provide at least one of: --private-key, --vault"));
      process.exit(1);
    }
  });

configCmd
  .command("show")
  .description("Display current config for the active network")
  .action(() => {
    const chainId = getChain().id;
    const contracts = getChainContracts(chainId);
    const config = loadConfig();

    console.log();
    console.log(chalk.bold(`Sherwood Config (chain ${chainId})`));
    console.log(chalk.dim("─".repeat(50)));
    console.log(`  Wallet:     ${config.privateKey ? chalk.green("configured") : chalk.dim("not set")}`);
    console.log(`  Agent ID:   ${config.agentId ?? chalk.dim("not set")}`);
    console.log(`  Vault:      ${contracts.vault ?? chalk.dim("not set")}`);
    console.log();
    console.log(chalk.dim("  Config file: ~/.sherwood/config.json"));
    console.log();
  });

program.parse();
