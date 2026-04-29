import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import {
  callFincept,
  clearFinceptCache,
  FINCEPT_SCRIPTS_DIR,
} from "./bridge.js";

beforeEach(() => {
  clearFinceptCache();
});

describe("callFincept", () => {
  it("returns ok:true with parsed JSON for a valid script call", async () => {
    // blockchain_com_data.py stats requires no API key
    const result = await callFincept<{ market_price_usd: number }>(
      "blockchain_com_data.py",
      ["stats"],
    );

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data!.market_price_usd).toBe("number");
    expect(result.latencyMs).toBeGreaterThan(0);
  }, 30_000);

  it("returns ok:false with error for a nonexistent script", async () => {
    const result = await callFincept("nonexistent_script.py", ["foo"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("nonexistent_script.py");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok:false when script outputs an error object", async () => {
    // Calling blockchain_com_data.py with no args returns { error: "No command provided..." }
    const result = await callFincept("blockchain_com_data.py", []);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No command provided");
  });

  it("respects timeout", async () => {
    // 1ms timeout should always fail
    const result = await callFincept(
      "blockchain_com_data.py",
      ["stats"],
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.toLowerCase()).toContain("timed out");
  });

  it("caches results when cacheTtlMs > 0", async () => {
    const r1 = await callFincept(
      "blockchain_com_data.py",
      ["stats"],
      30_000,
      60_000,
    );
    expect(r1.ok).toBe(true);
    expect(r1.latencyMs).toBeGreaterThan(0);

    // Second call should hit cache (latencyMs === 0)
    const r2 = await callFincept(
      "blockchain_com_data.py",
      ["stats"],
      30_000,
      60_000,
    );
    expect(r2.ok).toBe(true);
    expect(r2.latencyMs).toBe(0);
    expect(r2.data).toEqual(r1.data);
  }, 30_000);

  it("FINCEPT_SCRIPTS_DIR points to an existing directory", () => {
    expect(existsSync(FINCEPT_SCRIPTS_DIR)).toBe(true);
  });
});
