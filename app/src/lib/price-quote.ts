/**
 * Client-side Uniswap V3 QuoterV2 price fetching.
 *
 * Ported from cli/src/lib/price.ts — uses encodeFunctionData + client.call()
 * because QuoterV2 is nonpayable (reverts internally, returns data via revert).
 */

import {
  type Address,
  type PublicClient,
  createPublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  formatUnits,
  parseUnits,
  http,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { getAddresses, UNISWAP_QUOTER_V2_ABI, robinhoodTestnet } from "./contracts";

/** Client-safe RPC URL resolver — reads NEXT_PUBLIC_ env vars that Next.js inlines at build. */
function getClientRpcUrl(chainId: number): string {
  const envMap: Record<number, string> = {
    8453: process.env.NEXT_PUBLIC_RPC_URL_BASE || "https://mainnet.base.org",
    84532: process.env.NEXT_PUBLIC_RPC_URL_BASE_SEPOLIA || "https://sepolia.base.org",
    46630: "https://rpc.testnet.chain.robinhood.com",
  };
  return envMap[chainId] || "https://mainnet.base.org";
}

// Known WETH addresses per chain (for multi-hop routing)
const WETH: Record<number, Address> = {
  8453: "0x4200000000000000000000000000000000000006",
  84532: "0x4200000000000000000000000000000000000006",
};

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const CHAIN_MAP: Record<number, typeof base> = {
  8453: base,
  84532: baseSepolia,
  46630: robinhoodTestnet,
};

export interface TokenPrice {
  price: number;
  amountOut: bigint;
}

/** Try a single QuoterV2 call, return TokenPrice or null. */
async function tryQuote(
  client: PublicClient,
  quoterV2: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
  outDecimals: number,
): Promise<TokenPrice | null> {
  try {
    const calldata = encodeFunctionData({
      abi: UNISWAP_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const { data } = await client.call({ to: quoterV2, data: calldata });
    if (!data) return null;
    const [amountOut] = decodeFunctionResult({
      abi: UNISWAP_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      data,
    }) as [bigint, bigint, number, bigint];
    return { price: Number(formatUnits(amountOut, outDecimals)), amountOut };
  } catch {
    return null;
  }
}

/** Try a single QuoterV2 call, return raw amountOut or null. */
async function tryQuoteRaw(
  client: PublicClient,
  quoterV2: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const calldata = encodeFunctionData({
      abi: UNISWAP_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const { data } = await client.call({ to: quoterV2, data: calldata });
    if (!data) return null;
    const [amountOut] = decodeFunctionResult({
      abi: UNISWAP_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      data,
    }) as [bigint, bigint, number, bigint];
    return amountOut;
  } catch {
    return null;
  }
}

/**
 * Quote the price of 1 unit of `token` denominated in `asset` (e.g. USDC).
 * Tries fee tiers in order: preferred → 10000 → 3000 → 500.
 * Falls back to multi-hop via WETH if no direct pool exists.
 */
export async function quoteTokenPrice(
  chainId: number,
  token: Address,
  tokenDecimals: number,
  asset: Address,
  assetDecimals: number,
  preferredFeeTier?: number,
): Promise<TokenPrice | null> {
  // Same token = price 1.0
  if (token.toLowerCase() === asset.toLowerCase()) {
    return { price: 1.0, amountOut: parseUnits("1", assetDecimals) };
  }

  const { quoterV2 } = getAddresses(chainId);
  if (quoterV2 === ZERO) return null;

  const chain = CHAIN_MAP[chainId];
  if (!chain) return null;

  const client = createPublicClient({
    chain,
    transport: http(getClientRpcUrl(chainId)),
  });

  const oneToken = parseUnits("1", tokenDecimals);
  const feeTiers = [preferredFeeTier ?? 10000, 10000, 3000, 500].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  for (const fee of feeTiers) {
    const result = await tryQuote(client, quoterV2, token, asset, oneToken, fee, assetDecimals);
    if (result) return result;
  }

  // Multi-hop fallback: token → WETH → asset
  const weth = WETH[chainId];
  if (weth && token.toLowerCase() !== weth.toLowerCase() && asset.toLowerCase() !== weth.toLowerCase()) {
    for (const tokenToWethFee of feeTiers) {
      const wethAmount = await tryQuoteRaw(client, quoterV2, token, weth, oneToken, tokenToWethFee);
      if (!wethAmount) continue;
      for (const wethToAssetFee of [500, 3000, 10000]) {
        const result = await tryQuote(client, quoterV2, weth, asset, wethAmount, wethToAssetFee, assetDecimals);
        if (result) {
          // Price is per 1 unit of token (we started with oneToken)
          return result;
        }
      }
    }
  }

  return null;
}

/**
 * Quote prices for multiple tokens in parallel (server-side, direct RPC).
 * Used by the /api/prices route.
 */
export async function quoteAllTokenPrices(
  chainId: number,
  tokens: { token: Address; decimals: number; feeTier?: number }[],
  asset: Address,
  assetDecimals: number,
): Promise<Map<string, TokenPrice>> {
  const results = await Promise.allSettled(
    tokens.map((t) =>
      quoteTokenPrice(chainId, t.token, t.decimals, asset, assetDecimals, t.feeTier),
    ),
  );

  const priceMap = new Map<string, TokenPrice>();
  for (let i = 0; i < tokens.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      priceMap.set(tokens[i].token.toLowerCase(), result.value);
    }
  }

  return priceMap;
}

/**
 * Client-side: fetch prices via the /api/prices route (server caches for 30s).
 * No RPC calls from the browser.
 */
export async function fetchPricesFromApi(
  chainId: number,
  tokens: { token: Address; decimals: number; feeTier?: number }[],
  asset: Address,
  assetDecimals: number,
): Promise<Map<string, TokenPrice>> {
  try {
    const res = await fetch("/api/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, tokens, asset, assetDecimals }),
    });
    if (!res.ok) return new Map();
    const data = await res.json() as Record<string, { price: number }>;
    const map = new Map<string, TokenPrice>();
    for (const [addr, val] of Object.entries(data)) {
      map.set(addr, { price: val.price, amountOut: 0n });
    }
    return map;
  } catch {
    return new Map();
  }
}
