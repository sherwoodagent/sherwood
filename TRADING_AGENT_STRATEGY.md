# Sherwood Trading Agent — Strategy Specification

> **Note:** This is a design/planning document. Features described here (x402 micropayments, Nansen, Messari, LunarCrush integrations) are aspirational and not yet implemented. The current implementation uses CoinGecko, Fear&Greed, and technical analysis scoring. See `cli/src/agent/` for the actual code.

> Autonomous trading agent that combines on-chain intelligence (Nansen/Messari via x402), technical analysis, sentiment data, and DeFi-native signals to make high-conviction trades.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    DECISION ENGINE                       │
│         Multi-Signal Scoring → Trade or Pass             │
└──────────────┬──────────────────────────┬───────────────┘
               │                          │
    ┌──────────▼──────────┐    ┌──────────▼──────────┐
    │   DATA COLLECTORS   │    │   STRATEGY MODULES   │
    │                     │    │                      │
    │  • Nansen (x402)    │    │  • Smart Money Copy  │
    │  • Messari (x402)   │    │  • Token Unlock      │
    │  • DefiLlama (free) │    │  • Sentiment Contra  │
    │  • CoinGecko (free) │    │  • Breakout + Chain  │
    │  • Fear&Greed (free)│    │  • Funding Arb       │
    │  • X Sentiment      │    │  • TVL Momentum      │
    │  • DEX Pool Data    │    │  • DEX Arb           │
    └─────────────────────┘    └──────────────────────┘
               │                          │
    ┌──────────▼──────────────────────────▼───────────────┐
    │                 EXECUTION LAYER                      │
    │  • Position sizing  • Slippage control               │
    │  • Stop-loss mgmt   • MEV protection                 │
    │  • Gas optimization • Portfolio tracking              │
    └─────────────────────────────────────────────────────┘
```

## Data Sources

### Paid (x402 micropayments on Base)

| Source | Command | Cost | Data |
|--------|---------|------|------|
| Nansen | `sherwood research smart-money` | ~$0.01-0.06/query | Smart money wallets, netflow, labels |
| Nansen | `sherwood research wallet` | ~$0.01-0.06/query | Wallet PnL, holdings, history |
| Messari | `sherwood research token` | ~$0.10-0.20/query | Asset profile, metrics, fundamentals |
| Messari | `sherwood research market` | ~$0.10-0.20/query | Market data, ATH, volume metrics |

### Free (no API key)

| Source | Endpoint | Data |
|--------|----------|------|
| DefiLlama | `api.llama.fi/tvl/{protocol}` | TVL, DEX volumes, yields, protocol revenue |
| DefiLlama | `yields.llama.fi/pools` | Pool APY data |
| DefiLlama | `coins.llama.fi/prices/current/{coins}` | Token prices |
| CoinGecko | `api.coingecko.com/api/v3/` | Market data, social metrics, volume |
| Fear & Greed | `api.alternative.me/fng/` | Fear & Greed Index (0-100) |
| TokenUnlocks | `token.unlocks.app` | Upcoming token unlock events |
| CryptoQuant | Public dashboards | Exchange flows, miner flows |

### Sentiment (needs API key or scraping)

| Source | Method | Data |
|--------|--------|------|
| X/Twitter | API v2 or scraping | Raw tweets for CryptoBERT scoring |
| LunarCrush | API (free tier) | Galaxy Score, AltRank, social volume |
| Santiment | API (free tier) | Social dominance, dev activity, on-chain |

---

## Strategy Modules

### Strategy 1: Smart Money Convergence

**Signal source:** Nansen (via `sherwood research smart-money`)
**Timeframe:** 4H-1D
**Type:** Trend-following / copy-trading

**Logic:**
```
EVERY 4 HOURS:
  1. Query Nansen smart-money netflow for watchlist tokens
  2. Identify tokens where 3+ distinct "Smart Money" wallets
     accumulated within the last 48 hours
  3. Filter: only tokens with market cap > $10M and DEX liquidity > $500K

ENTRY:
  - Smart money convergence detected (3+ wallets buying)
  - Price near support on 4H chart (within 5% of 20-period SMA)
  - RSI(14) < 60 (not overbought)
  - Volume increasing (current > 1.2x 20-period avg)

EXIT:
  - Smart money wallets start selling (Nansen shows net outflow)
  - Take profit: scale out 50% at +15%, remaining at +30%
  - Stop loss: 12% below entry
  - Time stop: exit if no movement after 7 days

POSITION SIZE:
  - Max 5% of portfolio per trade
  - Max 3 concurrent smart-money positions
```

**Edge:** Smart money wallets (VC funds, successful traders) have information advantage. Following their on-chain moves with 1-4 hour delay still captures most of the move.

---

### Strategy 2: Token Unlock Frontrun

**Signal source:** Messari (via `sherwood research token`) + TokenUnlocks
**Timeframe:** 1D-1W
**Type:** Event-driven / mean-reversion

**Logic:**
```
DAILY SCAN:
  1. Query Messari for tokens with upcoming unlock events
  2. Filter: unlock size > 2% of circulating supply
  3. Prioritize: cliff unlocks > linear vesting
  4. Prioritize: VC/team unlocks > community/ecosystem

PRE-UNLOCK SHORT (7 days before):
  - Enter short when unlock > 5% of supply AND token is within 20% of recent highs
  - Confirmation: RSI(14) > 55 on daily (not already dumped)
  - Target: 10-25% drop from entry
  - Stop: 8% above entry
  - Exit: 1-3 days after unlock date

POST-UNLOCK LONG (after the dump):
  - Wait for 15-30% dump post-unlock
  - Enter when: selling volume declines for 3+ consecutive days
  - Price forms higher low on 4H chart
  - Target: 50-78.6% Fibonacci retracement of the dump
  - Stop: below post-unlock low

POSITION SIZE:
  - Max 3% of portfolio per trade (higher risk)
  - Max 2 concurrent unlock trades
```

**Edge:** Research shows tokens with >5% supply unlock see avg -7% returns in surrounding 7 days. Market systematically underreacts to scheduled unlock events.

---

### Strategy 3: Contrarian Sentiment

**Signal source:** Fear & Greed Index + X/Twitter sentiment + LunarCrush
**Timeframe:** 1D
**Type:** Contrarian / mean-reversion

**Logic:**
```
DAILY CHECK:
  1. Fetch Fear & Greed Index from alternative.me
  2. Compute Twitter sentiment z-score (rolling 30-day window)
  3. Check LunarCrush Galaxy Score for target tokens

BUY (Extreme Fear):
  - Fear & Greed Index < 20 for 2+ consecutive days
  - Twitter sentiment z-score < -2.0
  - RSI(14) < 35 on daily chart
  - Price at or below lower Bollinger Band (20, 2.0)
  - Buy BTC/ETH (safest) or top altcoins with Galaxy Score rising

SELL (Extreme Greed):
  - Fear & Greed Index > 75 for 2+ consecutive days
  - Twitter sentiment z-score > +2.0 (euphoria)
  - RSI(14) > 70 on daily chart
  - Social dominance of coin > 2x its 30-day average (Santiment)

EXIT:
  - Take profit: 15-25% gain OR sentiment normalizes (index 40-60)
  - Stop loss: 8% below entry
  - Trailing stop: 10% from peak once in profit

POSITION SIZE:
  - Up to 10% of portfolio (high conviction contrarian)
  - Scale in: 33% at first signal, 33% if drops 5% more, 33% if drops 10% more
```

**Edge:** Backtested 2018-2024 on BTC: outperforms buy-and-hold by 15-40% annually. Crowds are reliably wrong at sentiment extremes.

---

### Strategy 4: Breakout + On-Chain Confirmation

**Signal source:** Technical analysis + exchange flows + Nansen
**Timeframe:** 4H
**Type:** Momentum / breakout

**Logic:**
```
SCAN (every 4 hours):
  1. Check watchlist tokens for 20-day high breakouts
  2. Pull exchange flow data (CryptoQuant or Nansen)
  3. Check open interest trends (for tokens with perps)

ENTRY (Long breakout):
  - Price closes above 20-day high on 4H candle
  - Volume on breakout candle > 2x 20-period average
  - Exchange outflows rising (accumulation — tokens leaving CEXs)
  - Nansen: smart money not selling (net flow neutral or positive)
  - EMA(50) sloping upward (trend confirmation)

ENTRY (Short breakdown):
  - Price closes below 20-day low on 4H candle
  - Volume confirmation > 2x average
  - Exchange inflows spiking (distribution — tokens entering CEXs)
  - Smart money selling on Nansen

EXIT:
  - Take profit: 2x risk (risk = entry to stop distance)
  - Stop loss: below breakout candle low (long) / above breakdown candle high (short)
  - Trailing stop: move to breakeven at 1x risk, then trail by 1.5x ATR(14)
  - On-chain exit: if exchange flows reverse direction, tighten stop to 0.5x ATR

POSITION SIZE:
  - Risk 2% of portfolio per trade
  - Position size = (2% of portfolio) / (entry - stop loss)
  - Max 4 concurrent breakout positions
```

**Edge:** Breakouts confirmed by on-chain flows have 65-70% success rate vs 50-55% for pure technical breakouts.

---

### Strategy 5: Funding Rate Harvester

**Signal source:** Perpetual futures funding rates
**Timeframe:** 8H (aligned with funding periods)
**Type:** Delta-neutral / arbitrage

**Logic:**
```
EVERY 8 HOURS (before funding snapshot):
  1. Scan all perp markets for extreme funding rates
  2. Rank by absolute funding rate

POSITIVE FUNDING > 0.05% (longs pay shorts):
  - Short the perpetual future
  - Long the spot (equal notional value)
  - Collect funding payment every 8 hours
  - Net exposure: zero (delta-neutral)

NEGATIVE FUNDING < -0.05% (shorts pay longs):
  - Long the perpetual future
  - Short the spot (or use stablecoin as hedge)
  - Collect funding payment every 8 hours

EXIT:
  - When funding rate normalizes to < 0.01% (close both legs)
  - Max holding period: 7 days (avoid basis risk)
  - Emergency exit: if unrealized PnL on either leg exceeds -5%

POSITION SIZE:
  - Up to 20% of portfolio (low risk, delta-neutral)
  - Split across 3-5 pairs for diversification
  - Account for trading fees on both legs (must net positive after fees)
```

**Edge:** 15-40% APY in trending markets. During bull runs, funding can sustain >0.1% for weeks. Pure math, no directional bias needed.

---

### Strategy 6: TVL Momentum

**Signal source:** DefiLlama (free) + Messari fundamentals
**Timeframe:** 1W
**Type:** Fundamental momentum

**Logic:**
```
WEEKLY SCAN:
  1. Pull TVL data for top 200 DeFi protocols from DefiLlama
  2. Calculate TVL growth rate (7-day and 30-day)
  3. Pull protocol revenue from DefiLlama
  4. Cross-reference with Messari for token metrics

BUY:
  - TVL growing > 10% week-over-week for 2+ consecutive weeks
  - Protocol revenue growing (not just incentivized TVL)
  - Token market cap / TVL ratio < 1.0 (undervalued relative to deposits)
  - Messari: no major token unlocks in next 30 days
  - Technical: price above 50-day EMA

SELL:
  - TVL growth stalls (< 2% WoW) or declines
  - Revenue drops while TVL maintained (yield farming mercenaries leaving)
  - Market cap / TVL ratio > 3.0 (overvalued)
  - Price below 50-day EMA

POSITION SIZE:
  - Max 5% per protocol token
  - Max 5 concurrent TVL momentum positions
  - Rebalance weekly
```

**Edge:** TVL growth is a leading indicator for token price. Protocols with genuine growth (revenue-backed, not just incentivized) tend to see 2-5x token appreciation over 3-6 months.

---

### Strategy 7: DEX Arbitrage (Flash Loan)

**Signal source:** On-chain pool data (The Graph / direct RPC)
**Timeframe:** Real-time (block-by-block)
**Type:** Arbitrage

**Logic:**
```
CONTINUOUS MONITORING:
  1. Subscribe to price feeds across DEXs (Uniswap, Sushiswap, Curve, Balancer)
  2. Compare prices for same token across pools
  3. Calculate potential profit after gas + fees

CROSS-DEX ARBITRAGE:
  - Price difference between DEX A and DEX B > 0.5% (after fees + gas)
  - Execute via flash loan (zero capital required):
    1. Borrow token from Aave/dYdX flash loan
    2. Sell on expensive DEX
    3. Buy on cheap DEX
    4. Repay flash loan + fee
    5. Keep profit
  - All in one atomic transaction (no risk if profitable, reverts if not)

TRIANGLE ARBITRAGE:
  - Token A → B → C → A across Uniswap pools
  - Calculate circular trade profit
  - Execute if profit > gas cost + 0.1% buffer

SAFETY:
  - Max gas price: 50 gwei on L1, or use L2s (Arbitrum, Base, Optimism)
  - MEV protection: submit via Flashbots Protect or private mempool
  - Profit threshold: must exceed gas cost by 2x minimum
  - Simulate transaction before submitting (eth_call)
```

**Edge:** Risk-free when executed atomically. Competition is fierce on L1 but opportunities exist on L2s and between L2 DEXs. Flash loans eliminate capital requirements.

---

## Decision Engine — Multi-Signal Scoring

The agent runs all strategy modules in parallel and combines signals into a unified score:

```
SIGNAL WEIGHTS:
  smart_money_signal    = 0.25  (Nansen smart money convergence)
  technical_signal      = 0.20  (breakout, RSI, MACD, BB)
  sentiment_signal      = 0.20  (Fear&Greed, X sentiment, social dominance)
  onchain_signal        = 0.15  (exchange flows, whale movements)
  fundamental_signal    = 0.10  (TVL growth, revenue, Messari metrics)
  event_signal          = 0.10  (token unlocks, governance votes, upgrades)

EACH SIGNAL SCORED: -1.0 (strong bearish) to +1.0 (strong bullish)

COMBINED SCORE = weighted sum of all signals

ACTIONS:
  score > +0.6  → OPEN LONG  (high conviction)
  score > +0.3  → INCREASE LONG / tighten short stops
  score -0.3 to +0.3 → HOLD / no new positions
  score < -0.3  → INCREASE SHORT / tighten long stops
  score < -0.6  → OPEN SHORT (high conviction)
```

### Signal Calculation Details

**smart_money_signal:**
```
+1.0 = 5+ smart money wallets accumulating, zero selling
+0.5 = 3+ wallets accumulating, minimal selling
 0.0 = mixed signals or no data
-0.5 = smart money reducing positions
-1.0 = smart money dumping, moving to exchanges
```

**technical_signal:**
```
+1.0 = breakout above 20-day high + volume spike + RSI momentum
+0.5 = price above key EMAs, RSI rising from oversold
 0.0 = ranging, no clear direction
-0.5 = price below key EMAs, RSI falling from overbought
-1.0 = breakdown below 20-day low + volume spike
```

**sentiment_signal:**
```
+1.0 = extreme fear (F&G < 15) + sentiment z-score < -2.5 (contrarian buy)
+0.5 = fear zone (F&G 15-30) + negative sentiment
 0.0 = neutral sentiment
-0.5 = greed zone (F&G 65-75) + positive sentiment rising
-1.0 = extreme greed (F&G > 80) + social dominance spike (contrarian sell)
```

**onchain_signal:**
```
+1.0 = sustained exchange outflows + stablecoin inflows to exchanges
+0.5 = moderate outflows, whale accumulation
 0.0 = balanced flows
-0.5 = exchange inflows rising, whale deposits to CEX
-1.0 = massive exchange inflows + whale dumping + miner selling
```

**fundamental_signal:**
```
+1.0 = TVL growing >15% WoW + revenue growing + mcap/TVL < 0.5
+0.5 = TVL growing 5-15% WoW + stable revenue
 0.0 = flat metrics
-0.5 = TVL declining, revenue dropping
-1.0 = TVL collapsing + token unlock imminent + no revenue
```

**event_signal:**
```
+1.0 = positive catalyst (major upgrade, partnership, listing)
+0.5 = minor positive event
 0.0 = no events
-0.5 = minor negative (small unlock, governance dispute)
-1.0 = major negative (large unlock >5% supply, hack, regulatory action)
```

---

## Risk Management

### Position Limits
```
MAX_PORTFOLIO_RISK    = 15%    # max % of portfolio at risk at any time
MAX_SINGLE_POSITION   = 10%   # max % of portfolio in one trade
MAX_CORRELATED_EXPOSURE = 20% # max in correlated assets (e.g., all L1s)
MAX_CONCURRENT_TRADES = 8     # across all strategies
```

### Stop Loss Rules
```
HARD_STOP             = 12%   # absolute max loss per trade
TRAILING_STOP         = 1.5x ATR(14)
BREAKEVEN_TRIGGER     = 1x risk achieved → move stop to entry
TIME_STOP             = exit if no movement after N candles (strategy-specific)
CORRELATION_STOP      = if BTC drops >10% in 24h, close all altcoin longs
```

### Drawdown Protection
```
DAILY_LOSS_LIMIT      = 5%    # stop trading for the day
WEEKLY_LOSS_LIMIT     = 10%   # reduce position sizes by 50% for rest of week
MONTHLY_LOSS_LIMIT    = 15%   # pause all strategies, require manual restart
```

### MEV Protection
```
- All DEX trades via MEV-protected RPC (Flashbots Protect, MEV Blocker)
- Max slippage: 0.5% large caps, 1.5% mid caps, 3% small caps
- Simulate all transactions before submitting
- Use private mempool for large orders
```

---

## Agent Loop

```
EVERY CYCLE (configurable: 15min / 1h / 4h):

  1. COLLECT DATA
     ├── sherwood research smart-money     → smart money flows
     ├── sherwood research token {TOKEN}   → fundamentals
     ├── sherwood research market           → market overview
     ├── fetch DefiLlama                   → TVL, volumes, yields
     ├── fetch CoinGecko                   → prices, market data
     ├── fetch Fear & Greed                → sentiment index
     ├── fetch X sentiment                 → tweet scoring
     └── fetch exchange flows              → CEX in/out

  2. COMPUTE SIGNALS
     ├── Run each strategy module
     ├── Score each signal (-1.0 to +1.0)
     └── Compute weighted combined score

  3. CHECK RISK
     ├── Current portfolio exposure
     ├── Drawdown status
     ├── Correlation check
     └── Available capital

  4. DECIDE
     ├── If score > +0.6 AND risk allows → generate BUY order
     ├── If score < -0.6 AND risk allows → generate SELL/SHORT order
     ├── Check existing positions for exit signals
     └── Adjust stops on open positions

  5. EXECUTE
     ├── Calculate position size
     ├── Set slippage limits
     ├── Submit via MEV-protected RPC
     └── Confirm execution

  6. REPORT
     ├── Log trade to portfolio tracker
     ├── Pin to IPFS (--post flag)
     ├── Attest via EAS
     ├── Post to syndicate XMTP chat
     └── Send Telegram alert to operator

  7. SLEEP until next cycle
```

---

## CLI Commands (proposed additions to sherwood CLI)

```bash
# Start the autonomous trading agent
sherwood agent start --strategy all --cycle 1h --dry-run

# Run specific strategy only
sherwood agent start --strategy smart-money --cycle 4h

# Check agent status and open positions
sherwood agent status

# View trade history and PnL
sherwood agent history --period 7d

# Pause/resume trading
sherwood agent pause
sherwood agent resume

# Backtest a strategy on historical data
sherwood agent backtest --strategy sentiment --from 2024-01-01 --to 2024-12-31

# Set risk parameters
sherwood agent config --max-risk 15 --max-position 10 --daily-loss-limit 5

# View current signal scores
sherwood agent signals --token ETH

# One-shot research + score (no trade execution)
sherwood agent analyze --token ETH
```

---

## Implementation Phases

### Phase 1 — Data Layer (Week 1)
- [ ] Integrate free APIs (DefiLlama, CoinGecko, Fear&Greed) as data providers
- [ ] Add technical analysis library (ta-lib or technicalindicators)
- [ ] Build signal scoring framework
- [ ] Wire existing `sherwood research` commands into the agent loop

### Phase 2 — Strategy Engine (Week 2)
- [ ] Implement Strategy 1 (Smart Money Convergence)
- [ ] Implement Strategy 3 (Contrarian Sentiment)
- [ ] Implement Strategy 4 (Breakout + On-Chain)
- [ ] Build decision engine with multi-signal scoring

### Phase 3 — Execution & Risk (Week 3)
- [ ] Position sizing calculator
- [ ] Stop-loss manager (hard, trailing, time-based)
- [ ] MEV-protected transaction submission
- [ ] Drawdown protection (daily/weekly/monthly limits)
- [ ] Portfolio tracker

### Phase 4 — Automation (Week 4)
- [ ] Agent loop (configurable cycle)
- [ ] Dry-run mode with paper trading
- [ ] IPFS pinning + EAS attestation of trades
- [ ] XMTP chat reporting
- [ ] Telegram alerts
- [ ] Backtest framework

### Phase 5 — Advanced Strategies (Week 5+)
- [ ] Strategy 2 (Token Unlock Frontrun)
- [ ] Strategy 5 (Funding Rate Harvester)
- [ ] Strategy 6 (TVL Momentum)
- [ ] Strategy 7 (DEX Arbitrage via Flash Loans)
- [ ] X/Twitter sentiment pipeline (CryptoBERT)
- [ ] LunarCrush / Santiment integration

---

## Token Watchlist (initial)

### Large Cap (core positions)
- ETH, BTC (via WBTC), SOL

### DeFi Blue Chips
- AAVE, UNI, MKR, CRV, LDO, PENDLE

### L2 / Infrastructure
- ARB, OP, BASE ecosystem tokens

### Sherwood Native
- WOOD/WETH (primary pair on Aerodrome)

### Dynamic additions
- Agent should propose new tokens based on smart money signals and TVL momentum scans

---

## Cost Estimates

### x402 Research Costs (per cycle)
```
Nansen smart-money query:  $0.06 × 1     = $0.06
Nansen wallet queries:     $0.03 × 5     = $0.15
Messari token queries:     $0.15 × 10    = $1.50
Messari market query:      $0.20 × 1     = $0.20
                                    TOTAL ≈ $1.91/cycle

At 1h cycles: $1.91 × 24 = $45.84/day
At 4h cycles: $1.91 × 6  = $11.46/day
```

### Free API Calls (per cycle)
```
DefiLlama: unlimited (free, no key)
CoinGecko: 30 req/min free tier (plenty)
Fear & Greed: unlimited (free)
```

**Recommendation:** Run at 4h cycles for strategies 1-4, 6. Run strategies 5 (funding) at 8h. Run strategy 7 (arb) continuously on its own loop.

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Win Rate | > 55% | Profitable trades / total trades |
| Sharpe Ratio | > 1.5 | Risk-adjusted returns |
| Max Drawdown | < 15% | Largest peak-to-trough decline |
| Monthly Return | > 5% | Net of fees and gas |
| Avg Trade Duration | 1-14 days | Time in position |
| Signal Accuracy | > 60% | Correct directional calls |
| x402 ROI | > 10x | Trading profit / research costs |
