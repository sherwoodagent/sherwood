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
  source: "api" | "eth_call";
  errorMessage?: string;
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
): Promise<SimulationResult> {
  try {
    return await simulateViaApi(vault, calls);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(DIM(`  Simulation API unavailable (${message}), falling back to eth_call...`));

    return simulateViaEthCall(vault, calls);
  }
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

  if (result.warnings.length > 0) {
    console.log(chalk.yellow(`  ⚠ Warnings`));
    for (const w of result.warnings) {
      console.log(chalk.yellow(`    - ${w}`));
    }
    console.log();
  }

  SEP();
}
