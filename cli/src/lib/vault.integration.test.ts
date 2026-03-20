/**
 * Integration tests for SyndicateVault — read-only RPC calls.
 * Requires BASE_SEPOLIA_RPC_URL env var.
 * Dynamically resolves the vault address from syndicate #1 via the factory.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Address } from "viem";
import { setVaultAddress, getAssetAddress, getAssetDecimals, getVaultInfo } from "./vault.js";
import { getSyndicate } from "./factory.js";
import { TOKENS } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

let vaultAddress: Address;
let vaultResolved = false;

beforeAll(async () => {
  const syndicate = await getSyndicate(1n);
  if (syndicate.vault === ZERO_ADDRESS) {
    console.warn("Syndicate #1 has no vault — skipping vault tests");
    return;
  }
  vaultAddress = syndicate.vault;
  setVaultAddress(vaultAddress);
  vaultResolved = true;
});

describe("SyndicateVault (Base Sepolia)", () => {
  it("getAssetAddress returns USDC on Sepolia", async () => {
    if (!vaultResolved) return;
    const asset = await getAssetAddress();
    expect(asset.toLowerCase()).toBe(TOKENS().USDC.toLowerCase());
  });

  it("getAssetDecimals returns 6 for USDC", async () => {
    if (!vaultResolved) return;
    const decimals = await getAssetDecimals();
    expect(decimals).toBe(6);
  });

  it("getVaultInfo returns valid shape", async () => {
    if (!vaultResolved) return;
    const info = await getVaultInfo();
    expect(info.address.toLowerCase()).toBe(vaultAddress.toLowerCase());
    expect(typeof info.totalAssets).toBe("string");
    expect(["number", "bigint"]).toContain(typeof info.agentCount);
    expect(typeof info.redemptionsLocked).toBe("boolean");
    expect(typeof info.managementFeeBps).toBe("bigint");
  });
});
