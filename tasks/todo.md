# feat/hyperliquid-strategy — Review Fixes

## Critical (Fixed)
- [x] `sweepToVault()` — added `onlyProposer` modifier + zero-balance revert
- [x] `minReturnAmount` — enforced in `sweepToVault()` with `InsufficientReturn` error
- [x] CLI version bump — `0.23.0` -> `0.25.0`
- [x] SyndicateFactory — restored null-safety guards for `ensRegistrar` and `agentRegistry`
- [x] Leverage validation — added `leverage >= 1 && <= 50` check in `_initialize()`

## High (Fixed)
- [x] Phase 2 settlement in CLI — added `sweepToVault` ABI + `buildSweepToVaultCalls` template
- [x] Pragma pinned — L1Read.sol, L1Write.sol, CoreWriter.sol now use `0.8.28`

## Medium (Fixed)
- [x] Risk config bounds — `agent config --set` validates values within safe bounds
- [x] Portfolio JSON validation — `load()` validates numeric fields are finite/non-negative
- [x] DexScreener throttle — moved to module-level shared across instances
- [x] Backtest Sharpe — now subtracts risk-free rate (5% annual)
- [x] Duplicate `DEFAULT_PORTFOLIO` — renamed to `EMPTY_PORTFOLIO` in risk.ts

## Low (Fixed)
- [x] `trades.json` — atomic writes via tmp-and-rename pattern
- [x] `--days` CLI arg — validated with `Math.max(1, parseInt(...) || 30)`
- [x] Indentation — fixed `portfolio.ts:143` and `risk.ts:123`
- [x] `clamp()` — extracted to shared `cli/src/agent/utils.ts`, removed 9 duplicates
- [x] `market-maker/README.md` — removed leftover file + directory
- [x] `TRADING_AGENT_STRATEGY.md` — added disclaimer about aspirational vs implemented

## Previously Outstanding (Now Fixed)
- [x] Foundry tests — 32 tests for HyperliquidPerpStrategy (init, execute, updateParams, settle, sweepToVault lifecycle)
- [x] CLI tests — vitest tests for utils, risk, scoring, portfolio modules
- [x] HyperEVM chain config — added `hyperevm` and `hyperevm-testnet` networks (999/998) to CLI
- [x] NatSpec — documented `positionOpen` async desync with HyperCore
- [x] CoreWriter — moved mock to `test/mocks/MockCoreWriter.sol`, documented src/ version as interface stub
- [x] Forge build — updated Foundry 0.2.0 -> 1.5.1 (fixes `osaka` evm_version error)
- [x] Bug fix — `_updateParams` action byte reading (`data[:1]` -> `abi.decode(data[:32])`)

## Still Outstanding (Requires Deployment/External Work)
- [ ] `HYPERLIQUID_PERP` template address is zero on all networks (deploy `DeployTemplates.s.sol` on HyperEVM first)
- [ ] No `contracts/chains/999.json` for HyperEVM mainnet (created by deploy scripts)
- [ ] `_cancelAllOrdersForAsset()` only cancels latest CLOID (HyperCore API limitation)
- [ ] Python TGE simulation scripts in `scripts/` unrelated to this branch
