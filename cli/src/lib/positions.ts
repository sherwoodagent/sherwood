/**
 * Position tracking for memecoin trades.
 *
 * Persists open and closed positions to ~/.sherwood/config.json.
 * Uses Uniswap QuoterV2 for current price lookups.
 */

import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { loadConfig, saveConfig } from "./config.js";
import { getQuote } from "./quote.js";
import { TOKENS } from "./addresses.js";
import type { ExitConfig } from "./exit-strategy.js";

export interface Position {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amountIn: string;           // amount spent (human-readable, e.g. "500")
  amountOut: string;          // tokens received (raw bigint as string)
  entryPrice: number;         // input token per target token at entry
  highWaterPrice: number;     // highest observed price since entry
  feeTier: number;            // Uniswap fee tier used
  openedAt: number;           // unix timestamp
  txHash: string;             // buy tx hash
  exitConfig: ExitConfig;     // per-position exit parameters
  inputTokenAddress?: Address; // token used to buy (default: USDC for backwards compat)
  inputTokenSymbol?: string;   // symbol of input token (default: "USDC")
  inputTokenDecimals?: number; // decimals of input token (default: 6)
}

export interface ClosedPosition extends Position {
  exitPrice: number;
  closedAt: number;
  exitTxHash: string;
  exitReason: string;
  pnlUsdc: number;
  pnlPct: number;
}

// ── Reads ──

export function getOpenPositions(): Position[] {
  const config = loadConfig();
  return (config.positions as Position[] | undefined) ?? [];
}

export function getClosedPositions(): ClosedPosition[] {
  const config = loadConfig();
  return (config.closedPositions as ClosedPosition[] | undefined) ?? [];
}

// ── Writes ──

export function addPosition(pos: Position): void {
  const config = loadConfig();
  const positions = (config.positions as Position[] | undefined) ?? [];
  positions.push(pos);
  config.positions = positions;
  saveConfig(config);
}

export function closePosition(
  tokenAddress: Address,
  exitData: {
    exitPrice: number;
    closedAt: number;
    exitTxHash: string;
    exitReason: string;
    pnlUsdc: number;
    pnlPct: number;
  },
): void {
  const config = loadConfig();
  const positions = (config.positions as Position[] | undefined) ?? [];
  const idx = positions.findIndex(
    (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (idx === -1) {
    throw new Error(`No open position for ${tokenAddress}`);
  }

  const [pos] = positions.splice(idx, 1);
  const closed: ClosedPosition = { ...pos, ...exitData };

  const closedPositions = (config.closedPositions as ClosedPosition[] | undefined) ?? [];
  closedPositions.push(closed);

  config.positions = positions;
  config.closedPositions = closedPositions;
  saveConfig(config);
}

export function updateHighWater(tokenAddress: Address, price: number): void {
  const config = loadConfig();
  const positions = (config.positions as Position[] | undefined) ?? [];
  const pos = positions.find(
    (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (pos && price > pos.highWaterPrice) {
    pos.highWaterPrice = price;
    config.positions = positions;
    saveConfig(config);
  }
}

// ── Price Lookup ──

/**
 * Get the current USDC price of one token via Uniswap QuoterV2.
 * Quotes 1 full token unit against USDC.
 */
export async function getCurrentPrice(
  tokenAddress: Address,
  tokenDecimals: number,
  feeTier: number,
): Promise<number> {
  const oneToken = parseUnits("1", tokenDecimals);
  const usdc = TOKENS().USDC;

  const { amountOut } = await getQuote({
    tokenIn: tokenAddress,
    tokenOut: usdc,
    amountIn: oneToken,
    fee: feeTier,
  });

  // USDC has 6 decimals
  return Number(formatUnits(amountOut, 6));
}
