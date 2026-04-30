# HyperliquidGridStrategy — Live Grid Execution Design

## Motivation

The grid strategy has been paper-trading profitably ($900/day on $5k, 133 RTs/day) but only simulates fills against price — no real orders are placed. To use syndicate vault funds, execution must go on-chain through the Sherwood proposal lifecycle.

## Architecture

**Hybrid model (Option C):** A new `HyperliquidGridStrategy` contract inherits `BaseStrategy` and uses HyperEVM `L1Write` precompiles to place/manage grid orders on HyperCore. The proposer EOA (keeper) calls `updateParams()` every 60 seconds to drive the grid. Grid intelligence (ATR computation, level calculation, rebalance decisions) stays off-chain in the existing TypeScript `GridManager`.

### Money Flow

```
Vault (USDC)
    ↓ execute()
Strategy contract pulls USDC, sends to HyperCore margin via L1Write.sendUsdClassTransfer()
    ↓
Keeper calls updateParams(ACTION_CANCEL_AND_PLACE) every 60s
    ↓ L1Write.sendLimitOrder() × N
GTC limit orders resting on HyperCore orderbook
    ↓ fills happen naturally on HyperCore
Keeper polls positions via L1Read/SDK, detects fills, updates grid state
    ↓ settle()
Force-close all positions, transfer USD back to spot, sweepToVault() → Vault
```

### Trust Model

Same as `HyperliquidPerpStrategy` — the proposer is trusted to send good orders via `updateParams`. On-chain safety bounds cap risk:
- `maxOrdersPerTick` — limits orders per `updateParams` call (default 32)
- `maxPositionSize` — caps total notional exposure per asset
- `leverage` — set once at init, immutable for the strategy lifetime
- `assetIndices` whitelist — only pre-approved HL asset indices can be traded

## Strategy Contract

### Init Params

```solidity
(
    address asset_,          // USDC
    uint256 depositAmount_,  // 0 = dynamic-all (use vault's full balance)
    uint32 leverage_,        // 1-50x (default 5)
    uint256 maxPositionSize_, // Per-asset notional cap in USDC
    uint32 maxOrdersPerTick_, // Safety cap (default 32)
    uint32[] assetIndices_   // HL perp asset indices [BTC=3, ETH=4, SOL=5]
)
```

### Action Types

`ACTION_PLACE_GRID = 1` — Place batch of GTC limit orders.
```
Encoding: (uint8 action, GridOrder[] orders)
GridOrder: (uint32 assetIndex, bool isBuy, uint64 limitPx, uint64 sz)
```
Validates `orders.length <= maxOrdersPerTick`. Each order is placed as a GTC limit via `L1Write.sendLimitOrder()` with `reduceOnly=false`.

`ACTION_CANCEL_ALL = 2` — Cancel all open orders for an asset.
```
Encoding: (uint8 action, uint32 assetIndex, uint128[] cloids)
```
The keeper passes the CLOIDs to cancel (computed deterministically off-chain from the same formula). The contract iterates and calls `L1Write.sendCancelOrderByCloid()` for each. This avoids storing CLOIDs on-chain — the keeper and contract share the deterministic formula.

`ACTION_CANCEL_AND_PLACE = 3` — Atomic cancel + place (used on rebalance).
```
Encoding: (uint8 action, uint32 assetIndex, GridOrder[] orders)
```
Cancel all for asset, then place new orders. Single `updateParams` call = single tx.

### CLOID Tracking

Each placed order gets a deterministic CLOID: `keccak256(assetIndex, isBuy, levelIndex, nonce)` truncated to `uint128`. The strategy tracks a `nonce` that increments on each grid rebuild, making prior CLOIDs stale. This enables targeted cancellation without storing order IDs from HyperCore.

### Lifecycle

`_execute()`:
1. Pull USDC from vault
2. `L1Write.sendUsdClassTransfer(amount, true)` — move to HyperCore margin
3. `L1Write.sendUpdateLeverage(asset, true, leverage)` for each asset index

`_settle()`:
1. Cancel all tracked orders on all assets
2. Force-close all positions (reduce-only IOC at extreme prices, same pattern as `HyperliquidPerpStrategy`)
3. `L1Write.sendUsdClassTransfer(type(uint64).max, false)` — move all USD back to spot

`sweepToVault()`:
- Permissionless, repeatable — pushes arrived USDC back to vault
- Same implementation as `HyperliquidPerpStrategy.sweepToVault()`

### L1Read Views

```solidity
function getPosition(uint32 asset) external view returns (Position memory);
function getMarginSummary() external view returns (AccountMarginSummary memory);
function getSpotBalance() external view returns (SpotBalance memory);
```

## Off-Chain Integration (GridLoop)

### Execution Mode Flag

`sherwood grid start --live --strategy <address>` activates live execution. Without `--live`, the grid runs in simulation mode (current behavior, unchanged).

### GridLoop Changes

Constructor accepts optional `strategyAddress` + `walletClient` (viem). When present, the loop runs in live mode:

**Normal tick (no rebalance):**
1. Fetch prices from Hyperliquid (unchanged)
2. Poll actual positions via HL SDK (`hlGetPositions()`) or `L1Read`
3. Compare positions against grid state to detect fills
4. Update PnL tracking based on real fills
5. No orders placed — GTC orders already resting

**Rebalance tick:**
1. Compute new grid levels via `GridManager.computeOrders(prices)`
2. Encode as `ACTION_CANCEL_AND_PLACE` calldata
3. Send `updateParams` tx via viem
4. Log placed orders

### Fill Detection

Instead of simulating fills when price crosses a level, the keeper:
1. Reads HyperCore positions via `hlGetPositions()`
2. Compares actual position size against expected (sum of placed buy orders that should have filled)
3. Detects round trips by tracking position size changes between ticks
4. Updates `GridTokenState.openFills` and stats based on real data

### GridManager Changes

New method: `computeOrders(prices: Record<string, number>): GridOrderPlan`

```typescript
interface GridOrderPlan {
  ordersToPlace: Array<{
    token: string;
    assetIndex: number;
    isBuy: boolean;
    price: number;
    quantity: number;
  }>;
  assetsToCancel: number[];  // asset indices needing cancel before place
  needsRebalance: boolean;
}
```

This extracts the grid level computation from `tick()` without the fill simulation. The existing `tick()` (simulation mode) stays unchanged.

## Proposal Lifecycle

- `strategyDuration`: 30 days (current `maxStrategyDuration`)
- When proposal expires: settle (closes all positions, returns USDC to vault), then re-propose
- Brief downtime during re-proposal (vote + execute window) — acceptable given paper results show profitability on 2-day windows
- Future improvement: rolling proposals (auto-settle + re-propose at day 25)

## Gas and Fee Analysis

**Gas (HyperEVM):** Effectively free. ~825k gas per rebalance tick × ~1 gwei = ~$0 in HYPE.

**Trading fees (Hyperliquid):** Grid uses GTC limit orders → maker fee (0.02% per side).
- Estimated: 130 RTs/day × $1,667 notional × 0.02% × 2 sides = ~$87/day
- vs ~$900/day gross grid profit = ~10% fee drag
- Net after fees: ~$810/day on $5k capital

**Funding rate:** Hedge shorts pay funding when rate is positive. Estimated ~$3/day based on current exposure. Negligible vs profits.

## Error Handling

**On-chain (strategy contract):**
- `maxOrdersPerTick` revert if too many orders
- `maxPositionSize` revert if notional exceeded
- Asset whitelist revert if unauthorized asset index
- State machine gates: `onlyProposer`, `State.Executed`

**Off-chain (keeper/GridLoop):**
- `updateParams` tx revert → log error, skip to next 60s cycle. GTC orders already resting aren't affected.
- Position polling failure → use cached state, don't place new orders
- Gas estimation failure → skip tick
- `pauseThresholdPct` (20% drawdown) → keeper stops calling `updateParams`

**Settlement:**
- `_settle()` force-closes all positions on all tracked assets
- `sweepToVault()` permissionless and repeatable for partial async USD arrivals
- If positions can't be closed (extreme illiquidity), settlement reverts — owner can `unstick` or `emergencySettle` via the governor

## Testing

**Solidity (Foundry):**
- Unit tests with `MockCoreWriter` (same pattern as `HyperliquidPerpStrategy` tests)
- Test: init, execute, updateParams with each action type, settle, sweepToVault
- Test: maxOrdersPerTick revert, maxPositionSize revert, unauthorized asset revert
- Test: CLOID generation determinism, nonce increment on rebuild

**TypeScript (vitest):**
- `GridManager.computeOrders()` unit tests (same level computation as `tick()`, different output format)
- Live mode integration: mock viem wallet, verify calldata encoding

**Manual (HyperEVM testnet):**
- Deploy strategy clone, propose, execute, run keeper loop
- Verify orders appear on HyperCore orderbook
- Verify fills are detected correctly
- Verify settlement closes all positions and returns USDC

## Out of Scope

- Rolling proposals (auto re-propose before expiry)
- On-chain ATR computation or grid intelligence
- Hedge integration on-chain (hedge stays off-chain for now)
- Fee rebate optimization (builder fee, referral)
- Multi-vault grid (one strategy clone per vault)
