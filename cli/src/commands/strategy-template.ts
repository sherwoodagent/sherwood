/**
 * Strategy template commands — clone, build calls, propose.
 *
 * Replaces the old strategy registry commands with template-based workflow:
 *   sherwood strategy list     — show available templates
 *   sherwood strategy clone    — clone + initialize a template
 *   sherwood strategy propose  — clone + init + build calls + submit proposal (all-in-one)
 */

import type { Command } from "commander";
import type { Address, Hex } from "viem";
import { parseUnits, isAddress, erc20Abi } from "viem";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getPublicClient, getAccount, writeContractWithRetry } from "../lib/client.js";
import { getChain, getExplorerUrl } from "../lib/network.js";
import { TOKENS, MOONWELL, VENICE, AERODROME, STRATEGY_TEMPLATES } from "../lib/addresses.js";
import { BASE_STRATEGY_ABI } from "../lib/abis.js";
import { cloneTemplate } from "../lib/clone.js";
import type { BatchCall } from "../lib/batch.js";
import { formatBatch } from "../lib/batch.js";

import * as moonwellBuilder from "../strategies/moonwell-supply-template.js";
import * as veniceBuilder from "../strategies/venice-inference-template.js";
import * as aerodromeBuilder from "../strategies/aerodrome-lp-template.js";
import * as wstethBuilder from "../strategies/wsteth-moonwell-template.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

// ── Template definitions ──

interface TemplateDef {
  name: string;
  key: string;
  description: string;
  addressKey: keyof ReturnType<typeof STRATEGY_TEMPLATES>;
}

const TEMPLATES: TemplateDef[] = [
  {
    name: "Moonwell Supply",
    key: "moonwell-supply",
    description: "Supply tokens to Moonwell lending market, earn yield",
    addressKey: "MOONWELL_SUPPLY",
  },
  {
    name: "Aerodrome LP",
    key: "aerodrome-lp",
    description: "Provide liquidity on Aerodrome DEX + optional gauge staking",
    addressKey: "AERODROME_LP",
  },
  {
    name: "Venice Inference",
    key: "venice-inference",
    description: "Stake VVV for sVVV — Venice private AI inference",
    addressKey: "VENICE_INFERENCE",
  },
  {
    name: "wstETH Moonwell Yield",
    key: "wsteth-moonwell",
    description: "WETH → wstETH → Moonwell — stack Lido + lending yield",
    addressKey: "WSTETH_MOONWELL",
  },
];

function resolveTemplate(key: string): { def: TemplateDef; address: Address } {
  const def = TEMPLATES.find((t) => t.key === key);
  if (!def) {
    console.error(chalk.red(`Unknown template: ${key}`));
    console.error(chalk.dim(`Available: ${TEMPLATES.map((t) => t.key).join(", ")}`));
    process.exit(1);
  }
  const address = STRATEGY_TEMPLATES()[def.addressKey];
  if (address === ZERO) {
    console.error(chalk.red(`Template "${def.name}" not deployed on this network.`));
    process.exit(1);
  }
  return { def, address };
}

// ── Helpers for building init data per template ──

async function buildInitDataForTemplate(
  templateKey: string,
  opts: Record<string, string | boolean | undefined>,
  vault: Address,
): Promise<{ initData: Hex; asset: Address; assetAmount: bigint; extraApprovals?: { token: Address; amount: bigint }[] }> {
  if (templateKey === "moonwell-supply") {
    if (!opts.amount) {
      console.error(chalk.red("--amount is required for moonwell-supply template"));
      process.exit(1);
    }
    const token = (opts.token as string) || "USDC";
    const underlying = resolveToken(token);
    const mToken = resolveMToken(token);
    const decimals = token.toUpperCase() === "USDC" ? 6 : 18;
    const supplyAmount = parseUnits(opts.amount as string, decimals);
    const minRedeem = parseUnits((opts.minRedeem as string) || opts.amount as string, decimals);

    return {
      initData: moonwellBuilder.buildInitData(underlying, mToken, supplyAmount, minRedeem),
      asset: underlying,
      assetAmount: supplyAmount,
    };
  }

  if (templateKey === "venice-inference") {
    if (!opts.amount) {
      console.error(chalk.red("--amount is required for venice-inference template"));
      process.exit(1);
    }
    const assetSymbol = (opts.asset as string) || "USDC";
    const asset = resolveToken(assetSymbol);
    const vvv = VENICE().VVV;
    const isDirect = asset.toLowerCase() === vvv.toLowerCase();
    const decimals = assetSymbol.toUpperCase() === "USDC" ? 6 : 18;
    const assetAmount = parseUnits(opts.amount as string, decimals);
    const agent = (opts.agent as Address) || getAccount().address;

    const params: veniceBuilder.VeniceInferenceInitParams = {
      asset,
      weth: isDirect ? ZERO : TOKENS().WETH,
      vvv,
      sVVV: VENICE().STAKING,
      aeroRouter: isDirect ? ZERO : AERODROME().ROUTER,
      aeroFactory: isDirect ? ZERO : AERODROME().FACTORY,
      agent,
      assetAmount,
      minVVV: isDirect ? 0n : parseUnits((opts.minVvv as string) || "0", 18),
      deadlineOffset: 300n,
      singleHop: !!opts.singleHop,
    };

    return {
      initData: veniceBuilder.buildInitData(params),
      asset,
      assetAmount,
    };
  }

  if (templateKey === "aerodrome-lp") {
    for (const flag of ["tokenA", "tokenB", "amountA", "amountB", "lpToken"]) {
      if (!opts[flag]) {
        console.error(chalk.red(`--${flag.replace(/([A-Z])/g, "-$1").toLowerCase()} is required for aerodrome-lp template`));
        process.exit(1);
      }
    }
    const tokenA = opts.tokenA as Address;
    const tokenB = opts.tokenB as Address;
    const publicClient = getPublicClient();
    const [decimalsA, decimalsB] = await Promise.all([
      publicClient.readContract({ address: tokenA, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: tokenB, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const amountA = parseUnits(opts.amountA as string, decimalsA);
    const amountB = parseUnits(opts.amountB as string, decimalsB);
    const minAOut = parseUnits((opts.minAOut as string) || "0", decimalsA);
    const minBOut = parseUnits((opts.minBOut as string) || "0", decimalsB);

    const params: aerodromeBuilder.AerodromeLPInitParams = {
      tokenA,
      tokenB,
      stable: !!opts.stable,
      factory: AERODROME().FACTORY,
      router: AERODROME().ROUTER,
      gauge: (opts.gauge as Address) || ZERO,
      lpToken: opts.lpToken as Address,
      amountADesired: amountA,
      amountBDesired: amountB,
      amountAMin: amountA, // use desired as min for now
      amountBMin: amountB,
      minAmountAOut: minAOut,
      minAmountBOut: minBOut,
    };

    return {
      initData: aerodromeBuilder.buildInitData(params),
      asset: tokenA,
      assetAmount: amountA,
      extraApprovals: [{ token: tokenB, amount: amountB }],
    };
  }

  if (templateKey === "wsteth-moonwell") {
    if (!opts.amount) {
      console.error(chalk.red("--amount is required for wsteth-moonwell template"));
      process.exit(1);
    }
    const supplyAmount = parseUnits(opts.amount as string, 18); // WETH = 18 decimals
    const slippageBps = BigInt((opts.slippage as string) || "500"); // default 5% slippage
    const minWstethOut = supplyAmount - (supplyAmount * slippageBps) / 10000n;
    const minWethOut = supplyAmount - (supplyAmount * slippageBps) / 10000n;

    const params: wstethBuilder.WstETHMoonwellInitParams = {
      weth: TOKENS().WETH,
      wsteth: TOKENS().wstETH,
      mwsteth: MOONWELL().mWstETH,
      aeroRouter: AERODROME().ROUTER,
      aeroFactory: AERODROME().FACTORY,
      supplyAmount,
      minWstethOut,
      minWethOut,
      deadlineOffset: 300n,
    };

    return {
      initData: wstethBuilder.buildInitData(params),
      asset: TOKENS().WETH,
      assetAmount: supplyAmount,
    };
  }

  throw new Error(`No init builder for template: ${templateKey}`);
}

function buildCallsForTemplate(
  templateKey: string,
  clone: Address,
  asset: Address,
  assetAmount: bigint,
  extraApprovals?: { token: Address; amount: bigint }[],
): { executeCalls: BatchCall[]; settleCalls: BatchCall[] } {
  if (templateKey === "moonwell-supply") {
    return {
      executeCalls: moonwellBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: moonwellBuilder.buildSettleCalls(clone),
    };
  }

  if (templateKey === "venice-inference") {
    return {
      executeCalls: veniceBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: veniceBuilder.buildSettleCalls(clone),
    };
  }

  if (templateKey === "aerodrome-lp") {
    const tokenB = extraApprovals?.[0]?.token ?? ZERO;
    const amountB = extraApprovals?.[0]?.amount ?? 0n;
    return {
      executeCalls: aerodromeBuilder.buildExecuteCalls(clone, asset, assetAmount, tokenB, amountB),
      settleCalls: aerodromeBuilder.buildSettleCalls(clone),
    };
  }

  if (templateKey === "wsteth-moonwell") {
    return {
      executeCalls: wstethBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: wstethBuilder.buildSettleCalls(clone),
    };
  }

  throw new Error(`No call builder for template: ${templateKey}`);
}

// ── Token resolution ──

function resolveToken(symbolOrAddress: string): Address {
  if (isAddress(symbolOrAddress)) return symbolOrAddress as Address;
  const upper = symbolOrAddress.toUpperCase();
  const tokens = TOKENS();
  const tokenMap: Record<string, Address> = {
    USDC: tokens.USDC,
    WETH: tokens.WETH,
    DAI: tokens.DAI,
    AERO: tokens.AERO,
    VVV: VENICE().VVV,
  };
  const addr = tokenMap[upper];
  if (!addr || addr === ZERO) {
    console.error(chalk.red(`Unknown token: ${symbolOrAddress}`));
    process.exit(1);
  }
  return addr;
}

function resolveMToken(tokenSymbol: string): Address {
  const upper = tokenSymbol.toUpperCase();
  const moonwell = MOONWELL();
  const mTokenMap: Record<string, Address> = {
    USDC: moonwell.mUSDC,
    WETH: moonwell.mWETH,
  };
  const addr = mTokenMap[upper];
  if (!addr || addr === ZERO) {
    console.error(chalk.red(`No Moonwell market for: ${tokenSymbol}`));
    process.exit(1);
  }
  return addr;
}

function serializeCalls(calls: BatchCall[]): string {
  return JSON.stringify(
    calls.map((c) => ({
      target: c.target,
      data: c.data,
      value: c.value.toString(),
    })),
    null,
    2,
  );
}

// ── Commands ──

export function registerStrategyTemplateCommands(strategy: Command): void {
  // ── strategy list ──

  strategy
    .command("list")
    .description("List available strategy templates")
    .action(() => {
      const templates = STRATEGY_TEMPLATES();

      console.log();
      console.log(chalk.bold("Strategy Templates"));
      console.log(chalk.dim("─".repeat(60)));

      for (const t of TEMPLATES) {
        const addr = templates[t.addressKey];
        const deployed = addr !== ZERO;
        console.log();
        console.log(`  ${chalk.bold(t.name)} (${chalk.cyan(t.key)})`);
        console.log(`    ${t.description}`);
        console.log(`    Template: ${deployed ? chalk.green(addr) : chalk.red("not deployed")}`);
      }

      console.log();
      console.log(chalk.dim("Clone a template:  sherwood strategy clone <template> --vault <addr> ..."));
      console.log(chalk.dim("Full proposal:     sherwood strategy propose <template> --vault <addr> ..."));
      console.log();
    });

  // ── strategy clone ──

  strategy
    .command("clone")
    .description("Clone a strategy template and initialize it")
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell")
    .requiredOption("--vault <address>", "Vault address")
    // moonwell-supply / wsteth-moonwell
    .option("--amount <n>", "Asset amount to deploy")
    .option("--min-redeem <n>", "Min asset on settlement (Moonwell)")
    .option("--token <symbol>", "Asset token symbol (default: USDC)")
    // venice-inference
    .option("--asset <symbol>", "Asset token (USDC, VVV, or address)")
    .option("--agent <address>", "Agent wallet (Venice, default: your wallet)")
    .option("--min-vvv <n>", "Min VVV from swap (Venice)")
    .option("--single-hop", "Single-hop Aerodrome swap (Venice)")
    // aerodrome-lp
    .option("--token-a <address>", "Token A (Aerodrome)")
    .option("--token-b <address>", "Token B (Aerodrome)")
    .option("--amount-a <n>", "Token A amount (Aerodrome)")
    .option("--amount-b <n>", "Token B amount (Aerodrome)")
    .option("--stable", "Stable pool (Aerodrome)")
    .option("--gauge <address>", "Gauge address (Aerodrome)")
    .option("--lp-token <address>", "LP token address (Aerodrome)")
    .option("--min-a-out <n>", "Min token A on settle (Aerodrome)")
    .option("--min-b-out <n>", "Min token B on settle (Aerodrome)")
    // wsteth-moonwell
    .option("--slippage <bps>", "Slippage tolerance in bps (wstETH, default: 500 = 5%)")
    .action(async (templateKey: string, opts) => {
      const vault = opts.vault as Address;
      if (!isAddress(vault)) {
        console.error(chalk.red("Invalid vault address"));
        process.exit(1);
      }

      const { def, address: templateAddr } = resolveTemplate(templateKey);

      // 1. Clone
      const cloneSpinner = ora(`Cloning ${def.name} template...`).start();
      let clone: Address;
      let cloneHash: Hex;
      try {
        const result = await cloneTemplate(templateAddr);
        clone = result.clone;
        cloneHash = result.hash;
        cloneSpinner.succeed(`Cloned: ${chalk.green(clone)}`);
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(cloneHash)}`));
      } catch (err) {
        cloneSpinner.fail("Clone failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // 2. Initialize
      const initSpinner = ora("Initializing strategy...").start();
      try {
        const { initData } = await buildInitDataForTemplate(templateKey, opts, vault);
        const account = getAccount();

        const initHash = await writeContractWithRetry({
          account,
          chain: getChain(),
          address: clone,
          abi: BASE_STRATEGY_ABI,
          functionName: "initialize",
          args: [vault, account.address, initData],
        });

        const receipt = await getPublicClient().waitForTransactionReceipt({ hash: initHash });
        if (receipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold("Strategy clone ready:"), chalk.green(clone));
      console.log(chalk.dim("Use this address in your proposal batch calls."));
      console.log();
    });

  // ── strategy init ──

  strategy
    .command("init")
    .description("Initialize an already-deployed but uninitialized strategy clone")
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell")
    .requiredOption("--clone <address>", "Clone address to initialize")
    .requiredOption("--vault <address>", "Vault address")
    // moonwell-supply / wsteth-moonwell
    .option("--amount <n>", "Asset amount to deploy")
    .option("--min-redeem <n>", "Min asset on settlement (Moonwell)")
    .option("--token <symbol>", "Asset token symbol (default: USDC)")
    // venice-inference
    .option("--asset <symbol>", "Asset token (USDC, VVV, or address)")
    .option("--agent <address>", "Agent wallet (Venice, default: your wallet)")
    .option("--min-vvv <n>", "Min VVV from swap (Venice)")
    .option("--single-hop", "Single-hop Aerodrome swap (Venice)")
    // aerodrome-lp
    .option("--token-a <address>", "Token A (Aerodrome)")
    .option("--token-b <address>", "Token B (Aerodrome)")
    .option("--amount-a <n>", "Token A amount (Aerodrome)")
    .option("--amount-b <n>", "Token B amount (Aerodrome)")
    .option("--stable", "Stable pool (Aerodrome)")
    .option("--gauge <address>", "Gauge address (Aerodrome)")
    .option("--lp-token <address>", "LP token address (Aerodrome)")
    .option("--min-a-out <n>", "Min token A on settle (Aerodrome)")
    .option("--min-b-out <n>", "Min token B on settle (Aerodrome)")
    // wsteth-moonwell
    .option("--slippage <bps>", "Slippage tolerance in bps (wstETH, default: 500 = 5%)")
    .action(async (templateKey: string, opts) => {
      const clone = opts.clone as Address;
      const vault = opts.vault as Address;
      if (!isAddress(clone)) {
        console.error(chalk.red("Invalid clone address"));
        process.exit(1);
      }
      if (!isAddress(vault)) {
        console.error(chalk.red("Invalid vault address"));
        process.exit(1);
      }

      resolveTemplate(templateKey); // validate template exists

      // Check if already initialized
      const publicClient = getPublicClient();
      const currentVault = await publicClient.readContract({
        address: clone,
        abi: BASE_STRATEGY_ABI,
        functionName: "vault",
      }) as Address;

      if (currentVault !== "0x0000000000000000000000000000000000000000") {
        console.error(chalk.red(`Clone already initialized (vault: ${currentVault})`));
        process.exit(1);
      }

      const initSpinner = ora("Initializing strategy clone...").start();
      try {
        const { initData } = await buildInitDataForTemplate(templateKey, opts, vault);
        const account = getAccount();

        const initHash = await writeContractWithRetry({
          account,
          chain: getChain(),
          address: clone,
          abi: BASE_STRATEGY_ABI,
          functionName: "initialize",
          args: [vault, account.address, initData],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash: initHash });
        if (receipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(initHash)}`));
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Verify
      const verifiedVault = await publicClient.readContract({
        address: clone,
        abi: BASE_STRATEGY_ABI,
        functionName: "vault",
      }) as Address;

      console.log();
      console.log(chalk.bold("Clone initialized:"), chalk.green(clone));
      console.log(`  Vault:    ${chalk.green(verifiedVault)}`);
      console.log(`  Proposer: ${chalk.green(getAccount().address)}`);
      console.log();
    });

  // ── strategy propose ──

  strategy
    .command("propose")
    .description("Clone + init + build calls + submit governance proposal (all-in-one)")
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell")
    .requiredOption("--vault <address>", "Vault address")
    .option("--write-calls <dir>", "Write execute/settle JSON to directory (skip proposal submission)")
    // proposal metadata (required unless --write-calls)
    .option("--name <name>", "Proposal name")
    .option("--description <text>", "Proposal description")
    .option("--performance-fee <bps>", "Agent fee in bps")
    .option("--duration <duration>", "Strategy duration (7d, 24h, etc.)")
    // template-specific (same as clone)
    .option("--amount <n>", "Asset amount to deploy")
    .option("--min-redeem <n>", "Min asset on settlement (Moonwell)")
    .option("--token <symbol>", "Asset token symbol (default: USDC)")
    .option("--asset <symbol>", "Asset token (USDC, VVV, or address)")
    .option("--agent <address>", "Agent wallet (Venice, default: your wallet)")
    .option("--min-vvv <n>", "Min VVV from swap (Venice)")
    .option("--single-hop", "Single-hop Aerodrome swap (Venice)")
    .option("--token-a <address>", "Token A (Aerodrome)")
    .option("--token-b <address>", "Token B (Aerodrome)")
    .option("--amount-a <n>", "Token A amount (Aerodrome)")
    .option("--amount-b <n>", "Token B amount (Aerodrome)")
    .option("--stable", "Stable pool (Aerodrome)")
    .option("--gauge <address>", "Gauge address (Aerodrome)")
    .option("--lp-token <address>", "LP token address (Aerodrome)")
    .option("--min-a-out <n>", "Min token A on settle (Aerodrome)")
    .option("--min-b-out <n>", "Min token B on settle (Aerodrome)")
    // wsteth-moonwell
    .option("--slippage <bps>", "Slippage tolerance in bps (wstETH, default: 500 = 5%)")
    .action(async (templateKey: string, opts) => {
      const vault = opts.vault as Address;
      if (!isAddress(vault)) {
        console.error(chalk.red("Invalid vault address"));
        process.exit(1);
      }

      const { def, address: templateAddr } = resolveTemplate(templateKey);

      // 1. Clone
      const cloneSpinner = ora(`Cloning ${def.name} template...`).start();
      let clone: Address;
      try {
        const result = await cloneTemplate(templateAddr);
        clone = result.clone;
        cloneSpinner.succeed(`Cloned: ${chalk.green(clone)}`);
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(result.hash)}`));
      } catch (err) {
        cloneSpinner.fail("Clone failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // 2. Initialize
      const initSpinner = ora("Initializing strategy...").start();
      let asset: Address;
      let assetAmount: bigint;
      let extraApprovals: { token: Address; amount: bigint }[] | undefined;
      try {
        const built = await buildInitDataForTemplate(templateKey, opts, vault);
        asset = built.asset;
        assetAmount = built.assetAmount;
        extraApprovals = built.extraApprovals;

        const account = getAccount();

        const initHash = await writeContractWithRetry({
          account,
          chain: getChain(),
          address: clone,
          abi: BASE_STRATEGY_ABI,
          functionName: "initialize",
          args: [vault, account.address, built.initData],
        });

        const initReceipt = await getPublicClient().waitForTransactionReceipt({ hash: initHash });
        if (initReceipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // 3. Build batch calls
      const { executeCalls, settleCalls } = buildCallsForTemplate(
        templateKey, clone, asset, assetAmount, extraApprovals,
      );

      console.log();
      console.log(chalk.bold(`Execute calls (${executeCalls.length}):`));
      console.log(formatBatch(executeCalls));
      console.log(chalk.bold(`Settle calls (${settleCalls.length}):`));
      console.log(formatBatch(settleCalls));

      // 4. Write files or submit proposal
      if (opts.writeCalls) {
        const dir = resolve(opts.writeCalls as string);
        mkdirSync(dir, { recursive: true });

        const execPath = resolve(dir, "execute.json");
        const settlePath = resolve(dir, "settle.json");
        writeFileSync(execPath, serializeCalls(executeCalls));
        writeFileSync(settlePath, serializeCalls(settleCalls));

        console.log();
        console.log(chalk.green(`Execute calls:  ${execPath}`));
        console.log(chalk.green(`Settle calls:   ${settlePath}`));
        console.log(chalk.green(`Clone address:  ${clone}`));
        console.log();
        console.log(chalk.dim("Submit with:"));
        console.log(chalk.dim(`  sherwood proposal create \\`));
        console.log(chalk.dim(`    --vault ${vault} \\`));
        console.log(chalk.dim(`    --name "..." --description "..." \\`));
        console.log(chalk.dim(`    --performance-fee 0 --duration 7d \\`));
        console.log(chalk.dim(`    --execute-calls ${execPath} \\`));
        console.log(chalk.dim(`    --settle-calls ${settlePath}`));

        if (templateKey === "venice-inference") {
          console.log();
          console.log(chalk.yellow("Reminder: before settlement, agent must approve repayment:"));
          console.log(chalk.yellow(`  asset.approve(${clone}, <repaymentAmount>)`));
          console.log(chalk.yellow("  Agent can update repayment via strategy.updateParams(newRepayment, 0, 0)"));
        }

        console.log();
        return;
      }

      // Direct proposal submission requires metadata flags
      if (!opts.name || !opts.performanceFee || !opts.duration) {
        console.error(chalk.red("Missing --name, --performance-fee, or --duration. Use --write-calls to skip proposal submission."));
        process.exit(1);
      }

      // Lazy import governor to avoid pulling it in for --write-calls path
      const { propose } = await import("../lib/governor.js");
      const { pinJSON } = await import("../lib/ipfs.js");
      const { parseDuration } = await import("../lib/governor.js");

      const performanceFeeBps = BigInt(opts.performanceFee as string);
      if (performanceFeeBps < 0n || performanceFeeBps > 10000n) {
        console.error(chalk.red("--performance-fee must be 0-10000 (basis points)"));
        process.exit(1);
      }
      const strategyDuration = parseDuration(opts.duration as string);
      const account = getAccount();

      const metaSpinner = ora("Pinning metadata to IPFS...").start();
      let metadataURI: string;
      try {
        const metadata = {
          name: opts.name,
          description: opts.description || "",
          proposer: account.address,
          vault,
          strategyClone: clone,
          template: def.key,
          performanceFeeBps: Number(performanceFeeBps),
          strategyDuration: Number(strategyDuration),
          createdAt: new Date().toISOString(),
        };
        metadataURI = await pinJSON(metadata, opts.name as string);
        metaSpinner.succeed(`Metadata pinned: ${metadataURI}`);
      } catch (err) {
        metaSpinner.fail("IPFS pin failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const proposeSpinner = ora("Submitting proposal...").start();
      try {
        const { hash, proposalId } = await propose(
          vault, metadataURI, performanceFeeBps, strategyDuration,
          executeCalls, settleCalls,
        );
        proposeSpinner.succeed(`Proposal #${proposalId} created`);
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(hash)}`));
        console.log(chalk.dim(`  Clone: ${clone}`));
      } catch (err) {
        proposeSpinner.fail("Proposal failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (templateKey === "venice-inference") {
        console.log();
        console.log(chalk.yellow("Next steps:"));
        console.log(chalk.yellow("  1. After execution: sherwood venice provision"));
        console.log(chalk.yellow("  2. Use inference: sherwood venice infer --model <id> --prompt '...'"));
        console.log(chalk.yellow("  3. Before settlement: approve repayment (principal + profit):"));
        console.log(chalk.yellow(`     asset.approve(${clone}, <repaymentAmount>)`));
      }

      console.log();
    });
}
