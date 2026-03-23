/**
 * Uniswap Trading API provider — swaps on Base via the hosted API.
 *
 * Uses the 3-step flow:
 *   1. POST /check_approval → check/submit token approval
 *   2. POST /quote          → get optimal route + executable quote
 *   3. POST /swap           → get transaction calldata to sign
 *
 * API key required — set via `sherwood config set --uniswap-api-key <key>`
 * or UNISWAP_API_KEY env var.
 *
 * Docs: https://docs.uniswap.org/api/trading-api
 * Key:  https://developers.uniswap.org/
 */

import type { Address, Hex } from "viem";
import { isAddress, isHex, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { TradingProvider, ProviderInfo, SwapParams, SwapQuoteParams, TxResult, SwapQuote } from "../types.js";
import { getPublicClient, getAccount } from "../lib/client.js";
import { getChain } from "../lib/network.js";
import { getUniswapApiKey } from "../lib/config.js";

const API_BASE = "https://trade-api.gateway.uniswap.org/v1";

// ── API Types ──

interface ApprovalResponse {
  approval: {
    to: Address;
    from: Address;
    data: Hex;
    value: string;
    chainId: number;
  } | null;
}

// CLASSIC route quote
interface ClassicQuote {
  routing: "CLASSIC" | "WRAP" | "UNWRAP";
  quote: {
    input: { token: string; amount: string };
    output: { token: string; amount: string };
    slippage: number;
    route: unknown[];
    gasFee: string;
    gasFeeUSD: string;
    gasUseEstimate: string;
  };
  permitData: Record<string, unknown> | null;
}

// UniswapX route quote (PRIORITY on Base)
interface UniswapXQuote {
  routing: "DUTCH_V2" | "DUTCH_V3" | "PRIORITY";
  quote: {
    orderInfo: {
      outputs: Array<{
        token: string;
        startAmount: string;
        endAmount: string;
        recipient: string;
      }>;
      input: { token: string; startAmount: string; endAmount: string };
      deadline: number;
      nonce: string;
    };
    encodedOrder: string;
    orderHash: string;
  };
  permitData: Record<string, unknown> | null;
}

type QuoteResponse = ClassicQuote | UniswapXQuote;

interface SwapResponse {
  swap: {
    to: Address;
    from: Address;
    data: Hex;
    value: string;
    chainId: number;
    gasLimit?: string;
  };
}

// ── Helpers ──

function getApiKey(): string {
  const key = getUniswapApiKey();
  if (!key) {
    throw new Error(
      "Uniswap API key not configured. Run 'sherwood config set --uniswap-api-key <key>' " +
      "or set UNISWAP_API_KEY env var.\n" +
      "Get your key at https://developers.uniswap.org/",
    );
  }
  return key;
}

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": getApiKey(),
    "x-universal-router-version": "2.0",
  };
}

function isUniswapXRouting(routing: string): boolean {
  return routing === "DUTCH_V2" || routing === "DUTCH_V3" || routing === "PRIORITY";
}

function getOutputAmount(q: QuoteResponse): string {
  if (isUniswapXRouting(q.routing)) {
    const ux = q as UniswapXQuote;
    const firstOutput = ux.quote.orderInfo.outputs[0];
    if (!firstOutput) throw new Error("UniswapX quote has no outputs");
    return firstOutput.startAmount; // best-case fill
  }
  return (q as ClassicQuote).quote.output.amount;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === maxRetries) return response;

    const delay = Math.min(200 * Math.pow(2, attempt) + Math.random() * 100, 10000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Unreachable");
}

// ── Provider ──

export class UniswapProvider implements TradingProvider {
  info(): ProviderInfo {
    return {
      name: "uniswap",
      type: "trading",
      capabilities: [
        "swap.exact-input",
        "swap.quote",
        "swap.check-approval",
      ],
      supportedChains: [base, baseSepolia],
    };
  }

  /**
   * Get a quote from the Uniswap Trading API.
   * Returns the optimal route (CLASSIC, PRIORITY, or UniswapX).
   */
  async quote(params: SwapQuoteParams): Promise<SwapQuote> {
    const account = getAccount();
    const chainId = getChain().id;

    const body = {
      swapper: account.address,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      tokenInChainId: String(chainId),
      tokenOutChainId: String(chainId),
      amount: params.amountIn.toString(),
      type: "EXACT_INPUT",
      slippageTolerance: 0.5,
      routingPreference: "BEST_PRICE",
    };

    const res = await fetchWithRetry(`${API_BASE}/quote`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Uniswap quote failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as QuoteResponse;
    const amountOut = BigInt(getOutputAmount(data));

    return {
      amountOut,
      priceImpact: 0,
      route: `${data.routing}: ${params.tokenIn.slice(0, 8)}→${params.tokenOut.slice(0, 8)}`,
    };
  }

  /**
   * Get a full quote response (preserving the raw API response for swap execution).
   */
  async fullQuote(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    slippageTolerance?: number;
  }): Promise<{ quoteResponse: QuoteResponse; amountOut: bigint; routing: string }> {
    const account = getAccount();
    const chainId = getChain().id;

    const body = {
      swapper: account.address,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      tokenInChainId: String(chainId),
      tokenOutChainId: String(chainId),
      amount: params.amountIn.toString(),
      type: "EXACT_INPUT",
      slippageTolerance: params.slippageTolerance ?? 0.5,
      routingPreference: "BEST_PRICE",
    };

    const res = await fetchWithRetry(`${API_BASE}/quote`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Uniswap quote failed (${res.status}): ${err}`);
    }

    const quoteResponse = (await res.json()) as QuoteResponse;
    const amountOut = BigInt(getOutputAmount(quoteResponse));
    return { quoteResponse, amountOut, routing: quoteResponse.routing };
  }

  /**
   * Check and handle token approval for Uniswap.
   * Uses the Trading API's /check_approval endpoint.
   */
  async checkApproval(params: {
    token: Address;
    amount: bigint;
  }): Promise<void> {
    const account = getAccount();
    const chainId = getChain().id;
    const client = getPublicClient();

    const res = await fetchWithRetry(`${API_BASE}/check_approval`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        walletAddress: account.address,
        token: params.token,
        amount: params.amount.toString(),
        chainId,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Approval check failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as ApprovalResponse;

    if (data.approval) {
      // The Trading API returns a ready-to-send approval transaction
      const { getWalletClient } = await import("../lib/client.js");
      const wallet = getWalletClient();
      const approvalHash = await wallet.sendTransaction({
        to: data.approval.to,
        data: data.approval.data,
        value: BigInt(data.approval.value || "0"),
        account,
        chain: getChain(),
      });
      await client.waitForTransactionReceipt({ hash: approvalHash });
    }
  }

  /**
   * Execute a swap via the Uniswap Trading API.
   *
   * Full flow: check_approval → quote → swap → sign & broadcast.
   */
  async swap(params: SwapParams): Promise<TxResult> {
    const account = getAccount();
    const client = getPublicClient();

    // 1. Check approval (skip for native ETH)
    const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
    if (params.tokenIn !== ETH_ADDRESS) {
      await this.checkApproval({
        token: params.tokenIn,
        amount: params.amountIn,
      });
    }

    // 2. Get quote
    const slippageBps = params.fee; // repurpose fee field for slippage in API mode
    const { quoteResponse } = await this.fullQuote({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      slippageTolerance: 0.5, // 0.5%
    });

    // 3. Prepare swap request — routing-aware permitData handling
    const quoteRaw = quoteResponse as unknown as Record<string, unknown>;
    const { permitData, ...cleanQuote } = quoteRaw;
    const swapRequest: Record<string, unknown> = { ...cleanQuote };

    // UniswapX routes: permitData is for local signing only, must NOT be sent to /swap
    // For CLASSIC routes without Permit2: omit both signature and permitData
    // (We use direct approval via /check_approval, not Permit2)
    if (isUniswapXRouting(quoteResponse.routing)) {
      // UniswapX: sign the order with permitData locally
      if (permitData && typeof permitData === "object") {
        const typedData = permitData as {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          values: Record<string, unknown>;
        };
        const signature = await account.signTypedData({
          domain: typedData.domain as Record<string, unknown>,
          types: typedData.types as Record<string, Array<{ name: string; type: string }>>,
          primaryType: Object.keys(typedData.types).find((k) => k !== "EIP712Domain") ?? "PermitWitnessTransferFrom",
          message: typedData.values,
        });
        swapRequest.signature = signature;
      }
    }
    // For CLASSIC: no signature/permitData needed (we use /check_approval)

    // 4. Get swap transaction
    const swapRes = await fetchWithRetry(`${API_BASE}/swap`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(swapRequest),
    });

    if (!swapRes.ok) {
      const err = await swapRes.text();
      throw new Error(`Uniswap swap failed (${swapRes.status}): ${err}`);
    }

    const swapData = (await swapRes.json()) as SwapResponse;

    // 5. Validate before broadcasting
    if (!swapData.swap?.data || swapData.swap.data === ("" as Hex) || swapData.swap.data === "0x") {
      throw new Error("Empty swap data — quote may have expired. Try again.");
    }
    if (!isAddress(swapData.swap.to) || !isAddress(swapData.swap.from)) {
      throw new Error("Invalid address in swap response");
    }

    // 6. Sign and broadcast
    const { getWalletClient } = await import("../lib/client.js");
    const wallet = getWalletClient();
    const hash = await wallet.sendTransaction({
      to: swapData.swap.to,
      data: swapData.swap.data,
      value: BigInt(swapData.swap.value || "0"),
      account,
      chain: getChain(),
    });

    const receipt = await client.waitForTransactionReceipt({ hash });
    return {
      hash,
      success: receipt.status === "success",
      gasUsed: receipt.gasUsed,
    };
  }
}
