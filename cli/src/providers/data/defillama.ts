/**
 * DefiLlama free API provider — no API key needed.
 * Provides TVL, protocol, DEX volume, yield, price, and stablecoin data.
 */

import type { Provider, ProviderInfo } from "../../types.js";

export class DefiLlamaProvider implements Provider {
  info(): ProviderInfo {
    return {
      name: "DefiLlama",
      type: "research",
      capabilities: [
        "protocol-tvl",
        "protocol-list",
        "protocol-details",
        "dex-volumes",
        "yields",
        "token-prices",
        "stablecoins",
      ],
      supportedChains: [],
    };
  }

  /** Get current TVL for a protocol (returns a number). */
  async getProtocolTvl(protocol: string): Promise<number> {
    try {
      const res = await fetch(`https://api.llama.fi/tvl/${encodeURIComponent(protocol)}`);
      if (!res.ok) throw new Error(`DefiLlama tvl error: ${res.status} ${res.statusText}`);
      const data = await res.json();
      return data as number;
    } catch (err) {
      throw new Error(`Failed to fetch TVL for ${protocol}: ${(err as Error).message}`);
    }
  }

  /** Get all protocols with TVL & chain info. */
  async getProtocols(): Promise<any[]> {
    try {
      const res = await fetch("https://api.llama.fi/protocols");
      if (!res.ok) throw new Error(`DefiLlama protocols error: ${res.status} ${res.statusText}`);
      return (await res.json()) as any[];
    } catch (err) {
      throw new Error(`Failed to fetch protocols: ${(err as Error).message}`);
    }
  }

  /** Get detailed protocol info with historical TVL. */
  async getProtocolDetails(protocol: string): Promise<any> {
    try {
      const res = await fetch(`https://api.llama.fi/protocol/${encodeURIComponent(protocol)}`);
      if (!res.ok) throw new Error(`DefiLlama protocol detail error: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Failed to fetch protocol details for ${protocol}: ${(err as Error).message}`);
    }
  }

  /** Get DEX volumes, optionally filtered by chain. */
  async getDexVolumes(chain?: string): Promise<any> {
    try {
      const url = chain
        ? `https://api.llama.fi/overview/dexs/${encodeURIComponent(chain)}`
        : "https://api.llama.fi/overview/dexs";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`DefiLlama dex volumes error: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Failed to fetch DEX volumes: ${(err as Error).message}`);
    }
  }

  /** Get yield/pool data from DefiLlama yields API. */
  async getYields(): Promise<any> {
    try {
      const res = await fetch("https://yields.llama.fi/pools");
      if (!res.ok) throw new Error(`DefiLlama yields error: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Failed to fetch yields: ${(err as Error).message}`);
    }
  }

  /**
   * Get current token prices.
   * @param coins Array of "chain:address" strings, e.g. ["ethereum:0x..."]
   */
  async getTokenPrices(coins: string[]): Promise<any> {
    try {
      const joined = coins.map(encodeURIComponent).join(",");
      const res = await fetch(`https://coins.llama.fi/prices/current/${joined}`);
      if (!res.ok) throw new Error(`DefiLlama prices error: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Failed to fetch token prices: ${(err as Error).message}`);
    }
  }

  /** Get stablecoin data. */
  async getStablecoins(): Promise<any> {
    try {
      const res = await fetch("https://stablecoins.llama.fi/stablecoins");
      if (!res.ok) throw new Error(`DefiLlama stablecoins error: ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Failed to fetch stablecoins: ${(err as Error).message}`);
    }
  }
}
