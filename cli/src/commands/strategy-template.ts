/**
 * Strategy template commands — clone, build calls, propose, rebalance, status.
 *
 * Replaces the old strategy registry commands with template-based workflow:
 *   sherwood strategy list      — show available templates
 *   sherwood strategy clone     — clone + initialize a template
 *   sherwood strategy propose   — clone + init + build calls + submit proposal (all-in-one)
 *   sherwood strategy status    — read portfolio allocations + state
 *   sherwood strategy rebalance — sell-all/re-buy at current target weights (Portfolio only)
 */

import type { Command } from "commander";
import type { Address, Hex } from "viem";
import { parseUnits, formatUnits, isAddress, erc20Abi, encodeAbiParameters, decodeAbiParameters } from "viem";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getPublicClient, getAccount, writeContractWithRetry, waitForReceipt, formatContractError } from "../lib/client.js";
import { getChain, getExplorerUrl, getNetwork, CHAIN_REGISTRY } from "../lib/network.js";
import { getCachedSwapRoute, cacheSwapRoute, type SwapRoute } from "../lib/config.js";
import { TOKENS, MOONWELL, VENICE, AERODROME, UNISWAP, STRATEGY_TEMPLATES, SYNTHRA, CHAINLINK } from "../lib/addresses.js";
import { BASE_STRATEGY_ABI, PORTFOLIO_STRATEGY_ABI, SYNDICATE_VAULT_ABI } from "../lib/abis.js";
import { cloneTemplate } from "../lib/clone.js";
import type { BatchCall } from "../lib/batch.js";
import { formatBatch } from "../lib/batch.js";

import * as moonwellBuilder from "../strategies/moonwell-supply-template.js";
import * as veniceBuilder from "../strategies/venice-inference-template.js";
import * as aerodromeBuilder from "../strategies/aerodrome-lp-template.js";
import * as wstethBuilder from "../strategies/wsteth-moonwell-template.js";
import * as mamoBuilder from "../strategies/mamo-yield-template.js";
import * as portfolioBuilder from "../strategies/portfolio-template.js";
import * as hyperliquidPerpBuilder from "../strategies/hyperliquid-perp-template.js";

import { concat, numberToHex, size } from "viem";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

// ── Uniswap V3 swap routing helpers ──

/**
 * Encode Uniswap V3 packed path: token (20 bytes) + fee (3 bytes) + token (20 bytes) [+ fee + token ...]
 */
function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1) throw new Error("tokens.length must be fees.length + 1");
  const parts: Hex[] = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(tokens[i].toLowerCase() as Hex);
    if (i < fees.length) {
      // fee as 3 bytes (uint24)
      parts.push(numberToHex(fees[i], { size: 3 }));
    }
  }
  return concat(parts);
}

/**
 * Build swapExtraData for the UniswapSwapAdapter.
 *
 * Mode 0 — single-hop: 0x00 + abi.encode(uint24 fee)
 * Mode 1 — multi-hop:  0x01 + abi.encode(bytes path)
 *
 * For Synthra (Robinhood), extraData is just abi.encode(uint24 fee) with no mode prefix.
 */
function buildSwapExtraData(
  network: string,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: number,
  hop?: { via: Address; feeIn: number; feeOut: number },
): Hex {
  if (network === "robinhood-testnet") {
    // SynthraDirectAdapter: plain abi.encode(uint24 fee)
    return encodeAbiParameters([{ type: "uint24" }], [feeTier]);
  }

  if (hop) {
    // Multi-hop: tokenIn → hop.via → tokenOut
    const path = encodeV3Path([tokenIn, hop.via, tokenOut], [hop.feeIn, hop.feeOut]);
    const encoded = encodeAbiParameters([{ type: "bytes" }], [path]);
    return `0x01${encoded.slice(2)}` as Hex;
  }

  // Single-hop: mode 0
  const encoded = encodeAbiParameters([{ type: "uint24" }], [feeTier]);
  return `0x00${encoded.slice(2)}` as Hex;
}

/**
 * Auto-detect swap route for a token pair on Uniswap V3.
 * Returns { direct: true, feeTier } or { direct: false, hop } or null if no route found.
 */
async function detectSwapRoute(
  asset: Address,
  token: Address,
  preferredFeeTier: number,
): Promise<{ extraData: Hex; routeDesc: string } | null> {
  const network = getNetwork();
  if (network === "robinhood-testnet") {
    return {
      extraData: buildSwapExtraData(network, asset, token, preferredFeeTier),
      routeDesc: `direct (fee ${preferredFeeTier})`,
    };
  }

  const chainId = CHAIN_REGISTRY[network].chain.id;

  // Check config cache first
  const cached = getCachedSwapRoute(chainId, asset, token);
  if (cached) {
    const extraData = cached.hop
      ? buildSwapExtraData(network, asset, token, 0, {
          via: cached.hop.via as Address,
          feeIn: cached.hop.feeIn,
          feeOut: cached.hop.feeOut,
        })
      : buildSwapExtraData(network, asset, token, cached.feeTier);
    const desc = cached.hop
      ? `cached multi-hop: ${cached.hop.feeIn}→WETH→${cached.hop.feeOut}`
      : `cached direct (fee ${cached.feeTier})`;
    return { extraData, routeDesc: desc };
  }

  const publicClient = getPublicClient();
  const quoterAddr = UNISWAP().QUOTER_V2;
  const quoterAbi = [{
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [{ type: "tuple", components: [
      { type: "address", name: "tokenIn" },
      { type: "address", name: "tokenOut" },
      { type: "uint256", name: "amountIn" },
      { type: "uint24", name: "fee" },
      { type: "uint160", name: "sqrtPriceLimitX96" },
    ]}],
    outputs: [
      { type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" },
    ],
    stateMutability: "nonpayable",
  }] as const;

  // 1. Try direct at preferred fee tier
  const testAmount = asset.toLowerCase() === TOKENS().USDC.toLowerCase() ? 1_000_000n : 1_000_000_000_000_000n; // 1 USDC or 0.001 WETH
  const feeTiers = [preferredFeeTier, 10000, 3000, 500].filter((v, i, a) => a.indexOf(v) === i);

  for (const fee of feeTiers) {
    try {
      await publicClient.simulateContract({
        address: quoterAddr,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: asset, tokenOut: token, amountIn: testAmount, fee, sqrtPriceLimitX96: 0n }],
      });
      cacheSwapRoute(chainId, asset, token, { mode: "direct", feeTier: fee, detectedAt: Math.floor(Date.now() / 1000) });
      return {
        extraData: buildSwapExtraData(network, asset, token, fee),
        routeDesc: `direct (fee ${fee})`,
      };
    } catch {
      // No pool at this fee tier
    }
  }

  // 2. Try multi-hop via WETH
  const weth = TOKENS().WETH;
  if (asset.toLowerCase() === weth.toLowerCase()) return null; // Already tried direct with WETH

  // Find best USDC→WETH fee
  let bestAssetToWethFee: number | null = null;
  for (const fee of [500, 3000, 10000]) {
    try {
      await publicClient.simulateContract({
        address: quoterAddr,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: asset, tokenOut: weth, amountIn: testAmount, fee, sqrtPriceLimitX96: 0n }],
      });
      bestAssetToWethFee = fee;
      break; // 500 is cheapest, prefer it
    } catch {}
  }
  if (!bestAssetToWethFee) return null;

  // Find best WETH→token fee
  const wethTestAmount = 1_000_000_000_000_000n; // 0.001 WETH
  for (const fee of feeTiers) {
    try {
      await publicClient.simulateContract({
        address: quoterAddr,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: weth, tokenOut: token, amountIn: wethTestAmount, fee, sqrtPriceLimitX96: 0n }],
      });
      const hop = { via: weth, feeIn: bestAssetToWethFee, feeOut: fee };
      cacheSwapRoute(chainId, asset, token, { mode: "multi-hop", feeTier: 0, hop, detectedAt: Math.floor(Date.now() / 1000) });
      return {
        extraData: buildSwapExtraData(network, asset, token, 0, hop),
        routeDesc: `multi-hop: ${bestAssetToWethFee}→WETH→${fee}`,
      };
    } catch {}
  }

  return null; // No route found
}

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
  {
    name: "Mamo Yield",
    key: "mamo-yield",
    description: "Deposit into Mamo for optimized yield across Moonwell + Morpho vaults",
    addressKey: "MAMO_YIELD",
  },
  {
    name: "Portfolio",
    key: "portfolio",
    description: "Weighted portfolio of tokens (stock tokens, crypto) with rebalancing",
    addressKey: "PORTFOLIO",
  },
  {
    name: "Hyperliquid Perp",
    key: "hyperliquid-perp",
    description: "Leveraged perp trading on Hyperliquid via HyperEVM precompiles",
    addressKey: "HYPERLIQUID_PERP",
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
    const isSingleHop = !!opts.singleHop;

    // Auto-quote minVVV if not specified (non-direct paths only)
    let minVVV = 0n;
    if (!isDirect) {
      if (opts.minVvv) {
        minVVV = parseUnits(opts.minVvv as string, 18);
      } else {
        // Quote expected VVV out and apply 5% slippage
        const publicClient = getPublicClient();
        const aeroRouterAbi = [{
          name: "getAmountsOut",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "routes", type: "tuple[]", components: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "stable", type: "bool" },
              { name: "factory", type: "address" },
            ]},
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        }] as const;

        const routes = isSingleHop
          ? [{ from: asset, to: vvv, stable: false, factory: AERODROME().FACTORY }]
          : [
              { from: asset, to: TOKENS().WETH, stable: false, factory: AERODROME().FACTORY },
              { from: TOKENS().WETH, to: vvv, stable: false, factory: AERODROME().FACTORY },
            ];

        try {
          const amounts = await publicClient.readContract({
            address: AERODROME().ROUTER,
            abi: aeroRouterAbi,
            functionName: "getAmountsOut",
            args: [assetAmount, routes],
          });
          const expectedVVV = amounts[amounts.length - 1];
          // 5% slippage: minVVV = expectedVVV * 95 / 100
          minVVV = (expectedVVV * 95n) / 100n;
          console.log(chalk.dim(`  Auto-quoted minVVV: ${(Number(minVVV) / 1e18).toFixed(4)} VVV (5% slippage on ~${(Number(expectedVVV) / 1e18).toFixed(4)} VVV)`));
        } catch {
          console.error(chalk.red("Could not quote USDC→VVV price. Pass --min-vvv <amount> manually."));
          process.exit(1);
        }
      }
    }

    const params: veniceBuilder.VeniceInferenceInitParams = {
      asset,
      weth: isDirect ? ZERO : TOKENS().WETH,
      vvv,
      sVVV: VENICE().STAKING,
      aeroRouter: isDirect ? ZERO : AERODROME().ROUTER,
      aeroFactory: isDirect ? ZERO : AERODROME().FACTORY,
      agent,
      assetAmount,
      minVVV,
      deadlineOffset: 300n,
      singleHop: isSingleHop,
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
    const supplyAmount = opts.amount ? parseUnits(opts.amount as string, 18) : 0n; // WETH = 18 decimals; 0 => use full vault balance at execute time
    const slippageBps = BigInt((opts.slippage as string) || "500"); // default 5% slippage
    // Per-unit rates (1e18-scaled) — Aerodrome wstETH/WETH stable pool trades
    // near 1:1, so default the expected rate to 1e18. Slippage cuts from that.
    // Rates scale with amountIn at execute time → dynamic-all mode is safe.
    const ONE = 10n ** 18n;
    const minWstethOutPerWeth = (ONE * (10000n - slippageBps)) / 10000n;
    const minWethOutPerWsteth = (ONE * (10000n - slippageBps)) / 10000n;

    const params: wstethBuilder.WstETHMoonwellInitParams = {
      weth: TOKENS().WETH,
      wsteth: TOKENS().wstETH,
      mwsteth: MOONWELL().mWstETH,
      aeroRouter: AERODROME().ROUTER,
      aeroFactory: AERODROME().FACTORY,
      supplyAmount,
      minWstethOutPerWeth,
      minWethOutPerWsteth,
      deadlineOffset: 300n,
    };

    return {
      initData: wstethBuilder.buildInitData(params),
      asset: TOKENS().WETH,
      assetAmount: supplyAmount,
    };
  }

  if (templateKey === "mamo-yield") {
    if (!opts.amount) {
      console.error(chalk.red("--amount is required for mamo-yield template"));
      process.exit(1);
    }
    if (!opts.mamoFactory) {
      console.error(chalk.red("--mamo-factory is required for mamo-yield template"));
      process.exit(1);
    }
    const token = (opts.token as string) || "USDC";
    const underlying = resolveToken(token);
    const decimals = token.toUpperCase() === "USDC" ? 6 : 18;
    const amount = parseUnits(opts.amount as string, decimals);
    const minRedeemAmount = parseUnits((opts.minRedeem as string) || opts.amount as string, decimals);

    return {
      initData: mamoBuilder.buildInitData(underlying, opts.mamoFactory as Address, minRedeemAmount),
      asset: underlying,
      assetAmount: amount,
    };
  }

  if (templateKey === "portfolio") {
    if (!opts.amount) { console.error(chalk.red("--amount is required for portfolio template")); process.exit(1); }
    if (!opts.tokens || !opts.weights) {
      console.error(chalk.red("--tokens and --weights are required for portfolio template"));
      console.error(chalk.dim("  --tokens: comma-separated token addresses or symbols"));
      console.error(chalk.dim("  --weights: comma-separated bps (must sum to 10000)"));
      process.exit(1);
    }
    const tokens = TOKENS();
    const defaultAsset = getNetwork() === "robinhood-testnet" ? "WETH" : "USDC";
    const assetSymbol = (opts.asset as string) || defaultAsset;
    const asset = resolveToken(assetSymbol);
    const decimals = assetSymbol.toUpperCase() === "USDC" ? 6 : 18;
    const totalAmount = parseUnits(opts.amount as string, decimals);
    const maxSlippageBps = Number((opts.maxSlippage as string) || "500");
    const feeTier = (opts.feeTier as string) || "3000";

    const tokenAddrs = (opts.tokens as string).split(",").map((t) => {
      const trimmed = t.trim();
      if (isAddress(trimmed)) return trimmed as Address;
      const allTokens = tokens as Record<string, Address>;
      const resolved = allTokens[trimmed.toUpperCase()];
      if (resolved && resolved !== ZERO) return resolved;
      console.error(chalk.red(`Unknown token: ${trimmed}`)); process.exit(1);
    });
    const weightsBps = (opts.weights as string).split(",").map((w) => Number(w.trim()));
    if (tokenAddrs.length !== weightsBps.length) { console.error(chalk.red("--tokens and --weights must have same length")); process.exit(1); }
    if (weightsBps.reduce((a, b) => a + b, 0) !== 10000) { console.error(chalk.red(`Weights must sum to 10000`)); process.exit(1); }

    const swapAdapter = (opts.swapAdapter as Address) || resolveSwapAdapter();
    const chainlinkVerifier = CHAINLINK().VERIFIER_PROXY;

    // Auto-detect swap routes for each token
    console.log(chalk.dim("  Detecting swap routes..."));
    const allocations: portfolioBuilder.BasketAllocation[] = [];
    for (let i = 0; i < tokenAddrs.length; i++) {
      const token = tokenAddrs[i];
      const route = await detectSwapRoute(asset, token, Number(feeTier));
      if (!route) {
        console.error(chalk.red(`No swap route found for ${token}. No Uniswap V3 pool (direct or via WETH).`));
        process.exit(1);
      }
      console.log(chalk.dim(`    ${token.slice(0, 10)}... → ${route.routeDesc}`));
      allocations.push({
        token, weightBps: weightsBps[i],
        swapExtraData: route.extraData,
      });
    }
    return {
      initData: portfolioBuilder.buildInitData(asset, swapAdapter, chainlinkVerifier, allocations, totalAmount, maxSlippageBps),
      asset, assetAmount: totalAmount,
    };
  }

  if (templateKey === "hyperliquid-perp") {
    const token = (opts.token as string) || "USDC";
    const asset = resolveToken(token);
    const decimals = token.toUpperCase() === "USDC" ? 6 : 18;
    // Omit --amount to use the vault's full asset balance at execute time (dynamic-all mode).
    const depositAmount = opts.amount ? parseUnits(opts.amount as string, decimals) : 0n;
    // --min-return is a settlement floor: `sweepToVault` reverts on the first
    // call if `balance < minReturnAmount`. With --amount set we default to 1:1
    // (return at least the deposit). With dynamic-all we have no anchor, so
    // require --min-return explicitly — a zero floor would trivially pass the
    // settlement guard and defeat the whole check.
    if (depositAmount === 0n && !opts.minReturn) {
      console.error(chalk.red(
        "--min-return is required when --amount is omitted (dynamic-all mode).\n" +
        "  The settlement floor can't be derived without a reference deposit — " +
        "set it explicitly to the minimum USDC you'll accept back from HyperCore.",
      ));
      process.exit(1);
    }
    const minReturn = opts.minReturn
      ? parseUnits(opts.minReturn as string, decimals)
      : opts.amount
        ? parseUnits(opts.amount as string, decimals)
        : 0n;
    const leverage = Number((opts.leverage as string) || "10");
    const assetIndex = Number((opts.assetIndex as string) || "0");
    const maxPosition = parseUnits((opts.maxPosition as string) || "100000", decimals);
    const maxTradesDay = Number((opts.maxTradesPerDay as string) || "50");
    return {
      initData: hyperliquidPerpBuilder.buildInitData(asset, depositAmount, minReturn, assetIndex, leverage, maxPosition, maxTradesDay),
      asset, assetAmount: depositAmount,
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

  if (templateKey === "mamo-yield") {
    return {
      executeCalls: mamoBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: mamoBuilder.buildSettleCalls(clone),
    };
  }

  if (templateKey === "portfolio") {
    return {
      executeCalls: portfolioBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: portfolioBuilder.buildSettleCalls(clone),
    };
  }

  if (templateKey === "hyperliquid-perp") {
    return {
      executeCalls: hyperliquidPerpBuilder.buildExecuteCalls(clone, asset, assetAmount),
      settleCalls: hyperliquidPerpBuilder.buildSettleCalls(clone),
    };
  }

  throw new Error(`No call builder for template: ${templateKey}`);
}

// ── Token resolution ──

function resolveSwapAdapter(): Address {
  const network = getNetwork();
  if (network === "robinhood-testnet") {
    if (SYNTHRA().ROUTER === ZERO) { console.error(chalk.red("Synthra DEX not available")); process.exit(1); }
    return "0xdae81cDCfcB14c56fCeB788A147Fcd6CbEdfEeca" as Address;
  }
  const adapterAddr = UNISWAP().SWAP_ADAPTER;
  if (adapterAddr !== ZERO) return adapterAddr;
  console.error(chalk.red("UniswapSwapAdapter not deployed yet. Use --swap-adapter to specify manually."));
  process.exit(1);
}

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
      const network = getNetwork();

      console.log();
      console.log(chalk.bold("Strategy Templates"), chalk.dim(`(${network})`));
      console.log(chalk.dim("─".repeat(60)));

      let availableCount = 0;
      for (const t of TEMPLATES) {
        const addr = templates[t.addressKey];
        if (addr !== ZERO) {
          availableCount++;
          console.log();
          console.log(`  ${chalk.bold(t.name)} (${chalk.cyan(t.key)})`);
          console.log(`    ${t.description}`);
          console.log(`    Template: ${chalk.green(addr)}`);
        }
      }

      if (availableCount === 0) {
        console.log();
        console.log(chalk.yellow("  No strategy templates deployed on this network."));
      }

      const unavailable = TEMPLATES.filter((t) => templates[t.addressKey] === ZERO);
      if (unavailable.length > 0) {
        console.log();
        console.log(chalk.dim(`  Not available on ${network}:`));
        for (const t of unavailable) {
          console.log(chalk.dim(`    ${t.name} (${t.key})`));
        }
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
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell, mamo-yield, portfolio, hyperliquid-perp")
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
    // mamo-yield
    .option("--mamo-factory <address>", "Mamo StrategyFactory address (Mamo)")
    // portfolio
    .option("--tokens <list>", "Comma-separated token addresses or symbols (Portfolio)")
    .option("--weights <list>", "Comma-separated weights in bps, must sum to 10000 (Portfolio)")
    .option("--max-slippage <bps>", "Max slippage bps (Portfolio, default: 500)")
    .option("--fee-tier <n>", "Pool fee tier (Portfolio, default: 3000)")
    .option("--swap-adapter <address>", "Swap adapter address (Portfolio)")
    // hyperliquid-perp
    .option("--leverage <number>", "Leverage multiplier (Hyperliquid Perp, default: 10)")
    .option("--asset-index <number>", "Perp asset index (Hyperliquid Perp, default: 0 for BTC)")
    .option("--min-return <n>", "Min return amount on settlement (Hyperliquid Perp)")
    .option("--max-position <amount>", "Max position size in USD (Hyperliquid Perp, default: 100000)")
    .option("--max-trades-per-day <n>", "Max trades per day (Hyperliquid Perp, default: 50)")
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
        console.error(chalk.red(formatContractError(err)));
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

        const receipt = await waitForReceipt(initHash);
        if (receipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(formatContractError(err)));
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
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell, mamo-yield, portfolio, hyperliquid-perp")
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
    // mamo-yield
    .option("--mamo-factory <address>", "Mamo StrategyFactory address (Mamo)")
    // portfolio
    .option("--tokens <list>", "Comma-separated token addresses or symbols (Portfolio)")
    .option("--weights <list>", "Comma-separated weights in bps, must sum to 10000 (Portfolio)")
    .option("--max-slippage <bps>", "Max slippage bps (Portfolio, default: 500)")
    .option("--fee-tier <n>", "Pool fee tier (Portfolio, default: 3000)")
    .option("--swap-adapter <address>", "Swap adapter address (Portfolio)")
    // hyperliquid-perp
    .option("--leverage <number>", "Leverage multiplier (Hyperliquid Perp, default: 10)")
    .option("--asset-index <number>", "Perp asset index (Hyperliquid Perp, default: 0 for BTC)")
    .option("--min-return <n>", "Min return amount on settlement (Hyperliquid Perp)")
    .option("--max-position <amount>", "Max position size in USD (Hyperliquid Perp, default: 100000)")
    .option("--max-trades-per-day <n>", "Max trades per day (Hyperliquid Perp, default: 50)")
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

        const receipt = await waitForReceipt(initHash);
        if (receipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(initHash)}`));
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(formatContractError(err)));
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
    .argument("<template>", "Template: moonwell-supply, aerodrome-lp, venice-inference, wsteth-moonwell, mamo-yield, portfolio, hyperliquid-perp")
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
    // mamo-yield
    .option("--mamo-factory <address>", "Mamo StrategyFactory address (Mamo)")
    // portfolio
    .option("--tokens <list>", "Comma-separated token addresses or symbols (Portfolio)")
    .option("--weights <list>", "Comma-separated weights in bps, must sum to 10000 (Portfolio)")
    .option("--max-slippage <bps>", "Max slippage bps (Portfolio, default: 500)")
    .option("--fee-tier <n>", "Pool fee tier (Portfolio, default: 3000)")
    .option("--swap-adapter <address>", "Swap adapter address (Portfolio)")
    // hyperliquid-perp
    .option("--leverage <number>", "Leverage multiplier (Hyperliquid Perp, default: 10)")
    .option("--asset-index <number>", "Perp asset index (Hyperliquid Perp, default: 0 for BTC)")
    .option("--min-return <n>", "Min return amount on settlement (Hyperliquid Perp)")
    .option("--max-position <amount>", "Max position size in USD (Hyperliquid Perp, default: 100000)")
    .option("--max-trades-per-day <n>", "Max trades per day (Hyperliquid Perp, default: 50)")
    .action(async (templateKey: string, opts) => {
      const vault = opts.vault as Address;
      if (!isAddress(vault)) {
        console.error(chalk.red("Invalid vault address"));
        process.exit(1);
      }

      const { def, address: templateAddr } = resolveTemplate(templateKey);

      // 0. Preflight — bail out before burning gas on clone + init for a
      //    proposal the governor will refuse anyway. Two read-only checks,
      //    no gas cost.
      const account = getAccount();
      const preflightSpinner = ora("Preflight checks...").start();
      try {
        const publicClient = getPublicClient();

        // (a) Signer must be a registered active agent on this vault.
        const isRegistered = await publicClient.readContract({
          address: vault,
          abi: SYNDICATE_VAULT_ABI,
          functionName: "isAgent",
          args: [account.address],
        });
        if (!isRegistered) {
          preflightSpinner.fail("Preflight failed");
          console.error(
            chalk.red(
              `  Signer ${account.address} is not a registered agent on ${vault}.\n` +
                `  Register first via: sherwood syndicate approve --wallet ${account.address}`,
            ),
          );
          process.exit(1);
        }

        // (b) Vault must not be paused (deposits + governance ops would revert).
        const paused = await publicClient.readContract({
          address: vault,
          abi: SYNDICATE_VAULT_ABI,
          functionName: "paused",
        });
        if (paused) {
          preflightSpinner.fail("Preflight failed");
          console.error(chalk.red(`  Vault ${vault} is paused. Cannot propose.`));
          process.exit(1);
        }

        preflightSpinner.succeed("Preflight OK");
      } catch (err) {
        preflightSpinner.fail("Preflight failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

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
        console.error(chalk.red(formatContractError(err)));
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

        // account hoisted above during preflight — reuse.
        const initHash = await writeContractWithRetry({
          account,
          chain: getChain(),
          address: clone,
          abi: BASE_STRATEGY_ABI,
          functionName: "initialize",
          args: [vault, account.address, built.initData],
        });

        const initReceipt = await waitForReceipt(initHash);
        if (initReceipt.status === "reverted") {
          throw new Error("Initialize transaction reverted on-chain");
        }
        initSpinner.succeed("Initialized");
      } catch (err) {
        initSpinner.fail("Initialize failed");
        console.error(chalk.red(formatContractError(err)));
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
      // account already hoisted at preflight.

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
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

      const proposeSpinner = ora("Submitting proposal...").start();
      try {
        const { hash, proposalId } = await propose(
          vault, metadataURI, performanceFeeBps, strategyDuration,
          executeCalls, settleCalls,
        );
        proposeSpinner.succeed(`Proposal #${proposalId} created`);
        console.log(`Proposal #${proposalId}`);
        console.log(chalk.dim(`  Tx: ${getExplorerUrl(hash)}`));
        console.log(chalk.dim(`  Clone: ${clone}`));
      } catch (err) {
        proposeSpinner.fail("Proposal failed");
        console.error(chalk.red(formatContractError(err)));
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

  // ── strategy status ──

  strategy
    .command("status")
    .description("Show portfolio strategy status — allocations, balances, drift, PnL (Portfolio only)")
    .argument("<clone>", "Strategy clone address")
    .option("--json", "Output machine-readable JSON for agent consumption")
    .action(async (cloneArg: string, opts) => {
      if (!isAddress(cloneArg)) {
        console.error(chalk.red("Invalid clone address"));
        process.exit(1);
      }
      const clone = cloneArg as Address;
      const publicClient = getPublicClient();
      const network = getNetwork();
      const jsonMode = !!opts.json;

      const spinner = jsonMode ? null : ora("Reading strategy state...").start();
      try {
        // Read strategy state + swap extra data (for fee tiers)
        const [stateRaw, vault, proposer, assetAddr, totalAmount, maxSlippage, allocations, swapExtraData] = await Promise.all([
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "state" }),
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "vault" }) as Promise<Address>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "proposer" }) as Promise<Address>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "asset" }) as Promise<Address>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "totalAmount" }) as Promise<bigint>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "maxSlippageBps" }) as Promise<bigint>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "getAllocations" }) as Promise<readonly { token: Address; targetWeightBps: bigint; tokenAmount: bigint; investedAmount: bigint }[]>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "getSwapExtraData" }) as Promise<readonly `0x${string}`[]>,
        ]);

        const stateNames = ["Pending", "Executed", "Settled"];
        const stateStr = stateNames[Number(stateRaw)] || `Unknown(${stateRaw})`;

        // Read asset decimals & symbol
        const [assetDecimals, assetSymbol] = await Promise.all([
          publicClient.readContract({ address: assetAddr, abi: erc20Abi, functionName: "decimals" }),
          publicClient.readContract({ address: assetAddr, abi: erc20Abi, functionName: "symbol" }),
        ]);

        // Read current token balances & symbols in parallel
        const tokenReads = allocations.map((a) => Promise.all([
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [clone] }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "symbol" }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "decimals" }),
        ]));
        const tokenData = await Promise.all(tokenReads);

        // Read asset balance held by strategy
        const assetBalance = await publicClient.readContract({
          address: assetAddr,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [clone],
        });

        // Extract fee tiers from swapExtraData (abi.encode(uint24 fee))
        const feeTiers = swapExtraData.map((data) => {
          try {
            const [fee] = decodeAbiParameters([{ type: "uint24" }], data);
            return Number(fee) > 0 && Number(fee) <= 100000 ? Number(fee) : 3000;
          } catch {
            return 3000;
          }
        });

        // Fetch prices (graceful — continues without if unavailable)
        let prices: (import("../lib/price.js").TokenPrice | null)[] = [];
        let priceSource: "uniswap" | "synthra" | null = null;
        try {
          const { getTokenPricesInAsset } = await import("../lib/price.js");
          prices = await getTokenPricesInAsset({
            tokens: allocations.map((a, i) => ({
              token: a.token,
              tokenDecimals: tokenData[i][2] as number,
              feeTier: feeTiers[i],
            })),
            asset: assetAddr,
            assetDecimals,
          });
          priceSource = prices.find((p) => p !== null)?.source ?? null;
        } catch {
          // Prices unavailable — continue with balance-only
        }

        const pricesAvailable = prices.some((p) => p !== null);

        // Compute enriched allocation data
        const assetBalanceNum = Number(formatUnits(assetBalance as bigint, assetDecimals));
        let totalPortfolioValue = assetBalanceNum;
        let totalInvested = 0n;

        interface AllocStatus {
          token: Address;
          symbol: string;
          decimals: number;
          targetWeightBps: number;
          balance: string;
          balanceRaw: string;
          investedAmount: string;
          currentPrice: number | null;
          currentValue: number | null;
          actualWeightBps: number | null;
          driftBps: number | null;
          pnl: number | null;
          pnlPct: number | null;
        }

        const allocStatuses: AllocStatus[] = allocations.map((alloc, i) => {
          const [balance, symbol, decimals] = tokenData[i];
          const balanceNum = Number(formatUnits(balance as bigint, decimals));
          const investedNum = Number(formatUnits(alloc.investedAmount, assetDecimals));
          totalInvested += alloc.investedAmount;

          const price = prices[i];
          let currentValue: number | null = null;

          if (price) {
            currentValue = balanceNum * price.price;
            totalPortfolioValue += currentValue;
          }

          return {
            token: alloc.token,
            symbol: symbol as string,
            decimals: decimals as number,
            targetWeightBps: Number(alloc.targetWeightBps),
            balance: formatUnits(balance as bigint, decimals),
            balanceRaw: (balance as bigint).toString(),
            investedAmount: formatUnits(alloc.investedAmount, assetDecimals),
            currentPrice: price?.price ?? null,
            currentValue,
            actualWeightBps: null, // computed after totals
            driftBps: null,
            pnl: currentValue !== null ? currentValue - investedNum : null,
            pnlPct: currentValue !== null && investedNum > 0
              ? ((currentValue - investedNum) / investedNum) * 100
              : null,
          };
        });

        // Second pass: compute actual weights and drift (needs totalPortfolioValue)
        let maxDriftBps = 0;
        let maxDriftToken = "";
        if (pricesAvailable && totalPortfolioValue > 0) {
          for (const a of allocStatuses) {
            if (a.currentValue !== null) {
              a.actualWeightBps = Math.round((a.currentValue / totalPortfolioValue) * 10000);
              a.driftBps = a.actualWeightBps - a.targetWeightBps;
              if (Math.abs(a.driftBps) > Math.abs(maxDriftBps)) {
                maxDriftBps = a.driftBps;
                maxDriftToken = a.symbol;
              }
            }
          }
        }

        // Total PnL
        const totalInvestedNum = Number(formatUnits(totalInvested, assetDecimals));
        const totalPnl = pricesAvailable ? totalPortfolioValue - totalInvestedNum : null;
        const totalPnlPct = totalPnl !== null && totalInvestedNum > 0
          ? (totalPnl / totalInvestedNum) * 100
          : null;

        spinner?.succeed("Strategy state loaded");

        // ── JSON output ──
        if (jsonMode) {
          const result = {
            clone,
            vault,
            proposer,
            state: stateStr,
            network,
            asset: { address: assetAddr, symbol: assetSymbol as string, decimals: assetDecimals as number },
            totalDeployed: formatUnits(totalAmount, assetDecimals),
            maxSlippageBps: Number(maxSlippage),
            assetBalance: formatUnits(assetBalance as bigint, assetDecimals),
            pricesAvailable,
            priceSource,
            portfolio: {
              totalValue: pricesAvailable ? totalPortfolioValue : null,
              totalPnl,
              totalPnlPct,
            },
            allocations: allocStatuses,
            maxDriftBps: pricesAvailable ? maxDriftBps : null,
            maxDriftToken: pricesAvailable ? maxDriftToken : null,
            timestamp: new Date().toISOString(),
          };
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }

        // ── Human-friendly output ──
        const stateColor = stateStr === "Executed" ? chalk.green : stateStr === "Settled" ? chalk.blue : chalk.yellow;

        console.log();
        console.log(chalk.bold("Portfolio Strategy Status"));
        console.log(chalk.dim("─".repeat(70)));
        console.log(`  Clone:       ${chalk.cyan(clone)}`);
        console.log(`  Vault:       ${chalk.cyan(vault)}`);
        console.log(`  Proposer:    ${chalk.cyan(proposer)}`);
        console.log(`  State:       ${stateColor(stateStr)}`);
        console.log(`  Asset:       ${assetSymbol} (${assetAddr})`);
        console.log(`  Deployed:    ${formatUnits(totalAmount, assetDecimals)} ${assetSymbol}`);
        console.log(`  Max Slip:    ${Number(maxSlippage) / 100}%`);
        console.log(`  Asset held:  ${formatUnits(assetBalance as bigint, assetDecimals)} ${assetSymbol}`);

        if (pricesAvailable) {
          const pvStr = totalPortfolioValue.toFixed(6);
          const pnlStr = totalPnl !== null ? (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(6) : "n/a";
          const pnlPctStr = totalPnlPct !== null ? (totalPnlPct >= 0 ? "+" : "") + totalPnlPct.toFixed(1) + "%" : "";
          const pnlColor = totalPnl !== null && totalPnl >= 0 ? chalk.green : chalk.red;
          console.log(`  Value:       ${pvStr} ${assetSymbol}  |  PnL: ${pnlColor(`${pnlStr} (${pnlPctStr})`)}`);
          console.log(`  Price src:   ${priceSource}`);
        }

        console.log();
        console.log(chalk.bold("Allocations"));
        console.log(chalk.dim("─".repeat(70)));

        if (pricesAvailable) {
          // Price-enriched table
          console.log(
            chalk.dim("  Token".padEnd(10)) +
            chalk.dim("Target".padEnd(9)) +
            chalk.dim("Actual".padEnd(9)) +
            chalk.dim("Drift".padEnd(8)) +
            chalk.dim("Value".padEnd(16)) +
            chalk.dim("PnL".padEnd(16)) +
            chalk.dim("Balance"),
          );

          for (const a of allocStatuses) {
            const targetStr = (a.targetWeightBps / 100).toFixed(1) + "%";
            const actualStr = a.actualWeightBps !== null ? (a.actualWeightBps / 100).toFixed(1) + "%" : "—";
            const driftStr = a.driftBps !== null
              ? (a.driftBps >= 0 ? "+" : "") + a.driftBps
              : "—";
            const driftColor = a.driftBps !== null
              ? (Math.abs(a.driftBps) > 500 ? chalk.red : Math.abs(a.driftBps) > 200 ? chalk.yellow : chalk.dim)
              : chalk.dim;
            const valueStr = a.currentValue !== null ? a.currentValue.toFixed(6) : "—";
            const pnlPctStr = a.pnlPct !== null ? (a.pnlPct >= 0 ? "+" : "") + a.pnlPct.toFixed(1) + "%" : "—";
            const pnlColor = a.pnlPct !== null ? (a.pnlPct >= 0 ? chalk.green : chalk.red) : chalk.dim;

            console.log(
              `  ${chalk.bold(a.symbol.padEnd(8))}` +
              `${targetStr.padEnd(9)}` +
              `${actualStr.padEnd(9)}` +
              `${driftColor(driftStr.toString().padEnd(8))}` +
              `${valueStr.padEnd(16)}` +
              `${pnlColor(pnlPctStr.padEnd(16))}` +
              `${a.balance}`,
            );
          }
        } else {
          // Balance-only table (no prices available)
          console.log(chalk.dim("  Prices unavailable — showing raw balances only."));
          console.log();
          console.log(
            chalk.dim("  Token".padEnd(12)) +
            chalk.dim("Weight".padEnd(10)) +
            chalk.dim("Invested".padEnd(18)) +
            chalk.dim("Balance".padEnd(18)) +
            chalk.dim("Address"),
          );

          for (const a of allocStatuses) {
            const weightPct = (a.targetWeightBps / 100).toFixed(1) + "%";
            console.log(
              `  ${chalk.bold(a.symbol.padEnd(10))}` +
              `${weightPct.padEnd(10)}` +
              `${a.investedAmount.padEnd(18)}` +
              `${a.balance.padEnd(18)}` +
              `${chalk.dim(a.token)}`,
            );
          }
        }

        console.log(chalk.dim("─".repeat(70)));
        console.log(`  Total invested: ${formatUnits(totalInvested, assetDecimals)} ${assetSymbol}`);

        if (pricesAvailable && maxDriftToken) {
          const absMaxDrift = Math.abs(maxDriftBps);
          const driftColor = absMaxDrift > 500 ? chalk.red : absMaxDrift > 200 ? chalk.yellow : chalk.green;
          console.log(`  Max drift:      ${driftColor(`${maxDriftBps > 0 ? "+" : ""}${maxDriftBps} bps`)} (${maxDriftToken})`);
        }

        if (stateStr === "Executed") {
          console.log();
          console.log(chalk.dim("Rebalance:  sherwood strategy rebalance " + clone));
          console.log(chalk.dim("With new weights: sherwood strategy rebalance " + clone + " --new-weights 2500,2500,2000,1500,1500"));
        }

        console.log();
      } catch (err) {
        spinner?.fail("Failed to read strategy state");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── strategy rebalance ──

  strategy
    .command("rebalance")
    .description("Rebalance a portfolio strategy — sell all positions, re-buy at target weights (Portfolio only)")
    .argument("<clone>", "Strategy clone address")
    .option("--new-weights <list>", "Comma-separated new weights in bps (must sum to 10000). Updates weights before rebalancing.")
    .option("--max-slippage <bps>", "New max slippage bps (used with --new-weights)")
    .option("--dry-run", "Show what would happen without executing")
    .action(async (cloneArg: string, opts) => {
      if (!isAddress(cloneArg)) {
        console.error(chalk.red("Invalid clone address"));
        process.exit(1);
      }
      const clone = cloneArg as Address;
      const publicClient = getPublicClient();
      const account = getAccount();
      const chain = getChain();

      // 1. Verify strategy state
      const verifySpinner = ora("Verifying strategy state...").start();
      try {
        const [stateRaw, proposer, assetAddr, allocations] = await Promise.all([
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "state" }),
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "proposer" }) as Promise<Address>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "asset" }) as Promise<Address>,
          publicClient.readContract({ address: clone, abi: PORTFOLIO_STRATEGY_ABI, functionName: "getAllocations" }) as Promise<readonly { token: Address; targetWeightBps: bigint; tokenAmount: bigint; investedAmount: bigint }[]>,
        ]);

        // Check state
        if (Number(stateRaw) !== 1) { // State.Executed = 1
          const stateNames = ["Pending", "Executed", "Settled"];
          verifySpinner.fail(`Strategy is ${stateNames[Number(stateRaw)] || "Unknown"}, must be Executed to rebalance`);
          process.exit(1);
        }

        // Check proposer
        if (proposer.toLowerCase() !== account.address.toLowerCase()) {
          verifySpinner.fail(`Only the proposer (${proposer}) can rebalance. Your wallet: ${account.address}`);
          process.exit(1);
        }

        const [assetDecimals, assetSymbol] = await Promise.all([
          publicClient.readContract({ address: assetAddr, abi: erc20Abi, functionName: "decimals" }),
          publicClient.readContract({ address: assetAddr, abi: erc20Abi, functionName: "symbol" }),
        ]);

        // Read current balances
        const tokenReads = allocations.map((a) => Promise.all([
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [clone] }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "symbol" }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "decimals" }),
        ]));
        const tokenData = await Promise.all(tokenReads);

        verifySpinner.succeed("Strategy is Executed — ready to rebalance");

        // Show current allocations
        console.log();
        console.log(chalk.bold("Current Allocations"));
        console.log(chalk.dim("─".repeat(50)));
        for (let i = 0; i < allocations.length; i++) {
          const alloc = allocations[i];
          const [balance, symbol, decimals] = tokenData[i];
          const weightPct = (Number(alloc.targetWeightBps) / 100).toFixed(1) + "%";
          console.log(
            `  ${chalk.bold((symbol as string).padEnd(8))} ` +
            `${weightPct.padEnd(8)} ` +
            `bal: ${formatUnits(balance as bigint, decimals)}`,
          );
        }

        // Parse new weights if provided
        let newWeightsBps: number[] | undefined;
        if (opts.newWeights) {
          newWeightsBps = (opts.newWeights as string).split(",").map((w) => Number(w.trim()));
          if (newWeightsBps.length !== allocations.length) {
            console.error(chalk.red(`--new-weights must have ${allocations.length} values (one per token)`));
            process.exit(1);
          }
          const weightSum = newWeightsBps.reduce((a, b) => a + b, 0);
          if (weightSum !== 10000) {
            console.error(chalk.red(`Weights must sum to 10000, got ${weightSum}`));
            process.exit(1);
          }

          console.log();
          console.log(chalk.bold("New Target Weights"));
          console.log(chalk.dim("─".repeat(50)));
          for (let i = 0; i < allocations.length; i++) {
            const [, symbol] = tokenData[i];
            const oldPct = (Number(allocations[i].targetWeightBps) / 100).toFixed(1);
            const newPct = (newWeightsBps[i] / 100).toFixed(1);
            const arrow = oldPct !== newPct ? chalk.yellow("→") : chalk.dim("→");
            console.log(`  ${chalk.bold((symbol as string).padEnd(8))} ${oldPct}% ${arrow} ${newPct}%`);
          }
        }

        if (opts.dryRun) {
          console.log();
          console.log(chalk.yellow("Dry run — no transactions sent."));
          console.log(chalk.dim("The rebalance would:"));
          console.log(chalk.dim("  1. Sell all current token positions back to " + assetSymbol));
          console.log(chalk.dim("  2. Re-buy at " + (newWeightsBps ? "new" : "current") + " target weights"));
          console.log();
          return;
        }

        // 2. Update weights first (if specified)
        if (newWeightsBps) {
          const maxSlip = Number((opts.maxSlippage as string) || "0");
          const swapData = await publicClient.readContract({
            address: clone,
            abi: PORTFOLIO_STRATEGY_ABI,
            functionName: "getSwapExtraData",
          }) as Hex[];

          const updateSpinner = ora("Updating target weights...").start();
          try {
            const innerData = encodeAbiParameters(
              [{ type: "uint256[]" }, { type: "uint256" }, { type: "bytes[]" }],
              [newWeightsBps.map((w: number) => BigInt(w)), BigInt(maxSlip), swapData],
            );

            const updateHash = await writeContractWithRetry({
              account,
              chain,
              address: clone,
              abi: PORTFOLIO_STRATEGY_ABI,
              functionName: "updateParams",
              args: [innerData],
            });

            const receipt = await waitForReceipt(updateHash);
            if (receipt.status === "reverted") throw new Error("updateParams reverted");
            updateSpinner.succeed("Target weights updated");
            console.log(chalk.dim(`  Tx: ${getExplorerUrl(updateHash)}`));
          } catch (err) {
            updateSpinner.fail("Failed to update weights");
            console.error(chalk.red(formatContractError(err)));
            process.exit(1);
          }
        }

        // 3. Execute rebalance
        const rebalanceSpinner = ora("Rebalancing portfolio (sell all → re-buy at targets)...").start();
        try {
          const rebalanceHash = await writeContractWithRetry({
            account,
            chain,
            address: clone,
            abi: PORTFOLIO_STRATEGY_ABI,
            functionName: "rebalance",
          });

          const receipt = await waitForReceipt(rebalanceHash);
          if (receipt.status === "reverted") throw new Error("rebalance() reverted on-chain");
          rebalanceSpinner.succeed("Portfolio rebalanced");
          console.log(chalk.dim(`  Tx: ${getExplorerUrl(rebalanceHash)}`));
        } catch (err) {
          rebalanceSpinner.fail("Rebalance failed");
          console.error(chalk.red(formatContractError(err)));
          process.exit(1);
        }

        // 4. Show updated balances
        const postSpinner = ora("Reading updated allocations...").start();
        const postAllocations = await publicClient.readContract({
          address: clone,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "getAllocations",
        }) as readonly { token: Address; targetWeightBps: bigint; tokenAmount: bigint; investedAmount: bigint }[];

        const postReads = postAllocations.map((a) => Promise.all([
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [clone] }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "symbol" }),
          publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "decimals" }),
        ]));
        const postData = await Promise.all(postReads);
        postSpinner.succeed("Updated allocations");

        console.log();
        console.log(chalk.bold("Post-Rebalance Allocations"));
        console.log(chalk.dim("─".repeat(50)));
        for (let i = 0; i < postAllocations.length; i++) {
          const alloc = postAllocations[i];
          const [balance, symbol, decimals] = postData[i];
          const weightPct = (Number(alloc.targetWeightBps) / 100).toFixed(1) + "%";
          const investedStr = formatUnits(alloc.investedAmount, assetDecimals);
          console.log(
            `  ${chalk.bold((symbol as string).padEnd(8))} ` +
            `${weightPct.padEnd(8)} ` +
            `invested: ${investedStr.padEnd(14)} ` +
            `bal: ${formatUnits(balance as bigint, decimals)}`,
          );
        }

        console.log();
        console.log(chalk.green("✓ Rebalance complete"));
        console.log();
      } catch (err: any) {
        if (err.code === "ERR_MODULE_NOT_FOUND" || err instanceof TypeError) throw err;
        verifySpinner.fail("Pre-flight check failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });
}
