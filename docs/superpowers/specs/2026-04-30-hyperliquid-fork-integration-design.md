# Hyperliquid Fork Integration Tests + minReturnAmount Removal — Design Spec

## Motivation

Existing Hyperliquid strategy tests (`HyperliquidPerpStrategy.t.sol`, `HyperliquidGridStrategy.t.sol`) all use `MockCoreWriter` etched at the precompile address `0x3333...3333`. They validate calldata encoding but never exercise the contracts against the real HyperEVM precompile environment, the real HyperEVM-native USDC, or a full syndicate proposal lifecycle on HyperEVM.

This spec adds **fork integration tests** for the grid strategy that run the entire syndicate flow (deposit → propose → vote → guardian review → execute → grid orders → settle → sweep → redeem) against a HyperEVM mainnet fork.

While building the test, we found a **contract bug**: `sweepToVault()` enforces `minReturnAmount` cumulatively. If the strategy loses money (returned USDC < minReturnAmount), every sweep call reverts forever — vault funds become permanently stuck. This spec also removes `minReturnAmount` from both Hyperliquid strategies.

## Scope

- New abstract base: `contracts/test/integration/HyperEVMIntegrationTest.sol`
- New test contract: `contracts/test/integration/HyperliquidGridFork.t.sol` (3 happy-path lifecycle tests)
- Contract changes:
  - Remove `minReturnAmount` from `HyperliquidGridStrategy` (init param, storage, `sweepToVault()` check, `InsufficientReturn` error)
  - Remove `minReturnAmount` from `HyperliquidPerpStrategy` (same shape — applies the same fix)
  - Update unit tests in both strategy test files to drop the `MIN_RETURN` constant and remove min-return-related tests
- Deploy-script refactor: extract internal helpers from `Deploy.s.sol::run()` and `DeployTemplates.s.sol::run()` so tests can deploy without writing to `chains/{chainId}.json`

**Out of scope:**
- `HyperliquidPerpStrategy` fork test (focus is grid only — per user direction)
- Real HyperCore order placement / live testnet smoke tests
- Edge-case fuzzing on the fork (slow; edge cases stay in unit tests)

## Architecture

### Test base: `HyperEVMIntegrationTest`

Mirrors the pattern of `BaseIntegrationTest` and `RobinhoodIntegrationTest`. Forks HyperEVM mainnet via `vm.createSelectFork(vm.envString("HYPEREVM_RPC_URL"))` in `setUp()`, then:

1. Calls deploy-script helpers to deploy fresh protocol contracts on the fork (governor proxy, factory proxy, registry proxy, vault impl, executor lib, Hyperliquid grid template)
2. Funds LPs with HyperEVM-native USDC at `0xb88339CB7199b77E23DB6E890353E22632Ba630f` via `deal()`
3. Provides helpers: `_createSyndicate()`, `_proposeGridStrategy()`, `_voteAndExecute()`, `_settleAndSweep()`

If `HYPEREVM_RPC_URL` env var is unset, `setUp()` calls `vm.skip(true)` so the test suite passes without RPC configured. CI runs the integration suite only when the secret is set.

### What's validated on the fork

- HyperEVM-native USDC (`0xb88339...`) flows through factory → vault → strategy → back
- Full proposal lifecycle on HyperEVM (propose → vote → guardian review → execute → settle)
- `L1Write` precompile calls succeed (emit `RawAction` events on the fork — HyperCore won't process them, but the EVM-side flow is real)
- Strategy USDC stays in the contract after simulated `sendUsdClassTransfer` (since HyperCore can't move it on a fork) → `sweepToVault()` returns it → LPs can redeem
- Loss-recovery: even when the strategy returns less than the original deposit, sweep + redeem still works (validates the `minReturnAmount` removal)

### What's NOT validated (accepted scope)

- Whether HyperCore actually places orders / fills happen
- Real margin balance / position state changes after writes
- Cross-chain LayerZero behavior

## Contract Changes

### `HyperliquidGridStrategy.sol`

Remove from `_initialize` decode:
```solidity
// OLD: (address asset_, uint256 depositAmount_, uint256 minReturnAmount_, uint32 leverage_, uint256 maxOrderSize_, uint32 maxOrdersPerTick_, uint32[] assetIndices_)
// NEW: (address asset_, uint256 depositAmount_, uint32 leverage_, uint256 maxOrderSize_, uint32 maxOrdersPerTick_, uint32[] assetIndices_)
```

Remove storage:
```solidity
uint256 public minReturnAmount;  // DELETE
```

Remove from `sweepToVault()`:
```solidity
// OLD:
uint256 newTotal = cumulativeSwept + bal;
if (minReturnAmount > 0 && newTotal < minReturnAmount) {
    revert InsufficientReturn(newTotal, minReturnAmount);
}
cumulativeSwept = newTotal;

// NEW:
cumulativeSwept += bal;
```

Remove `InsufficientReturn` error.

Keep `cumulativeSwept` accumulator — useful for off-chain monitoring/reporting, but no longer gates anything.

### `HyperliquidPerpStrategy.sol`

Same shape: drop `minReturnAmount` from init params, storage, check, and error. Keep `cumulativeSwept`.

### Updated NatSpec on `sweepToVault()`

```solidity
/// @notice Push USDC back to the vault after async transfer completes.
/// @dev Permissionless — funds only go to the vault, no diversion possible.
///      Repeatable for partial async arrivals. NO minReturnAmount guard:
///      a strategy that loses money must still be able to return whatever
///      remains. The cumulative tracker (`cumulativeSwept`) records totals
///      for off-chain monitoring but does not gate withdrawals.
```

### Test updates

- `HyperliquidGridStrategy.t.sol`: remove `MIN_RETURN` constant, drop `test_sweepToVault_revertsIfBelowMinReturn` and `test_sweepToVault_dustRaceCannotBypassMinReturn`. Update `test_initialize` to assert the new param shape.
- `HyperliquidPerpStrategy.t.sol`: same — drop `MIN_RETURN`, remove `test_sweepToVault_enforces_minReturnAmount`, `test_sweepToVault_dustRaceCannotBypassMinReturn`, `test_sweepToVault_zeroMinReturn_skipsCheck`. Update `test_initialize` and other init helpers.

## Test Scenarios

`contracts/test/integration/HyperliquidGridFork.t.sol`:

### `test_fullLifecycle_placeGridAndSettle`

1. Create syndicate via factory; LPs deposit USDC (60k + 40k = 100k)
2. Agent proposes `HyperliquidGridStrategy` clone (assetIndices = [3, 4, 5] for BTC/ETH/SOL perp markets, leverage = 5x, maxOrdersPerTick = 32, maxOrderSize = 50k)
3. Vote → `vm.warp` past voting period → open guardian review → `vm.warp` past review window → execute
4. Assert vault USDC drained, strategy holds full deposit (since fork can't move it)
5. Verify `RawAction` events emitted via `vm.recordLogs()`: 3 leverage-update events + 1 USD-transfer event
6. Agent calls `updateParams(ACTION_PLACE_GRID, [...])` with 30 GTC orders (5 per side per asset × 3 assets) → verify 30 `RawAction` events emit with correct CLOIDs
7. `vm.warp` past strategy duration → `settleProposal` → `_settle()` emits 6 force-close orders (long+short per asset × 3) + 1 transfer
8. `sweepToVault()` → strategy USDC returns to vault
9. LPs redeem proportional shares — total returned ≈ deposited (within rounding)

### `test_fullLifecycle_cancelAndPlaceRebalance`

1. Setup through initial place (steps 1–6 above)
2. Agent calls `updateParams(ACTION_CANCEL_AND_PLACE, assetIndex=3, oldCloids, newOrders)` simulating a rebalance
3. Verify both cancel `RawAction`s AND new place `RawAction`s emit in the same tx via `vm.recordLogs()`
4. Settle + sweep happy path

### `test_fullLifecycle_lossyStrategyStillReturnsFunds`

1. Setup through execute
2. Test harness drains most of the strategy's USDC mid-flight via `vm.prank(address(strategy))` + `usdc.transfer(burn, X)` — simulates a loss leaving e.g. 1000 USDC of 10000 deposited
3. `vm.warp` past duration → settle → `sweepToVault()` succeeds, returns 1000 USDC to vault — **no revert despite "loss"**
4. LPs redeem proportional shares against the diminished vault balance
5. Asserts `cumulativeSwept` advances correctly

## Test Infrastructure

### `HyperEVMIntegrationTest.sol`

Abstract base. Constants:

```solidity
address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
```

Test actors: `owner`, `agent`, `lp1`, `lp2` (via `makeAddr`).

Deployed protocol fields: `governor`, `factory`, `registry`, `vaultImpl`, `executorLib`, `hyperliquidGridTemplate`.

### Deploy-script refactor

Extract internal helpers so tests can deploy without writing to `chains/{chainId}.json`:

- `Deploy.s.sol`: refactor `run()` to call `_deployCore()` (returns `DeployedAddresses` struct) + `_persistAddresses(addrs)`. Tests call `_deployCore()` only.
- `DeployTemplates.s.sol`: refactor `run()` to call `_deployTemplates()` + `_persistTemplates(addrs)`. Tests call `_deployTemplates()` only.

### Fork setup pattern

```solidity
function setUp() public virtual {
    string memory rpc = vm.envOr("HYPEREVM_RPC_URL", string(""));
    if (bytes(rpc).length == 0) vm.skip(true);
    vm.createSelectFork(rpc);

    _deployProtocol();
    _deployTemplates();

    deal(USDC, lp1, 60_000e6);
    deal(USDC, lp2, 40_000e6);
}
```

### Helper signatures

```solidity
function _createSyndicate() internal returns (SyndicateVault);
function _proposeGridStrategy(uint32[] memory assetIndices, uint256 deposit)
    internal returns (uint256 proposalId, address clone);
function _voteAndExecute(uint256 proposalId) internal;
function _settleAndSweep(uint256 proposalId, address strategyClone) internal;
```

### Invocation

```bash
forge test --fork-url $HYPEREVM_RPC_URL --match-path "test/integration/HyperliquidGridFork.t.sol"
```

CI gates this on the `HYPEREVM_RPC_URL` secret being set; local dev runs the unit suite by default (no RPC needed).

## Error Handling

- Missing RPC → `vm.skip(true)`, suite passes silently
- RPC timeout → `forge test` reports failure, re-run is recovery path
- Fork tests are slow (~30s/test due to setup + warp). Run in their own CI job, not on every push.
- Each test starts from a fresh fork — Foundry resets state per test with `vm.createSelectFork`. No cross-test pollution.
- HyperCore precompile responses on fork are mainnet state for our freshly-deployed strategy = zero. We assert via `RawAction` event captures, not post-state reads.

## Out of Scope

- `HyperliquidPerpStrategy` fork test (separate follow-up if needed; same `HyperEVMIntegrationTest` base would be reused)
- Real HyperCore order placement / live testnet smoke tests (separate cron-style validation)
- Edge-case fuzzing on the fork (slow; covered by unit tests with `MockCoreWriter`)
- Updating `mintlify-docs` for the `minReturnAmount` removal (will be folded into the implementation PR)
