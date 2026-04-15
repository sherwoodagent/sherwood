/**
 * Network-aware price quoting for portfolio valuation.
 *
 * Dispatches to the right DEX quoter based on network:
 *   - Base / Base Sepolia → Uniswap QuoterV2 (struct params, 4-tuple return)
 *   - Robinhood testnet   → Direct pool slot0 (Synthra QuoterV2 can't resolve
 *     proxy-deployed pools via CREATE2, so we read sqrtPriceX96 from the pool)
 *
 * Uniswap quoter uses eth_call (not view — it reverts internally).
 */

import type { Address } from "viem";
import { encodeFunctionData, decodeFunctionResult, parseUnits, formatUnits } from "viem";
import { getPublicClient } from "./client.js";
import { getNetwork } from "./network.js";
import { UNISWAP, SYNTHRA } from "./addresses.js";
import { UNISWAP_QUOTER_V2_ABI } from "./abis.js";

export interface TokenPrice {
  price: number;       // 1 token = X asset units (human-readable)
  amountOut: bigint;   // raw quoter output
  source: "uniswap" | "synthra";
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Get the price of one token denominated in the strategy's asset.
 * Uses the appropriate DEX quoter for the current network.
 */
export async function getTokenPriceInAsset(params: {
  token: Address;
  tokenDecimals: number;
  asset: Address;
  assetDecimals: number;
  feeTier: number;
}): Promise<TokenPrice> {
  const { token, tokenDecimals, asset, assetDecimals, feeTier } = params;

  // Short-circuit: token IS the asset
  if (token.toLowerCase() === asset.toLowerCase()) {
    return { price: 1.0, amountOut: parseUnits("1", assetDecimals), source: "uniswap" };
  }

  const network = getNetwork();
  const client = getPublicClient();

  if (network === "robinhood-testnet") {
    return quoteSynthra(client, token, tokenDecimals, asset, assetDecimals, feeTier);
  }

  return quoteUniswap(client, token, tokenDecimals, asset, assetDecimals, feeTier);
}

/**
 * Batch price lookup — parallel, graceful failure (null per failed quote).
 */
export async function getTokenPricesInAsset(params: {
  tokens: { token: Address; tokenDecimals: number; feeTier: number }[];
  asset: Address;
  assetDecimals: number;
}): Promise<(TokenPrice | null)[]> {
  const { tokens, asset, assetDecimals } = params;

  const results = await Promise.allSettled(
    tokens.map((t) =>
      getTokenPriceInAsset({
        token: t.token,
        tokenDecimals: t.tokenDecimals,
        asset,
        assetDecimals,
        feeTier: t.feeTier,
      }),
    ),
  );

  return results.map((r) => (r.status === "fulfilled" ? r.value : null));
}

// ── Synthra direct pool pricing (Robinhood testnet) ──
//
// The Synthra QuoterV2 can't resolve proxy-deployed pools via CREATE2 (same
// issue that led to SynthraDirectAdapter). Instead we look up the pool via
// factory.getPool(), read slot0.sqrtPriceX96, and derive the spot price.

const POOL_SLOT0_ABI = [
  {
    type: "function" as const,
    name: "slot0",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" as const },
      { name: "tick", type: "int24" as const },
      { name: "observationIndex", type: "uint16" as const },
      { name: "observationCardinality", type: "uint16" as const },
      { name: "observationCardinalityNext", type: "uint16" as const },
      { name: "feeProtocol", type: "uint8" as const },
      { name: "unlocked", type: "bool" as const },
    ],
    stateMutability: "view" as const,
  },
] as const;

const POOL_TOKEN0_ABI = [
  {
    type: "function" as const,
    name: "token0",
    inputs: [],
    outputs: [{ name: "", type: "address" as const }],
    stateMutability: "view" as const,
  },
] as const;

const FACTORY_GET_POOL_ABI = [
  {
    type: "function" as const,
    name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" as const },
      { name: "tokenB", type: "address" as const },
      { name: "fee", type: "uint24" as const },
    ],
    outputs: [{ name: "", type: "address" as const }],
    stateMutability: "view" as const,
  },
] as const;

/**
 * Derive a spot price from a Uniswap V3 / Synthra V3 pool's sqrtPriceX96.
 *
 * sqrtPriceX96 = sqrt(token1/token0) × 2^96
 * price (token1 per token0) = (sqrtPriceX96 / 2^96)^2
 *
 * Returns the price of `tokenIn` denominated in `tokenOut`.
 */
function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
  tokenInIsToken0: boolean,
): number {
  const Q96 = 2 ** 96;
  const ratio = Number(sqrtPriceX96) / Q96;
  // raw price = token1 per token0 (adjusted for same-decimal tokens only)
  const rawPrice = ratio * ratio;
  // decimal adjustment: token0Decimals - token1Decimals
  const decimalAdjust = 10 ** (token0Decimals - token1Decimals);
  const token1PerToken0 = rawPrice * decimalAdjust;

  // If tokenIn is token0, price = how many token1 per token0 → token1PerToken0
  // If tokenIn is token1, price = how many token0 per token1 → 1/token1PerToken0
  return tokenInIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

async function quoteSynthra(
  client: ReturnType<typeof getPublicClient>,
  tokenIn: Address,
  tokenInDecimals: number,
  tokenOut: Address,
  tokenOutDecimals: number,
  fee: number,
): Promise<TokenPrice> {
  const factoryAddr = SYNTHRA().FACTORY;
  if (factoryAddr === ZERO) {
    throw new Error("Synthra Factory not deployed on this network");
  }

  // 1. Resolve pool via factory.getPool()
  const pool = await client.readContract({
    address: factoryAddr,
    abi: FACTORY_GET_POOL_ABI,
    functionName: "getPool",
    args: [tokenIn, tokenOut, fee],
  });

  if (!pool || pool === ZERO) {
    throw new Error(`No Synthra pool for ${tokenIn}↔${tokenOut} fee=${fee}`);
  }

  // 2. Read slot0 and token0 from the pool
  const [slot0, token0] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_SLOT0_ABI, functionName: "slot0" }),
    client.readContract({ address: pool, abi: POOL_TOKEN0_ABI, functionName: "token0" }),
  ]);

  const sqrtPriceX96 = slot0[0];
  if (sqrtPriceX96 === 0n) {
    throw new Error(`Pool ${pool} not initialized (sqrtPriceX96 = 0)`);
  }

  // 3. Determine token ordering
  const tokenInIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
  const t0Decimals = tokenInIsToken0 ? tokenInDecimals : tokenOutDecimals;
  const t1Decimals = tokenInIsToken0 ? tokenOutDecimals : tokenInDecimals;

  const price = priceFromSqrtPriceX96(sqrtPriceX96, t0Decimals, t1Decimals, tokenInIsToken0);

  // Compute amountOut for 1 tokenIn
  const oneToken = parseUnits("1", tokenInDecimals);
  const amountOut = BigInt(Math.round(price * Number(parseUnits("1", tokenOutDecimals))));

  return { price, amountOut, source: "synthra" };
}

// ── Uniswap QuoterV2 (Base / Base Sepolia) ──

async function quoteUniswap(
  client: ReturnType<typeof getPublicClient>,
  tokenIn: Address,
  tokenInDecimals: number,
  tokenOut: Address,
  tokenOutDecimals: number,
  fee: number,
): Promise<TokenPrice> {
  const quoterAddr = UNISWAP().QUOTER_V2;
  if (quoterAddr === ZERO) {
    throw new Error("Uniswap QuoterV2 not deployed on this network");
  }

  const oneToken = parseUnits("1", tokenInDecimals);

  const calldata = encodeFunctionData({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        amountIn: oneToken,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const { data } = await client.call({ to: quoterAddr, data: calldata });

  if (!data) {
    throw new Error(`Uniswap quoter returned no data for ${tokenIn}→${tokenOut} fee=${fee}`);
  }

  const [amountOut] = decodeFunctionResult({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    data,
  }) as [bigint, bigint, number, bigint];

  const price = Number(formatUnits(amountOut, tokenOutDecimals));
  return { price, amountOut, source: "uniswap" };
}
