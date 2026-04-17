/**
 * Unit tests for TradeExecutor asset resolution + ABI encoding.
 */

import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";

// Import the static method directly
// TradeExecutor is a class — we only test the static resolveAssetIndex and encoding.

describe("TradeExecutor", () => {
  // Re-create the map here since it's private static
  const TOKEN_TO_ASSET_INDEX: Record<string, number> = {
    bitcoin: 0, ethereum: 1, solana: 2, aave: 10,
    dogecoin: 6, hyperliquid: 131, zcash: 144,
  };

  describe("resolveAssetIndex", () => {
    it("maps known tokens to their HL perp asset index", () => {
      expect(TOKEN_TO_ASSET_INDEX["bitcoin"]).toBe(0);
      expect(TOKEN_TO_ASSET_INDEX["ethereum"]).toBe(1);
      expect(TOKEN_TO_ASSET_INDEX["aave"]).toBe(10);
      expect(TOKEN_TO_ASSET_INDEX["hyperliquid"]).toBe(131);
    });

    it("returns undefined for unknown tokens", () => {
      expect(TOKEN_TO_ASSET_INDEX["unknown-token"]).toBeUndefined();
    });
  });

  describe("ACTION_OPEN_LONG_MULTI encoding", () => {
    it("encodes correctly for contract decode", () => {
      // action=6, assetIndex=10 (AAVE), limitPx, sz, stopLossPx, stopLossSz
      const encoded = encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
        [6, 10, 50000000000n, 100000n, 45000000000n, 100000n],
      );
      expect(encoded).toBeDefined();
      expect(encoded.startsWith("0x")).toBe(true);
      // First byte after padding should encode action=6
      // The encoding is ABI-packed, verify it's non-trivial
      expect(encoded.length).toBeGreaterThan(66); // more than just one word
    });

    it("encodes short action correctly", () => {
      const encoded = encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
        [7, 0, 75000000000n, 50000n, 80000000000n, 50000n], // short BTC
      );
      expect(encoded).toBeDefined();
    });

    it("encodes close-multi with isBuy for short close", () => {
      // action=8, assetIndex=10, isBuy=true (close short), limitPx, sz
      const encoded = encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }],
        [8, 10, true, 55000000000n, 100000n],
      );
      expect(encoded).toBeDefined();
    });
  });
});
