# feat/hyperliquid-strategy — Review Fixes

## Critical (Fixed)
- [x] `sweepToVault()` — callable by anyone (funds only go to vault), zero-balance revert, minReturnAmount on first sweep
- [x] `minReturnAmount` — enforced in `sweepToVault()` with `InsufficientReturn` error
- [x] CLI version bump — `0.23.0` -> `0.26.0`
- [x] SyndicateFactory — null-safety guards for `ensRegistrar` and `agentRegistry`
- [x] Leverage validation — `leverage >= 1 && <= 50` in `_initialize()`

## High (Fixed)
- [x] Phase 2 settlement in CLI — `sweepToVault` ABI + `buildSweepToVaultCalls` template
- [x] Pragma pinned — L1Read.sol, L1Write.sol, CoreWriter.sol use `0.8.28`
- [x] Executor limitPx/sz math — limitPx = currentPrice * 1.01, sz = quantity (not USD)

## Architectural Changes (Applied)
- [x] Removed `positionOpen` flag — L1Read.position2() is source of truth
- [x] 1-phase settlement — sweepToVault callable by anyone, repeatable, non-terminal
- [x] Single fixed CLOID — removed nonce, O(1) gas, hasActiveStopLoss tracking
- [x] On-chain risk params — maxPositionSize + maxTradesPerDay enforced per proposal
- [x] CLI live execution — `--mode hyperliquid-perp` wired to updateParams via viem

## Deployment (Complete)
- [x] Generic Deploy.s.sol with CREATE3 + env-based chain config
- [x] HyperEVM deployment: Factory, Governor, VaultImpl, ExecutorLib, all templates
- [x] `contracts/chains/999.json` complete with all addresses
- [x] CLI addresses.ts updated (Factory, Governor, USDC, HyperliquidPerp template)
- [x] Frontend contracts.ts updated (chain def, addresses, badge, RPC)
- [x] USDC address: `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
- [x] Syndicate #1 created: vault `0x9cC32B1a04c4ae5236a29e69fedFD468AA97F83F`

## Tests
- [x] 41 Foundry tests passing (HyperliquidPerpStrategy)
- [x] 4 CLI test files (utils, risk, scoring, portfolio)

## Data Providers
- [x] FundingRateProvider (Binance free API) — wired to FundingRateStrategy
- [x] TokenUnlocksProvider (DefiLlama FDV) — wired to TokenUnlockStrategy
- [x] `--x402` flag for Nansen + Messari paid data

## Follow-up (Not Blocking Merge)
- [ ] Tests for FundingRateProvider and TokenUnlocksProvider
- [ ] Tests for executor live mode
- [ ] `buildSweepToVaultCalls` is exported but unused (Phase 2 is manual — needs CLI `strategy sweep` command)
