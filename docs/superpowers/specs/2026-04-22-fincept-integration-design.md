# FinceptTerminal Integration — Design Spec

**Date:** 2026-04-22  
**Branch:** `feat/fincept-data-bridge`  
**Approach:** Python Bridge (subprocess JSON, matching TradingView MCP pattern)

## Goal

Replace Sherwood's in-house data providers with FinceptTerminal's Python data fetchers and add new data sources that fill gaps in the signal stack. All modules are called via the project's `execFileNoThrow` utility (safe subprocess execution, no shell injection). FinceptTerminal scripts output JSON to stdout — designed for exactly this usage pattern.

## Module Map

### Replace In-House

| Sherwood Provider | Replace With | Why |
|---|---|---|
| `coingecko.ts` (OHLCV, prices) | **CryptoCompare** `cryptocompare_data.py` | 5700+ coins, hourly/daily OHLCV, no 429 rate-limit hell. Free tier 100 calls/hr vs CG's 30/min with aggressive circuit breakers |
| `defillama.ts` (TVL only) | **DefiLlama** `defillama_data.py` | Their version covers TVL + yields + stablecoins + bridges + fees. Ours only does TVL and protocol list |
| `dexscreener.ts` (basic pairs) | **DexScreener** `dexscreener_data.py` | 80+ chains, token boosts, profile data. Ours covers basic pair search only |
| `feargreed.ts` + `sentiment.ts` | **CryptoCompare social** + **Messari news** | Per-token social volume + news sentiment replaces single global F&G number |
| `funding-rate.ts` (Binance only) | **CCXT funding rates** `fetch_funding_rate.py` | 200+ exchanges vs our single Binance endpoint. Native HyperLiquid support via CCXT |
| `token-unlocks.ts` (FDV estimate) | **Messari** `messari_data.py` metrics | Real token profiles and supply data vs our crude FDV-based estimation |
| `twitter.ts` (disabled) | **CryptoCompare social** | Twitter API requires paid access + OpenAI calls. CryptoCompare social data is free |

### New Sources (fill signal gaps)

| New Source | Module | Fills Gap |
|---|---|---|
| **Glassnode** `glassnode_data.py` | On-chain: active addresses, NVT, SOPR, exchange flows | `scoreOnChain()` — currently 35% weight, ~0% real data |
| **Messari** `messari_data.py` | Fundamentals: supply metrics, revenue, market data, profiles | `scoreFundamental()` — currently 0% weight because no data |
| **Blockchain.com** `blockchain_com_data.py` | BTC network: hashrate, difficulty, mempool, miner revenue | Regime detection enrichment for BTC-specific signals |
| **Polymarket** `polymarket.py` | Prediction market probabilities for macro events | New signal: forward-looking macro regime context |

### Keep As-Is

| Provider | Reason |
|---|---|
| `hyperliquid.ts` | Native exchange data for the venue we trade on. Orderbook, OI, mark/oracle prices are execution-critical |
| `tradingview.ts` | MCP subprocess already working. TradingView indicators not available from FinceptTerminal |

## Architecture

### Directory Structure

```
cli/
  src/
    providers/
      fincept/
        bridge.ts          # Generic Python subprocess runner (uses execFileNoThrow)
        cryptocompare.ts   # CryptoCompare wrapper (replaces coingecko.ts)
        defillama.ts       # DefiLlama wrapper (replaces defillama.ts)
        dexscreener.ts     # DexScreener wrapper (replaces dexscreener.ts)
        glassnode.ts       # Glassnode wrapper (NEW — on-chain metrics)
        messari.ts         # Messari wrapper (NEW — fundamentals)
        blockchain.ts      # Blockchain.com wrapper (NEW — BTC network)
        polymarket.ts      # Polymarket wrapper (NEW — prediction markets)
        funding-rate.ts    # CCXT funding rates (replaces funding-rate.ts)
        sentiment.ts       # CryptoCompare social + Messari news (replaces sentiment.ts)
      data/
        hyperliquid.ts     # KEEP — native exchange
        tradingview.ts     # KEEP — MCP subprocess
        index.ts           # UPDATE — re-export from fincept/
  scripts/
    fincept/               # Vendored Python scripts from FinceptTerminal
      cryptocompare_data.py
      defillama_data.py
      dexscreener_data.py
      glassnode_data.py
      messari_data.py
      blockchain_com_data.py
      polymarket.py
      fetch_funding_rate.py
      requirements.txt     # pinned deps
```

### Python Bridge (`bridge.ts`)

Central subprocess runner using the project's `execFileNoThrow` utility (prevents shell injection, handles errors cleanly).

```typescript
interface BridgeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

async function callFincept<T>(
  script: string,      // e.g. "glassnode_data.py"
  args: string[],      // e.g. ["active_addresses", "BTC", "30d"]
  timeoutMs?: number,  // default 30_000 (matches FinceptTerminal's 30s)
): Promise<BridgeResult<T>>
```

Implementation details:
- Uses `execFileNoThrow('python3', [scriptPath, ...args])` — no shell, no injection
- Parses stdout as JSON, stderr as error context
- Returns `{ ok, data, error, latencyMs }`
- Env vars (`GLASSNODE_API_KEY`, `MESSARI_API_KEY`, `CRYPTOCOMPARE_API_KEY`) passed through from `process.env`
- In-memory cache with configurable TTL per module

### Caching Strategy

| Module | Cache TTL | Rationale |
|---|---|---|
| CryptoCompare OHLCV | 2 hours | Candle data does not change retroactively |
| CryptoCompare price | 60 seconds | Near-realtime price needed |
| DefiLlama TVL | 30 minutes | TVL updates every ~15 min |
| DefiLlama yields | 1 hour | Pool APYs change slowly |
| DexScreener pairs | 5 minutes | DEX activity is fast-moving |
| Glassnode metrics | 1 hour | On-chain data updates daily |
| Messari fundamentals | 1 hour | Supply/revenue data updates slowly |
| Messari news | 10 minutes | News moves markets quickly |
| Blockchain.com stats | 30 minutes | BTC network updates per block (~10min) |
| Polymarket | 5 minutes | Prediction probabilities move with events |
| CCXT funding rates | 5 minutes | Funding resets every 8h, but trends matter |

### Signal Stack Wiring

How each Fincept module feeds into the scoring engine:

```
CryptoCompare OHLCV ──> technical.ts (candles) ──> scoreTechnical()
                                                ──> BreakoutOnChainStrategy
                                                ──> MultiTimeframeStrategy
                                                ──> CrossSectionalMomentumStrategy

CryptoCompare social ──> NEW: SocialVolumeStrategy ──> sentiment category
Messari news         ──> merged into sentiment category

Glassnode            ──> scoreOnChain() fields:
                         activeAddressesGrowth  <-- active_count delta
                         whaleAccumulating      <-- NVT/SOPR trends

Messari              ──> scoreFundamental() fields:
                         revenueGrowth  <-- blockchain_stats_24h revenue delta
                         mcapToTvl      <-- metrics.market_data.market_cap / DefiLlama TVL

DefiLlama            ──> scoreFundamental() fields:
                         tvlGrowthWeekly <-- protocol TVL 7d delta (existing)
                         + NEW: yield data for DeFi tokens
                         + NEW: stablecoin flows (minting = buying pressure)

Blockchain.com       ──> regime.ts enrichment:
                         hashrate trends --> miner confidence
                         mempool size    --> network congestion signal

Polymarket           ──> NEW signal category:
                         prediction probabilities for macro events
                         (rate cuts, ETF decisions, regulatory)

DexScreener          ──> DexFlowStrategy (existing, enhanced data)
                         + token boost detection (new: early meme/momentum detection)

CCXT funding rates   ──> FundingRateStrategy (existing, multi-exchange)
                         aggregate funding across Binance+HL+Bybit+OKX
```

### StrategyContext Additions

```typescript
interface StrategyContext {
  // ... existing fields kept ...

  // Fincept: Glassnode on-chain
  glassnodeData?: {
    activeAddresses: number;
    activeAddressesGrowth: number;  // 7d delta
    nvtRatio: number;
    sopr: number;
    transactionCount: number;
  };

  // Fincept: Messari fundamentals
  messariFundamentals?: {
    marketCap: number;
    supply: { circulating: number; max: number; percentCirculating: number };
    revenueUsd24h: number;
    revenueGrowth7d: number;
    developerActivity: number;
  };

  // Fincept: Blockchain.com BTC network
  btcNetworkData?: {
    hashRate: number;
    hashRateGrowth7d: number;
    difficulty: number;
    mempoolSize: number;
    minerRevenueBtc: number;
    avgBlockSize: number;
  };

  // Fincept: Polymarket predictions
  predictionData?: {
    markets: Array<{
      question: string;
      probability: number;  // 0-1
      volume: number;
      category: string;     // 'crypto' | 'macro' | 'regulatory'
    }>;
  };

  // Fincept: CryptoCompare social
  socialData?: {
    socialVolume24h: number;
    socialVolumeSpike: number;  // ratio vs 7d avg
    newsCount24h: number;
    topNewsSentiment: number;   // -1 to +1
  };

  // Fincept: Enhanced DEX data
  dexBoostData?: {
    isBoosted: boolean;
    boostCount: number;
  };

  // Fincept: Multi-exchange funding
  aggregateFunding?: {
    meanRate: number;       // average across exchanges
    maxRate: number;
    minRate: number;
    exchanges: string[];
    consensus: 'long-crowded' | 'short-crowded' | 'neutral';
  };
}
```

### New Strategies

| Strategy | Category | Signal Logic |
|---|---|---|
| `GlassnodeOnChainStrategy` | onchain | NVT < 30 = bullish (undervalued network), SOPR < 1 = capitulation (contrarian buy), active addresses growing = bullish |
| `SocialVolumeStrategy` | sentiment | Social volume spike > 2x average = contrarian signal (crowd is often wrong at extremes). Replaces F&G-only sentiment |
| `PredictionMarketStrategy` | event | High-probability macro catalysts (>75% on Polymarket) weighted into regime. E.g. "ETF approval 90% likely" = bullish regime boost |
| `BtcNetworkHealthStrategy` | technical | Hashrate growth + low mempool = healthy network = bullish BTC bias. Feeds into correlation guard for alts |

### Scoring Weight Rebalancing

With real data flowing to previously-dead categories:

```typescript
// BEFORE (Apr 2026 — dead categories zeroed)
export const DEFAULT_WEIGHTS: ScoringWeights = {
  smartMoney: 0.10,
  technical: 0.35,
  sentiment: 0.20,
  onchain: 0.35,
  fundamental: 0.00,  // no data
  event: 0.00,         // no data
};

// AFTER (Fincept integration — all categories fed)
export const DEFAULT_WEIGHTS: ScoringWeights = {
  smartMoney: 0.05,    // reduced — still x402 dependent
  technical: 0.25,     // still core, but shared with more sources
  sentiment: 0.20,     // now fed by CryptoCompare social (per-token)
  onchain: 0.25,       // now fed by Glassnode (real data)
  fundamental: 0.15,   // now fed by Messari + DefiLlama
  event: 0.10,         // now fed by Polymarket + Messari news
};
```

## Migration Strategy

Phased rollout — do not break production:

**Phase 1: Bridge + new sources (additive, no breakage)**
1. Create `bridge.ts` and vendor Python scripts
2. Install Python deps (`pip install -r requirements.txt`)
3. Wire Glassnode into `scoreOnChain()`
4. Wire Messari into `scoreFundamental()`
5. Wire Polymarket as new `PredictionMarketStrategy`
6. Wire Blockchain.com into `regime.ts` enrichment
7. Re-enable fundamental/event weights
8. Run 1 cycle, verify signal-history.jsonl shows new categories firing

**Phase 2: Replace in-house providers (swap + validate)**
1. Swap CoinGecko OHLCV to CryptoCompare for candles
2. Swap DefiLlama (ours) to DefiLlama (theirs)
3. Swap DexScreener (ours) to DexScreener (theirs)
4. Swap Binance funding to CCXT multi-exchange funding
5. Swap F&G sentiment to CryptoCompare social
6. Remove `token-unlocks.ts` (replaced by Messari)
7. Run both old and new in parallel for 1 cycle, compare output

**Phase 3: Cleanup + optimize**
1. Remove deprecated provider files from `providers/data/`
2. Update all imports across codebase
3. Run `sherwood agent autoresearch` to re-optimize weights with new data
4. Bump CLI version

## Environment Variables Required

```bash
# Required for full integration
GLASSNODE_API_KEY=xxx      # On-chain metrics (free tier available)

# Optional (enhance data quality, higher rate limits)
MESSARI_API_KEY=xxx        # Messari fundamentals
CRYPTOCOMPARE_API_KEY=xxx  # CryptoCompare OHLCV + social
```

## Python Dependencies

```
# cli/scripts/fincept/requirements.txt
requests==2.32.5
ccxt>=4.5.44
numpy>=2.2.3
```

Install: `pip install -r cli/scripts/fincept/requirements.txt`

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Python not installed | Check at startup, warn if missing, fall back to in-house providers |
| API key missing | Graceful degradation — skip module, log warning, signal gets confidence=0 |
| Subprocess timeout | 30s timeout with error return, signal gets confidence=0 |
| Fincept script changes | Vendor scripts (copy into repo, not git submodule) so we control versions |
| Rate limit hit | FinceptTerminal has retry logic built in (3 retries, session pooling) |
| Data format mismatch | TypeScript wrapper validates JSON structure before passing to scoring |
| Phase 2 regression | Run old+new in parallel for 1 cycle before cutting over |

## Success Criteria

1. `scoreOnChain()` receives real Glassnode data — not zeros
2. `scoreFundamental()` receives real Messari data — not zeros
3. CryptoCompare candles match Hyperliquid candles within 1% for same timeframe
4. Signal-history.jsonl shows all 6 categories firing with non-zero values
5. `sherwood agent autoresearch` shows improved Sharpe after weight rebalancing
6. No regression in existing long-side WR (currently 67%)
