/**
 * Nansen research provider — supports both API key auth (Pro subscription,
 * ~5× cheaper) and x402 micropayments (pay-per-request, no subscription).
 *
 * Auth priority:
 *   1. NANSEN_API_KEY env var → standard fetch with apiKey header (Pro plan)
 *   2. x402 fetch wrapper → automatic USDC micropayments on Base
 *
 * Docs: https://docs.nansen.ai
 * Pro pricing: 5 credits/call for Smart Money endpoints (~$0.005/call)
 * x402 pricing: ~$0.06/call for Smart Money endpoints
 *
 * Supports all query types:
 *   token       → token screener (on-chain metrics, holder quality)
 *   market      → token screener sorted by market cap / volume
 *   smart-money → smart money net flow from labeled wallets
 *   hl-perp-trades → Hyperliquid smart-money perp trades
 *   wallet      → wallet profiler (PnL, tx patterns, counterparties)
 */

import { base, baseSepolia } from "viem/chains";
import type { ProviderInfo } from "../../types.js";
import type { ResearchProvider, ResearchQuery, ResearchResult } from "./index.js";
import { getX402Fetch } from "../../lib/x402.js";

const BASE_URL = "https://api.nansen.ai";

/**
 * Returns a fetch function configured for Nansen auth. Cached after first
 * creation — same pattern as getX402Fetch() to avoid allocating a new
 * closure on every call.
 *
 * If NANSEN_API_KEY is set → standard fetch with apiKey header (Pro plan).
 * Otherwise → x402 micropayment fetch.
 */
let _nansenFetch: typeof fetch | null = null;
let _nansenFetchKey: string | undefined;

async function getNansenFetch(): Promise<typeof fetch> {
  const apiKey = process.env.NANSEN_API_KEY;

  // Cache hit — return if key hasn't changed
  if (_nansenFetch && _nansenFetchKey === apiKey) return _nansenFetch;

  if (apiKey) {
    const baseFetch = globalThis.fetch;
    _nansenFetch = ((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("apiKey", apiKey);
      return baseFetch(url, { ...init, headers });
    }) as typeof fetch;
    _nansenFetchKey = apiKey;
  } else {
    _nansenFetch = await getX402Fetch();
    _nansenFetchKey = undefined;
  }

  return _nansenFetch;
}

/** Known x402 cost per Nansen query type. */
export const NANSEN_COST_ESTIMATE: Record<string, string> = {
  token: "~$0.01",
  market: "~$0.01",
  "smart-money": "~$0.06",
  "hl-perp-trades": "~$0.06",
  wallet: "~$0.01",
  "flow-intelligence": "~$0.005",  // 1 credit — cheapest premium endpoint
};

export class NansenProvider implements ResearchProvider {
  info(): ProviderInfo {
    return {
      name: "nansen",
      type: "research",
      capabilities: [
        "research.token",
        "research.market",
        "research.smart-money",
        "research.wallet",
      ],
      supportedChains: [base, baseSepolia],
    };
  }

  async query(params: ResearchQuery): Promise<ResearchResult> {
    switch (params.type) {
      case "token":
        return this.tokenScreener(params.target);
      case "market":
        return this.marketScreener(params.target);
      case "smart-money":
        return this.smartMoneyNetflow(params.options?.token ?? params.target);
      case "wallet":
        return this.walletProfile(params.target);
      default:
        throw new Error(`Unsupported query type: ${params.type}`);
    }
  }

  /**
   * Token Screener — comprehensive token discovery with on-chain metrics.
   * Endpoint: POST /api/v1/token-screener
   * Cost: ~$0.01 (basic tier)
   */
  private async tokenScreener(target: string): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    // Determine if target is an address or symbol
    const isAddr = target.startsWith("0x") && target.length === 42;
    const filters: Record<string, unknown> = isAddr
      ? { token_address: [target] }
      : { token_symbol: [target.toUpperCase()] };

    const body = {
      chains: ["base"],
      timeframe: "24h",
      filters,
      pagination: { page: 1, records_per_page: 10 },
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/token-screener`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Nansen token query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: unknown[] };
    const costUsdc = this.extractCost(res, "token");

    return {
      provider: "nansen",
      queryType: "token",
      target,
      data: { tokens: json.data ?? [], count: (json.data ?? []).length },
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Market Screener — token screener sorted by volume/market cap for market overview.
   * Endpoint: POST /api/v1/token-screener
   * Cost: ~$0.01 (basic tier)
   */
  private async marketScreener(asset: string): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    const isAddr = asset.startsWith("0x") && asset.length === 42;
    const filters: Record<string, unknown> = isAddr
      ? { token_address: [asset] }
      : { token_symbol: [asset.toUpperCase()] };

    const body = {
      chains: ["base"],
      timeframe: "24h",
      filters,
      order_by: [{ field: "buy_volume", direction: "desc" }],
      pagination: { page: 1, records_per_page: 10 },
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/token-screener`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Nansen market query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: unknown[] };
    const costUsdc = this.extractCost(res, "market");

    return {
      provider: "nansen",
      queryType: "market",
      target: asset,
      data: { tokens: json.data ?? [], count: (json.data ?? []).length },
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Smart Money Net Flow — capital flow analysis from labeled wallets.
   * Endpoint: POST /api/v1/smart-money/netflow
   * Cost: ~$0.06 (premium tier)
   *
   * Queries across all major chains (ethereum, solana, base, arbitrum, etc.)
   * using the token's symbol for filtering. Previously hardcoded to ["base"]
   * which returned empty flows for BTC/ETH/SOL — those tokens don't
   * meaningfully trade on Base.
   *
   * Response includes net_flow_1h/24h/7d/30d in USD per token+chain,
   * plus trader_count (active smart money wallets in 30d window).
   */
  private async smartMoneyNetflow(
    target: string,
  ): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    // Map CoinGecko token IDs to symbols for the filter
    const symbolMap: Record<string, string> = {
      bitcoin: "BTC", ethereum: "ETH", solana: "SOL",
      arbitrum: "ARB", aave: "AAVE", uniswap: "UNI",
      chainlink: "LINK", dogecoin: "DOGE", ripple: "XRP",
      polkadot: "DOT", avalanche: "AVAX", near: "NEAR",
      sui: "SUI", aptos: "APT", hyperliquid: "HYPE",
      worldcoin: "WLD", "worldcoin-wld": "WLD",
      bittensor: "TAO", zcash: "ZEC", fartcoin: "FARTCOIN",
      pepe: "PEPE", pendle: "PENDLE", jupiter: "JUP",
    };
    const symbol = symbolMap[target.toLowerCase()] ?? target.toUpperCase();

    const body: Record<string, unknown> = {
      // Query all supported smart-money chains — the API returns per-chain
      // rows so we get flows across ethereum, solana, base, L2s, etc.
      chains: ["ethereum", "solana", "base", "arbitrum", "optimism", "polygon", "avalanche", "bnb"],
      filters: {
        token_symbol: [symbol],
      },
      order_by: [{ field: "net_flow_24h_usd", direction: "DESC" }],
      pagination: { page: 1, per_page: 10 },
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/smart-money/netflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Nansen smart-money query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: unknown[] };
    const costUsdc = this.extractCost(res, "smart-money");

    return {
      provider: "nansen",
      queryType: "smart-money",
      target,
      data: { flows: json.data ?? [], count: (json.data ?? []).length },
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Hyperliquid Smart Money Perp Trades — what smart wallets are trading
   * on Hyperliquid perps right now.
   * Endpoint: POST /api/v1/smart-money/perp-trades
   * Cost: ~$0.06 (premium tier, estimated)
   *
   * Returns granular trade data: direction (Long/Short), size, price, action
   * (Buy - Add Long, Sell - Open Short, etc.), trader labels (Fund, Smart Trader).
   * Directly relevant — same venue + instrument we trade.
   */
  async queryHyperliquidSmartMoney(
    tokenSymbol: string,
  ): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    const body = {
      filters: {
        include_smart_money_labels: ["Fund", "Smart Trader", "Smart HL Perps Trader"],
        token_symbol: tokenSymbol,
        value_usd: { min: 50000 }, // only meaningful-size trades
      },
      only_new_positions: false,
      pagination: { page: 1, per_page: 20 },
      order_by: [{ field: "block_timestamp", direction: "DESC" }],
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/smart-money/perp-trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Nansen HL perp-trades query failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { data?: unknown[] };
    const costUsdc = this.extractCost(res, "smart-money");

    return {
      provider: "nansen",
      queryType: "hl-perp-trades",
      target: tokenSymbol,
      data: { trades: json.data ?? [], count: (json.data ?? []).length },
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Flow Intelligence — net inflows/outflows by investor category.
   * Endpoint: POST /api/v1/tgm/flow-intelligence
   * Cost: 1 credit (~$0.005 at Pro pricing)
   *
   * Returns aggregated flow data by investor type (Smart Traders, Whales,
   * Exchanges, Top PnL). More stable than individual trade data — shows
   * accumulation/distribution trends rather than noisy per-trade signals.
   */
  async queryFlowIntelligence(
    tokenSymbol: string,
  ): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    const body = {
      token_symbol: tokenSymbol,
      timeframe: "24h",
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/tgm/flow-intelligence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Nansen flow-intelligence query failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { data?: unknown };
    const costUsdc = this.extractCost(res, "flow-intelligence");

    return {
      provider: "nansen",
      queryType: "flow-intelligence",
      target: tokenSymbol,
      data: (json.data ?? {}) as Record<string, unknown>,
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Wallet Profile — PnL summary, realized/unrealized gains, token breakdown.
   * Endpoint: POST /api/v1/profiler/address/pnl-summary
   * Cost: ~$0.01 (basic tier)
   *
   * Note: /api/v1/profiler/wallet-pnl requires an API key and does not support x402.
   * The correct x402 endpoint is /api/v1/profiler/address/pnl-summary.
   */
  private async walletProfile(address: string): Promise<ResearchResult> {
    const fetchWithPay = await getNansenFetch();

    // pnl-summary uses `chain` (singular) + a date range, not `chains` array
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const body = {
      address,
      chain: "base",
      date: {
        from: thirtyDaysAgo.toISOString().replace(/\.\d{3}Z$/, "Z"),
        to: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/profiler/address/pnl-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `Nansen wallet query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const costUsdc = this.extractCost(res, "wallet");

    return {
      provider: "nansen",
      queryType: "wallet",
      target: address,
      data: json.data ?? (json as Record<string, unknown>),
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Resolve a token symbol or name to its contract address on Base.
   * Uses the token screener endpoint ($0.01) to look up the address.
   * If the target is already an address (0x...), returns it as-is.
   */
  private async resolveTokenAddress(target: string): Promise<string | null> {
    if (target.startsWith("0x") && target.length === 42) {
      return target;
    }

    const fetchWithPay = await getNansenFetch();
    const body = {
      chains: ["base"],
      timeframe: "24h",
      filters: { token_symbol: [target.toUpperCase()] },
      pagination: { page: 1, records_per_page: 1 },
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/token-screener`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Array<{ token_address?: string }>;
    };
    return json.data?.[0]?.token_address ?? null;
  }

  /**
   * Extract cost from x402 response headers.
   * Falls back to the known estimate for the query type when headers are absent.
   */
  private extractCost(res: Response, queryType: string): string {
    // Check Nansen-specific credit header
    const creditsUsed = res.headers.get("x-nansen-credits-used");
    if (creditsUsed) {
      return creditsUsed;
    }

    // Fall back to x402 payment-response header
    const paymentResponse = res.headers.get("payment-response");
    if (paymentResponse) {
      try {
        const parsed = JSON.parse(paymentResponse) as { amount?: string };
        if (parsed.amount) {
          const cents = Number(parsed.amount) / 1e6;
          return cents.toFixed(4);
        }
      } catch {
        // Fall through
      }
    }

    // Fall back to known estimate (strip "~$" prefix)
    const est = NANSEN_COST_ESTIMATE[queryType];
    if (est) {
      return est.replace("~$", "");
    }

    return "unknown";
  }
}
