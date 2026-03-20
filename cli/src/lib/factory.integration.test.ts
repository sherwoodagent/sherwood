/**
 * Integration tests for SyndicateFactory — read-only RPC calls.
 * Requires BASE_SEPOLIA_RPC_URL env var. Factory address is hardcoded in addresses.ts.
 */

import { describe, it, expect } from "vitest";
import { getSyndicateCount, getActiveSyndicates, getSyndicate } from "./factory.js";

describe("SyndicateFactory (Base Sepolia)", () => {
  it("getSyndicateCount returns >= 1 (at least one syndicate deployed)", async () => {
    const count = await getSyndicateCount();
    expect(typeof count).toBe("bigint");
    expect(count).toBeGreaterThanOrEqual(1n);
  });

  it("getActiveSyndicates returns at least one syndicate", async () => {
    const syndicates = await getActiveSyndicates();
    expect(Array.isArray(syndicates)).toBe(true);
    expect(syndicates.length).toBeGreaterThanOrEqual(1);
  });

  it("getSyndicate(1) returns a valid active syndicate", async () => {
    const info = await getSyndicate(1n);
    expect(info.id).toBe(1n);
    expect(info.vault).not.toBe("0x0000000000000000000000000000000000000000");
    expect(info.subdomain).toBeTruthy();
    expect(typeof info.subdomain).toBe("string");
    expect(info.active).toBe(true);
    expect(info.creator).not.toBe("0x0000000000000000000000000000000000000000");
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
