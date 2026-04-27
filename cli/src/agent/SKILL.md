---
name: sherwood-directional-agent
description: Reference for the directional paper-trading agent — signal stack, scoring weights, regime gating, calibrator, autoresearch, and runtime ops.
tags: [sherwood, agent, paper-trading, scoring, regime, autoresearch]
---

# Sherwood Directional Trading Agent

The directional agent scores tokens on every cycle, gates entries, sizes
positions, and writes trades + cycle data to `~/.sherwood/agent/`. This file
is the single source of truth for the live behavior — code is authoritative,
this doc tracks the *why*.

## Runtime

- `sherwood agent start --auto --cycle 1` — single dry-run cycle then exit
  (used by the Hermes trade-scanner cron).
- `sherwood agent start --auto --cycle 5m --use-judge` — persistent loop via
  systemd. Manage with `systemctl --user {start|stop|restart|status} sherwood-agent`,
  follow logs with `journalctl --user -u sherwood-agent -f`.
- `sherwood agent summary` — deterministic XMTP/Telegram-formatted summary.
  Pipe to `chat send --stdin` to avoid bash `$`-expansion of dollar amounts.

systemd services need `Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"` —
linuxbrew Node.js can't find CA certs without it and HTTPS fetches fail
silently with `TypeError: fetch failed`.

## Scoring Weights

Authoritative values live in `cli/src/agent/scoring.ts:DEFAULT_WEIGHTS` and
`WEIGHT_PROFILES`. The agent picks `majors` for BTC/ETH/SOL and `default`
for everything else, unless `--weight-profile` overrides.

| Category    | default | majors | altcoin |
|-------------|---------|--------|---------|
| smartMoney  | 0.30    | 0.30   | 0.25    |
| technical   | 0.25    | 0.30   | 0.20    |
| sentiment   | 0.10    | 0.10   | 0.10    |
| onchain     | 0.20    | 0.20   | 0.15    |
| fundamental | 0.15    | 0.10   | 0.30    |
| event       | 0.00    | 0.00   | 0.00    |

`event` is held at 0 across all profiles until it produces non-zero, testable
observations. Re-run `sherwood agent autoresearch` after any signal-stack
change to recalibrate, then update this table.

## Regime Thresholds

Regime detection uses EMA(21,50) and ADX(7) — 4× faster than the prior
EMA(50,200) / ADX(14) baseline. Thresholds per regime live in
`scoring.ts:REGIME_THRESHOLDS`. The ranging-regime BUY/SELL threshold
is symmetric ±0.14 after the Apr 27 autoresearch replay.

The minimum conviction gate (`|score| ≥ 0.08`) lives in `executor.ts`.

## Excluded / Dampened Signals

`scoring.ts` keeps two sets to stop noisy signals from polluting the
weighted average:

- `EXCLUDED_SCORING_SIGNALS` — skipped entirely (continue) before the
  weight-and-vote loop. Driven by forward-return analysis (Apr 27, 50
  trades): inverted edges, zero-variance signals, dead/noise signals.
- `COUNTER_TREND_DAMPENED` — kept in scoring but dampened to 30% weight
  when the signal opposes the regime direction. `kronosVolForecast` and
  `whaleIntent` qualify; signals aligned with the trend keep full weight.
  Convergence-bonus voting mirrors the same 0.3× dampening.

## Entry Gates

Velocity gate (`entry-gates.ts:VELOCITY_GATE_*`):

- BUY rejected when 1h velocity ≤ -0.01 (-1%).
- SELL rejected when 1h velocity ≥ +0.01 (+1%).
- `±0.3%` was too tight for the 4h candle window we actually use; the
  ±1% threshold is the post-audit value.

Real-alpha gate (`entry-gates.ts:REAL_ALPHA_THRESHOLDS`): an entry must be
backed by at least one of `smartMoney`, `whaleIntent`, `fundamental`, or
`narrativeVacuum` exceeding the per-signal floor.

Regime + short protection:

- Shorts blocked in non-bearish regimes (trending-up, ranging, low-volatility).
  Allowed only in trending-down and high-volatility.
- Per-token consecutive-loss cooldown: 24h ban after 2 losses on the same token.
- Short position sizing halved (0.5× multiplier).

## Cash Model & Leverage

`PortfolioTracker` (`portfolio.ts`) debits 33% margin (`MARGIN_FRACTION = 0.33`)
of notional for both longs and shorts on every open / pyramid add, and
credits margin + PnL on close. `DIRECTIONAL_LEVERAGE` (`executor.ts`) is the
notional multiplier on order quantity; currently `1` after autoresearch
showed leverage was amplifying losses at 54% WR. Live mode
(`hyperliquid-perp`) uses the venue's own margin schedule.

## Calibrator

Two paths, both write JSON to `~/.sherwood/agent/`:

- **Candle path** (`sherwood agent calibrate`) — re-fetches OHLC and recomputes
  signals from candles only. Cannot replay HL flow / fundingRate / smartMoney
  (those need live data). Output is a lower bound on production performance —
  many configs show 0 trades because the candle-only stack rarely fires.
- **Replay path** (`sherwood agent calibrate --from-history`) — replays
  captured production signals from `signal-history.jsonl`. Far truer to live
  behavior. Add `--last <days>` after a scoring change to ignore stale rows
  captured under the prior code.

The backtester is direction-aware: `Position.side` + SHORT entries on SELL
signals; exit math (stop / TP / trail) flips for shorts.

## Autoresearch

`sherwood agent autoresearch [--experiments N] [--last D]` — autonomous
parameter optimization against `signal-history.jsonl`. Mutates weights /
thresholds / stops, replays, keeps improvements. Results land in
`autoresearch-best-params.json`. Re-run after any new signal stack change.

## State Files (`~/.sherwood/agent/`)

- `cycles.jsonl` — append-only per-cycle summary:
  `{cycleNumber, timestamp, signals: [{token, score, action, regime}],
  tradesExecuted, exitsProcessed, portfolioValue, dailyRealizedPnl,
  unrealizedPnl, dailyPnl (deprecated alias of dailyRealizedPnl),
  totalPnlUsd, totalPnlPct, errors}`.
  - `dailyRealizedPnl` moves only on closed trades (drives the drawdown gate).
  - `unrealizedPnl` is mark-to-market across open positions.
  - `totalPnlUsd` / `totalPnlPct` are cumulative vs `portfolio.initialValue`
    (10k default for paper, on-chain vault balance for live syndicates).
- `signal-history.jsonl` — per-token full signal stack including HL / funding /
  dexFlow values + regime + weights used. Source for replay calibration.
- `portfolio.json` — directional positions, cash, PnL counters. Atomic write
  via `.tmp` rename.
- `trades.json` — closed-trade history (entry / exit / PnL / reason).
- `calibration-results.json` / `replay-calibration-results.json` — last
  calibrator run output.

`portfolio.totalValue` only tracks directional cash + positions; grid
allocation lives in `~/.sherwood/grid/portfolio.json` (see
`cli/src/grid/SKILL.md`). The summary formatter combines both for the
headline number.

## Data Providers

External providers use vendored Python scripts called via subprocess
(`cli/src/providers/fincept/bridge.ts`, scripts in `cli/scripts/fincept/`).

- **Active**: Messari (fundamentals), Blockchain.com (BTC network), Polymarket
  (predictions), CryptoCompare (candles fallback + social), DefiLlama
  (TVL / yields), DexScreener (DEX pairs).
- **In-house**: Hyperliquid (native), TradingView (MCP subprocess).
- **Removed**: Glassnode (paywall), CoinGecko OHLCV (replaced by CryptoCompare).
- CoinGecko free tier is 30 calls/min; circuit breaker trips on 429
  (5-min cooldown). HL candles are the primary source since 0.44.0 — CG
  OHLC is fallback.
- BTC correlation uses Hyperliquid-native data since 0.43.5 (no CG dependency).
- `CRYPTOCOMPARE_API_KEY` env var needed for news / social endpoints.

## Kronos Volatility Forecaster

Kronos-mini (4.1M param foundation model) predicts future OHLCV via Monte
Carlo paths. Used for dynamic stop-loss width and the `kronosVolForecast`
directional bias signal.

- Venv at `~/.sherwood/kronos-venv/` with CPU-only PyTorch (~200MB).
  Model code vendored at `cli/scripts/fincept/kronos_model/`.
- Inference: ~2.3s per token for 5 paths on CPU. Results cached 1 hour per token.
- If venv missing, Kronos signals gracefully return null.
- Weights auto-download from HuggingFace (`NeoQuasar/Kronos-mini`,
  `NeoQuasar/Kronos-Tokenizer-base`) on first run, cached in `~/.cache/huggingface/`.
