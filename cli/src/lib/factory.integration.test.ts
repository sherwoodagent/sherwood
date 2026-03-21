/**
 * Integration tests for SyndicateFactory — read-only RPC calls.
 * Requires BASE_SEPOLIA_RPC_URL env var. Factory address is hardcoded in addresses.ts.
 */

import { describe, it, expect } from "vitest";
import { getSyndicateCount, getActiveSyndicates, getSyndicate } from "./factory.js";

describe("SyndicateFactory (Base Sepolia)", () => {
  it("getSyndicateCount returns a bigint >= 0", async () => {
    const count = await getSyndicateCount();
    expect(typeof count).toBe("bigint");
    expect(count).toBeGreaterThanOrEqual(0n);
  });

  it("getActiveSyndicates returns an array", async () => {
    const syndicates = await getActiveSyndicates();
    expect(Array.isArray(syndicates)).toBe(true);
  });

  it("getSyndicate(0) returns zero vault (no syndicate 0)", async () => {
    const info = await getSyndicate(0n);
    expect(info.vault).toBe("0x0000000000000000000000000000000000000000");
  });

  it("getSyndicate(999999) returns zero vault (non-existent)", async () => {
    const info = await getSyndicate(999999n);
    expect(info.vault).toBe("0x0000000000000000000000000000000000000000");
  });
});
