/**
 * Messari research provider — x402 micropayments for crypto market data.
 *
 * Docs: https://docs.messari.io
 * Payment: x402 (USDC on Base) — no API key required
 * Data: 34,000+ assets, market metrics, protocol data, asset profiles
 * Pricing: $0.10/call for asset details, ROI, ATH. $0.15–$0.35 for timeseries.
 *          $0.55 for news/signals. Full pricing: https://docs.messari.io/api-reference/x402-payments
 *
 * Supports all query types:
 *   token   → asset profile (description, technology, governance)
 *   market  → market metrics (price, volume, market cap, ROI, ATH)
 *   smart-money → asset metrics filtered to on-chain activity
 *   wallet  → not natively supported, falls back to asset lookup by address
 */

import { base, baseSepolia } from "viem/chains";
import type { ProviderInfo } from "../../types.js";
import type { ResearchProvider, ResearchQuery, ResearchResult } from "./index.js";
import { getX402Fetch } from "../../lib/x402.js";

const BASE_URL = "https://data.messari.io/api";

/** Known x402 cost per Messari query (approximate). */
export const MESSARI_COST_ESTIMATE: Record<string, string> = {
  token: "~$0.10",
  market: "~$0.10",
  "smart-money": "~$0.10",
  wallet: "~$0.10",
};

export class MessariProvider implements ResearchProvider {
  info(): ProviderInfo {
    return {
      name: "messari",
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
        return this.tokenReport(params.target);
      case "market":
        return this.marketOverview(params.target);
      case "smart-money":
        return this.smartMoney(params.options?.token ?? params.target);
      case "wallet":
        return this.walletLookup(params.target);
      default:
        throw new Error(`Unsupported query type: ${params.type}`);
    }
  }

  /**
   * Get full asset profile: description, technology, contributors, governance, etc.
   * Endpoint: GET /v2/assets/{assetKey}/profile
   */
  private async tokenReport(assetKey: string): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();
    const url = `${BASE_URL}/v2/assets/${encodeURIComponent(assetKey)}/profile`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari token query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const costUsdc = this.extractCost(res);

    return {
      provider: "messari",
      queryType: "token",
      target: assetKey,
      data: json.data ?? (json as Record<string, unknown>),
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Get market metrics: price, volume, market cap, ROI, ATH, etc.
   * Endpoint: GET /v1/assets/{assetKey}/metrics
   */
  private async marketOverview(assetKey: string): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();
    const url = `${BASE_URL}/v1/assets/${encodeURIComponent(assetKey)}/metrics`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari market query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const costUsdc = this.extractCost(res);

    return {
      provider: "messari",
      queryType: "market",
      target: assetKey,
      data: json.data ?? (json as Record<string, unknown>),
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Smart money — Messari's on-chain metrics for the asset.
   * Uses the metrics endpoint filtered to on-chain activity data
   * (active addresses, transaction volume, NVT, exchange flows).
   * Endpoint: GET /v1/assets/{assetKey}/metrics
   */
  private async smartMoney(assetKey: string): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();
    const url = `${BASE_URL}/v1/assets/${encodeURIComponent(assetKey)}/metrics`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari smart-money query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const costUsdc = this.extractCost(res);

    // Extract on-chain relevant fields from the full metrics response
    const metrics = json.data ?? {};
    const onChainData: Record<string, unknown> = {};
    const onChainKeys = [
      "on_chain_data",
      "blockchain_stats_24_hours",
      "exchange_flows",
      "miner_flows",
      "supply",
      "market_data",
    ];
    for (const key of onChainKeys) {
      if (key in metrics) {
        onChainData[key] = metrics[key];
      }
    }

    return {
      provider: "messari",
      queryType: "smart-money",
      target: assetKey,
      data: Object.keys(onChainData).length > 0 ? onChainData : metrics,
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Wallet lookup — Messari doesn't have per-wallet analytics, but if the
   * address corresponds to a known asset, we can return its profile.
   * Falls back to a search by address.
   * Endpoint: GET /v2/assets/{address}/profile
   */
  private async walletLookup(address: string): Promise<ResearchResult> {
    const fetchWithPay = await getX402Fetch();

    // Try looking up the address as an asset (works for token contract addresses)
    const url = `${BASE_URL}/v2/assets/${encodeURIComponent(address)}/profile`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari wallet/asset lookup failed: ${res.status} ${res.statusText}. ` +
          `Messari maps addresses to token profiles — for full wallet analytics, use --provider nansen`,
      );
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const costUsdc = this.extractCost(res);

    return {
      provider: "messari",
      queryType: "wallet",
      target: address,
      data: json.data ?? (json as Record<string, unknown>),
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Extract cost from x402 response headers.
   * The PAYMENT-RESPONSE header may contain settlement details including the amount paid.
   */
  private extractCost(res: Response): string {
    const paymentResponse = res.headers.get("payment-response");
    if (paymentResponse) {
      try {
        const parsed = JSON.parse(paymentResponse) as {
          amount?: string;
        };
        if (parsed.amount) {
          // x402 amounts are in USDC atomic units (6 decimals)
          const cents = Number(parsed.amount) / 1e6;
          return cents.toFixed(4);
        }
      } catch {
        // Fall through to default
      }
    }
    return "unknown";
  }
}
