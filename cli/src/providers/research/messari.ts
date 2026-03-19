/**
 * Messari research provider — x402 micropayments for crypto market data.
 *
 * Docs: https://docs.messari.io
 * Payment: x402 (USDC on Base) — no API key required
 * Data: 34,000+ assets, market metrics, asset profiles
 * Pricing: $0.10/call for asset details, ROI, ATH. $0.15–$0.35 for timeseries.
 *          $0.55 for news/signals. Full pricing: https://docs.messari.io/api-reference/x402-payments
 *
 * Supports:
 *   token  → asset details (description, category, sector, links, market snapshot)
 *   market → market metrics + ATH (price, volume, market cap, ROI, ATH, cycle low)
 *
 * Not supported (use --provider nansen instead):
 *   smart-money → on-chain analytics not available in Messari x402 API
 *   wallet      → wallet profiling not available in Messari x402 API
 */

import { base, baseSepolia } from "viem/chains";
import type { ProviderInfo } from "../../types.js";
import type { ResearchProvider, ResearchQuery, ResearchResult } from "./index.js";
import { getX402Fetch } from "../../lib/x402.js";

const BASE_URL = "https://api.messari.io";

/** Known x402 cost per Messari query (approximate). */
export const MESSARI_COST_ESTIMATE: Record<string, string> = {
  token: "~$0.10",
  market: "~$0.20",
};

export class MessariProvider implements ResearchProvider {
  info(): ProviderInfo {
    return {
      name: "messari",
      type: "research",
      capabilities: [
        "research.token",
        "research.market",
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
        throw new Error(
          "Messari x402 API does not support on-chain analytics. Use --provider nansen for smart money data.",
        );
      case "wallet":
        throw new Error(
          "Messari does not support wallet analytics. Use --provider nansen for wallet profiling.",
        );
      default:
        throw new Error(`Unsupported query type: ${params.type}`);
    }
  }

  /**
   * Resolve any user input (symbol, name, slug, address) to a Messari asset slug.
   * Uses the free /metrics/v2/assets endpoint ($0.00) to search.
   */
  private async resolveSlug(target: string): Promise<string> {
    const fetchWithPay = await getX402Fetch();
    const params = new URLSearchParams({
      search: target,
      limit: "1",
    });
    const url = `${BASE_URL}/metrics/v2/assets?${params}`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari asset lookup failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ slug?: string }>;
    };

    const slug = json.data?.[0]?.slug;
    if (!slug) {
      throw new Error(
        `No Messari asset found for "${target}". Try a different name, symbol, or slug.`,
      );
    }
    return slug;
  }

  /**
   * Get asset details: description, category, sector, links, market snapshot.
   * Endpoint: GET /metrics/v2/assets/details?assetIDs={slug}  ($0.10)
   */
  private async tokenReport(target: string): Promise<ResearchResult> {
    const slug = await this.resolveSlug(target);
    const fetchWithPay = await getX402Fetch();
    const url = `${BASE_URL}/metrics/v2/assets/details?assetIDs=${encodeURIComponent(slug)}`;

    const res = await fetchWithPay(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Messari token query failed: ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    const costUsdc = this.extractCost(res);
    const asset = json.data?.[0] ?? {};

    return {
      provider: "messari",
      queryType: "token",
      target,
      data: asset,
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Get market metrics + ATH: price, volume, market cap, ROI, all-time high, cycle low.
   * Makes two parallel calls:
   *   GET /metrics/v2/assets/details?assetIDs={slug}  ($0.10)
   *   GET /metrics/v2/assets/ath?assetIDs={slug}      ($0.10)
   * Total: ~$0.20
   */
  private async marketOverview(target: string): Promise<ResearchResult> {
    const slug = await this.resolveSlug(target);
    const fetchWithPay = await getX402Fetch();
    const assetParam = encodeURIComponent(slug);

    const [detailsRes, athRes] = await Promise.all([
      fetchWithPay(`${BASE_URL}/metrics/v2/assets/details?assetIDs=${assetParam}`, { method: "GET" }),
      fetchWithPay(`${BASE_URL}/metrics/v2/assets/ath?assetIDs=${assetParam}`, { method: "GET" }),
    ]);

    if (!detailsRes.ok) {
      throw new Error(
        `Messari market query failed: ${detailsRes.status} ${detailsRes.statusText}`,
      );
    }
    if (!athRes.ok) {
      throw new Error(
        `Messari ATH query failed: ${athRes.status} ${athRes.statusText}`,
      );
    }

    const detailsJson = (await detailsRes.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    const athJson = (await athRes.json()) as {
      data?: Array<Record<string, unknown>>;
    };

    // Sum costs from both responses
    const cost1 = this.extractCostRaw(detailsRes);
    const cost2 = this.extractCostRaw(athRes);
    const totalCost = cost1 + cost2;
    const costUsdc = totalCost > 0 ? totalCost.toFixed(4) : "unknown";

    const details = detailsJson.data?.[0] ?? {};
    const ath = athJson.data?.[0] ?? {};

    return {
      provider: "messari",
      queryType: "market",
      target,
      data: {
        ...details,
        allTimeHigh: ath.allTimeHigh ?? null,
      },
      costUsdc,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Extract cost from x402 response headers as a number (USDC).
   * Returns 0 if no payment info found.
   */
  private extractCostRaw(res: Response): number {
    const paymentResponse = res.headers.get("payment-response");
    if (paymentResponse) {
      try {
        const parsed = JSON.parse(paymentResponse) as { amount?: string };
        if (parsed.amount) {
          return Number(parsed.amount) / 1e6;
        }
      } catch {
        // Fall through
      }
    }
    return 0;
  }

  /**
   * Extract cost from x402 response headers as a formatted string.
   */
  private extractCost(res: Response): string {
    const cost = this.extractCostRaw(res);
    return cost > 0 ? cost.toFixed(4) : "unknown";
  }
}
