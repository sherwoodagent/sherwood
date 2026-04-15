#!/usr/bin/env npx tsx
/**
 * Selective Portfolio Strategy Test on Base
 *
 * Thin wrapper that calls `sherwood strategy propose portfolio` with the
 * right args for testing on an existing Base syndicate. Resolves the vault
 * from the subdomain and verifies prerequisites before invoking the CLI.
 *
 * Usage:
 *   npx tsx cli/src/scripts/test-portfolio-base.ts \
 *     --subdomain aero-alpha \
 *     --tokens 0x6502...,0xf27b...,0xf30B... \
 *     --weights 5000,2500,2500 \
 *     --amount 10 \
 *     [--fee-tier 10000] \
 *     [--max-slippage 500] \
 *     [--duration 24h] \
 *     [--swap-adapter 0x...] \
 *     [--dry-run]
 *
 * Environment:
 *   PRIVATE_KEY    — agent wallet private key (the registered agent, NOT vault owner)
 *   BASE_RPC_URL   — optional, defaults to public Base RPC
 */

import { config as loadDotenv } from "dotenv";
try { loadDotenv(); } catch {}

import chalk from "chalk";
import {
  type Address,
  isAddress,
  createPublicClient,
  http,
  erc20Abi,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setNetwork } from "../lib/network.js";
import { STRATEGY_TEMPLATES, UNISWAP, SHERWOOD } from "../lib/addresses.js";

// Force Base
setNetwork("base");

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "../..");

const FACTORY_ABI = [{
  type: "function", name: "subdomainToSyndicate",
  inputs: [{ name: "subdomain", type: "string" }],
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
}, {
  type: "function", name: "syndicates",
  inputs: [{ name: "id", type: "uint256" }],
  outputs: [
    { name: "id", type: "uint256" },
    { name: "vault", type: "address" },
    { name: "creator", type: "address" },
    { name: "name", type: "string" },
    { name: "createdAt", type: "uint256" },
    { name: "active", type: "bool" },
    { name: "subdomain", type: "string" },
  ],
  stateMutability: "view",
}] as const;

const VAULT_ABI = [{
  type: "function", name: "isAgent", inputs: [{ name: "agentAddress", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view",
}, {
  type: "function", name: "asset", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view",
}, {
  type: "function", name: "totalAssets", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view",
}, {
  type: "function", name: "owner", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view",
}] as const;

// ── Parse args manually (simple — not using Commander to keep it light) ──

function getArg(flag: string, required = false): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1 || idx + 1 >= args.length) {
    if (required) { console.error(chalk.red(`--${flag} is required`)); process.exit(1); }
    return undefined;
  }
  return args[idx + 1];
}
const hasFlag = (flag: string) => process.argv.includes(`--${flag}`);

async function main() {
  console.log(chalk.bold("\n=== Portfolio Strategy Test — Base Mainnet ===\n"));

  // ── Args ──
  const subdomain = getArg("subdomain", true)!;
  const tokens = getArg("tokens", true)!;
  const weights = getArg("weights", true)!;
  const amount = getArg("amount", true)!;
  const feeTier = getArg("fee-tier") || "10000";
  const maxSlippage = getArg("max-slippage") || "500";
  const duration = getArg("duration") || "24h";
  const performanceFee = getArg("performance-fee") || "1000";
  const swapAdapter = getArg("swap-adapter");
  const dryRun = hasFlag("dry-run");

  // ── Validate env ──
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error(chalk.red("PRIVATE_KEY env var required (agent wallet)"));
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  console.log(`  Agent wallet: ${chalk.green(account.address)}`);

  // ── Validate tokens ──
  const tokenAddrs = tokens.split(",").map((t) => t.trim());
  for (const t of tokenAddrs) {
    if (!isAddress(t)) {
      console.error(chalk.red(`Invalid token address: ${t}`));
      process.exit(1);
    }
  }

  const weightsBps = weights.split(",").map((w) => Number(w.trim()));
  const weightSum = weightsBps.reduce((a, b) => a + b, 0);
  if (weightSum !== 10000) {
    console.error(chalk.red(`Weights must sum to 10000 (got ${weightSum})`));
    process.exit(1);
  }

  // ── Pre-flight checks ──
  console.log(chalk.bold("\nPre-flight checks:"));

  // 1. Template deployed?
  const templateAddr = STRATEGY_TEMPLATES().PORTFOLIO;
  if (templateAddr === ZERO) {
    console.log(`  ${chalk.red("✗")} PortfolioStrategy template: NOT DEPLOYED`);
    console.log(chalk.yellow("    Run: forge script script/DeployPortfolioStrategy.s.sol --rpc-url base --account sherwood-agent --broadcast"));
    process.exit(1);
  }
  console.log(`  ${chalk.green("✓")} PortfolioStrategy template: ${templateAddr}`);

  // 2. Swap adapter?
  const adapterAddr = swapAdapter || UNISWAP().SWAP_ADAPTER;
  if (adapterAddr === ZERO) {
    console.log(`  ${chalk.red("✗")} UniswapSwapAdapter: NOT DEPLOYED`);
    console.log(chalk.yellow("    Deploy via DeployPortfolioStrategy.s.sol and update addresses.ts, or pass --swap-adapter"));
    process.exit(1);
  }
  console.log(`  ${chalk.green("✓")} UniswapSwapAdapter: ${adapterAddr}`);

  // 3. Resolve vault
  const factory = SHERWOOD().FACTORY;
  let vault: Address;
  try {
    const syndicateId = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "subdomainToSyndicate",
      args: [subdomain],
    }) as bigint;
    if (syndicateId === 0n) throw new Error("Not found");
    const result = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "syndicates",
      args: [syndicateId],
    }) as [bigint, Address, Address, string, bigint, boolean, string];
    vault = result[1];
    if (vault === ZERO) throw new Error("Vault is zero address");
    console.log(`  ${chalk.green("✓")} Vault (${subdomain}): ${vault}`);
  } catch {
    console.log(`  ${chalk.red("✗")} Vault: could not resolve "${subdomain}.sherwoodagent.eth"`);
    process.exit(1);
  }

  // 4. Agent registered on vault?
  const [isAgent, vaultAsset, totalAssets, vaultOwner] = await Promise.all([
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "isAgent", args: [account.address] }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "asset" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalAssets" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "owner" }),
  ]) as [boolean, Address, bigint, Address];

  const isOwner = vaultOwner.toLowerCase() === account.address.toLowerCase();
  if (!isAgent && !isOwner) {
    console.log(`  ${chalk.red("✗")} Wallet ${account.address} is neither agent nor owner on vault`);
    process.exit(1);
  }
  console.log(`  ${chalk.green("✓")} Wallet registered on vault (${isOwner ? "owner" : "agent"})`);
  console.log(`  ${chalk.green("✓")} Vault asset: ${vaultAsset} (total: ${(Number(totalAssets) / 1e6).toFixed(2)} USDC)`);

  // 5. Token symbols
  console.log(chalk.bold("\nPortfolio:"));
  for (let i = 0; i < tokenAddrs.length; i++) {
    let symbol = tokenAddrs[i].slice(0, 10) + "...";
    try {
      symbol = await publicClient.readContract({
        address: tokenAddrs[i] as Address,
        abi: erc20Abi,
        functionName: "symbol",
      }) as string;
    } catch {}
    console.log(`  ${chalk.cyan(symbol.padEnd(12))} ${(weightsBps[i] / 100).toFixed(1).padStart(5)}%   ${tokenAddrs[i]}`);
  }
  console.log(`\n  Amount: ${amount} USDC | Fee tier: ${feeTier} | Slippage: ${maxSlippage} bps | Duration: ${duration}`);

  if (dryRun) {
    console.log(chalk.yellow("\n  [DRY RUN] Pre-flight passed. Would run:"));
    console.log(chalk.dim(`    sherwood --chain base strategy propose portfolio \\`));
    console.log(chalk.dim(`      --vault ${vault} --tokens ${tokens} --weights ${weights} \\`));
    console.log(chalk.dim(`      --amount ${amount} --fee-tier ${feeTier} --max-slippage ${maxSlippage} \\`));
    console.log(chalk.dim(`      --duration ${duration} --performance-fee ${performanceFee} \\`));
    console.log(chalk.dim(`      --name "Portfolio Test" --description "Base portfolio test" \\`));
    if (swapAdapter) console.log(chalk.dim(`      --swap-adapter ${swapAdapter} \\`));
    console.log();
    return;
  }

  // ── Execute via CLI ──
  console.log(chalk.bold("\nSubmitting proposal via CLI...\n"));

  const cliArgs = [
    "tsx", path.resolve(CLI_DIR, "src/index.ts"),
    "--chain", "base",
    "strategy", "propose", "portfolio",
    "--vault", vault,
    "--tokens", tokens,
    "--weights", weights,
    "--amount", amount,
    "--fee-tier", feeTier,
    "--max-slippage", maxSlippage,
    "--duration", duration,
    "--performance-fee", performanceFee,
    "--name", `Portfolio Test — ${tokenAddrs.length} tokens`,
    "--description", `Base portfolio test: weights ${weights}. Duration: ${duration}.`,
  ];

  if (swapAdapter) {
    cliArgs.push("--swap-adapter", swapAdapter);
  }

  try {
    const output = execFileSync("npx", cliArgs, {
      encoding: "utf8",
      cwd: CLI_DIR,
      env: {
        ...process.env,
        PRIVATE_KEY: privateKey,
      },
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log(output);

    console.log(chalk.bold("\n=== Proposal Submitted ==="));
    console.log(`\nNext steps:`);
    console.log(`  1. Wait for voting period (optimistic — auto-approves)`);
    console.log(`  2. Execute: sherwood --chain base proposal execute --vault ${vault}`);
    console.log(`  3. Monitor: sherwood --chain base strategy status <clone-address>`);
    console.log(`  4. Settle:  sherwood --chain base proposal settle --vault ${vault}`);
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    console.error(chalk.red("\nProposal failed:"));
    if (execErr.stdout) console.error(execErr.stdout);
    if (execErr.stderr) console.error(execErr.stderr);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
