/**
 * Nansen research provider — x402 micropayments for on-chain analytics.
 *
 * Docs: https://docs.nansen.ai
 * Payment: x402 (USDC on Base) — no API key required
 * Pricing: Basic $0.01/call (Token Screener, Wallet Balances, PnL, DEX Trades)
 *          Premium $0.05/call (Smart Money Net Flow, Holdings, PnL Leaderboard)
 *
 * Supports all query types:
 *   token       → token screener (on-chain metrics, holder quality)
 *   market      → token screener sorted by market cap / volume
 *   smart-money → smart money net flow from labeled wallets
 *   wallet      → wallet profiler (PnL, tx patterns, counterparties)
 */

import { base, baseSepolia } from "viem/chains";
import type { ProviderInfo } from "../../types.js";
import type { ResearchProvider, ResearchQuery, ResearchResult } from "./index.js";
import { getX402Fetch } from "../../lib/x402.js";

const BASE_URL = "https://api.nansen.ai";

/** Known x402 cost per Nansen query type. */
export const NANSEN_COST_ESTIMATE: Record<string, string> = {
  token: "~$0.01",
  market: "~$0.01",
  "smart-money": "~$0.06",
  wallet: "~$0.01",
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
    const fetchWithPay = await getX402Fetch();

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
    const costUsdc = this.extractCost(res);

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
    const fetchWithPay = await getX402Fetch();

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
    const costUsdc = this.extractCost(res);

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
   * Cost: ~$0.05 (premium tier)
   *
   * The netflow endpoint only accepts `token_address` filters (not `token_symbol`).
   * If the target is a symbol, we resolve it to an address via the token screener first.
   */
  private async smartMoneyNetflow(
    target: string,
  ): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();

    // Resolve symbol → address if needed (token screener is $0.01)
    const tokenAddress = await this.resolveTokenAddress(target);

    const body: Record<string, unknown> = {
      chains: ["base"],
      pagination: { page: 1, records_per_page: 10 },
    };

    if (tokenAddress) {
      body.filters = { token_address: [tokenAddress] };
    }

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
    const costUsdc = this.extractCost(res);

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
   * Wallet Profile — PnL history, transaction patterns, counterparties.
   * Endpoint: POST /api/v1/profiler/wallet-pnl
   * Cost: ~$0.01 (basic tier)
   */
  private async walletProfile(address: string): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();

    const body = {
      chains: ["base"],
      address,
    };

    const res = await fetchWithPay(`${BASE_URL}/api/v1/profiler/wallet-pnl`, {
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
    const costUsdc = this.extractCost(res);

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

    const fetchWithPay = await getX402Fetch();
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
   */
  private extractCost(res: Response): string {
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

    return "unknown";
  }
}
