# Grid Strategy Backtester — Design

**Status:** Design approved 2026-05-01. Implemented; see addendum at the bottom for post-build deltas.
**Branch (target):** `feat/grid-backtest`
**Scope:** Replay historical 1-minute price data through the existing `GridManager` and report PnL, fills, drawdown for any user-specified window.

## 1. Motivation

The grid strategy (`cli/src/grid/`) currently has only two run modes:

- **Live simulation** (`sherwood grid start`) — runs on a 60s cycle against live HL prices, no real orders. Useful for soak-testing but slow and tied to whatever the market is doing right now.
- **Live execution** (`sherwood grid start --live`) — places real orders on HyperCore.

Neither mode lets you ask: *"how would this config have performed during the March 2026 chop?"* or *"what does PnL look like over 30 days at leverage=4 vs 5?"*

A backtester that replays historical 1-minute bars through the same `GridManager` answers those questions and unlocks parameter sweeps as a follow-up.

## 2. Goals & Non-Goals

### Goals
- Replay 1-minute Hyperliquid bars through `GridManager` over an arbitrary `[--from, --to]` window.
- Use HLC (high-low-close) fill detection — a buy level fires when `bar.low ≤ level.price`, matching how a real exchange fills a resting limit.
- Cache fetched bars to disk so re-runs and parameter sweeps are fast.
- Output a structured JSON result file plus a terminal summary.
- Zero behavioral change to live mode. Live `GridLoop` and `HyperliquidProvider` are untouched.

### Non-Goals (v1)
- Hedge simulation (`GridHedgeManager` is not invoked during backtest).
- Parameter sweeps / multi-config runs.
- Plotting / charts / web UI.
- Slippage, partial fills, or funding-rate cost modeling.
- Backtesting tokens not listed on Hyperliquid.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  sherwood grid backtest --from <iso> --to <iso> [opts]         │
│         │                                                      │
│         ▼                                                      │
│  cli/src/commands/grid.ts  ─ new `backtest` subcommand         │
│         │                                                      │
│         ▼                                                      │
│  cli/src/grid/backtest.ts  ─ GridBacktester (new)              │
│    ├── HistoricalDataLoader  (fetch + cache 1m + 4h bars)      │
│    ├── ATRSeries             (pre-computed ATR per token)      │
│    ├── BacktestPortfolio     (in-memory; no disk writes)       │
│    ├── replay loop:                                            │
│    │     for each 1-min bar t:                                 │
│    │       prices = barCloses(t)                               │
│    │       manager.tick(prices)        ◄── HLC fill detection  │
│    │       capture equity-curve snapshot                       │
│    └── writes ~/.sherwood/grid/backtests/{runId}.json          │
│         │                                                      │
│         ▼                                                      │
│  cli/src/grid/manager.ts  ─ minimal change:                    │
│    constructor(config, candleFetcher?, fillDetector?,          │
│                closeFillDetector?, portfolio?)                 │
│      All optional → live behavior unchanged                    │
└────────────────────────────────────────────────────────────────┘
```

### Files touched

| File | Change |
|---|---|
| `cli/src/grid/manager.ts` | Add 4 optional constructor args (candleFetcher, fillDetector, closeFillDetector, portfolio). Default behavior preserved. |
| `cli/src/grid/backtest.ts` | **New.** ~250 lines. |
| `cli/src/commands/grid.ts` | Add `backtest` subcommand. ~40 lines. |

### Files NOT touched

`loop.ts`, `hedge.ts`, `executor.ts`, `onchain-executor.ts`, `portfolio.ts`, `config.ts`, `hyperliquid.ts`. Live mode is byte-for-byte identical.

## 4. Historical Data Layer

### Cache

- **Path:** `~/.sherwood/grid/backtest-cache/`
- **File naming:** `{coin}-{interval}-{startMs}-{endMs}.json` (coin = HL symbol like `BTC`, not CoinGecko ID).
- **Schema:**
  ```json
  {
    "coin": "BTC",
    "interval": "1m",
    "fetchedAt": 1742515300000,
    "bars": [
      { "t": 1739923200000, "o": "65430.5", "h": "65450.0",
        "l": "65420.0", "c": "65441.2", "v": "12.4" }
    ]
  }
  ```
- **Cache hit logic:** if any cached file's `[start, end]` superset-covers the requested range, slice from it. If partial coverage, fetch only the missing prefix/suffix and merge. Malformed cache files trigger a warn-and-refetch.

### Fetch strategy

- HL `candleSnapshot` returns ≤5000 bars per request.
- 1-minute: 5000 min ≈ 3.47 days/request → ~9 paginated requests for a 30-day window. Advance `startTime` to last bar's `t + intervalMs` per page; dedup boundary bars on merge.
- 4-hour: 5000 × 4h ≈ 833 days/request → 1 request covers any reasonable window. Always fetch with **14 × 4h = 56h warmup** before `--from` so ATR(14) is well-defined at t=start.
- Retry 3× with exponential backoff (1s/2s/4s) on transient network/5xx; bail with the last error after the third failure.

### ATRSeries

- After 4h bars are loaded, compute ATR(14) using **Wilder's smoothing** in a single forward pass. ~10-line standalone implementation; no agent dependency.
- Output: `Array<{ ts: number, atr: number }>` aligned to 4h bar closes.
- Lookup at any backtest timestamp `t`: binary-search for the largest `ts ≤ t`. If `t` precedes the 14th bar's close, error out clearly ("warmup window too short").
- **Sanity test:** the value at the last bar must equal `getLatestSignals(bars).atr` modulo float precision. Asserted in a unit test as a regression guard against drift between the two implementations.
- ATR gaps (missing 4h bar in HL data): warn and forward-fill last known ATR. Do not crash.

### Public API

```ts
class HistoricalDataLoader {
  constructor(opts: { cacheDir: string; noCache?: boolean });
  async load(coin: string, fromMs: number, toMs: number): Promise<{
    minutes: Bar1m[];
    atrSeries: { ts: number; atr: number }[];
  }>;
}
```

## 5. Replay Loop

### Time stepping

- Iterate the merged 1-minute timeline across all tokens, lockstep by timestamp.
- `t` only advances to a timestamp where **all** requested tokens have a bar; minutes where any token's bar is missing are skipped and counted (`skippedSteps`).
- `Date.now()` is meaningless during replay — the backtester's clock is `t`. `BacktestPortfolio.resetDailyStats(state, now)` accepts a `now` injection that returns `t`. Live `GridPortfolio` is unchanged.

### HLC fill detection

`GridManager` gains an optional `fillDetector` constructor arg:

```ts
type FillDetector = (level: GridLevel, price: number) => boolean;

const defaultFillDetector: FillDetector = (level, price) =>
  level.side === 'buy' ? price <= level.price : price >= level.price;
```

The manager's inline `currentPrice <= level.price` / `currentPrice >= level.price` checks are replaced with `this.fillDetector(level, currentPrice)`. **The default detector preserves current behavior bit-for-bit.**

The backtester swaps in a closure that reads the current bar's high/low:

```ts
const fillDetector: FillDetector = (level, _price) => {
  const bar = currentBars[grid.token];
  return level.side === 'buy' ? bar.low <= level.price : bar.high >= level.price;
};
```

The open-fill close-out check (`currentPrice >= openFill.targetSellPrice`) is similarly switched to use `bar.high >= openFill.targetSellPrice` in HLC mode. This is a second injection point — `closeFillDetector(openFill, price) → boolean` — same default-vs-backtest split.

### Multiple-fill ordering within one bar

The existing two-pass `simulateFills` (Step 1 = fill levels, Step 2 = close opens) handles the natural cases:

- Bar with `low ≤ multiple buy levels`: all those levels fire (loop iterates all unfilled levels).
- Bar with `low ≤ buy level` AND `high ≥ that level + spacing`: the buy fills in Step 1, the resulting open is closed in Step 2 → one round-trip recorded in a single bar.

### Optimistic accounting (documented limitation)

Wick-fill-then-target-hit-in-the-same-bar is recorded as a successful round-trip. In reality, if the wick down filled at 10:23 and the wick up hit at 10:51, the order timing was favorable; if the wick up was at 10:23 and wick down at 10:51, the round-trip wouldn't have happened. HL doesn't expose intra-minute tick data, so we can't disambiguate. Pessimistic alternative (require fill bar's close ≥ target) would systematically underestimate. For v1: accept the optimistic accounting and call it out in the run summary.

### Equity-curve snapshots

- Default cadence: every 60 simulated minutes (configurable via `--snapshot-every`).
- Snapshot fields: `{ t, totalAllocation, totalPnl, totalRoundTrips, openFillCount, paused }`.
- 30-day run at default cadence → 720 points → ~50KB JSON. Trivial.

### Pause behavior

Preserved exactly as live: if `pauseThresholdPct` triggers, `manager.tick` is a no-op and subsequent snapshots show `paused=true`. Final summary reports % time paused.

### Verbose mode

By default the replay is silent except for a progress line every 10% (`replaying… 30% [9/30 days]`). `--verbose` re-enables the manager's `console.error` chalk logs.

## 6. Output

### Run ID

`bt-{YYYYMMDD-HHMMSS}-{shortHash}` where `shortHash` = first 8 chars of `sha256(JSON.stringify({from, to, config}))`. Same window + same config → same hash → easy duplicate detection.

### Output path

`~/.sherwood/grid/backtests/{runId}.json` (override via `--out`).

### JSON schema

```ts
{
  runId: string,
  startedAt: number,            // wall-clock when run began
  finishedAt: number,
  durationMs: number,           // wall-clock duration

  window: {
    fromMs: number,
    toMs: number,
    fromIso: string,
    toIso: string,
    days: number,
  },

  config: GridConfig,            // exact config used post-CLI overrides

  capital: {
    initialUsd: number,
    finalUsd: number,
    pnlUsd: number,
    pnlPct: number,
  },

  totals: {
    roundTrips: number,
    fills: number,
    rebuilds: number,            // full + shifts
    pausedSteps: number,
    skippedSteps: number,
    totalSteps: number,
  },

  perToken: Array<{
    token: string,
    allocation: { initial: number, final: number },
    roundTrips: number,
    fills: number,
    pnlUsd: number,
    rebuilds: number,
  }>,

  drawdown: {
    maxUsd: number,
    maxPct: number,
    peakAt: number,
    troughAt: number,
  },

  equityCurve: Array<{
    t: number,
    totalAllocation: number,
    totalPnl: number,
    totalRoundTrips: number,
    openFillCount: number,
    paused: boolean,
  }>,
}
```

### Drawdown calculation

Single forward pass over the equity curve tracking running max of `totalAllocation`. Drawdown at each point = `runningMax - totalAllocation`. Final `maxUsd` is the worst observed.

### Terminal summary

```
  Grid Backtest — bt-20260501-143022-a3f9e1c4
  ────────────────────────────────────────────────────────────
  Window:        2026-04-01 → 2026-05-01  (30 days)
  Capital:       $5,000 → $5,847.32  (+$847.32, +16.95%)
  Round trips:   312  (10.4/day)
  Fills:         624  (20.8/day)
  Rebuilds:      18  (full + shifts)
  Max drawdown:  -$142.18 (-2.84%) on 2026-04-13
  Paused:        0 steps (0%)
  Skipped:       12 steps (no data for ≥1 token)

  Per token:
    bitcoin   $2,250 → $2,612 (+16.1%)  RTs=141  fills=282
    ethereum  $1,500 → $1,743 (+16.2%)  RTs=104  fills=208
    solana    $1,250 → $1,492 (+19.4%)  RTs= 67  fills=134

  Wall time:     4.2s
  Saved:         ~/.sherwood/grid/backtests/bt-20260501-143022-a3f9e1c4.json
  ────────────────────────────────────────────────────────────
```

### Programmatic API

`runBacktest(opts): Promise<BacktestResult>` is exported from `backtest.ts`. The CLI subcommand is a thin wrapper. This gives a clean entry point for parameter sweeps as a follow-up project — sweep code can `Promise.all` N invocations sharing one `HistoricalDataLoader` instance for cache hits.

## 7. CLI Surface

```
sherwood grid backtest [options]

Options:
  --from <iso-date>       Window start (default: 30d ago)
  --to <iso-date>         Window end (default: now)
  --capital <usd>         Starting capital (default: 5000)
  --tokens <list>         Comma-separated tokens (default: bitcoin,ethereum,solana)
  --leverage <n>          Override leverage
  --levels <n>            Override levels per side
  --atr-multiplier <n>    Override ATR multiplier
  --rebalance-drift <n>   Override rebalanceDriftPct
  --snapshot-every <min>  Equity-curve snapshot cadence (default: 60)
  --verbose               Print manager fill logs during replay
  --no-cache              Skip cache; always fetch fresh data
  --out <path>            Override output path
```

## 8. Error Handling

| Failure | Behavior |
|---|---|
| `--from` ≥ `--to` | exit 1, `"--from must be before --to"` |
| Window < 56h | exit 1, `"window too short — need ≥ 56h for ATR(14) warmup"` |
| HL fetch fails (network / 5xx) | retry 3× exponential backoff (1s/2s/4s); exit 1 with last error |
| HL returns empty bars for a token | exit 1, `"no data for {token} in window — token may not be listed yet on HL"` |
| `tokenSplit` doesn't sum to 1.0 | exit 1, `"tokenSplit must sum to 1.0, got {sum}"` (existing portfolio invariant) |
| Cache file malformed | warn and re-fetch |
| `~/.sherwood/grid/backtests/` not writable | exit 1 with EACCES path |
| ATR series gap (≥1 missing 4h bar) | warn but proceed — forward-fill last known ATR |

## 9. Testing

### `cli/src/grid/backtest.test.ts` (vitest, new)

- **Synthetic-price replay:** sine-wave 1-min bars around $60k, amplitude $500. Assert known round-trip count and PnL.
- **HLC fill detection:** single bar `low=$59,000`, `high=$60,000`, `close=$59,500`; buy levels at $59,200 and $58,800. Assert only $59,200 fills (`bar.low=$59,000 > $58,800`).
- **Wick-fill round-trip in single bar:** bar wicks down to fill a buy then wicks up to its target. Assert one round-trip recorded (the documented optimistic case).
- **Daily reset injection:** step replay across UTC-midnight boundaries; assert `todayPnlUsd` resets at the right backtest timestamp, not wall-clock.
- **Equity curve cadence:** 24h replay with `snapshotEveryMinutes=60` produces exactly 24 snapshots.
- **Drawdown calc:** known equity curve `[100, 120, 90, 110]` → `maxUsd=30` (`120 → 90`).

### `cli/src/grid/historical-data-loader.test.ts` (vitest, new)

- **Cache hit slicing:** pre-write a cache covering [Jan 1 → Feb 1]; request [Jan 10 → Jan 20]. Assert no fetch, slice is correct.
- **Pagination math:** mock `fetch`. Assert N requests for a 30-day 1m window with non-overlapping `startTime` advances and dedup on boundary bars.
- **ATR rolling computation:** feed 50 hand-built 4h bars with known true ranges. Assert last bar's ATR equals `getLatestSignals(bars).atr` from `cli/src/agent/technical.ts` modulo float precision.

### `cli/src/grid/manager.test.ts` (existing, extend)

- Add one regression test: construct `GridManager` with no optional args; assert default close-only fill behavior is bit-for-bit unchanged. Guards live mode against accidental drift.

## 10. Operational

- **CLI version bump:** minor (`0.x.y → 0.(x+1).0`) per CLAUDE.md — this is a new feature.
- **Branch:** `feat/grid-backtest`.
- **PR description:** must call out the `GridManager` constructor signature change (additive, all args optional) and confirm zero behavioral change to live mode. Include sample run output.
- **`npm run typecheck`** before PR.
- No Solidity touched → `forge fmt` does not apply.

## 11. Out of Scope (explicit)

- Hedge simulation (no `GridHedgeManager` invocation during backtest)
- Parameter sweeps
- Equity-curve plots / charts / web UI
- Slippage / partial-fill modeling (assumes perfect fill at level price)
- Funding-rate cost (grid is delta-neutral-ish over a round trip; v1 assumes zero funding cost)
- Trading fees (the existing `minProfitPerFillUsd` floor is the only fee-ish model; documented as a known gap)

---

## Addendum — Post-build deltas (2026-05-01)

Three changes made during implementation that diverge from the original §4–§6:

### A. Data source: Hyperliquid → Binance

The original spec used Hyperliquid's `candleSnapshot` endpoint. **Hyperliquid retains 1-minute candles only ~3 days back.** That makes 30-day or longer windows impossible.

Replaced with **Binance `/api/v3/klines`** (spot, no auth). Verified: 1m candles available for 2+ years. 4h candles for the full HL retention period.

Implementation impact:
- `cli/src/grid/historical-data-loader.ts` — endpoint, request method (GET not POST), max bars/page (1000 not 5000), response shape (array-of-arrays, not object).
- `COIN_TO_BINANCE_SYMBOL` map added (`BTC→BTCUSDT`, `ETH→ETHUSDT`, `SOL→SOLUSDT`, etc).
- `TOKEN_TO_COIN` (CoinGecko ID → HL coin symbol) is still imported and used; the resolution chain is `bitcoin → BTC → BTCUSDT`.
- The cache file naming and on-disk schema kept the HL coin symbol as the key (e.g. `BTC-1m-…`) for continuity — only the fetch backend changed.

Live mode (`GridLoop`, `HyperliquidProvider`) is **unaffected** — it continues to use HL for live mark prices and ATR. Spot Binance vs. HL perp is a small price-discovery delta during volatile minutes; acceptable noise for a backtester.

§11 row "Backtesting against tokens not on HL" is now **out of date**: any Binance USDT-spot symbol can be backtested by extending `COIN_TO_BINANCE_SYMBOL`. Removed from out-of-scope list.

### B. Drawdown computed against equity, not allocation

The original §6 schema had `equityCurve[].totalAllocation` (the fixed capital pool) feeding `computeDrawdown`. Bug: `state.totalAllocation` is set once at init and never updated, while round-trip profits accumulate in per-grid `g.allocation`. So drawdown was structurally always 0.

Fix: `computeDrawdown` now computes equity at each point as `totalAllocation + totalPnl` and tracks peak-to-trough on equity. Field names unchanged in the JSON output.

### C. Snapshot equity is mark-to-market

Even after fix B, drawdown was still 0 in a 30-day BTC smoke run. Root cause: `totalPnl` in the snapshot was `agg.totalPnlUsd` — **realized only**. The grid only books PnL on profitable closes (gated by `minProfitPerFillUsd`), so realized PnL is monotonically non-decreasing by construction.

Fix: at each snapshot the backtester walks open fills, prices them at the current bar's close, and adds `(close - buyPrice) × quantity × leverage` to `totalPnl` for that snapshot point. This matches the manager's leverage-aware PnL accounting.

The headline `result.capital.pnlUsd` is still **realized only** (matches what an LP actually walks away with on settlement). Drawdown specifically uses the marked-to-market equity curve.

Smoke run (2026-04-01 → 2026-05-01, BTC, $5k): **+$25,839.65 realized (+517%)**, **max drawdown −$5,057 (−35.86%)** on the way. The 36% unrealized DD never triggered the live `pauseThresholdPct=0.20` because the live `checkPauseThreshold` values open fills at BUY price, not current price — that's a separate blind spot in the live grid code (file as a follow-up issue if not already tracked).

### D. `mkdir` uses `dirname(outPath)`, not `DEFAULT_OUT_DIR`

§6 implicitly assumed JSON always writes to `~/.sherwood/grid/backtests/`. Custom `--out` paths in other directories failed with ENOENT. Fixed in PR by changing `mkdir(DEFAULT_OUT_DIR, ...)` to `mkdir(dirname(outPath), { recursive: true })`.

### Live results vs. spec example

The spec's §6 illustrative summary showed +16.95% on a 30-day window. Real results at default config (5x leverage, 15 levels/side, BTC) on April 2026 are wildly higher (+517%) because of the **optimistic two-pass wick-fill accounting** (already disclosed in §5: a single bar with `low ≤ buyLevel` AND `high ≥ buyLevel + spacing` records a round trip in the same minute). Compounded over 43,200 1m bars, this systematically overstates PnL. Treat the realized number as an **upper bound**; the reported drawdown is also a partial picture (snapshots are hourly by default; intra-hour wicks aren't captured in the equity curve).
