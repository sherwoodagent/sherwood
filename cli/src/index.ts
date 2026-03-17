#!/usr/bin/env node
// Load .env if present (dev convenience — production uses ~/.sherwood/config.json)
import { config as loadDotenv } from "dotenv";
try { loadDotenv(); } catch {};
import { Command } from "commander";
import { parseUnits } from "viem";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { input, confirm, select } from "@inquirer/prompts";
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
import { uploadMetadata } from "./lib/ipfs.js";
import type { SyndicateMetadata } from "./lib/ipfs.js";
import { registerVeniceCommands } from "./commands/venice.js";
import { registerAllowanceCommands } from "./commands/allowance.js";
import { registerIdentityCommands } from "./commands/identity.js";
import { setTextRecord, getTextRecord, resolveVaultSyndicate, resolveSyndicate } from "./lib/ens.js";
import * as easLib from "./lib/eas.js";
import { EAS_SCHEMAS } from "./lib/addresses.js";

// XMTP shells out to @xmtp/cli binary — lazy-load to avoid breaking
// non-chat commands if the CLI is not installed.
async function loadXmtp() {
  return import("./lib/xmtp.js");
}
import { cacheGroupId, getCachedGroupId, setChainContract, getChainContracts, loadConfig, setPrivateKey, getAgentId } from "./lib/config.js";

// ── Theme ──
const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const SEP = () => console.log(DIM("─".repeat(60)));

/** Set vault address from --vault flag or fall back to config. */
function resolveVault(opts: { vault?: string }) {
  if (opts.vault) {
    vaultLib.setVaultAddress(opts.vault as Address);
  }
  // If no --vault flag, getVaultAddress() in vault.ts reads from config
}

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
  .description("Create a new syndicate via the factory (interactive)")
  .option("--subdomain <name>", "ENS subdomain (skip prompt)")
  .option("--name <name>", "Syndicate name (skip prompt)")
  .option("--agent-id <id>", "ERC-8004 agent identity token ID (skip prompt)")
  .option("--asset <address>", "Underlying asset address")
  .option("--max-per-tx <amount>", "Max per transaction (in asset units)")
  .option("--max-daily <amount>", "Max daily combined spend (in asset units)")
  .option("--borrow-ratio <bps>", "Max borrow ratio in basis points")
  .option("--targets <addresses>", "Comma-separated allowlisted target addresses")
  .option("--description <text>", "Short description")
  .option("--metadata-uri <uri>", "Override metadata URI (skip IPFS upload)")
  .option("--open-deposits", "Allow anyone to deposit (no whitelist)")
  .option("--public-chat", "Enable dashboard spectator mode", false)
  .action(async (opts) => {
    try {
      // ── Header ──
      console.log();
      console.log(LABEL("  ◆ Create Syndicate"));
      SEP();

      const wallet = getAccount();
      console.log(DIM(`  Wallet:  ${wallet.address}`));
      console.log(DIM(`  Network: ${getChain().name}`));
      SEP();

      // ── Gather inputs (prompt if not provided via flags) ──

      const savedAgentId = getAgentId();

      const name = opts.name || await input({
        message: G("Syndicate name"),
        validate: (v: string) => v.length > 0 || "Name is required",
      });

      const subdomain = opts.subdomain || await input({
        message: G("ENS subdomain"),
        default: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
        validate: (v: string) => v.length >= 3 || "Must be at least 3 characters",
      });

      const description = opts.description || await input({
        message: G("Description"),
        default: `${name} — a Sherwood syndicate`,
      });

      const agentIdStr = opts.agentId || (savedAgentId
        ? await input({ message: G("Agent ID (ERC-8004)"), default: String(savedAgentId) })
        : await input({ message: G("Agent ID (ERC-8004)"), validate: (v: string) => /^\d+$/.test(v) || "Must be a number" })
      );

      const openDeposits = opts.openDeposits !== undefined ? opts.openDeposits : await confirm({
        message: G("Open deposits? (anyone can deposit)"),
        default: true,
      });

      const maxPerTx = opts.maxPerTx || await input({
        message: G("Max per transaction (USDC)"),
        default: "10000",
      });

      const maxDaily = opts.maxDaily || await input({
        message: G("Max daily spend (USDC)"),
        default: "50000",
      });

      const borrowRatio = opts.borrowRatio || await input({
        message: G("Max borrow ratio (bps, 7500 = 75%)"),
        default: "7500",
      });

      // ── Resolve asset ──
      const asset = (opts.asset || TOKENS().USDC) as Address;
      const publicClient = getPublicClient();
      const [decimals, assetSymbol] = await Promise.all([
        publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
        publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
      ]);
      const symbol = `sw${assetSymbol}`;

      const targets: Address[] = opts.targets
        ? opts.targets.split(",").map((a: string) => a.trim() as Address)
        : [];

      // ── Confirmation ──
      console.log();
      console.log(LABEL("  ◆ Review"));
      SEP();
      console.log(W(`  Name:         ${BOLD(name)}`));
      console.log(W(`  ENS:          ${G(`${subdomain}.sherwoodagent.eth`)}`));
      console.log(W(`  Description:  ${DIM(description)}`));
      console.log(W(`  Agent ID:     #${agentIdStr}`));
      console.log(W(`  Asset:        ${assetSymbol} (${asset.slice(0, 10)}...)`));
      console.log(W(`  Share token:  ${symbol}`));
      console.log(W(`  Max per tx:   ${maxPerTx} ${assetSymbol}`));
      console.log(W(`  Max daily:    ${maxDaily} ${assetSymbol}`));
      console.log(W(`  Borrow ratio: ${(Number(borrowRatio) / 100).toFixed(1)}%`));
      console.log(W(`  Open deposits: ${openDeposits ? G("yes") : chalk.red("no (whitelist)")}`));
      if (targets.length > 0) {
        console.log(W(`  Targets:      ${targets.length} address(es)`));
      }
      SEP();

      const go = await confirm({ message: G("Deploy syndicate?"), default: true });
      if (!go) {
        console.log(DIM("  Cancelled."));
        return;
      }

      // ── Upload metadata to IPFS ──
      let metadataURI = opts.metadataUri || "";

      if (!metadataURI) {
        const spinner = ora({ text: W("Uploading metadata to IPFS..."), color: "green" }).start();
        try {
          const metadata: SyndicateMetadata = {
            schema: "sherwood/syndicate/v1",
            name,
            description,
            chain: getChain().name,
            strategies: [],
            terms: {
              ragequitEnabled: true,
              feeModel: "none",
            },
            links: {},
          };
          metadataURI = await uploadMetadata(metadata);
          spinner.succeed(G(`Metadata pinned: ${DIM(metadataURI)}`));
        } catch (err) {
          spinner.warn(chalk.yellow(`IPFS upload failed — using inline metadata`));
          const json = JSON.stringify({ name, description, subdomain, asset: assetSymbol, openDeposits, createdBy: "@sherwoodagent/cli" });
          metadataURI = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
        }
      }

      // ── Deploy ──
      const spinner = ora({ text: W("Deploying vault via factory..."), color: "green" }).start();

      const result = await factoryLib.createSyndicate({
        creatorAgentId: BigInt(agentIdStr),
        metadataURI,
        asset,
        name,
        symbol,
        maxPerTx: parseUnits(maxPerTx, decimals),
        maxDailyTotal: parseUnits(maxDaily, decimals),
        maxBorrowRatio: BigInt(borrowRatio),
        initialTargets: targets,
        openDeposits,
        subdomain,
      });

      // Auto-save vault address to config
      setChainContract(getChain().id, "vault", result.vault);

      // ── Register creator as agent on the vault ──
      spinner.text = W("Registering creator as agent...");
      try {
        vaultLib.setVaultAddress(result.vault);
        const creatorAddress = getAccount().address;
        await vaultLib.registerAgent(
          BigInt(agentIdStr),
          creatorAddress,        // pkp = creator EOA (direct execution)
          creatorAddress,        // operator = creator EOA
          parseUnits(maxPerTx, decimals),
          parseUnits(maxDaily, decimals),
        );
      } catch (regErr) {
        // Non-fatal — creator can register later via `syndicate add`
        console.warn(chalk.yellow("\n  ⚠ Could not auto-register creator as agent — register manually with `syndicate add`"));
      }

      spinner.text = W("Setting up chat...");

      // Create XMTP group for syndicate chat
      try {
        const xmtp = await loadXmtp();
        const xmtpClient = await xmtp.getXmtpClient();
        const groupId = await xmtp.createSyndicateGroup(xmtpClient, subdomain, opts.publicChat);
        await setTextRecord(subdomain, "xmtpGroupId", groupId, result.vault as Address);
        cacheGroupId(subdomain, groupId);
      } catch {
        console.warn(chalk.yellow("\n  ⚠ Could not create XMTP chat group"));
        console.warn(chalk.dim(`    Recover later with: sherwood chat ${subdomain} init`));
      }

      spinner.stop();

      // ── Success ──
      console.log();
      console.log(LABEL("  ◆ Syndicate Created"));
      SEP();
      console.log(W(`  ID:       ${G(`#${result.syndicateId}`)}`));
      console.log(W(`  Vault:    ${G(result.vault)}`));
      console.log(W(`  ENS:      ${G(`${subdomain}.sherwoodagent.eth`)}`));
      console.log(W(`  Metadata: ${DIM(metadataURI.length > 50 ? metadataURI.slice(0, 50) + "..." : metadataURI)}`));
      console.log(W(`  Explorer: ${DIM(getExplorerUrl(result.hash))}`));
      console.log(W(`  Chat:     ${DIM(`sherwood chat ${subdomain}`)}`));
      SEP();
      console.log(G("  ✓ Vault saved to ~/.sherwood/config.json"));
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n  ✖ ${err instanceof Error ? err.message : String(err)}`));
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
  .command("update-metadata")
  .description("Update syndicate metadata (creator only)")
  .requiredOption("--id <id>", "Syndicate ID")
  .option("--name <name>", "Syndicate name")
  .option("--description <text>", "Short description")
  .option("--uri <uri>", "Direct metadata URI (skips IPFS upload)")
  .action(async (opts) => {
    const spinner = ora({ text: W("Loading syndicate..."), color: "green" }).start();
    try {
      const syndicateId = BigInt(opts.id);
      let metadataURI = opts.uri;

      if (!metadataURI) {
        const info = await factoryLib.getSyndicate(syndicateId);
        if (!info.vault || info.vault === "0x0000000000000000000000000000000000000000") {
          spinner.fail(`Syndicate #${opts.id} not found.`);
          process.exit(1);
        }

        const name = opts.name || info.subdomain;
        const description = opts.description || `${name} — a Sherwood syndicate on ${info.subdomain}.sherwoodagent.eth`;

        spinner.text = W("Uploading metadata to IPFS...");
        const metadata: SyndicateMetadata = {
          schema: "sherwood/syndicate/v1",
          name,
          description,
          chain: getChain().name,
          strategies: [],
          terms: { ragequitEnabled: true },
          links: {},
        };
        metadataURI = await uploadMetadata(metadata);
        spinner.text = W("Updating on-chain metadata...");
      }

      const hash = await factoryLib.updateMetadata(syndicateId, metadataURI);
      spinner.succeed(G(`Metadata updated`));
      console.log(DIM(`  IPFS: ${metadataURI}`));
      console.log(DIM(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Metadata update failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("approve-depositor")
  .description("Approve an address to deposit (owner only)")
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--depositor <address>", "Address to approve")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--depositor <address>", "Address to remove")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--agent-id <id>", "Agent's ERC-8004 identity token ID")
  .requiredOption("--pkp <address>", "Agent PKP address")
  .requiredOption("--eoa <address>", "Operator EOA address")
  .requiredOption("--max-per-tx <amount>", "Max per transaction (in asset units)")
  .requiredOption("--daily-limit <amount>", "Daily limit (in asset units)")
  .action(async (opts) => {
    const spinner = ora("Verifying creator...").start();
    try {
      // Resolve vault address from --vault flag or config
      resolveVault(opts);
      const vaultAddress = vaultLib.getVaultAddress();

      // Verify caller is the syndicate creator
      const { creator, subdomain } = await resolveVaultSyndicate(vaultAddress);
      const callerAddress = getAccount().address.toLowerCase();
      if (creator.toLowerCase() !== callerAddress) {
        spinner.fail("Only the syndicate creator can add agents");
        process.exit(1);
      }

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
        console.warn(chalk.dim(`    If no group exists, run: sherwood chat ${subdomain} init`));
      }
    } catch (err) {
      spinner.fail("Registration failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── EAS Join Request / Approval Commands ──

syndicate
  .command("join")
  .description("Request to join a syndicate (creates an EAS attestation)")
  .requiredOption("--subdomain <name>", "Syndicate subdomain to join")
  .option("--message <text>", "Message to the creator", "Requesting to join your syndicate")
  .action(async (opts) => {
    const spinner = ora("Resolving syndicate...").start();
    try {
      const agentId = getAgentId();
      if (!agentId) {
        spinner.fail("No agent identity found. Run 'sherwood identity mint' first.");
        process.exit(1);
      }

      const syndicate = await resolveSyndicate(opts.subdomain);
      const callerAddress = getAccount().address;

      // Check if already registered as an agent on this vault
      spinner.text = "Checking membership...";
      vaultLib.setVaultAddress(syndicate.vault);
      const alreadyAgent = await vaultLib.isAgent(callerAddress);
      if (alreadyAgent) {
        spinner.succeed("You are already a registered agent on this syndicate");
        // Still ensure XMTP identity is ready
        try {
          const xmtp = await loadXmtp();
          await xmtp.getXmtpClient();
          console.log(chalk.dim("  XMTP identity ready"));
        } catch {
          console.warn(chalk.yellow("  ⚠ Could not initialize XMTP identity"));
        }
        return;
      }

      // Check for existing pending join request
      spinner.text = "Checking pending requests...";
      const pendingRequests = await easLib.queryJoinRequests(syndicate.creator);
      const existingRequest = pendingRequests.find(
        (r) => r.attester.toLowerCase() === callerAddress.toLowerCase()
          && r.decoded.vault.toLowerCase() === syndicate.vault.toLowerCase(),
      );
      if (existingRequest) {
        spinner.succeed("You already have a pending join request for this syndicate");
        console.log(chalk.dim(`  Attestation: ${existingRequest.uid}`));
        console.log(chalk.dim(`  Submitted:   ${new Date(existingRequest.time * 1000).toLocaleString()}`));
        // Still ensure XMTP identity is ready
        try {
          const xmtp = await loadXmtp();
          await xmtp.getXmtpClient();
          console.log(chalk.dim("  XMTP identity ready"));
        } catch {
          console.warn(chalk.yellow("  ⚠ Could not initialize XMTP identity"));
        }
        return;
      }

      spinner.text = "Creating join request attestation...";
      const { uid, hash } = await easLib.createJoinRequest(
        syndicate.id,
        BigInt(agentId),
        syndicate.vault,
        syndicate.creator,
        opts.message,
      );

      // Pre-register XMTP identity so the creator can add us to the group on approval
      try {
        spinner.text = "Registering XMTP identity...";
        const xmtp = await loadXmtp();
        await xmtp.getXmtpClient();
        spinner.succeed("Join request created (XMTP identity ready)");
      } catch {
        spinner.succeed("Join request created");
        console.warn(chalk.yellow("  ⚠ Could not initialize XMTP identity — creator may not be able to auto-add you to chat"));
      }

      console.log();
      console.log(LABEL("  ◆ Join Request Submitted"));
      SEP();
      console.log(W(`  Syndicate:    ${G(`${opts.subdomain}.sherwoodagent.eth`)}`));
      console.log(W(`  Agent ID:     #${agentId}`));
      console.log(W(`  Creator:      ${DIM(syndicate.creator)}`));
      console.log(W(`  Attestation:  ${DIM(uid)}`));
      console.log(W(`  EAS Scan:     ${DIM(easLib.getEasScanUrl(uid))}`));
      console.log(W(`  Explorer:     ${DIM(getExplorerUrl(hash))}`));
      SEP();
      console.log(G("  ✓ The creator can review with:"));
      console.log(DIM(`    sherwood syndicate requests --subdomain ${opts.subdomain}`));
      console.log();
    } catch (err) {
      spinner.fail("Join request failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("requests")
  .description("View pending join requests for a syndicate (creator only)")
  .option("--subdomain <name>", "Syndicate subdomain")
  .option("--vault <address>", "Vault address (default: from config)")
  .action(async (opts) => {
    const spinner = ora("Loading join requests...").start();
    try {
      let creatorAddress: Address;
      let subdomain: string;

      if (opts.subdomain) {
        const syndicateInfo = await resolveSyndicate(opts.subdomain);
        creatorAddress = syndicateInfo.creator;
        subdomain = opts.subdomain;
      } else {
        resolveVault(opts);
        const vaultAddress = vaultLib.getVaultAddress();
        const syndicateInfo = await resolveVaultSyndicate(vaultAddress);
        creatorAddress = syndicateInfo.creator;
        subdomain = syndicateInfo.subdomain;
      }

      // Verify caller is creator
      const callerAddress = getAccount().address.toLowerCase();
      if (creatorAddress.toLowerCase() !== callerAddress) {
        spinner.fail("Only the syndicate creator can view join requests");
        process.exit(1);
      }

      spinner.text = "Querying EAS attestations...";
      const requests = await easLib.queryJoinRequests(creatorAddress);

      spinner.stop();

      if (requests.length === 0) {
        console.log(DIM("\n  No pending join requests.\n"));
        return;
      }

      console.log();
      console.log(LABEL(`  ◆ Pending Join Requests (${requests.length})`));
      SEP();

      for (let i = 0; i < requests.length; i++) {
        const req = requests[i];
        const date = new Date(req.time * 1000).toLocaleString();
        console.log(W(`  ${i + 1}. Agent #${req.decoded.agentId} ${DIM(`(${req.attester})`)}`));
        console.log(DIM(`     Message:     "${req.decoded.message}"`));
        console.log(DIM(`     Requested:   ${date}`));
        console.log(DIM(`     Attestation: ${req.uid}`));
        console.log();
      }

      console.log(G("  To approve:"));
      console.log(DIM(`    sherwood syndicate approve --agent-id <id> --pkp <addr> --eoa <addr> --max-per-tx <amt> --daily-limit <amt>`));
      console.log(G("  To reject:"));
      console.log(DIM(`    sherwood syndicate reject --attestation <uid>`));
      console.log();
    } catch (err) {
      spinner.fail("Failed to load requests");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("approve")
  .description("Approve an agent join request (registers agent + creates EAS approval)")
  .option("--vault <address>", "Vault address (default: from config)")
  .option("--subdomain <name>", "Syndicate subdomain (alternative to --vault)")
  .requiredOption("--agent-id <id>", "Agent's ERC-8004 identity token ID")
  .requiredOption("--pkp <address>", "Agent PKP address")
  .requiredOption("--eoa <address>", "Operator EOA address")
  .requiredOption("--max-per-tx <amount>", "Max per transaction (in asset units)")
  .requiredOption("--daily-limit <amount>", "Daily limit (in asset units)")
  .option("--revoke-request <uid>", "Revoke the join request attestation after approval")
  .action(async (opts) => {
    const spinner = ora("Verifying creator...").start();
    try {
      // Resolve vault from subdomain or --vault/config
      if (opts.subdomain && !opts.vault) {
        const syndicateInfo = await resolveSyndicate(opts.subdomain);
        vaultLib.setVaultAddress(syndicateInfo.vault);
      } else {
        resolveVault(opts);
      }
      const vaultAddress = vaultLib.getVaultAddress();

      // Verify caller is creator
      const { creator, subdomain, id: syndicateId } = await resolveVaultSyndicate(vaultAddress);
      const callerAddress = getAccount().address.toLowerCase();
      if (creator.toLowerCase() !== callerAddress) {
        spinner.fail("Only the syndicate creator can approve agents");
        process.exit(1);
      }

      const decimals = await vaultLib.getAssetDecimals();
      const maxPerTx = parseUnits(opts.maxPerTx, decimals);
      const dailyLimit = parseUnits(opts.dailyLimit, decimals);

      // 1. Register agent on-chain (same as syndicate add)
      spinner.text = "Registering agent on vault...";
      try {
        const regHash = await vaultLib.registerAgent(
          BigInt(opts.agentId),
          opts.pkp as Address,
          opts.eoa as Address,
          maxPerTx,
          dailyLimit,
        );
        console.log(DIM(`  Agent registered: ${getExplorerUrl(regHash)}`));
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (msg.includes("0xe098d3ee") || msg.includes("AgentAlreadyRegistered")) {
          console.log(DIM("  Agent already registered on vault — skipping"));
        } else {
          throw regErr;
        }
      }

      // 2. Create AGENT_APPROVED attestation
      spinner.text = "Creating approval attestation...";
      const { uid: approvalUid } = await easLib.createApproval(
        syndicateId,
        BigInt(opts.agentId),
        vaultAddress,
        opts.eoa as Address,
      );

      // 3. Optionally revoke the join request
      if (opts.revokeRequest) {
        spinner.text = "Revoking join request...";
        await easLib.revokeAttestation(
          EAS_SCHEMAS().SYNDICATE_JOIN_REQUEST,
          opts.revokeRequest as `0x${string}`,
        );
      }

      // 4. Auto-add agent to XMTP chat group
      try {
        spinner.text = "Adding to chat...";
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
        console.log(DIM(`  Added to chat: ${subdomain}`));
      } catch {
        console.warn(chalk.yellow("  ⚠ Could not add agent to chat group"));
        console.warn(chalk.dim(`    If no group exists, run: sherwood chat ${subdomain} init`));
      }

      spinner.succeed("Agent approved and registered");
      console.log();
      console.log(LABEL("  ◆ Agent Approved"));
      SEP();
      console.log(W(`  Agent ID:     #${opts.agentId}`));
      console.log(W(`  PKP:          ${G(opts.pkp)}`));
      console.log(W(`  EOA:          ${G(opts.eoa)}`));
      console.log(W(`  Approval:     ${DIM(approvalUid)}`));
      console.log(W(`  EAS Scan:     ${DIM(easLib.getEasScanUrl(approvalUid))}`));
      SEP();
    } catch (err) {
      spinner.fail("Approval failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

syndicate
  .command("reject")
  .description("Reject a join request by revoking its attestation")
  .requiredOption("--attestation <uid>", "Join request attestation UID to revoke")
  .action(async (opts) => {
    const spinner = ora("Revoking attestation...").start();
    try {
      const hash = await easLib.revokeAttestation(
        EAS_SCHEMAS().SYNDICATE_JOIN_REQUEST,
        opts.attestation as `0x${string}`,
      );
      spinner.succeed("Join request rejected");
      console.log(DIM(`  ${getExplorerUrl(hash)}`));
    } catch (err) {
      spinner.fail("Rejection failed");
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── Vault commands ──
const vaultCmd = program.command("vault");

vaultCmd
  .command("deposit")
  .description("Deposit into a vault")
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--amount <amount>", "Amount to deposit (in asset units)")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .option("--address <address>", "Address to check (default: your wallet)")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--target <address>", "Target address to allow")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--target <address>", "Target address to remove")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .action(async (opts) => {
    resolveVault(opts);
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
  .option("--vault <address>", "Vault address (default: from config)")
  .requiredOption("--collateral <amount>", "WETH collateral amount (e.g. 1.0)")
  .requiredOption("--borrow <amount>", "USDC to borrow against collateral")
  .requiredOption("--token <address>", "Target token address to buy")
  .option("--fee <tier>", "Uniswap fee tier in bps (500, 3000, 10000)", "500")
  .option("--slippage <bps>", "Slippage tolerance in bps", "100")
  .option("--execute", "Actually execute on-chain (default: simulate only)", false)
  .action(async (opts) => {
    resolveVault(opts);
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

// ── Chat commands (lazy-loaded — requires @xmtp/cli binary) ──
try {
  const { registerChatCommands } = await import("./commands/chat.js");
  registerChatCommands(program);
} catch {
  program
    .command("chat <name> [action] [actionArgs...]")
    .description("Syndicate chat (XMTP) — requires @xmtp/cli")
    .action(() => {
      console.error(chalk.red("XMTP CLI not available."));
      console.error(chalk.dim("Install with:  npm install -g @xmtp/cli"));
      console.error(chalk.dim("Or reinstall:  npm i -g @sherwoodagent/cli"));
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
