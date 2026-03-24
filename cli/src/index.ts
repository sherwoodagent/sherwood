#!/usr/bin/env node
// Load .env if present (dev convenience — production uses ~/.sherwood/config.json)
import { config as loadDotenv } from "dotenv";
try { loadDotenv(); } catch {};
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../package.json");
import { Command, Option } from "commander";
import { parseUnits, isAddress } from "viem";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { input, confirm, select } from "@inquirer/prompts";
import { setNetwork, getNetwork, VALID_NETWORKS } from "./lib/network.js";
import { getExplorerUrl, getChain } from "./lib/network.js";
import type { Network } from "./lib/network.js";
import { TOKENS } from "./lib/addresses.js";
import { getPublicClient, getAccount } from "./lib/client.js";
import { ERC20_ABI } from "./lib/abis.js";
import { MoonwellProvider } from "./providers/moonwell.js";
import { UniswapProvider } from "./providers/uniswap.js";
import { registerStrategyTemplateCommands } from "./commands/strategy-template.js";
import * as vaultLib from "./lib/vault.js";
import * as factoryLib from "./lib/factory.js";
import * as subgraphLib from "./lib/subgraph.js";
// registryLib removed — strategy registry is deprecated, replaced by template commands
import { uploadMetadata } from "./lib/ipfs.js";
import type { SyndicateMetadata } from "./lib/ipfs.js";
import { registerVeniceCommands } from "./commands/venice.js";
import { registerAllowanceCommands } from "./commands/allowance.js";
import { registerIdentityCommands } from "./commands/identity.js";
import { registerProposalCommands } from "./commands/proposal.js";
import { registerGovernorCommands } from "./commands/governor.js";
import { setTextRecord, getTextRecord, resolveVaultSyndicate, resolveSyndicate } from "./lib/ens.js";
import * as easLib from "./lib/eas.js";
import { EAS_SCHEMAS } from "./lib/addresses.js";

// XMTP shells out to @xmtp/cli binary — lazy-load to avoid breaking
// non-chat commands if the CLI is not installed.
async function loadXmtp() {
  return import("./lib/xmtp.js");
}
// Lazy-load cron module (only needed for openclaw agents)
async function loadCron() {
  return import("./lib/cron.js");
}
import { cacheGroupId, getCachedGroupId, setChainContract, getChainContracts, loadConfig, setPrivateKey, getAgentId, setConfigRpcUrl, getNotifyTo, setNotifyTo, setUniswapApiKey, getUniswapApiKey, setVeniceApiKey, getVeniceApiKey } from "./lib/config.js";
import { isTestnet } from "./lib/network.js";

// ── Theme ──
const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const SEP = () => console.log(DIM("─".repeat(60)));

function validateAddress(value: string, name: string): Address {
  if (!isAddress(value)) {
    console.error(chalk.red(`Invalid ${name} address: ${value}`));
    process.exit(1);
  }
  return value as Address;
}

/** Set vault address from --vault flag or fall back to config. */
function resolveVault(opts: { vault?: string }) {
  if (opts.vault) {
    vaultLib.setVaultAddress(validateAddress(opts.vault, "vault"));
  }
  // If no --vault flag, getVaultAddress() in vault.ts reads from config
}

const program = new Command();

program
  .name("sherwood")
  .description("CLI for agent-managed investment syndicates")
  .version(CLI_VERSION)
  .addOption(
    new Option("--chain <network>", "Target network")
      .choices(VALID_NETWORKS)
      .default("base"),
  )
  .option("--testnet", "Alias for --chain base-sepolia (deprecated)", false)
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    let network: string = opts.chain;
    if (opts.testnet) {
      process.env.ENABLE_TESTNET = "true";
      if (network !== "base") {
        console.warn(
          chalk.yellow("[warn] --testnet ignored, --chain takes precedence"),
        );
      } else {
        network = "base-sepolia";
      }
    }
    setNetwork(network as Network);
    if (getNetwork() !== "base") {
      console.log(chalk.yellow(`[${getNetwork()}]`));
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
  .option("--asset <symbol-or-address>", "Vault asset: USDC, WETH, or a token address")
  .option("--description <text>", "Short description")
  .option("--metadata-uri <uri>", "Override metadata URI (skip IPFS upload)")
  .option("--open-deposits", "Allow anyone to deposit (no whitelist)")
  .option("--public-chat", "Enable dashboard spectator mode", false)
  .option("-y, --yes", "Skip confirmation prompt (non-interactive mode)", false)
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

      const nonInteractive = opts.yes;

      const name = opts.name || (nonInteractive
        ? (() => { throw new Error("--name is required in non-interactive mode (-y)"); })()
        : await input({
            message: G("Syndicate name"),
            validate: (v: string) => v.length > 0 || "Name is required",
          }));

      const subdomain = opts.subdomain || (nonInteractive
        ? name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
        : await input({
            message: G("ENS subdomain"),
            default: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
            validate: (v: string) => v.length >= 3 || "Must be at least 3 characters",
          }));

      const description = opts.description || (nonInteractive
        ? `${name} — a Sherwood syndicate`
        : await input({
            message: G("Description"),
            default: `${name} — a Sherwood syndicate`,
          }));

      const agentIdStr = opts.agentId || (savedAgentId
        ? (nonInteractive
            ? String(savedAgentId)
            : await input({ message: G("Agent ID (ERC-8004)"), default: String(savedAgentId) }))
        : (nonInteractive
            ? "0"
            : await input({ message: G("Agent ID (ERC-8004)"), validate: (v: string) => /^\d+$/.test(v) || "Must be a number" }))
      );

      const openDeposits = opts.openDeposits !== undefined ? opts.openDeposits : (nonInteractive
        ? true
        : await confirm({
            message: G("Open deposits? (anyone can deposit)"),
            default: true,
          }));

      // ── Resolve asset ──
      // Supported symbols (testnet + mainnet). Will expand on mainnet launch.
      const ASSET_SYMBOLS: Record<string, Address> = {
        USDC: TOKENS().USDC,
        WETH: TOKENS().WETH,
      };

      let asset: Address;
      if (opts.asset) {
        const upper = opts.asset.toUpperCase();
        if (ASSET_SYMBOLS[upper]) {
          asset = ASSET_SYMBOLS[upper];
        } else if (opts.asset.startsWith("0x") && opts.asset.length === 42) {
          asset = opts.asset as Address;
        } else {
          const supported = Object.keys(ASSET_SYMBOLS).join(", ");
          console.error(chalk.red(`  Unknown asset "${opts.asset}". Use a symbol (${supported}) or a 0x address.`));
          process.exit(1);
        }
      } else if (nonInteractive) {
        // Default to WETH on chains without USDC, otherwise USDC
        asset = TOKENS().USDC !== "0x0000000000000000000000000000000000000000"
          ? ASSET_SYMBOLS.USDC
          : ASSET_SYMBOLS.WETH;
      } else {
        // Interactive prompt
        const assetChoice = await select({
          message: G("Vault asset (what token do depositors provide?)"),
          choices: [
            { name: "USDC", value: "USDC", description: "USD Coin (6 decimals)" },
            { name: "WETH", value: "WETH", description: "Wrapped Ether (18 decimals)" },
          ],
        });
        asset = ASSET_SYMBOLS[assetChoice];
      }

      const publicClient = getPublicClient();
      const [decimals, assetSymbol] = await Promise.all([
        publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
        publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
      ]);
      const symbol = `sw${assetSymbol}`;

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
      console.log(W(`  Open deposits: ${openDeposits ? G("yes") : chalk.red("no (whitelist)")}`));
      SEP();

      if (!nonInteractive) {
        const go = await confirm({ message: G("Deploy syndicate?"), default: true });
        if (!go) {
          console.log(DIM("  Cancelled."));
          return;
        }
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
        openDeposits,
        subdomain,
      });

      // Auto-save vault address to config
      setChainContract(getChain().id, "vault", result.vault);

      // ── Register creator as agent on the vault ──
      // Brief delay to let the RPC node sync its nonce after createSyndicate tx
      await new Promise((r) => setTimeout(r, 2000));
      spinner.text = W("Registering creator as agent...");
      try {
        vaultLib.setVaultAddress(result.vault);
        const creatorAddress = getAccount().address;
        await vaultLib.registerAgent(
          BigInt(agentIdStr),
          creatorAddress,        // agentAddress = creator EOA (direct execution)
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

      // ── Auto-register participation crons ──
      try {
        const cron = await loadCron();
        const cronResult = cron.registerSyndicateCrons(subdomain, isTestnet(), getNotifyTo());
        if (cronResult.isOpenClaw && cronResult.registered) {
          console.log(G("  ✓ Participation crons registered (15m check + hourly summary)"));
        } else if (!cronResult.isOpenClaw) {
          console.log(DIM("  Tip: Set up a scheduled process to run `sherwood session check " + subdomain + "` periodically"));
        }
      } catch { /* non-fatal */ }

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
      console.log(`    Total Assets:       ${vaultInfo.totalAssets}`);
      console.log(`    Agent Count:        ${vaultInfo.agentCount}`);
      console.log(`    Redemptions Locked: ${vaultInfo.redemptionsLocked}`);
      console.log(`    Management Fee:     ${Number(vaultInfo.managementFeeBps) / 100}%`);
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
          terms: {},
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
      const depositor = validateAddress(opts.depositor, "depositor");
      const hash = await vaultLib.approveDepositor(depositor);
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
      const depositor = validateAddress(opts.depositor, "depositor");
      const hash = await vaultLib.removeDepositor(depositor);
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
  .requiredOption("--wallet <address>", "Agent wallet address")
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

      const agentWallet = validateAddress(opts.wallet, "wallet");
      spinner.text = "Registering agent...";
      const hash = await vaultLib.registerAgent(
        BigInt(opts.agentId),
        agentWallet,
      );
      spinner.succeed(`Agent registered: ${hash}`);
      console.log(chalk.dim(`  ${getExplorerUrl(hash)}`));

      // Auto-add agent to XMTP chat group
      try {
        const xmtp = await loadXmtp();
        const xmtpClient = await xmtp.getXmtpClient();
        const group = await xmtp.getGroup(xmtpClient, subdomain);
        await xmtp.addMember(group, opts.wallet);
        await xmtp.sendEnvelope(group, {
          type: "AGENT_REGISTERED",
          agent: { erc8004Id: Number(opts.agentId), address: opts.wallet },
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
        // Auto-register participation crons (idempotent)
        try {
          const cron = await loadCron();
          const cronResult = cron.registerSyndicateCrons(opts.subdomain, isTestnet(), getNotifyTo());
          if (cronResult.isOpenClaw && cronResult.registered) {
            console.log(chalk.green("  ✓ Participation crons registered"));
          } else if (!cronResult.isOpenClaw) {
            console.log(chalk.dim("  Tip: Set up a scheduled process to run `sherwood session check " + opts.subdomain + "` periodically"));
          }
        } catch { /* non-fatal */ }
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

      // Auto-register participation crons (will HEARTBEAT_OK until approved)
      try {
        const cron = await loadCron();
        const cronResult = cron.registerSyndicateCrons(opts.subdomain, isTestnet(), getNotifyTo());
        if (cronResult.isOpenClaw && cronResult.registered) {
          console.log(G("  ✓ Participation crons registered (will activate after approval)"));
        } else if (!cronResult.isOpenClaw) {
          console.log(DIM("  Tip: Set up a scheduled process to run `sherwood session check " + opts.subdomain + "` periodically"));
        }
      } catch { /* non-fatal */ }

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
      let syndicateVault: Address;

      if (opts.subdomain) {
        const syndicateInfo = await resolveSyndicate(opts.subdomain);
        creatorAddress = syndicateInfo.creator;
        subdomain = opts.subdomain;
        syndicateVault = syndicateInfo.vault as Address;
      } else {
        resolveVault(opts);
        syndicateVault = vaultLib.getVaultAddress();
        const syndicateInfo = await resolveVaultSyndicate(syndicateVault);
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
      const [allRequests, approvals] = await Promise.all([
        easLib.queryJoinRequests(creatorAddress),
        easLib.queryApprovals(creatorAddress),
      ]);

      // Filter out agents that have already been approved for the same vault
      const approvedKeys = new Set(
        approvals
          .filter((a) => a.decoded.vault.toLowerCase() === syndicateVault.toLowerCase())
          .map((a) => a.decoded.agentId.toString()),
      );
      const requests = allRequests.filter(
        (r) => !approvedKeys.has(r.decoded.agentId.toString())
          && r.decoded.vault.toLowerCase() === syndicateVault.toLowerCase(),
      );

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
      console.log(DIM(`    sherwood syndicate approve --agent-id <id> --wallet <addr>`));
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
  .requiredOption("--wallet <address>", "Agent wallet address")
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

      const agentWallet = validateAddress(opts.wallet, "wallet");

      // Verify caller is creator
      const { creator, subdomain, id: syndicateId } = await resolveVaultSyndicate(vaultAddress);
      const callerAddress = getAccount().address.toLowerCase();
      if (creator.toLowerCase() !== callerAddress) {
        spinner.fail("Only the syndicate creator can approve agents");
        process.exit(1);
      }

      // 1. Register agent on-chain (same as syndicate add)
      spinner.text = "Registering agent on vault...";
      let agentWasRegistered = false;
      try {
        const regHash = await vaultLib.registerAgent(
          BigInt(opts.agentId),
          agentWallet,
        );
        agentWasRegistered = true;
        console.log(DIM(`  Agent registered: ${getExplorerUrl(regHash)}`));
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (msg.includes("0xe098d3ee") || msg.includes("AgentAlreadyRegistered")) {
          console.log(DIM("  Agent already registered on vault — skipping"));
        } else {
          throw regErr;
        }
      }

      // Brief delay after on-chain registration to let the RPC node sync its nonce
      if (agentWasRegistered) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 2. Create AGENT_APPROVED attestation (skip if one already exists)
      spinner.text = "Checking for existing approval...";
      const existingApprovals = await easLib.queryApprovals(getAccount().address);
      const alreadyApproved = existingApprovals.find(
        (a) => a.decoded.agentId === BigInt(opts.agentId) && a.decoded.vault.toLowerCase() === vaultAddress.toLowerCase(),
      );

      let approvalUid: `0x${string}`;
      if (alreadyApproved) {
        approvalUid = alreadyApproved.uid;
        console.log(DIM(`  Approval attestation already exists — skipping`));
      } else {
        spinner.text = "Creating approval attestation...";
        const result = await easLib.createApproval(
          syndicateId,
          BigInt(opts.agentId),
          vaultAddress,
          agentWallet,
        );
        approvalUid = result.uid;
      }

      // 3. Auto-add agent to XMTP chat group
      try {
        spinner.text = "Adding to chat...";
        const xmtp = await loadXmtp();
        const xmtpClient = await xmtp.getXmtpClient();
        const group = await xmtp.getGroup(xmtpClient, subdomain);
        await xmtp.addMember(group, opts.wallet);
        await xmtp.sendEnvelope(group, {
          type: "AGENT_REGISTERED",
          agent: { erc8004Id: Number(opts.agentId), address: opts.wallet },
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
      console.log(W(`  Wallet:       ${G(opts.wallet)}`));
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

syndicate
  .command("leave")
  .description("Leave a syndicate — removes participation crons and session state")
  .requiredOption("--subdomain <name>", "Syndicate subdomain to leave")
  .action(async (opts) => {
    const spinner = ora("Cleaning up...").start();
    try {
      // 1. Remove participation crons (if OpenClaw)
      let cronsRemoved = false;
      try {
        const cron = await loadCron();
        const result = cron.unregisterSyndicateCrons(opts.subdomain, isTestnet());
        cronsRemoved = result.removed;
      } catch { /* non-fatal */ }

      // 2. Reset session state
      const { resetSession } = await import("./lib/session.js");
      resetSession(opts.subdomain);

      spinner.succeed("Left syndicate");
      if (cronsRemoved) {
        console.log(G("  ✓ Participation crons removed"));
      }
      console.log(G("  ✓ Session state cleared"));
      console.log();
      console.log(chalk.dim("  Note: This does not remove you on-chain. To exit your position:"));
      console.log(chalk.dim("    sherwood vault balance   — check your LP share balance"));
      console.log(chalk.dim("    Redeem shares via the vault contract or dashboard"));
      console.log();
    } catch (err) {
      spinner.fail("Leave failed");
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
      console.log(`  Address:            ${info.address}`);
      console.log(`  Total Assets:       ${info.totalAssets}`);
      console.log(`  Agent Count:        ${info.agentCount}`);
      console.log(`  Redemptions Locked: ${info.redemptionsLocked}`);
      console.log(`  Management Fee:     ${Number(info.managementFeeBps) / 100}%`);
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

// ── Strategy commands ──
const strategy = program.command("strategy").description("Strategy templates — list, clone, propose");
registerStrategyTemplateCommands(strategy);

// ── Provider info ──
program
  .command("providers")
  .description("List available DeFi providers")
  .action(async () => {
    const { MessariProvider, NansenProvider } = await import("./providers/research/index.js");
    const providers = [new MoonwellProvider(), new UniswapProvider(), new MessariProvider(), new NansenProvider()];
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

// ── Session commands ──
const { registerSessionCommands } = await import("./commands/session.js");
registerSessionCommands(program);

// ── Venice commands ──
registerVeniceCommands(program);

// ── Allowance commands ──
registerAllowanceCommands(program);

// ── Identity commands ──
registerIdentityCommands(program);

// ── Proposal commands ──
registerProposalCommands(program);

// ── Governor commands ──
registerGovernorCommands(program);

// ── Research commands ──
const { registerResearchCommands } = await import("./commands/research.js");
registerResearchCommands(program);

// ── Trade commands ──
const { registerTradeCommands } = await import("./commands/trade.js");
registerTradeCommands(program);

// ── Config commands ──
const configCmd = program.command("config");

configCmd
  .command("set")
  .description("Save settings to ~/.sherwood/config.json (persists across sessions)")
  .option("--private-key <key>", "Wallet private key (0x-prefixed)")
  .option("--vault <address>", "Default SyndicateVault address")
  .option("--rpc <url>", "Custom RPC URL for the active --chain network")
  .option("--notify-to <id>", "Destination for cron summaries (Telegram chat ID, phone, etc.)")
  .option("--uniswap-api-key <key>", "Uniswap Trading API key (from developers.uniswap.org)")
  .option("--venice-api-key <key>", "Venice AI inference API key")
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

    if (opts.rpc) {
      const network = getNetwork();
      setConfigRpcUrl(network, opts.rpc);
      console.log(chalk.green(`RPC URL saved for ${network}`));
      console.log(chalk.dim(`  RPC: ${opts.rpc}`));
      saved = true;
    }

    if (opts.notifyTo) {
      setNotifyTo(opts.notifyTo);
      console.log(chalk.green("Notify destination saved to ~/.sherwood/config.json"));
      console.log(chalk.dim(`  Notify to: ${opts.notifyTo}`));
      saved = true;
    }

    if (opts.uniswapApiKey) {
      setUniswapApiKey(opts.uniswapApiKey);
      console.log(chalk.green("Uniswap API key saved to ~/.sherwood/config.json"));
      saved = true;
    }

    if (opts.veniceApiKey) {
      setVeniceApiKey(opts.veniceApiKey);
      console.log(chalk.green("Venice API key saved to ~/.sherwood/config.json"));
      saved = true;
    }

    if (!saved) {
      console.log(chalk.red("Provide at least one of: --private-key, --vault, --rpc, --notify-to, --uniswap-api-key, --venice-api-key"));
      process.exit(1);
    }
  });

configCmd
  .command("show")
  .description("Display current config for the active network")
  .action(() => {
    const network = getNetwork();
    const chainId = getChain().id;
    const contracts = getChainContracts(chainId);
    const config = loadConfig();
    const customRpc = config.rpc?.[network];

    console.log();
    console.log(chalk.bold(`Sherwood Config`));
    console.log(chalk.dim("─".repeat(50)));
    console.log(`  Network:    ${chalk.cyan(network)} (chain ${chainId})`);
    console.log(`  RPC:        ${customRpc ? chalk.green(customRpc) : chalk.dim("default")}`);
    console.log(`  Wallet:     ${config.privateKey ? chalk.green("configured") : chalk.dim("not set")}`);
    console.log(`  Agent ID:   ${config.agentId ?? chalk.dim("not set")}`);
    console.log(`  Vault:      ${contracts.vault ?? chalk.dim("not set")}`);
    console.log(`  Uniswap:    ${getUniswapApiKey() ? chalk.green("API key configured") : chalk.dim("not set")}`);
    console.log(`  Venice:     ${getVeniceApiKey() ? chalk.green("API key configured") : chalk.dim("not set")}`);
    console.log();
    console.log(chalk.dim("  Config file: ~/.sherwood/config.json"));
    console.log();
  });

program.parse();
