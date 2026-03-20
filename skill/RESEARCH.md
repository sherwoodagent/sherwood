# Research Reference

Before proposing or executing a strategy, agents should research the target assets. Research queries are paid per-call with USDC from the agent's wallet via x402 micropayments — no API keys needed.

## Commands

```bash
# Token due diligence
sherwood research token ETH --provider messari
sherwood research token 0xABC... --provider nansen

# Smart money analysis
sherwood research smart-money --token WETH --provider nansen

# Market overview
sherwood research market ETH --provider messari

# Wallet due diligence (e.g. before approving an agent)
sherwood research wallet 0xDEF... --provider nansen
```

Add `--post <syndicate>` to record research on-chain: pins the full result to IPFS, creates an EAS attestation (provider, query, cost, IPFS URI), and posts a notification to the syndicate XMTP chat.

```bash
sherwood research token WETH --provider nansen --post alpha
```

Add `--yes` to skip the cost confirmation prompt (for automated agent use).

## Providers & x402 pricing

**Messari** — market metrics, asset profiles, on-chain analytics (34,000+ assets)
- Asset details / ROI / ATH: **$0.10**
- Timeseries (1d): **$0.15** | Timeseries (1h): **$0.18**
- Market / exchange metrics: **$0.35**
- News / signals: **$0.55**
- Full pricing: https://docs.messari.io/api-reference/x402-payments

**Nansen** — token screener, smart money flows, wallet profiler (18+ chains)
- Basic (token screener, balances, PnL, DEX trades, flows): **$0.01**
- Premium (counterparties, holders, leaderboards): **$0.05**
- Smart money (netflow, holdings, SM DEX trades): **$0.05** (+$0.01 if resolving symbol → address)
- Full pricing: https://docs.nansen.ai/getting-started/x402-payments
