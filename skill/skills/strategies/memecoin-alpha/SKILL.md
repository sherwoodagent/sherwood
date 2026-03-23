---
name: memecoin-alpha
description: Signal-driven memecoin trading on Base via Uniswap Trading API — buy, sell, swap tokens, scan for opportunities, monitor positions, auto-exit on signals. Uses Messari/Nansen research, Venice inference for sentiment. Triggers on trade, swap, buy, sell, memecoin, scan, monitor, uniswap, position, P&L.
allowed-tools: Read, Glob, Grep, Bash(sherwood *), Bash(npm *), Bash(npx *), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.1.0'
---

# Memecoin Alpha Strategy

Off-chain, signal-driven memecoin trading strategy on Base. Composes three existing Sherwood integrations:

- **Messari / Nansen** (x402 research) — on-chain smart money flows + market fundamentals
- **Venice inference** (private AI) — X/Twitter sentiment analysis via web search
- **Uniswap Trading API** — optimal routing, MEV-protected swaps (PRIORITY on Base)

No smart contract required. Trades execute from the agent's own EOA wallet. The agent funds Venice inference via the existing Venice proposal flow, then uses the CLI to research, trade, and manage positions.

## Overview

```
1. Research     →  sherwood trade scan (Nansen smart money + Messari fundamentals + Venice sentiment)
2. Buy          →  sherwood trade buy --token <addr> --amount <usdc>  (Uniswap Trading API)
3. Monitor      →  sherwood trade monitor (auto-exit on stop loss, trailing stop, or signal flip)
4. Sell         →  sherwood trade sell --token <addr>  (Uniswap Trading API)
5. Track        →  sherwood trade positions (P&L, unrealized gains)
```

## Prerequisites

### 1. Uniswap API Key (required)

Register at the [Uniswap Developer Portal](https://developers.uniswap.org/) to get an API key. Then configure it:

```bash
sherwood config set --uniswap-api-key <your-key>
```

Or set via environment variable:

```bash
export UNISWAP_API_KEY=<your-key>
```

The Trading API provides optimized routing across Uniswap V2/V3/V4 pools, UniswapX Dutch auctions, and PRIORITY orders (MEV-protected on Base). All swaps go through the API — no direct contract calls.

### 2. Venice API Key (for signal analysis)

The social sentiment signal uses Venice inference with web search. Fund your agent's Venice access via the existing Venice inference proposal:

```bash
sherwood strategy propose venice-inference \
  --vault <vault> --amount 100 --asset USDC \
  --name "Venice inference funding" \
  --description "Fund Venice inference for memecoin signal analysis" \
  --performance-fee 0 --duration 30d
```

After execution, provision your API key:

```bash
sherwood venice provision
```

### 3. USDC for Research + Trading

- **Research**: Messari (~$0.20/query) + Nansen (~$0.06/query) paid via x402 from agent wallet
- **Trading**: USDC in agent wallet for buying tokens

### 4. Wallet with ETH for Gas

```bash
sherwood config set --private-key 0x...
sherwood config show  # verify wallet, Uniswap API key status
```

## Signal Engine

The `trade scan` command aggregates three data sources into a composite buy/sell/hold signal:

| Signal | Source | Weight | Cost |
|--------|--------|--------|------|
| Smart Money Net Flow | Nansen x402 | 40% | ~$0.06 |
| X/Twitter Sentiment | Venice web search | 30% | free (sVVV) |
| Volume + Fundamentals | Messari x402 | 30% | ~$0.20 |

**Decision logic:**
- Composite score >= 0.3 AND confidence >= 50% → **BUY**
- Composite score <= -0.2 → **SELL**
- Otherwise → **HOLD**

Confidence = average strength of individual signals (how directional, regardless of direction). Low confidence means conflicting signals.

## Exit Strategy

Positions are monitored with a priority-ordered exit algorithm:

1. **Deadline** — force exit before a configurable timestamp
2. **Stop loss** — exit if P&L drops below threshold (default -10%)
3. **Trailing stop** — exit if price drops from high-water mark (disabled by default)
4. **Take profit** — exit at target P&L (disabled by default, use signal exit)
5. **Signal bearish** — exit when signals flip bearish with confidence > 40%

The `trade monitor` command checks positions on an interval and auto-executes sells when exit conditions trigger.

## Commands

### Scan for opportunities

```bash
# Scan known Base memecoins (DEGEN, TOSHI, BRETT, HIGHER)
sherwood trade scan

# Scan a specific token by address
sherwood trade scan --token 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed

# Skip cost confirmation (for automated agents)
sherwood trade scan --yes

# Post results to syndicate chat
sherwood trade scan --syndicate alpha
```

Output: table with token, composite score, action, confidence, per-signal breakdown.

### Buy a token

```bash
sherwood trade buy \
  --token DEGEN \
  --amount 50 \
  --slippage 0.5 \
  --stop-loss 10 \
  --trailing-stop 20 \
  --deadline 24 \
  --syndicate alpha
```

| Flag | Default | Description |
|------|---------|-------------|
| `--token` | required | Token address or known symbol |
| `--amount` | required | USDC amount to spend |
| `--slippage` | 0.5 | Slippage tolerance % (passed to Uniswap API) |
| `--stop-loss` | 10 | Stop loss percentage |
| `--trailing-stop` | 0 | Trailing stop from high-water (0 = disabled) |
| `--deadline` | 0 | Force exit after N hours (0 = none) |
| `--syndicate` | — | Post TRADE_EXECUTED to chat |

### Sell a token

```bash
# Sell entire position
sherwood trade sell --token DEGEN

# Sell partial amount
sherwood trade sell --token DEGEN --amount 1000
```

### View positions

```bash
sherwood trade positions
```

Shows: token, entry price, current price, quantity, cost basis, current value, unrealized P&L.

### Monitor positions (auto-exit)

```bash
# Check every 5 minutes, auto-sell on exit triggers
sherwood trade monitor --interval 300 --syndicate alpha
```

The monitor:
1. Gets current price via Uniswap QuoterV2
2. Updates high-water mark for trailing stops
3. Runs full signal analysis (Nansen + Venice + Messari)
4. Checks all exit conditions (stop loss, trailing stop, deadline, signals)
5. Auto-executes sell via Uniswap Trading API if exit triggered
6. Posts RISK_ALERT and TRADE_EXECUTED to syndicate chat

## Workflow: Agent Autonomy

A fully autonomous agent loop:

```bash
# 1. Scan for opportunities
sherwood trade scan --yes --syndicate alpha

# 2. If BUY signal found, execute
sherwood trade buy --token <addr> --amount 50 --stop-loss 10 --trailing-stop 20 --deadline 48 --syndicate alpha

# 3. Monitor and auto-exit
sherwood trade monitor --interval 300 --syndicate alpha
```

The agent can combine this with research commands for deeper due diligence:

```bash
# Deep research before buying
sherwood research token DEGEN --provider messari --post alpha --yes
sherwood research smart-money --token DEGEN --provider nansen --post alpha --yes
```

## Uniswap Trading API Integration

All swaps route through the hosted Uniswap Trading API (`trade-api.gateway.uniswap.org/v1`):

1. **`POST /check_approval`** — checks if token is approved for the Universal Router, returns approval tx if needed
2. **`POST /quote`** — returns the optimal route (CLASSIC AMM, UniswapX PRIORITY on Base, etc.) with price and gas estimate
3. **`POST /swap`** — returns the ready-to-sign transaction calldata

On Base, the API can route through **PRIORITY orders** — MEV-protected swaps that prevent frontrunning and sandwich attacks. This is especially important for memecoin trades where slippage and MEV are significant.

The API handles multi-hop routing, fee tier selection, and cross-pool optimization automatically. No manual pool selection needed.

## Chat Integration

All trade actions post to syndicate XMTP chat using existing message types:

| Message Type | When |
|-------------|------|
| `TRADE_SIGNAL` | After `trade scan` completes |
| `TRADE_EXECUTED` | After buy or sell |
| `RISK_ALERT` | When monitor triggers an exit |
| `POSITION_UPDATE` | Periodic position updates |

## Cost Breakdown (per trade cycle)

| Step | Cost | Source |
|------|------|--------|
| Scan (per token) | ~$0.26 | Nansen $0.06 + Messari $0.20 |
| Venice sentiment | free | Prepaid via sVVV staking |
| Buy swap | gas only | ~$0.001-0.01 on Base |
| Monitor (per check) | ~$0.26 | Same as scan |
| Sell swap | gas only | ~$0.001-0.01 on Base |

Total per trade cycle (1 token): **~$0.52 USDC** in research + minimal gas.
