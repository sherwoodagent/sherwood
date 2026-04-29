# FinceptTerminal Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Sherwood's in-house data providers with FinceptTerminal's Python data fetchers and add Glassnode, Messari, Blockchain.com, and Polymarket as new signal sources — filling the 35%+ dead weight in the scoring engine.

**Architecture:** Python bridge via `execFile` (no shell) calls vendored FinceptTerminal scripts that output JSON to stdout. Each TypeScript wrapper parses the JSON and feeds it into the existing scoring/strategy pipeline. Hyperliquid and TradingView providers are kept as-is.

**Tech Stack:** TypeScript (wrappers), Python 3 (vendored scripts), `requests`/`ccxt`/`numpy` (Python deps)

**Spec:** `docs/superpowers/specs/2026-04-22-fincept-integration-design.md`

---

## File Structure

### New files to create

```
cli/scripts/fincept/                    # Vendored Python scripts
  requirements.txt
  cryptocompare_data.py                 # From FinceptTerminal
  defillama_data.py                     # From FinceptTerminal
  dexscreener_data.py                   # From FinceptTerminal
  glassnode_data.py                     # From FinceptTerminal
  messari_data.py                       # From FinceptTerminal
  blockchain_com_data.py                # From FinceptTerminal
  polymarket.py                         # From FinceptTerminal
  fetch_funding_rate.py                 # From FinceptTerminal

cli/src/providers/fincept/
  bridge.ts                             # Generic Python subprocess runner
  bridge.test.ts                        # Bridge tests
  cryptocompare.ts                      # CryptoCompare wrapper
  defillama.ts                          # DefiLlama wrapper
  dexscreener.ts                        # DexScreener wrapper
  glassnode.ts                          # Glassnode wrapper (NEW source)
  messari.ts                            # Messari wrapper (NEW source)
  blockchain.ts                         # Blockchain.com wrapper (NEW source)
  polymarket.ts                         # Polymarket/Manifold wrapper (NEW source)
  funding-rate.ts                       # CCXT funding rate wrapper
  sentiment.ts                          # CryptoCompare social wrapper
  index.ts                              # Re-exports

cli/src/agent/strategies/
  glassnode-onchain.ts                  # NEW strategy
  social-volume.ts                      # NEW strategy
  prediction-market.ts                  # NEW strategy
  btc-network-health.ts                 # NEW strategy
```

### Files to modify

```
cli/src/agent/strategies/types.ts       # Add new StrategyContext fields
cli/src/agent/strategies/index.ts       # Register new strategies
cli/src/agent/index.ts                  # Wire Fincept providers into analyzeToken()
cli/src/agent/scoring.ts                # Update DEFAULT_WEIGHTS
cli/src/agent/regime.ts                 # Add BTC network health enrichment
```

### Files deprecated (Phase 3)

```
cli/src/providers/data/coingecko.ts     # Replaced by fincept/cryptocompare.ts
cli/src/providers/data/defillama.ts     # Replaced by fincept/defillama.ts
cli/src/providers/data/dexscreener.ts   # Replaced by fincept/dexscreener.ts
cli/src/providers/data/feargreed.ts     # Replaced by fincept/sentiment.ts
cli/src/providers/data/sentiment.ts     # Replaced by fincept/sentiment.ts
cli/src/providers/data/funding-rate.ts  # Replaced by fincept/funding-rate.ts
cli/src/providers/data/token-unlocks.ts # Replaced by fincept/messari.ts
cli/src/providers/data/twitter.ts       # Dropped (CryptoCompare social replaces)
```

---

## Phase 1: Bridge + New Sources (additive, no breakage)

### Task 1: Vendor Python scripts and install deps

**Files:**
- Create: `cli/scripts/fincept/requirements.txt`
- Create: `cli/scripts/fincept/*.py` (8 scripts from FinceptTerminal)

- [ ] **Step 1: Create the fincept scripts directory**

```bash
mkdir -p cli/scripts/fincept
```

- [ ] **Step 2: Write requirements.txt**

Create `cli/scripts/fincept/requirements.txt`:
```
requests==2.32.5
ccxt>=4.5.44
numpy>=2.2.3
```

- [ ] **Step 3: Download the Python scripts from FinceptTerminal**

```bash
cd cli/scripts/fincept

# Core crypto data modules
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/cryptocompare_data.py" -o cryptocompare_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/defillama_data.py" -o defillama_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/dexscreener_data.py" -o dexscreener_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/glassnode_data.py" -o glassnode_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/messari_data.py" -o messari_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/blockchain_com_data.py" -o blockchain_com_data.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/data/polymarket.py" -o polymarket.py
curl -sL "https://raw.githubusercontent.com/Fincept-Corporation/FinceptTerminal/main/fincept_terminal/exchange/fetch_funding_rate.py" -o fetch_funding_rate.py
```

After downloading, verify each script has a `if __name__ == "__main__":` block that outputs JSON. If any script imports from `fincept_terminal.*` internally, patch those imports to be self-contained (replace with inline logic or remove).

- [ ] **Step 4: Install Python dependencies**

```bash
pip install -r cli/scripts/fincept/requirements.txt
```

- [ ] **Step 5: Verify scripts run standalone**

```bash
python3 cli/scripts/fincept/blockchain_com_data.py stats
python3 cli/scripts/fincept/defillama_data.py chains
python3 cli/scripts/fincept/dexscreener_data.py search uniswap
```

Each should output valid JSON to stdout.

- [ ] **Step 6: Commit**

```bash
git add cli/scripts/fincept/
git commit -m "chore: vendor FinceptTerminal Python data scripts"
```

---

### Task 2: Build the Python bridge (`bridge.ts`)

**Files:**
- Create: `cli/src/providers/fincept/bridge.ts`
- Create: `cli/src/providers/fincept/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/providers/fincept/bridge.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { callFincept, FINCEPT_SCRIPTS_DIR } from "./bridge.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("callFincept", () => {
  it("returns ok:true with parsed JSON for a valid script call", async () => {
    // blockchain_com_data.py stats requires no API key and always works
    const result = await callFincept<Record<string, unknown>>(
      "blockchain_com_data.py",
      ["stats"],
    );
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data!.market_price_usd).toBe("number");
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it("returns ok:false with error for a nonexistent script", async () => {
    const result = await callFincept("nonexistent.py", ["foo"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns ok:false when script outputs invalid JSON", async () => {
    // Pass bad args that make the script output an error JSON
    const result = await callFincept("blockchain_com_data.py", ["nonexistent_command"]);
    // Should still return ok:false gracefully, not throw
    expect(typeof result.ok).toBe("boolean");
  });

  it("respects timeout", async () => {
    // 1ms timeout should always fail
    const result = await callFincept("blockchain_com_data.py", ["stats"], 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("FINCEPT_SCRIPTS_DIR points to an existing directory", () => {
    expect(existsSync(FINCEPT_SCRIPTS_DIR)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd cli && npx vitest run src/providers/fincept/bridge.test.ts
```

Expected: FAIL — module `./bridge.js` not found.

- [ ] **Step 3: Write the bridge implementation**

Create `cli/src/providers/fincept/bridge.ts`:
```typescript
/**
 * Python bridge — calls vendored FinceptTerminal scripts via subprocess.
 *
 * Each script outputs JSON to stdout. We parse it and return a typed result.
 * Uses execFile (not exec) to prevent shell injection.
 * Includes in-memory cache with configurable TTL.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Path to vendored Python scripts. */
export const FINCEPT_SCRIPTS_DIR = join(__dirname, "..", "..", "..", "scripts", "fincept");

export interface BridgeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

/** In-memory cache entry. */
interface CacheEntry<T> {
  ts: number;
  data: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

/** Default subprocess timeout (30 seconds — matches FinceptTerminal). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Call a vendored FinceptTerminal Python script.
 *
 * @param script  - Filename relative to FINCEPT_SCRIPTS_DIR (e.g. "glassnode_data.py")
 * @param args    - CLI arguments (e.g. ["active_addresses", "BTC"])
 * @param timeoutMs - Subprocess timeout in milliseconds (default 30s)
 * @param cacheTtlMs - Cache TTL in milliseconds (0 = no cache, default 0)
 */
export async function callFincept<T = unknown>(
  script: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cacheTtlMs: number = 0,
): Promise<BridgeResult<T>> {
  const cacheKey = `${script}:${args.join(":")}`;

  // Check cache
  if (cacheTtlMs > 0) {
    const entry = cache.get(cacheKey);
    if (entry && Date.now() - entry.ts < cacheTtlMs) {
      return { ok: true, data: entry.data as T, latencyMs: 0 };
    }
  }

  const scriptPath = join(FINCEPT_SCRIPTS_DIR, script);
  const start = Date.now();

  return new Promise<BridgeResult<T>>((resolve) => {
    execFile(
      "python3",
      [scriptPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB — some scripts return large JSON
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        const latencyMs = Date.now() - start;

        if (error) {
          const msg = error.killed
            ? `Script ${script} timed out after ${timeoutMs}ms`
            : `Script ${script} failed: ${error.message}`;
          resolve({ ok: false, error: msg, latencyMs });
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve({ ok: false, error: `Script ${script} returned empty output`, latencyMs });
          return;
        }

        try {
          const data = JSON.parse(trimmed) as T;

          // FinceptTerminal scripts return { error: "..." } on failure
          if (
            data &&
            typeof data === "object" &&
            "error" in data &&
            typeof (data as Record<string, unknown>).error === "string"
          ) {
            resolve({
              ok: false,
              error: (data as Record<string, unknown>).error as string,
              latencyMs,
            });
            return;
          }

          // Cache successful result
          if (cacheTtlMs > 0) {
            cache.set(cacheKey, { ts: Date.now(), data });
          }

          resolve({ ok: true, data, latencyMs });
        } catch {
          resolve({
            ok: false,
            error: `Script ${script} returned invalid JSON: ${trimmed.slice(0, 200)}`,
            latencyMs,
          });
        }
      },
    );
  });
}

/** Clear all cached entries (useful for tests). */
export function clearFinceptCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd cli && npx vitest run src/providers/fincept/bridge.test.ts
```

Expected: All tests PASS. The `stats` test makes a real HTTP call to blockchain.com (no API key needed).

- [ ] **Step 5: Commit**

```bash
git add cli/src/providers/fincept/bridge.ts cli/src/providers/fincept/bridge.test.ts
git commit -m "feat(fincept): add Python bridge for subprocess data fetching"
```

---

### Task 3: Glassnode wrapper + GlassnodeOnChainStrategy

**Files:**
- Create: `cli/src/providers/fincept/glassnode.ts`
- Create: `cli/src/agent/strategies/glassnode-onchain.ts`
- Modify: `cli/src/agent/strategies/types.ts` — add `glassnodeData` to StrategyContext
- Modify: `cli/src/agent/strategies/index.ts` — register GlassnodeOnChainStrategy

- [ ] **Step 1: Add `glassnodeData` to StrategyContext**

In `cli/src/agent/strategies/types.ts`, add after the `hyperliquidData` field:

```typescript
  /** Fincept: Glassnode on-chain metrics (BTC/ETH). */
  glassnodeData?: {
    activeAddresses: number;
    activeAddressesGrowth: number;
    nvtRatio: number;
    sopr: number;
    transactionCount: number;
  };
```

- [ ] **Step 2: Write the Glassnode provider wrapper**

Create `cli/src/providers/fincept/glassnode.ts`:
```typescript
/**
 * Glassnode on-chain metrics via FinceptTerminal Python bridge.
 * Requires GLASSNODE_API_KEY env var.
 *
 * Returns: active addresses, NVT ratio, SOPR, transaction count.
 * Cache: 1 hour (on-chain data updates daily).
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** Map CoinGecko token IDs to Glassnode asset symbols. */
const GLASSNODE_ASSETS: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
};

export interface GlassnodeMetrics {
  activeAddresses: number;
  activeAddressesGrowth: number;
  nvtRatio: number;
  sopr: number;
  transactionCount: number;
}

/**
 * Fetch Glassnode on-chain metrics for a token.
 * Only supports BTC and ETH (Glassnode limitation).
 * Returns null if the token is unsupported or the API key is missing.
 */
export async function getGlassnodeMetrics(tokenId: string): Promise<GlassnodeMetrics | null> {
  const asset = GLASSNODE_ASSETS[tokenId];
  if (!asset) return null;

  if (!process.env.GLASSNODE_API_KEY) {
    return null;
  }

  // Fetch active addresses (current + 7d ago for growth calc)
  const [activeResult, nvtResult, soprResult, txResult] = await Promise.allSettled([
    callFincept<Array<{ t: number; v: number }>>(
      "glassnode_data.py", ["active_addresses", asset, "7d"], 30_000, CACHE_TTL,
    ),
    callFincept<Array<{ t: number; v: number }>>(
      "glassnode_data.py", ["nvt", asset], 30_000, CACHE_TTL,
    ),
    callFincept<Array<{ t: number; v: number }>>(
      "glassnode_data.py", ["sopr", asset], 30_000, CACHE_TTL,
    ),
    callFincept<Array<{ t: number; v: number }>>(
      "glassnode_data.py", ["transactions", asset, "7d"], 30_000, CACHE_TTL,
    ),
  ]);

  // Extract latest values from time series
  const getLatest = (
    result: PromiseSettledResult<{ ok: boolean; data?: Array<{ t: number; v: number }> }>,
  ): number => {
    if (result.status !== "fulfilled" || !result.value.ok || !result.value.data?.length) return NaN;
    return result.value.data[result.value.data.length - 1]!.v;
  };

  const getFirst = (
    result: PromiseSettledResult<{ ok: boolean; data?: Array<{ t: number; v: number }> }>,
  ): number => {
    if (result.status !== "fulfilled" || !result.value.ok || !result.value.data?.length) return NaN;
    return result.value.data[0]!.v;
  };

  const activeNow = getLatest(activeResult);
  const active7dAgo = getFirst(activeResult);
  const growth = active7dAgo > 0 ? (activeNow - active7dAgo) / active7dAgo : 0;

  return {
    activeAddresses: activeNow,
    activeAddressesGrowth: growth,
    nvtRatio: getLatest(nvtResult),
    sopr: getLatest(soprResult),
    transactionCount: getLatest(txResult),
  };
}
```

- [ ] **Step 3: Write the GlassnodeOnChainStrategy**

Create `cli/src/agent/strategies/glassnode-onchain.ts`:
```typescript
/**
 * Glassnode On-Chain Strategy — uses NVT, SOPR, active address growth
 * to generate on-chain signals for BTC/ETH.
 *
 * - NVT < 30: network undervalued relative to transaction volume (bullish)
 * - NVT > 80: network overvalued (bearish)
 * - SOPR < 1: holders selling at a loss = capitulation (contrarian buy)
 * - SOPR > 1.05: holders in profit = potential distribution (mild bearish)
 * - Active addresses growing > 5%: network adoption (bullish)
 * - Active addresses declining > 5%: network stagnation (bearish)
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class GlassnodeOnChainStrategy implements Strategy {
  name = 'glassnodeOnChain';
  description = 'Glassnode on-chain metrics (NVT, SOPR, active addresses)';
  requiredData = ['glassnodeData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const gn = ctx.glassnodeData;
    if (!gn) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: 'No Glassnode data available',
      };
    }

    let value = 0;
    const details: string[] = [];
    let confidence = 0.4;

    // NVT Ratio scoring
    const nvt = gn.nvtRatio;
    if (!isNaN(nvt) && nvt > 0) {
      if (nvt < 30) {
        const nvtSignal = 0.4 * (1 - nvt / 30); // 0.4 at NVT=0, 0 at NVT=30
        value += nvtSignal;
        details.push(`NVT ${nvt.toFixed(1)} — undervalued (+${nvtSignal.toFixed(2)})`);
        confidence += 0.1;
      } else if (nvt > 80) {
        const nvtSignal = -0.4 * Math.min(1, (nvt - 80) / 40); // -0.4 max at NVT=120
        value += nvtSignal;
        details.push(`NVT ${nvt.toFixed(1)} — overvalued (${nvtSignal.toFixed(2)})`);
        confidence += 0.1;
      } else {
        details.push(`NVT ${nvt.toFixed(1)} — neutral`);
      }
    }

    // SOPR scoring (contrarian)
    const sopr = gn.sopr;
    if (!isNaN(sopr) && sopr > 0) {
      if (sopr < 1.0) {
        // Sellers are at a loss — capitulation = contrarian buy
        const soprSignal = 0.3 * (1 - sopr); // +0.3 at SOPR=0, +0.03 at SOPR=0.9
        value += soprSignal;
        details.push(`SOPR ${sopr.toFixed(3)} — capitulation, contrarian buy (+${soprSignal.toFixed(2)})`);
        confidence += 0.15;
      } else if (sopr > 1.05) {
        // Holders taking profit — distribution
        const soprSignal = -0.2 * Math.min(1, (sopr - 1.05) / 0.1);
        value += soprSignal;
        details.push(`SOPR ${sopr.toFixed(3)} — profit taking (${soprSignal.toFixed(2)})`);
        confidence += 0.1;
      } else {
        details.push(`SOPR ${sopr.toFixed(3)} — neutral`);
      }
    }

    // Active address growth
    const growth = gn.activeAddressesGrowth;
    if (!isNaN(growth)) {
      if (growth > 0.05) {
        const growthSignal = 0.3 * Math.min(1, growth / 0.15); // +0.3 at 15%+ growth
        value += growthSignal;
        details.push(`Active addr +${(growth * 100).toFixed(1)}% (7d) — adoption (+${growthSignal.toFixed(2)})`);
        confidence += 0.1;
      } else if (growth < -0.05) {
        const growthSignal = -0.3 * Math.min(1, Math.abs(growth) / 0.15);
        value += growthSignal;
        details.push(`Active addr ${(growth * 100).toFixed(1)}% (7d) — stagnation (${growthSignal.toFixed(2)})`);
        confidence += 0.1;
      }
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: this.description,
      details: details.join('; ') || 'Glassnode data inconclusive',
    };
  }
}
```

- [ ] **Step 4: Register the strategy in `strategies/index.ts`**

Add to imports at top of `cli/src/agent/strategies/index.ts`:
```typescript
import { GlassnodeOnChainStrategy } from './glassnode-onchain.js';
```

Add to exports:
```typescript
export { GlassnodeOnChainStrategy };
```

Add to `DEFAULT_STRATEGIES` array:
```typescript
  new GlassnodeOnChainStrategy(),       // onchain — Glassnode NVT/SOPR/active addresses
```

- [ ] **Step 5: Add `glassnodeOnChain` to SIGNAL_CATEGORY_MAP in `scoring.ts`**

In `cli/src/agent/scoring.ts`, add to the `SIGNAL_CATEGORY_MAP` object:
```typescript
  glassnodeOnChain: "onchain",
```

- [ ] **Step 6: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add cli/src/providers/fincept/glassnode.ts cli/src/agent/strategies/glassnode-onchain.ts cli/src/agent/strategies/types.ts cli/src/agent/strategies/index.ts cli/src/agent/scoring.ts
git commit -m "feat(fincept): add Glassnode on-chain strategy (NVT, SOPR, active addresses)"
```

---

### Task 4: Messari wrapper + scoreFundamental wiring

**Files:**
- Create: `cli/src/providers/fincept/messari.ts`
- Modify: `cli/src/agent/strategies/types.ts` — add `messariFundamentals` to StrategyContext

- [ ] **Step 1: Add `messariFundamentals` to StrategyContext**

In `cli/src/agent/strategies/types.ts`, add after `glassnodeData`:

```typescript
  /** Fincept: Messari fundamentals (supply, revenue, developer activity). */
  messariFundamentals?: {
    marketCap: number;
    supply: { circulating: number; max: number; percentCirculating: number };
    revenueUsd24h: number;
    revenueGrowth7d: number;
    developerActivity: number;
  };
```

- [ ] **Step 2: Write the Messari provider wrapper**

Create `cli/src/providers/fincept/messari.ts`:
```typescript
/**
 * Messari fundamentals via FinceptTerminal Python bridge.
 * Optional MESSARI_API_KEY for higher rate limits (free tier works).
 *
 * Returns: market cap, supply metrics, revenue, developer activity.
 * Cache: 1 hour.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export interface MessariFundamentals {
  marketCap: number;
  supply: { circulating: number; max: number; percentCirculating: number };
  revenueUsd24h: number;
  revenueGrowth7d: number;
  developerActivity: number;
}

/** Map CoinGecko IDs to Messari slugs (most are identical). */
const MESSARI_SLUG_MAP: Record<string, string> = {
  "avalanche-2": "avalanche",
  "worldcoin-wld": "worldcoin",
  "pudgy-penguins": "pudgy-penguins",
  "fetch-ai": "fetch-ai",
};

export async function getMessariFundamentals(tokenId: string): Promise<MessariFundamentals | null> {
  const slug = MESSARI_SLUG_MAP[tokenId] ?? tokenId;

  const result = await callFincept<{
    data?: {
      id: string;
      metrics?: {
        market_data?: { price_usd: number; market_cap: { current_marketcap_usd: number } };
        supply?: { circulating: number; max: number; y_2050: number };
        blockchain_stats_24_hours?: { revenue_usd: number };
        developer_activity?: { stars: number; watchers: number; commits_last_3_months: number };
        roi_data?: { percent_change_last_1_week: number };
      };
    };
  }>("messari_data.py", ["metrics", slug], 30_000, CACHE_TTL);

  if (!result.ok || !result.data?.data?.metrics) return null;

  const m = result.data.data.metrics;
  const circulating = m.supply?.circulating ?? 0;
  const max = m.supply?.max ?? m.supply?.y_2050 ?? 0;

  return {
    marketCap: m.market_data?.market_cap?.current_marketcap_usd ?? 0,
    supply: {
      circulating,
      max,
      percentCirculating: max > 0 ? circulating / max : 0,
    },
    revenueUsd24h: m.blockchain_stats_24_hours?.revenue_usd ?? 0,
    revenueGrowth7d: 0, // Messari doesn't expose 7d growth directly — compute from timeseries if needed
    developerActivity: m.developer_activity?.commits_last_3_months ?? 0,
  };
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add cli/src/providers/fincept/messari.ts cli/src/agent/strategies/types.ts
git commit -m "feat(fincept): add Messari fundamentals wrapper"
```

---

### Task 5: Blockchain.com wrapper + BtcNetworkHealthStrategy

**Files:**
- Create: `cli/src/providers/fincept/blockchain.ts`
- Create: `cli/src/agent/strategies/btc-network-health.ts`
- Modify: `cli/src/agent/strategies/types.ts` — add `btcNetworkData`
- Modify: `cli/src/agent/strategies/index.ts` — register strategy
- Modify: `cli/src/agent/scoring.ts` — add to SIGNAL_CATEGORY_MAP

- [ ] **Step 1: Add `btcNetworkData` to StrategyContext**

In `cli/src/agent/strategies/types.ts`:
```typescript
  /** Fincept: Blockchain.com BTC network stats. */
  btcNetworkData?: {
    hashRate: number;
    difficulty: number;
    mempoolSize: number;
    minerRevenueBtc: number;
    marketPriceUsd: number;
    transactionCount: number;
  };
```

- [ ] **Step 2: Write the Blockchain.com wrapper**

Create `cli/src/providers/fincept/blockchain.ts`:
```typescript
/**
 * Blockchain.com BTC network stats via FinceptTerminal Python bridge.
 * No API key required (public API).
 * Cache: 30 minutes.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export interface BtcNetworkStats {
  hashRate: number;
  difficulty: number;
  mempoolSize: number;
  minerRevenueBtc: number;
  marketPriceUsd: number;
  transactionCount: number;
}

export async function getBtcNetworkStats(): Promise<BtcNetworkStats | null> {
  const result = await callFincept<{
    hash_rate?: number;
    difficulty?: number;
    n_tx?: number;
    market_price_usd?: number;
    miners_revenue_btc?: number;
    mempool_size?: number;
  }>("blockchain_com_data.py", ["stats"], 30_000, CACHE_TTL);

  if (!result.ok || !result.data) return null;

  const d = result.data;
  return {
    hashRate: d.hash_rate ?? 0,
    difficulty: d.difficulty ?? 0,
    mempoolSize: d.mempool_size ?? 0,
    minerRevenueBtc: d.miners_revenue_btc ?? 0,
    marketPriceUsd: d.market_price_usd ?? 0,
    transactionCount: d.n_tx ?? 0,
  };
}
```

- [ ] **Step 3: Write the BtcNetworkHealthStrategy**

Create `cli/src/agent/strategies/btc-network-health.ts`:
```typescript
/**
 * BTC Network Health Strategy — uses hashrate, mempool, miner revenue
 * to gauge Bitcoin network confidence.
 *
 * - High hashrate = miners are investing = bullish BTC confidence
 * - Low mempool = network uncongested = smooth operation
 * - High miner revenue = chain is economically active = bullish
 *
 * Only fires for BTC. For alts, returns zero (the correlation guard
 * already propagates BTC regime to alts).
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class BtcNetworkHealthStrategy implements Strategy {
  name = 'btcNetworkHealth';
  description = 'Bitcoin network health (hashrate, mempool, miner revenue)';
  requiredData = ['btcNetworkData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (ctx.tokenId !== 'bitcoin' || !ctx.btcNetworkData) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: ctx.tokenId !== 'bitcoin' ? 'BTC-only strategy' : 'No BTC network data',
      };
    }

    const net = ctx.btcNetworkData;
    let value = 0;
    const details: string[] = [];

    // Hashrate: a high absolute value with growing trend is bullish.
    // We don't have historical comparison here, so just use
    // transaction count as a proxy for network activity.
    if (net.transactionCount > 300_000) {
      value += 0.2;
      details.push(`${(net.transactionCount / 1000).toFixed(0)}k daily txns — active network (+0.20)`);
    } else if (net.transactionCount < 200_000) {
      value -= 0.1;
      details.push(`${(net.transactionCount / 1000).toFixed(0)}k daily txns — low activity (-0.10)`);
    }

    // Miner revenue: healthy revenue = miners are profitable = they keep hashing
    if (net.minerRevenueBtc > 1000) {
      value += 0.15;
      details.push(`Miner revenue ${net.minerRevenueBtc.toFixed(0)} BTC/day — healthy (+0.15)`);
    }

    // Mempool: large mempool = congestion = could be bullish (high demand)
    // but also causes high fees. Treat as neutral-to-mild-bullish.
    if (net.mempoolSize > 100_000) {
      value += 0.1;
      details.push(`Mempool ${(net.mempoolSize / 1000).toFixed(0)}k txns — high demand (+0.10)`);
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: details.length > 0 ? 0.5 : 0.2,
      source: this.description,
      details: details.join('; ') || 'BTC network data inconclusive',
    };
  }
}
```

- [ ] **Step 4: Register in `strategies/index.ts`**

Add import:
```typescript
import { BtcNetworkHealthStrategy } from './btc-network-health.js';
```

Add export:
```typescript
export { BtcNetworkHealthStrategy };
```

Add to `DEFAULT_STRATEGIES`:
```typescript
  new BtcNetworkHealthStrategy(),       // technical — BTC network health
```

- [ ] **Step 5: Add to SIGNAL_CATEGORY_MAP in `scoring.ts`**

```typescript
  btcNetworkHealth: "technical",
```

- [ ] **Step 6: Run typecheck**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/providers/fincept/blockchain.ts cli/src/agent/strategies/btc-network-health.ts cli/src/agent/strategies/types.ts cli/src/agent/strategies/index.ts cli/src/agent/scoring.ts
git commit -m "feat(fincept): add Blockchain.com BTC network health strategy"
```

---

### Task 6: Polymarket wrapper + PredictionMarketStrategy

**Files:**
- Create: `cli/src/providers/fincept/polymarket.ts`
- Create: `cli/src/agent/strategies/prediction-market.ts`
- Modify: `cli/src/agent/strategies/types.ts` — add `predictionData`
- Modify: `cli/src/agent/strategies/index.ts` — register strategy
- Modify: `cli/src/agent/scoring.ts` — add to SIGNAL_CATEGORY_MAP

- [ ] **Step 1: Add `predictionData` to StrategyContext**

In `cli/src/agent/strategies/types.ts`:
```typescript
  /** Fincept: Polymarket/Manifold prediction market probabilities. */
  predictionData?: {
    markets: Array<{
      question: string;
      probability: number;
      volume: number;
    }>;
  };
```

- [ ] **Step 2: Write the Polymarket wrapper**

Create `cli/src/providers/fincept/polymarket.ts`:
```typescript
/**
 * Polymarket/Manifold prediction market data via FinceptTerminal Python bridge.
 * Uses Manifold Markets (geo-unrestricted fallback for Polymarket).
 * No API key required.
 * Cache: 5 minutes.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface PredictionMarket {
  question: string;
  probability: number;
  volume: number;
}

/** Crypto/macro keywords to filter relevant prediction markets. */
const CRYPTO_KEYWORDS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'sec', 'etf',
  'fed', 'rate', 'inflation', 'regulation', 'stablecoin', 'defi',
];

export async function getCryptoPredictions(): Promise<PredictionMarket[]> {
  const result = await callFincept<
    Array<{
      question?: string;
      outcomePrices?: string[];
      probability?: number;
      volume?: string | number;
      active?: boolean;
      closed?: boolean;
    }>
  >("polymarket.py", ["markets", "50"], 30_000, CACHE_TTL);

  if (!result.ok || !result.data || !Array.isArray(result.data)) return [];

  return result.data
    .filter((m) => {
      if (!m.question || m.closed) return false;
      const q = m.question.toLowerCase();
      return CRYPTO_KEYWORDS.some((kw) => q.includes(kw));
    })
    .map((m) => ({
      question: m.question!,
      probability: m.outcomePrices?.[0]
        ? parseFloat(m.outcomePrices[0])
        : (m.probability ?? 0.5),
      volume: typeof m.volume === 'string' ? parseFloat(m.volume) : (m.volume ?? 0),
    }))
    .slice(0, 10); // top 10 crypto-relevant markets
}
```

- [ ] **Step 3: Write the PredictionMarketStrategy**

Create `cli/src/agent/strategies/prediction-market.ts`:
```typescript
/**
 * Prediction Market Strategy — uses Polymarket/Manifold probabilities
 * to detect high-conviction macro catalysts.
 *
 * - Bullish catalysts (ETF approval, rate cuts) at >75% probability: boost long bias
 * - Bearish catalysts (regulation, bans) at >75% probability: boost short bias
 * - No strong signal when probabilities are near 50% (uncertain)
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

const BULLISH_KEYWORDS = ['approve', 'etf', 'cut', 'ease', 'adopt', 'pass', 'bull'];
const BEARISH_KEYWORDS = ['ban', 'restrict', 'crash', 'reject', 'hike', 'bear', 'default'];

export class PredictionMarketStrategy implements Strategy {
  name = 'predictionMarket';
  description = 'Prediction market macro catalysts (Polymarket/Manifold)';
  requiredData = ['predictionData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const markets = ctx.predictionData?.markets;
    if (!markets || markets.length === 0) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: 'No prediction market data',
      };
    }

    let bullishScore = 0;
    let bearishScore = 0;
    const details: string[] = [];

    for (const m of markets) {
      const q = m.question.toLowerCase();
      const prob = m.probability;
      const isHighConviction = prob > 0.75 || prob < 0.25;

      if (!isHighConviction) continue;

      const isBullish = BULLISH_KEYWORDS.some((kw) => q.includes(kw));
      const isBearish = BEARISH_KEYWORDS.some((kw) => q.includes(kw));

      if (isBullish && prob > 0.75) {
        const strength = (prob - 0.75) * 4; // 0 at 75%, 1 at 100%
        bullishScore += strength * 0.15;
        details.push(`${m.question.slice(0, 50)}... (${(prob * 100).toFixed(0)}% YES)`);
      } else if (isBearish && prob > 0.75) {
        const strength = (prob - 0.75) * 4;
        bearishScore += strength * 0.15;
        details.push(`${m.question.slice(0, 50)}... (${(prob * 100).toFixed(0)}% YES)`);
      } else if (isBullish && prob < 0.25) {
        // Bullish event unlikely = mild bearish
        bearishScore += 0.05;
      } else if (isBearish && prob < 0.25) {
        // Bearish event unlikely = mild bullish
        bullishScore += 0.05;
      }
    }

    const value = clamp(bullishScore - bearishScore, -0.5, 0.5);

    return {
      name: this.name,
      value,
      confidence: details.length > 0 ? 0.5 : 0.15,
      source: this.description,
      details: details.join('; ') || 'No high-conviction macro catalysts',
    };
  }
}
```

- [ ] **Step 4: Register in `strategies/index.ts`**

Add import:
```typescript
import { PredictionMarketStrategy } from './prediction-market.js';
```

Add export:
```typescript
export { PredictionMarketStrategy };
```

Add to `DEFAULT_STRATEGIES`:
```typescript
  new PredictionMarketStrategy(),       // event — prediction market catalysts
```

- [ ] **Step 5: Add to SIGNAL_CATEGORY_MAP in `scoring.ts`**

```typescript
  predictionMarket: "event",
```

- [ ] **Step 6: Run typecheck**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/providers/fincept/polymarket.ts cli/src/agent/strategies/prediction-market.ts cli/src/agent/strategies/types.ts cli/src/agent/strategies/index.ts cli/src/agent/scoring.ts
git commit -m "feat(fincept): add Polymarket prediction market strategy"
```

---

### Task 7: CryptoCompare social + SocialVolumeStrategy

**Files:**
- Create: `cli/src/providers/fincept/sentiment.ts`
- Create: `cli/src/agent/strategies/social-volume.ts`
- Modify: `cli/src/agent/strategies/types.ts` — add `socialData`
- Modify: `cli/src/agent/strategies/index.ts` — register strategy
- Modify: `cli/src/agent/scoring.ts` — add to SIGNAL_CATEGORY_MAP

- [ ] **Step 1: Add `socialData` to StrategyContext**

In `cli/src/agent/strategies/types.ts`:
```typescript
  /** Fincept: CryptoCompare social volume + news sentiment. */
  socialData?: {
    socialVolume24h: number;
    socialVolumeSpike: number;
    newsCount24h: number;
    topNewsSentiment: number;
  };
```

- [ ] **Step 2: Write the CryptoCompare social wrapper**

Create `cli/src/providers/fincept/sentiment.ts`:
```typescript
/**
 * CryptoCompare social data + news via FinceptTerminal Python bridge.
 * Optional CRYPTOCOMPARE_API_KEY for higher rate limits.
 * Cache: 10 minutes for news, 30 minutes for social.
 */

import { callFincept } from "./bridge.js";

const NEWS_CACHE_TTL = 10 * 60 * 1000;

/** CoinGecko ID to CryptoCompare symbol mapping. */
const CC_SYMBOL_MAP: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', aave: 'AAVE',
  uniswap: 'UNI', chainlink: 'LINK', ripple: 'XRP', dogecoin: 'DOGE',
  polkadot: 'DOT', avalanche: 'AVAX', arbitrum: 'ARB', hyperliquid: 'HYPE',
  zcash: 'ZEC', fartcoin: 'FARTCOIN', pepe: 'PEPE', cardano: 'ADA',
  ethena: 'ENA', 'worldcoin-wld': 'WLD', bittensor: 'TAO', sui: 'SUI',
  near: 'NEAR', aptos: 'APT',
};

export interface SocialData {
  socialVolume24h: number;
  socialVolumeSpike: number;
  newsCount24h: number;
  topNewsSentiment: number;
}

export async function getSocialData(tokenId: string): Promise<SocialData | null> {
  const symbol = CC_SYMBOL_MAP[tokenId] ?? tokenId.toUpperCase();

  // Fetch top volume (includes social stats) and news in parallel
  const [volumeResult, newsResult] = await Promise.allSettled([
    callFincept<{
      Data?: Array<{
        CoinInfo?: { Name: string };
        RAW?: { USD?: { TOTALVOLUME24H?: number } };
      }>;
    }>("cryptocompare_data.py", ["top_volume", "USD", "50"], 30_000, 30 * 60 * 1000),

    callFincept<{
      Data?: Array<{
        title?: string;
        categories?: string;
        tags?: string;
      }>;
    }>("cryptocompare_data.py", ["news"], 30_000, NEWS_CACHE_TTL),
  ]);

  // Count news mentioning this token
  let newsCount = 0;
  if (newsResult.status === 'fulfilled' && newsResult.value.ok && newsResult.value.data?.Data) {
    const articles = newsResult.value.data.Data;
    for (const a of articles) {
      const text = `${a.title ?? ''} ${a.categories ?? ''} ${a.tags ?? ''}`.toLowerCase();
      if (text.includes(symbol.toLowerCase()) || text.includes(tokenId.toLowerCase())) {
        newsCount++;
      }
    }
  }

  // Social volume from top_volume endpoint
  let volume24h = 0;
  if (volumeResult.status === 'fulfilled' && volumeResult.value.ok && volumeResult.value.data?.Data) {
    const coin = volumeResult.value.data.Data.find(
      (c) => c.CoinInfo?.Name?.toUpperCase() === symbol.toUpperCase(),
    );
    volume24h = coin?.RAW?.USD?.TOTALVOLUME24H ?? 0;
  }

  return {
    socialVolume24h: volume24h,
    socialVolumeSpike: 1.0, // baseline — would need historical comparison
    newsCount24h: newsCount,
    topNewsSentiment: 0, // CryptoCompare news doesn't have sentiment scores
  };
}
```

- [ ] **Step 3: Write the SocialVolumeStrategy**

Create `cli/src/agent/strategies/social-volume.ts`:
```typescript
/**
 * Social Volume Strategy — uses CryptoCompare news mentions as a
 * contrarian indicator.
 *
 * High news count = crowded attention = potential reversal point.
 * Low news count = under-the-radar = opportunity or irrelevance.
 *
 * Contrarian logic (same philosophy as sentimentContrarian):
 * - Many news articles (>5 in 24h): crowd is watching → likely late to the move
 * - Few/no articles: no crowd attention → clean signal environment
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class SocialVolumeStrategy implements Strategy {
  name = 'socialVolume';
  description = 'Social volume contrarian (CryptoCompare news)';
  requiredData = ['socialData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const social = ctx.socialData;
    if (!social) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: 'No social data available',
      };
    }

    let value = 0;
    const details: string[] = [];
    let confidence = 0.3;

    // News count as attention proxy
    const news = social.newsCount24h;
    if (news > 10) {
      // Extreme attention — contrarian signal (crowd is already in)
      value = -0.2;
      details.push(`${news} news articles — extreme attention, contrarian bearish (-0.20)`);
      confidence = 0.5;
    } else if (news > 5) {
      // Elevated attention — mild caution
      value = -0.1;
      details.push(`${news} news articles — elevated attention (-0.10)`);
      confidence = 0.4;
    } else if (news >= 1) {
      // Normal coverage — no signal
      details.push(`${news} news articles — normal coverage`);
    } else {
      // Zero coverage — under the radar (neutral, not bullish by itself)
      details.push('No recent news — under the radar');
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence,
      source: this.description,
      details: details.join('; '),
    };
  }
}
```

- [ ] **Step 4: Register in `strategies/index.ts`**

Add import:
```typescript
import { SocialVolumeStrategy } from './social-volume.js';
```

Add export:
```typescript
export { SocialVolumeStrategy };
```

Add to `DEFAULT_STRATEGIES`:
```typescript
  new SocialVolumeStrategy(),           // sentiment — social volume contrarian
```

- [ ] **Step 5: Add to SIGNAL_CATEGORY_MAP in `scoring.ts`**

```typescript
  socialVolume: "sentiment",
```

- [ ] **Step 6: Run typecheck**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/providers/fincept/sentiment.ts cli/src/agent/strategies/social-volume.ts cli/src/agent/strategies/types.ts cli/src/agent/strategies/index.ts cli/src/agent/scoring.ts
git commit -m "feat(fincept): add CryptoCompare social volume strategy"
```

---

### Task 8: Wire all Fincept providers into `analyzeToken()`

**Files:**
- Create: `cli/src/providers/fincept/index.ts`
- Modify: `cli/src/agent/index.ts` — import Fincept providers and pass data into StrategyContext

- [ ] **Step 1: Create the fincept index re-export**

Create `cli/src/providers/fincept/index.ts`:
```typescript
export { callFincept, clearFinceptCache, FINCEPT_SCRIPTS_DIR } from './bridge.js';
export { getGlassnodeMetrics } from './glassnode.js';
export { getMessariFundamentals } from './messari.js';
export { getBtcNetworkStats } from './blockchain.js';
export { getCryptoPredictions } from './polymarket.js';
export { getSocialData } from './sentiment.js';
```

- [ ] **Step 2: Add Fincept data fetching to `analyzeToken()` in `index.ts`**

In `cli/src/agent/index.ts`, add imports at the top:
```typescript
import {
  getGlassnodeMetrics,
  getMessariFundamentals,
  getBtcNetworkStats,
  getCryptoPredictions,
  getSocialData,
} from '../providers/fincept/index.js';
```

Then, inside `analyzeToken()`, add a new parallel fetch phase AFTER the existing Phase 1 (`hlCandleResult`, etc.) and BEFORE Phase 3 (strategy context). Find the comment `// Phase 3: Parallel strategy data fetching` and add just above it:

```typescript
    // Phase 2b: Fincept data (parallel, all fault-tolerant)
    const [glassnodeResult, messariResult, btcNetResult, predictionResult, socialResult] =
      await Promise.allSettled([
        getGlassnodeMetrics(tokenId),
        getMessariFundamentals(tokenId),
        tokenId === 'bitcoin' ? getBtcNetworkStats() : Promise.resolve(null),
        getCryptoPredictions(), // global, not per-token
        getSocialData(tokenId),
      ]);

    const glassnodeData = glassnodeResult.status === 'fulfilled' ? glassnodeResult.value : undefined;
    const messariFundamentals = messariResult.status === 'fulfilled' ? messariResult.value : undefined;
    const btcNetworkData = btcNetResult.status === 'fulfilled' ? btcNetResult.value : undefined;
    const predictionData = predictionResult.status === 'fulfilled' && predictionResult.value
      ? { markets: predictionResult.value }
      : undefined;
    const socialData = socialResult.status === 'fulfilled' ? socialResult.value : undefined;

    // Feed Messari fundamentals into scoreFundamental if available
    if (messariFundamentals && messariFundamentals.marketCap > 0) {
      const mcapToTvl = tvl && tvl > 0 ? messariFundamentals.marketCap / tvl : undefined;
      // Replace the empty scoreFundamental call with real data
      const existingFundIdx = signals.findIndex((s) => s.name === 'fundamental');
      const fundSignal = scoreFundamental({
        mcapToTvl,
        revenueGrowth: messariFundamentals.revenueGrowth7d,
      });
      if (existingFundIdx >= 0) {
        signals[existingFundIdx] = fundSignal;
      } else {
        signals.push(fundSignal);
      }
    }

    // Feed Glassnode into scoreOnChain if available
    if (glassnodeData && !isNaN(glassnodeData.activeAddresses)) {
      signals.push(scoreOnChain({
        activeAddressesGrowth: glassnodeData.activeAddressesGrowth,
        whaleAccumulating: glassnodeData.sopr < 1.0, // SOPR < 1 = accumulation phase
      }));
    }
```

Then, in the `stratCtx` object construction (the `const stratCtx: StrategyContext = { ... }` block), add the new fields:

```typescript
        glassnodeData: glassnodeData ?? undefined,
        messariFundamentals: messariFundamentals ?? undefined,
        btcNetworkData: btcNetworkData ?? undefined,
        predictionData,
        socialData: socialData ?? undefined,
```

- [ ] **Step 3: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add cli/src/providers/fincept/index.ts cli/src/agent/index.ts
git commit -m "feat(fincept): wire all Fincept providers into analyzeToken pipeline"
```

---

### Task 9: Update scoring weights for new data sources

**Files:**
- Modify: `cli/src/agent/scoring.ts` — update DEFAULT_WEIGHTS and WEIGHT_PROFILES

- [ ] **Step 1: Update DEFAULT_WEIGHTS**

In `cli/src/agent/scoring.ts`, replace the `DEFAULT_WEIGHTS` constant:

```typescript
// Post-Fincept weights. All 6 categories now have live data sources:
// - technical: HL candles + TradingView + BTC network health
// - onchain: HL flow + Glassnode (NVT, SOPR, active addresses)
// - sentiment: CryptoCompare social volume + sentimentContrarian (F&G)
// - fundamental: Messari + DefiLlama TVL
// - event: Polymarket predictions
// - smartMoney: Nansen x402 (when funded)
export const DEFAULT_WEIGHTS: ScoringWeights = {
  smartMoney: 0.05,
  technical: 0.25,
  sentiment: 0.20,
  onchain: 0.25,
  fundamental: 0.15,
  event: 0.10,
};
```

- [ ] **Step 2: Update WEIGHT_PROFILES**

Update the `majors` and `altcoin` profiles:

```typescript
  // Majors: Glassnode fires on BTC/ETH, Polymarket fires globally.
  // Sentiment stays high (social + contrarian). Fundamental from Messari.
  majors: { smartMoney: 0.05, technical: 0.20, sentiment: 0.25, onchain: 0.25, fundamental: 0.15, event: 0.10 },
  // Altcoins: DefiLlama TVL + Messari data more relevant. Glassnode less relevant.
  altcoin: { smartMoney: 0.05, technical: 0.20, sentiment: 0.20, onchain: 0.15, fundamental: 0.25, event: 0.15 },
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd cli && npm run typecheck && npx vitest run src/agent/scoring.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/agent/scoring.ts
git commit -m "feat(fincept): rebalance scoring weights for all-active categories"
```

---

### Task 10: Run full test suite + integration smoke test

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
cd cli && npm run typecheck
```

Expected: PASS

- [ ] **Step 2: Run full test suite**

```bash
cd cli && npx vitest run
```

Expected: Only pre-existing `network.test.ts` failures (4). All new + existing tests pass.

- [ ] **Step 3: Run a single agent cycle to verify Fincept data flows**

```bash
cd cli && npm run build && sherwood agent start --auto --cycle 1 2>&1 | head -100
```

Check the output for:
- Glassnode data fetched (if `GLASSNODE_API_KEY` is set)
- Messari data fetched
- Blockchain.com stats fetched (for BTC)
- Polymarket predictions fetched
- CryptoCompare social data fetched
- No Python subprocess errors

- [ ] **Step 4: Check signal-history.jsonl for new signals**

```bash
tail -1 ~/.sherwood/agent/signal-history.jsonl | python3 -m json.tool | grep -E "glassnodeOnChain|btcNetworkHealth|predictionMarket|socialVolume"
```

Expected: New strategy names appear in the signal history with non-zero values.

- [ ] **Step 5: Commit any fixes from smoke testing**

- [ ] **Step 6: Bump CLI version**

In `cli/package.json`, bump the minor version (e.g., `0.46.0` → `0.47.0`).

```bash
git add cli/package.json
git commit -m "chore: bump CLI version to 0.47.0 for Fincept integration"
```

---

## Phase 2: Replace In-House Providers (Tasks 11-14)

> **Note:** Phase 2 tasks swap existing providers for Fincept equivalents. Each task can be done independently. Run both old and new in parallel for 1 cycle to verify output parity before fully cutting over.

### Task 11: Replace CoinGecko OHLCV with CryptoCompare

**Files:**
- Create: `cli/src/providers/fincept/cryptocompare.ts`
- Modify: `cli/src/agent/index.ts` — swap CoinGecko fallback candle source

- [ ] **Step 1: Write the CryptoCompare candle wrapper**

Create `cli/src/providers/fincept/cryptocompare.ts`:
```typescript
/**
 * CryptoCompare OHLCV via FinceptTerminal Python bridge.
 * Replaces CoinGecko as the fallback candle source (Hyperliquid remains primary).
 * Optional CRYPTOCOMPARE_API_KEY for higher rate limits.
 * Cache: 2 hours for OHLCV.
 */

import { callFincept } from "./bridge.js";
import type { Candle } from "../../agent/technical.js";

const OHLCV_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/** CoinGecko ID to CryptoCompare symbol. */
const CC_SYMBOL: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', aave: 'AAVE',
  uniswap: 'UNI', chainlink: 'LINK', ripple: 'XRP', dogecoin: 'DOGE',
  polkadot: 'DOT', avalanche: 'AVAX', arbitrum: 'ARB', hyperliquid: 'HYPE',
  zcash: 'ZEC', fartcoin: 'FARTCOIN', pepe: 'PEPE', cardano: 'ADA',
  ethena: 'ENA', 'worldcoin-wld': 'WLD', bittensor: 'TAO', sui: 'SUI',
  near: 'NEAR', aptos: 'APT', 'pudgy-penguins': 'PENGU', blur: 'BLUR',
  'fetch-ai': 'FET',
};

/**
 * Fetch 4h-equivalent candles from CryptoCompare.
 * CryptoCompare offers hourly candles (histohour) — we fetch 720 hours (30 days)
 * and can optionally downsample to 4h if needed.
 */
export async function getCryptoCompareCandles(
  tokenId: string,
  limit: number = 180,
): Promise<Candle[] | null> {
  const symbol = CC_SYMBOL[tokenId] ?? tokenId.toUpperCase();

  const result = await callFincept<{
    Data?: {
      Data?: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volumefrom: number;
        volumeto: number;
      }>;
    };
  }>("cryptocompare_data.py", ["hourly", symbol, "USD", String(limit * 4)], 30_000, OHLCV_CACHE_TTL);

  if (!result.ok || !result.data?.Data?.Data) return null;

  const raw = result.data.Data.Data;
  if (raw.length < 10) return null;

  // Downsample hourly to 4h candles (aggregate 4 bars into 1)
  const candles: Candle[] = [];
  for (let i = 0; i + 3 < raw.length; i += 4) {
    const chunk = raw.slice(i, i + 4);
    candles.push({
      timestamp: chunk[0]!.time * 1000,
      open: chunk[0]!.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1]!.close,
      volume: chunk.reduce((sum, c) => sum + c.volumeto, 0),
    });
  }

  return candles;
}
```

- [ ] **Step 2: Swap CoinGecko fallback in `analyzeToken()`**

In `cli/src/agent/index.ts`, replace the CoinGecko OHLC fallback (the `1b. FALLBACK` block in Phase 1 data fetching) with:

```typescript
      // 1b. FALLBACK: CryptoCompare candles via Fincept (replaces CoinGecko OHLC)
      getCryptoCompareCandles(tokenId, 180),
```

Add the import at the top:
```typescript
import { getCryptoCompareCandles } from '../providers/fincept/cryptocompare.js';
```

- [ ] **Step 3: Run typecheck + tests**

```bash
cd cli && npm run typecheck && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/providers/fincept/cryptocompare.ts cli/src/agent/index.ts
git commit -m "feat(fincept): replace CoinGecko OHLCV fallback with CryptoCompare"
```

---

### Task 12: Replace DefiLlama + DexScreener + Funding Rate

**Files:**
- Create: `cli/src/providers/fincept/defillama.ts`
- Create: `cli/src/providers/fincept/dexscreener.ts`
- Create: `cli/src/providers/fincept/funding-rate.ts`
- Modify: `cli/src/agent/index.ts` — swap providers
- Modify: `cli/src/providers/fincept/index.ts` — re-export new modules

- [ ] **Step 1: Write the DefiLlama wrapper**

Create `cli/src/providers/fincept/defillama.ts`:
```typescript
/**
 * DefiLlama data via FinceptTerminal Python bridge.
 * Replaces in-house defillama.ts with richer coverage (yields, stablecoins, bridges, fees).
 * No API key required.
 */

import { callFincept } from "./bridge.js";

const TVL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getProtocolTvl(tokenId: string): Promise<number | null> {
  const result = await callFincept<{
    tvl?: number;
    name?: string;
  }>("defillama_data.py", ["protocol", tokenId], 30_000, TVL_CACHE_TTL);

  if (!result.ok || !result.data) return null;
  return typeof result.data.tvl === 'number' ? result.data.tvl : null;
}

export async function getYieldPools(limit: number = 20): Promise<Array<{
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
}> | null> {
  const result = await callFincept<{
    data?: Array<Record<string, unknown>>;
  }>("defillama_data.py", ["yields"], 30_000, 60 * 60 * 1000);

  if (!result.ok || !result.data?.data) return null;

  return result.data.data.slice(0, limit).map((p) => ({
    pool: String(p.pool ?? ''),
    chain: String(p.chain ?? ''),
    project: String(p.project ?? ''),
    symbol: String(p.symbol ?? ''),
    tvlUsd: Number(p.tvlUsd ?? 0),
    apy: Number(p.apy ?? 0),
  }));
}
```

- [ ] **Step 2: Write the DexScreener wrapper**

Create `cli/src/providers/fincept/dexscreener.ts`:
```typescript
/**
 * DexScreener data via FinceptTerminal Python bridge.
 * Replaces in-house dexscreener.ts with 80+ chain support + token boosts.
 * No API key required.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface FinceptDexPair {
  chainId: string;
  baseToken: { symbol: string; name: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number };
  liquidity: { usd: number };
  priceChange: { h24: number; h6: number; h1: number };
  txns: { h24: { buys: number; sells: number } };
}

export async function searchDexPairs(query: string): Promise<FinceptDexPair[]> {
  const result = await callFincept<{
    pairs?: FinceptDexPair[];
  }>("dexscreener_data.py", ["search", query], 30_000, CACHE_TTL);

  if (!result.ok || !result.data?.pairs) return [];
  return result.data.pairs;
}

export async function getTokenBoosts(): Promise<Array<{
  tokenAddress: string;
  chainId: string;
  amount: number;
}>> {
  const result = await callFincept<
    Array<{ tokenAddress?: string; chainId?: string; amount?: number }>
  >("dexscreener_data.py", ["boosted"], 30_000, CACHE_TTL);

  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data.map((b) => ({
    tokenAddress: String(b.tokenAddress ?? ''),
    chainId: String(b.chainId ?? ''),
    amount: Number(b.amount ?? 0),
  }));
}
```

- [ ] **Step 3: Write the CCXT funding rate wrapper**

Create `cli/src/providers/fincept/funding-rate.ts`:
```typescript
/**
 * Multi-exchange funding rates via FinceptTerminal CCXT bridge.
 * Replaces single-exchange Binance provider with aggregate across
 * Binance, Hyperliquid, Bybit, OKX.
 * No API key required (public data).
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const EXCHANGES = ['binance', 'bybit', 'okx'];

/** CoinGecko ID to CCXT perp symbol format. */
const PERP_SYMBOL: Record<string, string> = {
  bitcoin: 'BTC/USDT:USDT', ethereum: 'ETH/USDT:USDT', solana: 'SOL/USDT:USDT',
  aave: 'AAVE/USDT:USDT', chainlink: 'LINK/USDT:USDT', ripple: 'XRP/USDT:USDT',
  dogecoin: 'DOGE/USDT:USDT', polkadot: 'DOT/USDT:USDT', avalanche: 'AVAX/USDT:USDT',
  arbitrum: 'ARB/USDT:USDT', sui: 'SUI/USDT:USDT', near: 'NEAR/USDT:USDT',
  aptos: 'APT/USDT:USDT', pepe: 'PEPE/USDT:USDT',
};

export interface AggregateFunding {
  meanRate: number;
  maxRate: number;
  minRate: number;
  exchanges: string[];
  consensus: 'long-crowded' | 'short-crowded' | 'neutral';
}

export async function getAggregateFunding(tokenId: string): Promise<AggregateFunding | null> {
  const symbol = PERP_SYMBOL[tokenId];
  if (!symbol) return null;

  const results = await Promise.allSettled(
    EXCHANGES.map((ex) =>
      callFincept<{
        fundingRate?: number;
        markPrice?: number;
      }>("fetch_funding_rate.py", [ex, symbol], 15_000, CACHE_TTL),
    ),
  );

  const rates: number[] = [];
  const activeExchanges: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'fulfilled' && r.value.ok && r.value.data?.fundingRate != null) {
      rates.push(r.value.data.fundingRate);
      activeExchanges.push(EXCHANGES[i]!);
    }
  }

  if (rates.length === 0) return null;

  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const max = Math.max(...rates);
  const min = Math.min(...rates);

  let consensus: AggregateFunding['consensus'] = 'neutral';
  // Funding > 0.01% per 8h = longs paying shorts = long crowded
  if (mean > 0.0001) consensus = 'long-crowded';
  // Funding < -0.01% per 8h = shorts paying longs = short crowded
  else if (mean < -0.0001) consensus = 'short-crowded';

  return { meanRate: mean, maxRate: max, minRate: min, exchanges: activeExchanges, consensus };
}
```

- [ ] **Step 4: Update fincept/index.ts with new re-exports**

Add to `cli/src/providers/fincept/index.ts`:
```typescript
export { getCryptoCompareCandles } from './cryptocompare.js';
export { getProtocolTvl, getYieldPools } from './defillama.js';
export { searchDexPairs, getTokenBoosts } from './dexscreener.js';
export { getAggregateFunding } from './funding-rate.js';
```

- [ ] **Step 5: Run typecheck**

```bash
cd cli && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/providers/fincept/defillama.ts cli/src/providers/fincept/dexscreener.ts cli/src/providers/fincept/funding-rate.ts cli/src/providers/fincept/index.ts
git commit -m "feat(fincept): add DefiLlama, DexScreener, CCXT funding rate wrappers"
```

---

### Task 13: Final integration — swap remaining in-house providers in `analyzeToken()`

**Files:**
- Modify: `cli/src/agent/index.ts` — replace remaining in-house provider calls

- [ ] **Step 1: Replace DefiLlama TVL call**

In `analyzeToken()`, replace the in-house DefiLlama TVL call with:
```typescript
import { getProtocolTvl as finceptGetTvl } from '../providers/fincept/index.js';
```

Replace the `this.defillama.getProtocolTvl(tokenId)` call in Phase 1 with `finceptGetTvl(tokenId)`.

- [ ] **Step 2: Add aggregate funding to strategy context**

Import:
```typescript
import { getAggregateFunding } from '../providers/fincept/index.js';
```

Add to the Phase 2b Fincept parallel fetch:
```typescript
        getAggregateFunding(tokenId),
```

Add the result to the StrategyContext:
```typescript
        aggregateFunding: aggFundingResult.status === 'fulfilled' ? aggFundingResult.value ?? undefined : undefined,
```

Also add `aggregateFunding` to StrategyContext type in `types.ts`:
```typescript
  /** Fincept: Multi-exchange aggregate funding rates. */
  aggregateFunding?: {
    meanRate: number;
    maxRate: number;
    minRate: number;
    exchanges: string[];
    consensus: 'long-crowded' | 'short-crowded' | 'neutral';
  };
```

- [ ] **Step 3: Run typecheck + full test suite**

```bash
cd cli && npm run typecheck && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/agent/index.ts cli/src/agent/strategies/types.ts
git commit -m "feat(fincept): swap remaining in-house providers for Fincept equivalents"
```

---

### Task 14: Smoke test + version bump

- [ ] **Step 1: Build and run one cycle**

```bash
cd cli && npm run build && sherwood agent start --auto --cycle 1 2>&1 | tee /tmp/fincept-smoke.log
```

- [ ] **Step 2: Verify all Fincept sources are firing**

```bash
tail -5 ~/.sherwood/agent/signal-history.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    d = json.loads(line)
    signals = [s['name'] for s in d.get('signals', [])]
    print(f\"{d['tokenSymbol']}: {', '.join(signals)}\")
"
```

Expected: Should see `glassnodeOnChain`, `btcNetworkHealth`, `predictionMarket`, `socialVolume` among the signals.

- [ ] **Step 3: Bump version**

In `cli/package.json`, bump version to `0.47.0`.

- [ ] **Step 4: Commit**

```bash
git add cli/package.json
git commit -m "chore: bump CLI to 0.47.0 — FinceptTerminal data integration"
```

---

## Dependency Graph

```
Task 1 (vendor scripts)
  └─> Task 2 (bridge.ts)
        ├─> Task 3 (Glassnode + strategy)
        ├─> Task 4 (Messari)
        ├─> Task 5 (Blockchain.com + strategy)
        ├─> Task 6 (Polymarket + strategy)
        └─> Task 7 (CryptoCompare social + strategy)
              └─> Task 8 (wire into analyzeToken)
                    └─> Task 9 (rebalance weights)
                          └─> Task 10 (full test + smoke)
                                ├─> Task 11 (replace CoinGecko)
                                ├─> Task 12 (replace DeFiLlama/DexScreener/FundingRate)
                                └─> Task 13 (final swap)
                                      └─> Task 14 (smoke test + version bump)
```

Tasks 3-7 are independent of each other and can be parallelized.
Tasks 11-13 are independent of each other and can be parallelized.
