import type { Address, Chain } from "viem";

// ── Provider Pattern (adapted from defi-cli) ──

export interface ProviderInfo {
  name: string;
  type: "lending" | "trading" | "sniping" | "research";
  capabilities: string[];
  supportedChains: Chain[];
}

export interface Provider {
  info(): ProviderInfo;
}

export interface LendingProvider extends Provider {
  /** Deposit collateral into a lending market */
  depositCollateral(params: DepositParams): Promise<TxResult>;
  /** Borrow against collateral */
  borrow(params: BorrowParams): Promise<TxResult>;
  /** Repay an outstanding borrow */
  repay(params: RepayParams): Promise<TxResult>;
  /** Withdraw collateral */
  withdrawCollateral(params: WithdrawParams): Promise<TxResult>;
  /** Get current position */
  getPosition(account: Address): Promise<LendingPosition>;
}

export interface TradingProvider extends Provider {
  /** Execute a token swap */
  swap(params: SwapParams): Promise<TxResult>;
  /** Get a swap quote */
  quote(params: SwapQuoteParams): Promise<SwapQuote>;
}

// ── Parameter types ──

export interface DepositParams {
  market: Address;
  amount: bigint;
}

export interface BorrowParams {
  market: Address;
  amount: bigint;
}

export interface RepayParams {
  market: Address;
  amount: bigint; // Use maxUint256 for full repay
}

export interface WithdrawParams {
  market: Address;
  amount: bigint;
}

export interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee: 500 | 3000 | 10000;
}

export interface SwapQuoteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: 500 | 3000 | 10000;
}

// ── Result types ──

export interface TxResult {
  hash: `0x${string}`;
  success: boolean;
  gasUsed?: bigint;
}

export interface LendingPosition {
  collateralUSD: number;
  borrowedUSD: number;
  healthFactor: number;
  availableToBorrow: number;
}

export interface SwapQuote {
  amountOut: bigint;
  priceImpact: number;
  route: string;
}

// ── Registry types ──

export interface StrategyRecord {
  id: bigint;
  implementation: Address;
  creator: Address;
  strategyTypeId: bigint;
  active: boolean;
  name: string;
  metadataURI: string;
}

// ── Config ──
// SherwoodConfig is defined in lib/config.ts (the canonical version).
// Do not duplicate it here.
