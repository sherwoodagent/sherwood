/**
 * Proposal simulation — Tenderly API client, eth_call fallback,
 * calldata decoder, and CLI output formatter.
 *
 * The Tenderly integration is proxied through the Sherwood app API
 * (/api/simulate) so credentials stay server-side.
 */

import type { Address, Hex } from "viem";
import { decodeFunctionData, encodeFunctionData } from "viem";
import chalk from "chalk";
import { getPublicClient } from "./client.js";
import { getChain } from "./network.js";
import { getGovernorAddress } from "./governor.js";
import type { GovernorParams } from "./governor.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI, SWAP_ROUTER_ABI } from "./abis.js";
import { TOKENS, MOONWELL, UNISWAP, SHERWOOD, AERODROME, VENICE, STRATEGY_TEMPLATES } from "./addresses.js";
import type { BatchCall } from "./batch.js";

// ── Styling (matches proposal.ts conventions) ────────────

const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const SEP = () => console.log(DIM("─".repeat(60)));

// ── Types ────────────────────────────────────────────────

export interface SimulationCallResult {
  index: number;
  target: Address;
  decodedFunction: string | null;
  selector: Hex;
  success: boolean;
  gasUsed: number;
}

export interface SimulationResult {
  success: boolean;
  totalGasUsed: number;
  callResults: SimulationCallResult[];
  warnings: string[];
  risks: RiskFlag[];
  source: "api" | "eth_call";
  errorMessage?: string;
}

// ── Risk analysis types ─────────────────────────────────

export type RiskLevel = "critical" | "warning" | "info";

export interface RiskFlag {
  level: RiskLevel;
  code: string;
  message: string;
  callIndex?: number;
}

export interface RiskContext {
  vault?: Address;
  performanceFeeBps?: bigint;
  strategyDuration?: bigint;
  governorParams?: GovernorParams;
}

// ── Moonwell cToken ABI fragment (not in main abis.ts) ───

const MOONWELL_CTOKEN_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "redeemTokens", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "redeemUnderlying",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "borrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "borrowAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "repayBorrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "repayAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Moonwell Comptroller ABI fragment ────────────────────

const MOONWELL_COMPTROLLER_ABI = [
  {
    name: "enterMarkets",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mTokens", type: "address[]" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "exitMarket",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mToken", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Uniswap SwapRouter exactInputSingle ABI fragment ─────

const SWAP_ROUTER_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// ── Address label registry ───────────────────────────────

function buildLabelMap(): Map<string, string> {
  const map = new Map<string, string>();
  const add = (addr: Address, label: string) => {
    if (addr !== "0x0000000000000000000000000000000000000000") {
      map.set(addr.toLowerCase(), label);
    }
  };

  try {
    const tokens = TOKENS();
    add(tokens.USDC, "USDC");
    add(tokens.WETH, "WETH");
    add(tokens.cbETH, "cbETH");
    add(tokens.wstETH, "wstETH");
    add(tokens.cbBTC, "cbBTC");
    add(tokens.DAI, "DAI");
    add(tokens.AERO, "AERO");

    const mw = MOONWELL();
    add(mw.COMPTROLLER, "Moonwell Comptroller");
    add(mw.mUSDC, "mUSDC");
    add(mw.mWETH, "mWETH");
    add(mw.mCbETH, "mCbETH");
    add(mw.mWstETH, "mWstETH");
    add(mw.mCbBTC, "mCbBTC");
    add(mw.mDAI, "mDAI");
    add(mw.mAERO, "mAERO");

    const uni = UNISWAP();
    add(uni.SWAP_ROUTER, "SwapRouter");
    add(uni.QUOTER_V2, "QuoterV2");

    const sw = SHERWOOD();
    add(sw.FACTORY, "SyndicateFactory");
    add(sw.GOVERNOR, "SyndicateGovernor");

    const aero = AERODROME();
    add(aero.ROUTER, "Aerodrome Router");
    add(aero.FACTORY, "Aerodrome Factory");

    const venice = VENICE();
    add(venice.VVV, "VVV");
    add(venice.STAKING, "sVVV Staking");
    add(venice.DIEM, "DIEM");

    const strats = STRATEGY_TEMPLATES();
    add(strats.MOONWELL_SUPPLY, "MoonwellSupplyStrategy");
    add(strats.AERODROME_LP, "AerodromeLPStrategy");
    add(strats.VENICE_INFERENCE, "VeniceInferenceStrategy");
    add(strats.WSTETH_MOONWELL, "WstETHMoonwellStrategy");
  } catch {
    // Network not set yet — return partial map
  }

  return map;
}

/** Known token decimals for human-readable formatting */
function buildDecimalsMap(): Map<string, { decimals: number; symbol: string }> {
  const map = new Map<string, { decimals: number; symbol: string }>();
  try {
    const tokens = TOKENS();
    map.set(tokens.USDC.toLowerCase(), { decimals: 6, symbol: "USDC" });
    map.set(tokens.WETH.toLowerCase(), { decimals: 18, symbol: "WETH" });
    map.set(tokens.cbETH.toLowerCase(), { decimals: 18, symbol: "cbETH" });
    map.set(tokens.wstETH.toLowerCase(), { decimals: 18, symbol: "wstETH" });
    map.set(tokens.cbBTC.toLowerCase(), { decimals: 8, symbol: "cbBTC" });
    map.set(tokens.DAI.toLowerCase(), { decimals: 18, symbol: "DAI" });
    map.set(tokens.AERO.toLowerCase(), { decimals: 18, symbol: "AERO" });
  } catch {
    // Network not set
  }
  return map;
}

/** Moonwell mToken → underlying token address mapping */
function buildMTokenToUnderlying(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const mw = MOONWELL();
    const tokens = TOKENS();
    map.set(mw.mUSDC.toLowerCase(), tokens.USDC.toLowerCase());
    map.set(mw.mWETH.toLowerCase(), tokens.WETH.toLowerCase());
    map.set(mw.mCbETH.toLowerCase(), tokens.cbETH.toLowerCase());
    map.set(mw.mWstETH.toLowerCase(), tokens.wstETH.toLowerCase());
    map.set(mw.mCbBTC.toLowerCase(), tokens.cbBTC.toLowerCase());
    map.set(mw.mDAI.toLowerCase(), tokens.DAI.toLowerCase());
    map.set(mw.mAERO.toLowerCase(), tokens.AERO.toLowerCase());
  } catch {
    // Network not set
  }
  return map;
}

export function getAddressLabel(addr: Address): string | null {
  const labels = buildLabelMap();
  return labels.get(addr.toLowerCase()) ?? null;
}

// ── Human-readable formatting helpers ────────────────────

function truncAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function labeledAddr(addr: string): string {
  const label = buildLabelMap().get(addr.toLowerCase());
  const short = truncAddr(addr);
  return label ? `${short} (${label})` : short;
}

function formatTokenAmount(amount: bigint, target: string): string {
  const decimalsMap = buildDecimalsMap();

  // Direct match: target is a token
  const tokenInfo = decimalsMap.get(target.toLowerCase());
  if (tokenInfo) {
    return formatWithDecimals(amount, tokenInfo.decimals, tokenInfo.symbol);
  }

  // mToken: use underlying token's decimals
  const mTokenMap = buildMTokenToUnderlying();
  const underlying = mTokenMap.get(target.toLowerCase());
  if (underlying) {
    const underlyingInfo = decimalsMap.get(underlying);
    if (underlyingInfo) {
      return formatWithDecimals(amount, underlyingInfo.decimals, underlyingInfo.symbol);
    }
  }

  // Unknown — return raw
  return amount.toString();
}

function formatWithDecimals(amount: bigint, decimals: number, symbol: string): string {
  const num = Number(amount) / 10 ** decimals;
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals <= 8 ? 2 : 4,
  });
  return `${formatted} ${symbol}`;
}

// ── Calldata decoder ─────────────────────────────────────

/**
 * Decode calldata into a human-readable function call string.
 * Returns null for unknown selectors.
 */
export function decodeCallData(target: Address, data: Hex): string | null {
  if (data.length < 10) return null;

  const labels = buildLabelMap();
  const targetLower = target.toLowerCase();

  // Build a list of (abi, contextLabel) pairs to try, ordered by target match
  type AbiEntry = { abi: readonly unknown[]; context: string };
  const candidates: AbiEntry[] = [];

  // Moonwell mTokens
  const mw = safeCall(() => MOONWELL());
  if (mw) {
    const isMToken = [mw.mUSDC, mw.mWETH, mw.mCbETH, mw.mWstETH, mw.mCbBTC, mw.mDAI, mw.mAERO]
      .some((a) => a.toLowerCase() === targetLower);
    if (isMToken) {
      candidates.push({ abi: MOONWELL_CTOKEN_ABI, context: labels.get(targetLower) || "mToken" });
    }

    if (mw.COMPTROLLER.toLowerCase() === targetLower) {
      candidates.push({ abi: MOONWELL_COMPTROLLER_ABI, context: "Comptroller" });
    }
  }

  // Uniswap SwapRouter
  const uni = safeCall(() => UNISWAP());
  if (uni && uni.SWAP_ROUTER.toLowerCase() === targetLower) {
    candidates.push({ abi: SWAP_ROUTER_ABI, context: "SwapRouter" });
    candidates.push({ abi: SWAP_ROUTER_SINGLE_ABI, context: "SwapRouter" });
  }

  // ERC20 as generic fallback (always try last)
  candidates.push({ abi: ERC20_ABI, context: labels.get(targetLower) || "ERC20" });

  for (const { abi, context } of candidates) {
    try {
      const decoded = decodeFunctionData({
        abi: abi as readonly unknown[],
        data,
      });

      const args = formatArgs(decoded.args as readonly unknown[], decoded.functionName, target);
      return `${decoded.functionName}(${args})`;
    } catch {
      continue;
    }
  }

  return null;
}

function formatArgs(args: readonly unknown[], functionName: string, target: Address): string {
  if (!args || args.length === 0) return "";

  const parts: string[] = [];

  for (const arg of args) {
    if (typeof arg === "bigint") {
      parts.push(formatTokenAmount(arg, target));
    } else if (typeof arg === "string" && arg.startsWith("0x") && arg.length === 42) {
      parts.push(labeledAddr(arg));
    } else if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
      // Struct (e.g. exactInput params)
      const entries = Object.entries(arg as Record<string, unknown>);
      const structParts: string[] = [];
      for (const [key, val] of entries) {
        if (typeof val === "bigint") {
          structParts.push(`${key}: ${formatTokenAmount(val, target)}`);
        } else if (typeof val === "string" && val.startsWith("0x") && val.length === 42) {
          structParts.push(`${key}: ${labeledAddr(val)}`);
        } else if (typeof val === "string" && val.startsWith("0x") && key === "path") {
          structParts.push(`path: ${decodeUniswapPath(val)}`);
        } else {
          structParts.push(`${key}: ${String(val)}`);
        }
      }
      parts.push(`{${structParts.join(", ")}}`);
    } else if (Array.isArray(arg)) {
      const arrParts = (arg as unknown[]).map((item) => {
        if (typeof item === "string" && item.startsWith("0x") && item.length === 42) {
          return labeledAddr(item);
        }
        return String(item);
      });
      parts.push(`[${arrParts.join(", ")}]`);
    } else {
      parts.push(String(arg));
    }
  }

  return parts.join(", ");
}

/** Decode a Uniswap V3 packed path (address + fee + address + ...) */
function decodeUniswapPath(pathHex: string): string {
  const labels = buildLabelMap();
  const path = pathHex.startsWith("0x") ? pathHex.slice(2) : pathHex;
  const tokens: string[] = [];

  // Path format: 20 bytes address, 3 bytes fee, 20 bytes address, ...
  let offset = 0;
  while (offset + 40 <= path.length) {
    const addr = `0x${path.slice(offset, offset + 40)}`;
    const label = labels.get(addr.toLowerCase());
    tokens.push(label || truncAddr(addr));
    offset += 40;
    if (offset + 6 <= path.length) {
      offset += 6; // skip 3-byte fee
    } else {
      break;
    }
  }

  return tokens.join(" → ");
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ── Raw calldata decoder (for risk analysis) ─────────────

interface DecodedCall {
  functionName: string;
  args: readonly unknown[];
}

/**
 * Decode calldata into raw { functionName, args } for risk inspection.
 * Same ABI candidate logic as decodeCallData(), but returns typed values
 * instead of a formatted display string.
 */
function decodeCallArgs(target: Address, data: Hex): DecodedCall | null {
  if (data.length < 10) return null;

  const targetLower = target.toLowerCase();
  type AbiEntry = { abi: readonly unknown[] };
  const candidates: AbiEntry[] = [];

  const mw = safeCall(() => MOONWELL());
  if (mw) {
    const isMToken = [mw.mUSDC, mw.mWETH, mw.mCbETH, mw.mWstETH, mw.mCbBTC, mw.mDAI, mw.mAERO]
      .some((a) => a.toLowerCase() === targetLower);
    if (isMToken) candidates.push({ abi: MOONWELL_CTOKEN_ABI });
    if (mw.COMPTROLLER.toLowerCase() === targetLower) candidates.push({ abi: MOONWELL_COMPTROLLER_ABI });
  }

  const uni = safeCall(() => UNISWAP());
  if (uni && uni.SWAP_ROUTER.toLowerCase() === targetLower) {
    candidates.push({ abi: SWAP_ROUTER_ABI });
    candidates.push({ abi: SWAP_ROUTER_SINGLE_ABI });
  }

  candidates.push({ abi: ERC20_ABI });

  for (const { abi } of candidates) {
    try {
      const decoded = decodeFunctionData({ abi: abi as readonly unknown[], data });
      return { functionName: decoded.functionName, args: decoded.args as readonly unknown[] };
    } catch {
      continue;
    }
  }

  return null;
}

// ── Risk analysis engine ─────────────────────────────────

/**
 * Analyze simulation results for semantic risks.
 * Pure function — no chain calls. Checks each call against the known
 * address registry and flags dangerous patterns.
 */
export function analyzeRisk(
  calls: BatchCall[],
  callResults: SimulationCallResult[],
  context?: RiskContext,
): RiskFlag[] {
  const risks: RiskFlag[] = [];
  const labels = buildLabelMap();
  const vaultLower = context?.vault?.toLowerCase();

  const isKnown = (addr: string): boolean => {
    const lower = addr.toLowerCase();
    return labels.has(lower) || lower === vaultLower;
  };

  // ── Per-call checks ──

  let allTargetsVerified = true;
  let allCallsDecoded = true;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = callResults[i];
    const callNum = i + 1;

    // Simulation failure
    if (result && !result.success) {
      risks.push({
        level: "critical",
        code: "SIMULATION_FAILED",
        message: `Call #${callNum} to ${labeledAddr(call.target)} reverted during simulation`,
        callIndex: i,
      });
    }

    // Unknown target
    const targetKnown = isKnown(call.target);
    if (!targetKnown) {
      allTargetsVerified = false;
      risks.push({
        level: "critical",
        code: "UNKNOWN_TARGET",
        message: `Call #${callNum} targets ${labeledAddr(call.target)} which is not in the known address registry`,
        callIndex: i,
      });
    }

    // Decode calldata for inspection
    const decoded = decodeCallArgs(call.target, call.data);

    if (!decoded) {
      allCallsDecoded = false;
      if (!targetKnown) {
        risks.push({
          level: "critical",
          code: "UNDECODED_CALLDATA",
          message: `Call #${callNum} has unrecognized calldata (selector ${call.data.slice(0, 10)}) targeting unknown contract`,
          callIndex: i,
        });
      }
      continue;
    }

    // transfer(to, amount) → check 'to'
    if (decoded.functionName === "transfer" && decoded.args.length >= 2) {
      const to = decoded.args[0] as string;
      if (typeof to === "string" && to.startsWith("0x") && !isKnown(to)) {
        risks.push({
          level: "critical",
          code: "TRANSFER_TO_UNKNOWN",
          message: `Call #${callNum} transfer() sends funds to ${truncAddr(to)} which is not a known protocol`,
          callIndex: i,
        });
      }
    }

    // transferFrom(from, to, amount) → check 'to'
    if (decoded.functionName === "transferFrom" && decoded.args.length >= 3) {
      const to = decoded.args[1] as string;
      if (typeof to === "string" && to.startsWith("0x") && !isKnown(to)) {
        risks.push({
          level: "critical",
          code: "TRANSFER_FROM_TO_UNKNOWN",
          message: `Call #${callNum} transferFrom() sends funds to ${truncAddr(to)} which is not a known protocol`,
          callIndex: i,
        });
      }
    }

    // approve(spender, amount) → check 'spender'
    if (decoded.functionName === "approve" && decoded.args.length >= 2) {
      const spender = decoded.args[0] as string;
      if (typeof spender === "string" && spender.startsWith("0x") && !isKnown(spender)) {
        risks.push({
          level: "critical",
          code: "APPROVE_TO_UNKNOWN",
          message: `Call #${callNum} approve() grants allowance to ${truncAddr(spender)} which is not a known protocol`,
          callIndex: i,
        });
      }
    }
  }

  // ── Proposal parameter checks ──

  if (context?.performanceFeeBps !== undefined) {
    const fee = context.performanceFeeBps;
    const maxFee = context.governorParams?.maxPerformanceFeeBps;

    if (maxFee && fee > (maxFee * 80n) / 100n) {
      risks.push({
        level: "critical",
        code: "EXCESSIVE_PERFORMANCE_FEE",
        message: `Performance fee ${Number(fee) / 100}% is within 20% of the hard cap (${Number(maxFee) / 100}%)`,
      });
    } else if (fee > 2000n) {
      risks.push({
        level: "warning",
        code: "HIGH_PERFORMANCE_FEE",
        message: `Performance fee ${Number(fee) / 100}% exceeds 20% threshold`,
      });
    }
  }

  if (context?.strategyDuration !== undefined) {
    const dur = context.strategyDuration;
    if (dur < 3600n) {
      risks.push({
        level: "warning",
        code: "SHORT_STRATEGY_DURATION",
        message: `Strategy duration ${Number(dur)}s is under 1 hour — flash-loan-style risk`,
      });
    }
    if (dur > 2_592_000n) {
      risks.push({
        level: "warning",
        code: "LONG_STRATEGY_DURATION",
        message: `Strategy duration ${Number(dur) / 86400} days exceeds 30-day threshold`,
      });
    }
  }

  // ── Summary flags ──

  const hasCritical = risks.some((r) => r.level === "critical");
  const hasWarning = risks.some((r) => r.level === "warning");

  if (!hasCritical && !hasWarning) {
    if (allTargetsVerified) {
      risks.push({
        level: "info",
        code: "ALL_TARGETS_VERIFIED",
        message: "All call targets are verified protocol addresses",
      });
    }
    if (allCallsDecoded) {
      risks.push({
        level: "info",
        code: "ALL_CALLS_DECODED",
        message: "All calldata successfully decoded",
      });
    }
  }

  return risks;
}

// ── API simulation ───────────────────────────────────────

const API_URLS: Record<string, string> = {
  "base": "https://app.sherwood.sh",
  "base-sepolia": "https://testnet.app.sherwood.sh",
};

function getApiBaseUrl(): string {
  // Allow override for local development
  if (process.env.SHERWOOD_API_URL) return process.env.SHERWOOD_API_URL;

  const chain = getChain();
  return API_URLS[chain.testnet ? "base-sepolia" : "base"] || API_URLS["base"];
}

async function simulateViaApi(
  vault: Address,
  calls: BatchCall[],
): Promise<SimulationResult> {
  const baseUrl = getApiBaseUrl();
  const chainId = getChain().id;

  const response = await fetch(`${baseUrl}/api/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vault,
      chainId,
      calls: calls.map((c) => ({
        target: c.target,
        data: c.data,
        value: c.value.toString(),
      })),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Unknown error" })) as { error?: string; details?: string };
    throw new Error(body.error || `Simulation API returned ${response.status}`);
  }

  const result = await response.json() as {
    success: boolean;
    totalGasUsed: number;
    errorMessage: string | null;
    calls: Array<{
      index: number;
      target: string;
      success: boolean;
      gasUsed: number;
      returnData: string;
    }>;
  };

  const callResults: SimulationCallResult[] = result.calls.map((c, i) => ({
    index: c.index,
    target: (calls[i]?.target || c.target) as Address,
    decodedFunction: calls[i] ? decodeCallData(calls[i].target, calls[i].data) : null,
    selector: (calls[i]?.data.slice(0, 10) || "0x") as Hex,
    success: c.success,
    gasUsed: c.gasUsed,
  }));

  // Add decoded functions for any calls the API returned that weren't in our original list
  // (shouldn't happen, but defensive)
  for (const cr of callResults) {
    if (!cr.decodedFunction) {
      const matchingCall = calls[cr.index];
      if (matchingCall) {
        cr.decodedFunction = decodeCallData(matchingCall.target, matchingCall.data);
      }
    }
  }

  const warnings: string[] = [];
  for (const cr of callResults) {
    if (!cr.success) {
      warnings.push(`Call #${cr.index + 1} to ${labeledAddr(cr.target)} failed`);
    }
  }

  return {
    success: result.success,
    totalGasUsed: result.totalGasUsed,
    callResults,
    warnings,
    risks: [],
    source: "api",
    errorMessage: result.errorMessage ?? undefined,
  };
}

// ── eth_call fallback ────────────────────────────────────

async function simulateViaEthCall(
  vault: Address,
  calls: BatchCall[],
): Promise<SimulationResult> {
  const governor = getGovernorAddress();
  const client = getPublicClient();

  const input = encodeFunctionData({
    abi: SYNDICATE_VAULT_ABI,
    functionName: "executeGovernorBatch",
    args: [calls.map((c) => ({ target: c.target, data: c.data, value: c.value }))],
  });

  // Decode calldata for display regardless of simulation result
  const callResults: SimulationCallResult[] = calls.map((c, i) => ({
    index: i,
    target: c.target,
    decodedFunction: decodeCallData(c.target, c.data),
    selector: c.data.slice(0, 10) as Hex,
    success: true, // will be set after simulation
    gasUsed: 0,
  }));

  try {
    await client.call({
      account: governor,
      to: vault,
      data: input,
    });

    return {
      success: true,
      totalGasUsed: 0,
      callResults,
      warnings: [],
      risks: [],
      source: "eth_call",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Mark all calls as potentially failed (no per-call granularity)
    for (const cr of callResults) {
      cr.success = false;
    }

    return {
      success: false,
      totalGasUsed: 0,
      callResults,
      warnings: [`Batch reverted: ${message.slice(0, 200)}`],
      risks: [],
      source: "eth_call",
      errorMessage: message,
    };
  }
}

// ── Public API ───────────────────────────────────────────

export async function simulateBatchCalls(
  vault: Address,
  calls: BatchCall[],
  callType: "execute" | "settlement",
  riskContext?: RiskContext,
): Promise<SimulationResult> {
  let result: SimulationResult;

  try {
    result = await simulateViaApi(vault, calls);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(DIM(`  Simulation API unavailable (${message}), falling back to eth_call...`));

    result = await simulateViaEthCall(vault, calls);
  }

  // Run risk analysis on the results
  const ctx: RiskContext = { vault, ...riskContext };
  result.risks = analyzeRisk(calls, result.callResults, ctx);

  return result;
}

// ── Output formatter ─────────────────────────────────────

export function printSimulationResult(result: SimulationResult, callType: string): void {
  console.log();
  console.log(LABEL(`  ◆ Simulation — ${callType} calls`));
  SEP();

  const sourceLabel = result.source === "api"
    ? "Tenderly (via API)"
    : `eth_call ${DIM("(configure Tenderly for detailed results)")}`;
  console.log(W(`  Source:     ${sourceLabel}`));

  const statusIcon = result.success ? G("✓ PASS") : chalk.red("✖ FAIL");
  console.log(W(`  Status:     ${statusIcon}`));

  if (result.totalGasUsed > 0) {
    console.log(W(`  Total Gas:  ${result.totalGasUsed.toLocaleString()}`));
  }

  if (result.errorMessage && !result.success) {
    console.log(chalk.red(`  Error:      ${result.errorMessage.slice(0, 120)}`));
  }

  console.log();

  for (const cr of result.callResults) {
    const icon = cr.success ? G("✓") : chalk.red("✖");
    const funcName = cr.decodedFunction || `${cr.selector}... ${DIM("(unknown)")}`;
    console.log(W(`  [${cr.index + 1}] ${icon}  ${funcName}`));

    const label = getAddressLabel(cr.target);
    const targetDisplay = label ? `${cr.target} (${label})` : cr.target;
    console.log(DIM(`      Target: ${targetDisplay}`));

    if (cr.gasUsed > 0) {
      console.log(DIM(`      Gas:    ${cr.gasUsed.toLocaleString()}`));
    }

    console.log();
  }

  // ── Risk assessment ──
  if (result.risks.length > 0) {
    const criticals = result.risks.filter((r) => r.level === "critical");
    const warnings = result.risks.filter((r) => r.level === "warning");
    const infos = result.risks.filter((r) => r.level === "info");

    if (criticals.length > 0) {
      console.log(chalk.red.bold(`  ✖ CRITICAL RISKS (${criticals.length})`));
      for (const r of criticals) {
        const ref = r.callIndex !== undefined ? ` [call #${r.callIndex + 1}]` : "";
        console.log(chalk.red(`    ✖${ref} ${r.code} — ${r.message}`));
      }
      console.log();
    }

    if (warnings.length > 0) {
      console.log(chalk.yellow.bold(`  ⚠ WARNINGS (${warnings.length})`));
      for (const r of warnings) {
        const ref = r.callIndex !== undefined ? ` [call #${r.callIndex + 1}]` : "";
        console.log(chalk.yellow(`    ⚠${ref} ${r.code} — ${r.message}`));
      }
      console.log();
    }

    if (criticals.length === 0 && warnings.length === 0 && infos.length > 0) {
      console.log(G.bold(`  ✓ RISK ASSESSMENT: CLEAN`));
      for (const r of infos) {
        console.log(G(`    ✓ ${r.message}`));
      }
      console.log();
    }
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow(`  ⚠ Simulation Warnings`));
    for (const w of result.warnings) {
      console.log(chalk.yellow(`    - ${w}`));
    }
    console.log();
  }

  SEP();
}

// ── XMTP escalation ─────────────────────────────────────

/**
 * Send a simulation risk report to the syndicate's XMTP chat.
 * Uses RISK_ALERT message type for critical findings, POSITION_UPDATE otherwise.
 * Fails silently if XMTP is not configured.
 */
export async function sendSimulationAlert(
  subdomain: string,
  proposalId: bigint,
  vault: Address,
  execResult: SimulationResult,
  settleResult?: SimulationResult,
): Promise<void> {
  try {
    const xmtp = await import("./xmtp.js");
    const { getAccount } = await import("./client.js");

    const group = await xmtp.getGroup("", subdomain);

    // Collect all risks across both results
    const allRisks = [...execResult.risks, ...(settleResult?.risks ?? [])];
    const criticals = allRisks.filter((r) => r.level === "critical");
    const warnings = allRisks.filter((r) => r.level === "warning");

    const highestLevel: RiskLevel = criticals.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "info";

    // Build markdown report
    const lines: string[] = [];
    const statusEmoji = highestLevel === "critical" ? "🚨" : highestLevel === "warning" ? "⚠️" : "✅";
    const statusText = highestLevel === "critical" ? "RISKS DETECTED" : highestLevel === "warning" ? "WARNINGS" : "CLEAN";

    lines.push(`## ${statusEmoji} Proposal #${proposalId} — Simulation Report`);
    lines.push(`**Vault**: \`${truncAddr(vault)}\``);
    lines.push(`**Status**: ${statusText}`);
    lines.push(`**Source**: ${execResult.source === "api" ? "Tenderly" : "eth_call"}`);
    lines.push("");

    // Execute calls summary
    lines.push(`### Execute Calls ${execResult.success ? "✓" : "✖"}`);
    for (const cr of execResult.callResults) {
      const icon = cr.success ? "✓" : "✖";
      const fn = cr.decodedFunction || `${cr.selector}...`;
      const flag = allRisks.find((r) => r.callIndex === cr.index);
      const suffix = flag && flag.level === "critical" ? " ← **" + flag.code + "**" : "";
      lines.push(`${cr.index + 1}. ${icon} \`${fn}\`${suffix}`);
    }
    lines.push("");

    // Settlement calls summary (if present)
    if (settleResult && settleResult.callResults.length > 0) {
      lines.push(`### Settlement Calls ${settleResult.success ? "✓" : "✖"}`);
      for (const cr of settleResult.callResults) {
        const icon = cr.success ? "✓" : "✖";
        const fn = cr.decodedFunction || `${cr.selector}...`;
        lines.push(`${cr.index + 1}. ${icon} \`${fn}\``);
      }
      lines.push("");
    }

    // Risk flags
    if (criticals.length > 0) {
      lines.push(`### 🚨 Critical Risks`);
      for (const r of criticals) {
        const ref = r.callIndex !== undefined ? ` [call #${r.callIndex + 1}]` : "";
        lines.push(`- **${r.code}**${ref}: ${r.message}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push(`### ⚠️ Warnings`);
      for (const r of warnings) {
        const ref = r.callIndex !== undefined ? ` [call #${r.callIndex + 1}]` : "";
        lines.push(`- **${r.code}**${ref}: ${r.message}`);
      }
      lines.push("");
    }

    // Action recommendation
    if (highestLevel === "critical") {
      lines.push(`### Action Required`);
      lines.push(`Recommend **VETO** — critical risks detected.`);
    } else if (highestLevel === "warning") {
      lines.push(`### Review Required`);
      lines.push(`Warnings detected — manual review recommended before execution.`);
    } else {
      lines.push(`### ✅ No Risks Detected`);
      lines.push(`All call targets verified. All calldata decoded. Safe to proceed.`);
    }

    const markdown = lines.join("\n");
    const messageType = highestLevel === "critical" ? "RISK_ALERT" as const : "POSITION_UPDATE" as const;

    await xmtp.sendEnvelope(group, {
      type: messageType,
      from: getAccount().address,
      text: markdown,
      data: {
        format: "markdown",
        proposalId: Number(proposalId),
        vault,
        riskLevel: highestLevel,
        riskCodes: allRisks.filter((r) => r.level !== "info").map((r) => r.code),
        simulationSuccess: execResult.success && (settleResult?.success ?? true),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  ⚠ Failed to send XMTP alert: ${message.slice(0, 100)}`));
  }
}
