# Live NAV + Async Withdrawal Queue — Design Spec

**Status:** Draft, awaiting review
**Branch:** `feat/live-nav-async-withdrawals`
**Date:** 2026-04-30
**Tracks:** Pre-mainnet competitive parity vs. Concrete.xyz

---

## 1. Goal

Close two competitive gaps vs. Concrete.xyz that today force LP capital to sit
idle whenever a Sherwood vault has an active proposal:

- **Phase 1 — Async withdrawal queue.** Allow LPs to queue redemptions during
  an active proposal. Queued requests escrow shares in a `WithdrawalQueue`
  contract and drain automatically (permissionlessly) once the lock clears
  post-settle. LPs no longer have to time their exits around the proposal
  lifecycle.
- **Phase 2 — Live per-strategy NAV.** Expose live NAV through
  `BaseStrategy.positionValue()` so the vault's `totalAssets()` accounts for
  capital deployed into the active strategy. When the bound adapter reports
  `valid=true`, deposits and withdrawals stay open during an active proposal,
  and new deposits flow straight into the strategy via `onLiveDeposit`. When
  `valid=false` (Mamo / Venice / off-chain compute), the vault falls back to
  Phase 1's queue.

Together these two phases bring Sherwood's UX in line with Concrete's
multi-strategy vault: TVL stays productive, LPs can enter and exit without
waiting on governance windows, and the queue is the only fallback for
strategies whose NAV genuinely cannot be observed on-chain.

---

## 2. Background — competitor analysis (Concrete.xyz)

Concrete's `ConcreteMultiStrategyVault.totalAssets()` polls every bound
strategy adapter:

```
totalAssets = float + Σ adapter[i].convertToAssets(strategy.balanceOf(vault))
```

Each adapter wraps a single underlying protocol (Aave, Morpho, etc.) and
exposes a deterministic NAV read. Their `WithdrawalQueue` is a Lido-style
fork: an LP `requestWithdraw`s, an owner role periodically `finalize`s a
batch, and the LP `claim`s after finalize. Float and live NAV are always
exposed; the queue exists for the case where requested withdrawals exceed
available liquidity.

Sherwood today differs on both fronts:

- `SyndicateVault.totalAssets()` returns only the float (USDC sitting in the
  vault). Once capital is deployed into a strategy via `executeGovernorBatch`,
  the vault has no view of its current value until the strategy is settled.
- `redemptionsLocked()` (the on-chain check the vault uses to guard ERC4626
  entry/exit) gates **both** deposits and withdrawals during any active
  proposal. Capital in cannot enter, capital out cannot exit, until settle.

This plan adopts a queue (Phase 1) and a live-NAV adapter rail (Phase 2). We
are not adopting Concrete's full multi-strategy allocation model — Sherwood
runs one active strategy at a time per vault. See §9.

---

## 3. Lock-state truth table

Behavior of vault entrypoints across the four runtime states. `Idle` means
`getActiveProposal() == 0`. `valid` is the second return of
`IStrategy(adapter).positionValue()`.

| State                                       | `deposit` / `mint` | `withdraw` / `redeem` | `requestRedeem`     | `claimRedeem`      |
|---------------------------------------------|--------------------|-----------------------|---------------------|--------------------|
| Idle (no active proposal)                   | open               | open                  | reverts (no lock)   | open (drains FIFO) |
| Active proposal, no adapter bound           | locked             | locked                | open                | locked until idle  |
| Active proposal, adapter bound, `valid=true`| open (forwards into strategy via `onLiveDeposit`) | open (capped at `float - reserve`) | open  | open               |
| Active proposal, adapter bound, `valid=false`| locked            | locked                | open                | locked until idle  |

Notes:

- The `withdraw` cap in row 3 is `float - reservedQueueAssets()` — see §4.
  Withdrawals up to that cap are served straight from float without touching
  the strategy, so adapter-side `onLiveWithdraw` is not required for v1.
- `requestRedeem` is open in every locked state. It is the only LP-side exit
  path while the lock is on.
- `claimRedeem` is callable by anyone (permissionless drain), but only
  succeeds while the vault is unlocked.

---

## 4. Queue lifecycle

### 4.1 Share escrow flow

```
[lock on]
  LP ──vault.requestRedeem(shares, owner)──▶ SyndicateVault
                                              - require redemptionsLocked()
                                              - vault._transfer(owner → queue)
                                              - queue.recordRequest(owner, shares)
                                              - emit RedeemRequested(id, owner, shares)

  LP (optional, before claim) ──queue.cancel(id)──▶ WithdrawalQueue
                                              - require msg.sender == request.owner
                                              - vault._transfer(queue → owner)
                                              - delete request

[lock cleared post-settle]
  anyone ──queue.claim(id)──▶ WithdrawalQueue
                              - require !vault.redemptionsLocked()
                              - vault.redeem(shares, owner, address(queue))
                                  · vault burns shares the queue holds
                                  · vault transfers assets to owner
                              - emit RedeemClaimed(id, owner, assets)
```

Key properties:

- **Shares are not burned at request.** They are held by the queue. The owner
  can `cancel` to recover them at any time before `claim`. This matters for
  the governance integrity argument in §7 — escrowed shares retain their
  ERC20Votes weight at the proposal snapshot, so cancellation does not leak
  weight.
- **Claim is permissionless** but no-ops while locked. Anyone (including a
  bot) can drain the queue once the lock clears. There is no per-LP race; the
  queue processes requests in any order because each request claims at the
  same post-settle NAV.
- **Claim NAV is the post-settle NAV.** The queue calls `vault.redeem(...)`
  at claim time, so each requester gets a pro-rata share of `totalAssets()`
  at that moment — same as a fresh `redeem()` would.

### 4.2 Reserve enforcement

The vault tracks the float reserved for queued requests:

```
reservedQueueAssets() = convertToAssets(queue.pendingShares())
```

`pendingShares()` is the sum of shares held by the queue across every
non-cancelled, non-claimed request. The vault uses this in
`maxWithdraw(owner)` and in `_withdraw`'s liquidity check:

- A regular `withdraw` from an LP succeeds only if
  `assets <= float - reservedQueueAssets()`.
- A `claim` from the queue bypasses this cap — the queue is the rightful
  owner of the reserved float and is processing exactly the requests that
  reserved it.

This means queued users never starve: their share of the float is reserved
the moment they call `requestRedeem`, and direct withdrawals from other LPs
respect that reserve. If `valid=true` deposits keep coming in during the
lock, those deposits inflate the float and shrink the relative pressure of
the reserve — strictly helpful to queue claimants.

---

## 5. Phase 2 NAV math

### 5.1 `totalAssets()`

```
(value, valid) := adapter == address(0) ? (0, false) : IStrategy(adapter).positionValue();
totalAssets = float + (adapter == address(0) ? 0 : (valid ? value : 0))
```

When no adapter is bound, behavior is identical to today (float-only).
When an adapter is bound but reports `valid=false`, NAV still reads as
float-only — the strategy's deployed capital is invisible to the vault until
settle. This is the conservative path for off-chain strategies (Mamo,
Venice, Hyperliquid).

When an adapter is bound and reports `valid=true`, `totalAssets()` includes
live position value, and the vault unlocks `_deposit` / `_withdraw` even
during an active proposal. See §3 row 3.

### 5.2 Conversion math is unchanged

OZ ERC4626's virtual-shares inflation protection still holds. With
`_decimalsOffset = asset.decimals()` (today's setting):

```
shares = assets * (totalSupply + 10^offset) / (totalAssets + 1)
assets = shares * (totalAssets + 1) / (totalSupply + 10^offset)
```

The only change is that `totalAssets` is no longer just the float when an
adapter is bound. The virtual-shares term `(totalSupply + 10^offset)` and
the `+1` denominator are untouched, so first-depositor inflation is still
defended. No new unit conversions; no decimal mixing.

### 5.3 Live deposit forwarding

When `valid=true` and a new `_deposit` arrives during a lock, the vault
calls `IStrategy(adapter).onLiveDeposit(assets)` immediately after
collecting the asset transfer. Capital starts earning the same block. The
vault still mints shares against the post-deposit `totalAssets`, but
because `onLiveDeposit` is part of the same external call, NAV is fully
consistent at share-price computation time.

When `valid=false`, the vault behaves as today (locked), the queue is the
only exit path, and `onLiveDeposit` is never invoked.

### 5.4 Live withdraw

For v1 we do **not** add `onLiveWithdraw`. Direct withdrawals during a lock
are served from the float, capped at `float - reservedQueueAssets()`. If an
LP wants to exit beyond the float, they queue. This keeps the strategy
adapter surface minimal and avoids per-strategy unwind logic.

---

## 6. Strategy support matrix

Based on the strategies in `contracts/src/strategies/`:

| Strategy                  | `positionValue` `valid` | `onLiveDeposit`                              | Notes |
|---------------------------|-------------------------|----------------------------------------------|-------|
| `MoonwellSupplyStrategy`  | true                    | mint additional mToken                       | `mToken.balanceOfUnderlying(vault)` is the live NAV; deposit forwards into `mToken.mint`. |
| `WstETHMoonwellStrategy`  | true                    | mint additional mToken                       | Same as Moonwell core, plus the wstETH/stETH wrap leg pinned to `IStETH.getPooledEthByShares`. |
| `AerodromeLPStrategy`     | true                    | no-op (default)                              | NAV via LP-token redemption preview against the pool reserves. `onLiveDeposit` would require rebalancing both legs of the pool — left as future work for v1. |
| `MamoYieldStrategy`       | false                   | n/a                                          | Mamo accrues yield off-chain. NAV cannot be read on-chain → falls back to queue. |
| `VeniceInferenceStrategy` | false                   | n/a                                          | Off-chain compute strategy. No on-chain NAV. |
| `HyperliquidPerpStrategy` | false                   | n/a                                          | Hyperliquid PnL lives outside EVM state. |
| `PortfolioStrategy`       | false (default)         | n/a (default)                                | Composite of child strategies. Default to `false` for safety; a future v1.1 can recurse `positionValue` over children once each child's correctness is verified. |

`BaseStrategy` provides default `positionValue() returns (0, false)` and a
default `onLiveDeposit(uint256) {}` no-op so non-supporting strategies need
no changes. Strategies that opt in override both.

---

## 7. Governance integrity rationale

Allowing deposits during an active proposal does not break optimistic-veto
math. The argument rests on ERC20Votes checkpoints:

- **Vault shares are ERC20Votes.** A holder's voting weight at any
  historical timestamp is the checkpoint value at that timestamp, not their
  live balance.
- **Proposal vote weight is read at the snapshot.** `voteOnProposal` resolves
  weight via `getPastVotes(voter, voteSnapshotAt)`, where
  `voteSnapshotAt` is stamped at `propose()` (and `openReview` for guardian
  cohort, per the registry). A new deposit at `block.timestamp >
  voteSnapshotAt` produces a checkpoint that is strictly *after* the
  snapshot, so the new shares contribute zero weight to the in-flight
  proposal.
- **Same logic isolates the guardian cohort.** The registry already reads
  `_stakeCheckpoints[voter].upperLookupRecent(r.openedAt)` and
  `_delegatedInboundCheckpoints[voter].upperLookupRecent(r.openedAt)` to
  freeze the cohort at the review-open instant. New WOOD movements (own
  stake or delegation) after `openedAt` cannot influence an open review.
- **Escrowed shares retain their snapshot weight.** When an LP calls
  `requestRedeem` and the queue takes custody, the shares are *transferred*,
  not burned. ERC20Votes registers a delegation move from `owner` to
  `address(queue)`. The owner's pre-transfer checkpoint at
  `voteSnapshotAt` is unchanged, so any vote they already cast retains its
  weight. If the owner cancels before claim, custody returns and future
  proposal snapshots count those shares again.

The conclusion: late depositors cannot influence a proposal opened before
their deposit, and queued exiters cannot retroactively withdraw weight
they already contributed to a snapshot. Both directions are checkpoint-safe.

---

## 8. Storage layout impact

V1.5 is a fresh redeployment per `CLAUDE.md`, so we append slots and reduce
`__gap`. No reorder, no in-place insertion.

| Slot append            | Phase | Used by                                                       |
|------------------------|-------|---------------------------------------------------------------|
| `_withdrawalQueue`     | 1     | `requestRedeem`, `reservedQueueAssets`, `claim` integration   |
| `_activeStrategyAdapter` | 2   | `totalAssets`, `_deposit` live-forwarding, `redemptionsLocked` short-circuit |

`__gap` reduction: `38 → 37 → 36`. The two slots both live on
`SyndicateVault` storage; `WithdrawalQueue` is a separate contract with its
own storage.

Both slots are zero-initialized on a fresh proxy, so existing tests that
don't touch the queue or adapter behave identically — `adapter == 0` keeps
`totalAssets()` at the pre-change formula, and `_withdrawalQueue == 0` is
detected by `requestRedeem` as "queue not configured" and reverts. Setters
(`setWithdrawalQueue`, `setActiveStrategyAdapter`) are owner-only and
emit `ParameterChangeFinalized` so the multisig delay applies via Gnosis
Safe + Zodiac (consistent with V1.5's "no on-chain timelock" stance).

---

## 9. Out of scope (deferred)

The following are explicitly **not** part of this plan. They are recorded
here so future contributors don't re-litigate the choice during review.

- **EIP-7540 async-redemption standard.** We're shipping a Sherwood-native
  queue rather than the full ERC-7540 surface. ERC-7540 adds a request-id
  ABI, share-claim semantics, and operator hooks that we don't need today.
  When we have a second LP-facing integrator that demands the standard, we
  can wrap our queue behind a 7540-conforming adapter.
- **Concrete-style multi-strategy allocation BPS array.** Concrete vaults
  hold a `bytes[]` of allocations across N adapters at once. Sherwood runs
  one active strategy per vault per proposal — adding multi-allocation here
  is a larger architectural lift (rebalancing logic, per-adapter accounting)
  that should be its own spec.
- **Curator marketplace.** Concrete supports third-party curators who
  configure adapters. Sherwood's curators are the vault owner + agents; we
  don't expose curation as a separate role.

This plan adds the **minimum viable** live-NAV + queue. Anything more is a
follow-up.
