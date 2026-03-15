/**
 * Uniswap V3 Quoter V2 integration for swap quotes.
 *
 * quoteExactInputSingle is NOT a view function — it reverts internally
 * after computing the quote. Must use eth_call to get the return data.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, decodeFunctionResult, concat, pad, numberToHex } from "viem";
import { getPublicClient } from "./client.js";
import { UNISWAP_QUOTER_V2_ABI } from "./abis.js";
import { UNISWAP } from "./addresses.js";

export interface QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  gasEstimate: bigint;
}

/**
 * Get a swap quote from Uniswap Quoter V2.
 */
export async function getQuote(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: number;
}): Promise<QuoteResult> {
  const client = getPublicClient();

  const calldata = encodeFunctionData({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        fee: params.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const { data } = await client.call({
    to: UNISWAP().QUOTER_V2,
    data: calldata,
  });

  if (!data) {
    throw new Error("Quoter returned no data — pool may not exist for this pair/fee");
  }

  const [amountOut, sqrtPriceX96After, , gasEstimate] = decodeFunctionResult({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    data,
  }) as [bigint, bigint, number, bigint];

  return { amountOut, sqrtPriceX96After, gasEstimate };
}

/**
 * Apply slippage tolerance to a quote amount.
 * Returns the minimum acceptable output amount.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
}

/**
 * Encode a Uniswap V3 multi-hop swap path.
 * Format: abi.encodePacked(address, uint24, address, uint24, address, ...)
 */
export function encodeSwapPath(tokens: Address[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("Invalid path: need at least 2 tokens and (tokens-1) fees");
  }

  const parts: Hex[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // Address: 20 bytes (no padding)
    parts.push(tokens[i].toLowerCase() as Hex);
    if (i < fees.length) {
      // Fee: 3 bytes (uint24), left-padded to 3 bytes
      parts.push(pad(numberToHex(fees[i]), { size: 3 }) as Hex);
    }
  }
  return concat(parts);
}

/**
 * Get a multi-hop swap quote from Uniswap Quoter V2.
 */
export async function getMultiHopQuote(params: {
  path: Hex;
  amountIn: bigint;
}): Promise<QuoteResult> {
  const client = getPublicClient();

  const calldata = encodeFunctionData({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    args: [params.path, params.amountIn],
  });

  const { data } = await client.call({
    to: UNISWAP().QUOTER_V2,
    data: calldata,
  });

  if (!data) {
    throw new Error("Quoter returned no data — pool may not exist for this path");
  }

  const [amountOut, , , gasEstimate] = decodeFunctionResult({
    abi: UNISWAP_QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    data,
  }) as [bigint, bigint[], number[], bigint];

  return { amountOut, sqrtPriceX96After: 0n, gasEstimate };
}

/** Token decimals for display purposes. */
export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  WETH: 18,
  cbETH: 18,
  wstETH: 18,
  cbBTC: 8,
  DAI: 18,
  AERO: 18,
};
