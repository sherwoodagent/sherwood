/**
 * Identity commands — sherwood identity <subcommand>
 *
 * Wraps the Agent0 SDK (@agent0-sdk) for ERC-8004 agent identity management.
 * Handles: mint (register), set metadata, check status, load existing agent.
 * Required before creating or joining syndicates.
 */

import { Command } from "commander";
import type { Address } from "viem";
import chalk from "chalk";
import ora from "ora";
import { SDK } from "agent0-sdk";
import { getPublicClient, getAccount, formatContractError } from "../lib/client.js";
import { getExplorerUrl, getChain, getRpcUrl } from "../lib/network.js";
import { AGENT_REGISTRY } from "../lib/addresses.js";
import { setAgentId, getAgentId, loadConfig } from "../lib/config.js";

// ── ABI (minimal, for status reads without SDK) ──

const IDENTITY_REGISTRY_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Initialize the Agent0 SDK with the current network config.
 */
function getAgent0SDK(): SDK {
  // Read key from config first, env var as fallback
  const config = loadConfig();
  const key = config.privateKey || process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Private key not found. Run 'sherwood config set --private-key <key>' or set PRIVATE_KEY env var.",
    );
  }

  return new SDK({
    chainId: getChain().id,
    rpcUrl: getRpcUrl(),
    privateKey: key.startsWith("0x") ? key : `0x${key}`,
  });
}

export function registerIdentityCommands(program: Command): void {
  const identity = program.command("identity").description("Manage ERC-8004 agent identity (via Agent0 SDK)");

  // ── identity mint ──

  identity
    .command("mint")
    .description("Register a new ERC-8004 agent identity (required before creating/joining syndicates)")
    .requiredOption("--name <name>", "Agent name (e.g. 'Alpha Seeker Agent')")
    .option("--description <desc>", "Agent description", "Sherwood syndicate agent")
    .option("--image <uri>", "Agent image URI (IPFS recommended)")
    .action(async (opts) => {
      const account = getAccount();

      // Check if wallet already has an identity
      const existingId = getAgentId();
      if (existingId) {
        console.log(chalk.yellow(`You already have an agent identity saved: #${existingId}`));
        console.log(chalk.dim("  Minting a new one anyway. The old ID is not affected."));
        console.log();
      }

      const spinner = ora("Initializing Agent0 SDK...").start();
      try {
        const sdk = getAgent0SDK();

        // Create agent with metadata
        spinner.text = "Creating agent profile...";
        const agent = sdk.createAgent(opts.name, opts.description, opts.image);

        // Register on-chain (mints ERC-8004 NFT)
        spinner.text = "Registering on-chain (minting ERC-8004 identity)...";
        const txHandle = await agent.registerOnChain();

        spinner.text = "Waiting for confirmation...";
        await txHandle.waitMined();

        const agentId = agent.agentId;
        if (!agentId) {
          spinner.warn("Identity registered but could not read agentId");
          console.log(chalk.dim("  Check the transaction on the explorer."));
          return;
        }

        // Agent0 agentId format is "chainId:tokenId" — extract the token ID
        const tokenId = Number(agentId.includes(":") ? agentId.split(":")[1] : agentId);

        // Save to config
        setAgentId(tokenId);

        spinner.succeed(`Agent identity registered: #${tokenId}`);
        console.log(chalk.dim(`  Agent0 ID: ${agentId}`));
        console.log(chalk.dim(`  Name:      ${opts.name}`));
        console.log(chalk.dim(`  Owner:     ${account.address}`));
        console.log(chalk.dim(`  Saved to   ~/.sherwood/config.json`));
        console.log();
        console.log(chalk.green("You can now create syndicates:"));
        console.log(chalk.dim(`  sherwood syndicate create --agent-id ${tokenId} --subdomain <name> --name <name>`));
      } catch (err) {
        spinner.fail("Failed to register identity");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── identity load ──

  identity
    .command("load")
    .description("Load an existing ERC-8004 agent identity into your config")
    .requiredOption("--id <tokenId>", "Agent token ID to load")
    .action(async (opts) => {
      const account = getAccount();
      const client = getPublicClient();
      const registry = AGENT_REGISTRY().IDENTITY_REGISTRY;
      const tokenId = Number(opts.id);

      const spinner = ora(`Verifying ownership of agent #${tokenId}...`).start();
      try {
        const owner = await client.readContract({
          address: registry,
          abi: IDENTITY_REGISTRY_ABI,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        }) as Address;

        if (owner.toLowerCase() !== account.address.toLowerCase()) {
          spinner.fail(`Agent #${tokenId} is owned by ${owner}, not your wallet`);
          process.exit(1);
        }

        setAgentId(tokenId);
        spinner.succeed(`Agent #${tokenId} loaded and saved to config`);
        console.log(chalk.dim(`  Owner:  ${account.address}`));
        console.log(chalk.dim(`  Saved to ~/.sherwood/config.json`));
      } catch (err) {
        spinner.fail("Failed to load identity");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── identity status ──

  identity
    .command("status")
    .description("Show your agent identity status")
    .action(async () => {
      const account = getAccount();
      const registry = AGENT_REGISTRY().IDENTITY_REGISTRY;
      const client = getPublicClient();

      const spinner = ora("Checking identity...").start();
      try {
        const balance = await client.readContract({
          address: registry,
          abi: IDENTITY_REGISTRY_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;

        spinner.stop();

        const savedId = getAgentId();

        console.log();
        console.log(chalk.bold("Agent Identity (ERC-8004)"));
        console.log(chalk.dim("─".repeat(40)));
        console.log(`  Wallet:     ${account.address}`);
        console.log(`  Registry:   ${registry}`);
        console.log(`  NFTs owned: ${balance.toString()}`);

        if (savedId) {
          // Verify the saved ID is still owned by this wallet
          try {
            const owner = await client.readContract({
              address: registry,
              abi: IDENTITY_REGISTRY_ABI,
              functionName: "ownerOf",
              args: [BigInt(savedId)],
            }) as Address;

            const isOwner = owner.toLowerCase() === account.address.toLowerCase();
            console.log(`  Saved ID:   #${savedId} ${isOwner ? chalk.green("(verified)") : chalk.red("(owned by " + owner + ")")}`);

            // Load full agent details via SDK if verified
            if (isOwner) {
              try {
                const sdk = getAgent0SDK();
                const agent = await sdk.loadAgent(`${getChain().id}:${savedId}`);
                if (agent.name) console.log(`  Name:       ${agent.name}`);
                if (agent.description) console.log(`  Desc:       ${chalk.dim(agent.description)}`);
                if (agent.walletAddress) console.log(`  Wallet:     ${agent.walletAddress}`);
              } catch {
                // SDK load failed — not critical, basic info already shown
              }
            }
          } catch {
            console.log(`  Saved ID:   #${savedId} ${chalk.red("(token not found)")}`);
          }
        } else {
          console.log(`  Saved ID:   ${chalk.dim("none — run 'sherwood identity mint --name <name>'")}`);
        }
        console.log();
      } catch (err) {
        spinner.fail("Failed to check identity");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });
}
