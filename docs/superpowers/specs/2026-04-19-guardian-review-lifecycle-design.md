# Guardian Review Lifecycle — Design Spec (V1)

> **Status:** Design — awaiting review
> **Author:** Ana Julia
> **Date:** 2026-04-19
> **Tracks:** [imthatcarlos/sherwood#227](https://github.com/imthatcarlos/sherwood/issues/227)
> **Scope:** Pre-mainnet; breaking changes to governor lifecycle are acceptable.

## 1. Problem

Sherwood's governance is optimistic: proposals auto-pass after the voting period unless AGAINST votes reach a veto threshold. The only adversarial review today comes from the vault owner (running the informal `syndicate-owner` skill), who monitors proposals for their *own* vault. There is no economically incentivized third-party review layer, and nothing stops a compromised or absent vault owner from either (a) rubber-stamping a malicious proposal, or (b) abusing `emergencySettle` to execute arbitrary calldata against the vault.

Issue #227 proposes a staked, slashable guardian network. This spec scopes V1 to the on-chain primitives needed to:

1. Insert an enforceable guardian review step between proposal approval and execution.
2. Give guardians a quorum-based power to block malicious proposals.
3. Slash guardians who approve proposals that turn out to be malicious.
4. Require vault owners to post a slashable bond so their escape-hatch (`emergencySettle`) is no longer an unbounded trusted-root power.

Out of scope for V1 (tracked as follow-up specs):

- Guardian reward emissions, weekly reward cron, Minter integration for rewarding correct Approves.
- EAS attestation schema for guardian behavior + LLM-consumable knowledge base.
- Shareholder challenge / jury-style post-settlement adjudication (Option C).
- Hermes guardian skill upgrade (the off-chain agent that calls these primitives).

## 2. High-level lifecycle change

```
Today:
  Draft ──▶ Pending ──▶ Approved ──▶ Executed ──▶ Settled
                           │             │
                           └─▶ Rejected  └─▶ (Settled via emergencySettle w/ arbitrary calldata — unbounded owner power)

V1:
  Draft ──▶ Pending ──▶ GuardianReview ──▶ Approved ──▶ Executed ──▶ Settled
                               │                            │
                               ├─▶ Rejected (block quorum)  ├─▶ Settled (normal / proposer / unstick)
                               │   └─ early Approvers slashed
                               │                            └─▶ EmergencySettleReview ──▶ Settled
                               └─▶ Rejected (owner vetoProposal — Pending state only)     │
                                                                                          └─▶ Rejected (block quorum)
                                                                                              └─ owner slashed
```

Key invariants:

- Guardians cannot act before voting ends — they review *approved calldata*, not draft proposals.
- The owner's unilateral `vetoProposal` power is narrowed to `Pending` only (before guardians have weighed in).
- The owner's `emergencyCancel` power is narrowed to `Draft` and `Pending` (where funds are never at risk).
- Post-execution: `unstick(proposalId)` is owner-instant for stuck vaults (no new calldata), but any custom calldata goes through `EmergencySettleReview`.

## 3. Contracts

### 3.1 New: `GuardianRegistry.sol`

A single contract owning staking, unstaking, review vote accounting, and slashing for both guardian agents and vault owners. UUPS upgradeable, owned by the Sherwood protocol multisig. Interacts with `SyndicateGovernor` and `SyndicateFactory` via privileged hooks.

**Storage (conceptual — actual field order chosen to pack tightly):**

```solidity
// Guardian state
struct Guardian {
    uint128 stakedAmount;
    uint64 stakedAt;
    uint64 unstakeRequestedAt; // 0 = not requested
}
mapping(address => Guardian) private _guardians;
uint256 private _totalGuardianStake;      // sum of active guardian stake
uint256 private _activeGuardianCount;

// Owner stake (per-vault)
struct OwnerStake {
    uint128 stakedAmount;
    uint64 unstakeRequestedAt;
    address owner; // the staker (needed for slash credit / refund)
}
mapping(address vault => OwnerStake) private _ownerStakes;

// Pre-bind intent: owner stakes WOOD before the factory creates the vault.
struct PreparedOwnerStake {
    uint128 amount;
    uint64 preparedAt;
    bool bound;
}
mapping(address owner => PreparedOwnerStake) private _prepared;

// Proposal review state (one entry per proposal; lazily created on first vote)
struct Review {
    uint128 totalStakeAtOpen;   // snapshot of _totalGuardianStake on first vote; quorum denominator
    uint128 approveStakeWeight;
    uint128 blockStakeWeight;
    bool resolved;
    bool blocked;
}
// reviewEnd is NOT stored here — it lives on StrategyProposal.reviewEnd (governor),
// stamped alongside voteEnd at propose() / approveCollaboration() time.
mapping(uint256 proposalId => Review) private _reviews;
mapping(uint256 => mapping(address => VoteType)) private _votes;
mapping(uint256 => address[]) private _approvers; // for batch-slashing at resolution

// Emergency settle review
struct EmergencyReview {
    bytes32 callsHash;        // keccak256 of committed calldata array
    uint64 reviewEnd;
    uint128 totalStakeAtOpen; // snapshot of _totalGuardianStake
    uint128 blockStakeWeight;
    bool resolved;
    bool blocked;
}
mapping(uint256 proposalId => EmergencyReview) private _emergencyReviews;
mapping(uint256 => mapping(address => bool)) private _emergencyBlockVotes;

// Parameters (timelocked; pattern mirrors GovernorParameters)
uint256 public minGuardianStake;  // default: 10_000 WOOD
uint256 public minOwnerStake;     // default: 10_000 WOOD  (lowered from 50k — see §5)
uint256 public coolDownPeriod;    // default: 7 days
uint256 public defaultReviewPeriod; // default: 24 hours (used when proposer passes 0)
uint256 public minReviewPeriod;   // default: 6 hours  (lower bound on per-proposal override)
uint256 public maxReviewPeriod;   // default: 7 days   (upper bound on per-proposal override)
uint256 public blockQuorumBps;    // default: 3000 (30% of total guardian stake)
uint256 public rewardPerBlockWood;// default: 500 WOOD — flat bounty split pro-rata among Block voters on a blocked proposal
uint256 public rewardPool;        // WOOD held for guardian bounties; funded by treasury via fundRewardPool(amount)

// Slashing: WOOD is burned (not sent to treasury) — see §5 rationale
address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

// Privileged addresses
address public governor;
address public factory;
IERC20 public immutable wood;     // WOOD token
```

**Public / external functions:**

Guardian role:
- `stakeAsGuardian(uint256 amount)` — pull WOOD, register caller as active guardian. Requires `amount >= minGuardianStake`. Idempotent: existing guardians can top up.
- `requestUnstakeGuardian()` — marks `unstakeRequestedAt = block.timestamp`. Guardian immediately loses voting power (removed from `_totalGuardianStake`). Cannot re-vote until unstake is either cancelled or claimed.
- `cancelUnstakeGuardian()` — reverses an unstake request; stake becomes voting-eligible again.
- `claimUnstakeGuardian()` — after `coolDownPeriod` elapses, releases WOOD to guardian. Zero-stake guardians are fully deregistered.
- `voteOnProposal(uint256 proposalId, VoteType support)` — `Approve` or `Block`. The registry reads `reviewEnd` from the governor via `ISyndicateGovernor.getProposal(proposalId)` and the proposal's `voteEnd`; vote is allowed only when `voteEnd <= now < reviewEnd`. On the first vote for a given proposalId, snapshots `_totalGuardianStake` into `Review.totalStakeAtOpen` — this fixes the quorum denominator and prevents dilution by late-joining stakers. One vote per guardian per proposal; subsequent calls revert.

Owner role:
- `prepareOwnerStake(uint256 amount)` — pull WOOD into the registry under `_prepared[msg.sender]`. Does **not** yet bind to a vault. Must be ≥ `minOwnerStake`. One prepared stake per owner at a time.
- `cancelPreparedStake()` — only callable if not yet bound by the factory; refunds WOOD.
- `requestUnstakeOwner(address vault)` — vault owner only. Signals intent to exit; begins cool-down. Unstaking is **blocked while the vault has an active proposal** (any state between `Pending` and `Executed`) to prevent rage-quit around malicious executions.
- `claimUnstakeOwner(address vault)` — after cool-down, releases WOOD. Post-claim the vault is in a **grace-period** state (`ownerStaked == false`): new proposals cannot be created until owner re-binds a fresh stake.

Governor hooks:
- `openEmergencyReview(uint256 proposalId, bytes32 callsHash)` — **onlyGovernor**. Commits the calldata hash when owner calls `emergencySettleWithCalls`. Opens the window and snapshots `totalStakeAtOpen` immediately (unlike the proposal-review path, there's no earlier vote to piggyback on).
- `resolveReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Reads `reviewEnd` from the governor; requires `block.timestamp >= reviewEnd`. If no `Review` was ever created (no votes cast), returns `blocked = false` immediately. Otherwise computes `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`, sets `resolved = true`, and if `blocked`, invokes internal `_slashApprovers`. Returns cached `blocked` on subsequent calls. Governor calls this defensively from `_resolveState`; guardians/keepers can also call it to trigger slashing without waiting for someone to execute.
- `resolveEmergencyReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Same shape as `resolveReview` but resolves the emergency-settle window (using its own `reviewEnd` stored on the `EmergencyReview` struct) and invokes `_slashOwner` when blocked.

**Note on lifecycle integration:** the Pending → GuardianReview transition happens implicitly via `_resolveStateView` once `block.timestamp > voteEnd`. No external registry call is required at transition time — the registry only learns about the proposal when a guardian casts the first vote (or when `resolveReview` is called after `reviewEnd`).

Factory hook (onlyFactory):
- `bindOwnerStake(address owner, address vault)` — consumes `_prepared[owner]`, binds it as `_ownerStakes[vault]`. Reverts if no prepared stake.

Emergency-settle vote:
- `voteBlockEmergencySettle(uint256 proposalId)` — active guardians vote to block. Any single vote adds their stake weight to `blockStakeWeight`. When `blockStakeWeight >= blockQuorumBps * _totalGuardianStake / 10_000`, the review is flagged blocked (resolved at `resolveEmergencyReview` time).

Slashing (internal, triggered by governor):
- `_slashApprovers(uint256 proposalId)` — internal; invoked from `resolveReview` when block quorum resolves, or from the governor when owner calls `emergencyCancel` on a proposal that had recorded Approves. Iterates `_approvers[proposalId]`, zeroes each approver's stake, and **burns** the total slashed WOOD by transferring to `BURN_ADDRESS`. Capped gas-wise by `MAX_APPROVERS_PER_PROPOSAL = 100` (see §6).
- `_slashOwner(address vault)` — internal; invoked from `resolveEmergencyReview` when blocked. Zeros `_ownerStakes[vault].stakedAmount` and **burns** the slashed WOOD. Vault transitions into "owner must re-stake" state.
- **Appeal path (off-chain → on-chain):** a slashed party can petition the protocol multisig for refund. Multisig executes `refundSlash(address recipient, uint256 amount)` — **onlyOwner** on the registry, capped per-epoch — which transfers WOOD from the treasury reserve to the refund recipient. Requires governance vote record; spec in §7 and §10. No on-chain slash reversal — the burn is final; refund is a new treasury-funded transfer.

Reward distribution (Block-side, V1 minimal):
- `fundRewardPool(uint256 amount)` — **onlyOwner**. Pulls WOOD into `rewardPool`. Protocol treasury tops up this pool.
- `claimBlockReward(uint256 proposalId)` — active guardians who voted Block on a proposal that resolved `blocked = true` can claim their pro-rata share of `rewardPerBlockWood`, weighted by their stake at vote time over `blockStakeWeight`. Idempotent per (proposalId, guardian). Reverts if `rewardPool < payout` — treasury must top up.
- Note: no reward for correct Approve in V1. Correct-Approve rewards (the full "good guardians rewarded weekly" loop from issue #227) are deferred to V1.5 with emissions + EAS. V1 only rewards the *active-defence* action (Block) because that is the one that materially prevented an LP loss.

Parameter setters (timelocked — reuses `GovernorParameters` timelock pattern):
- `setMinGuardianStake`, `setMinOwnerStake`, `setCoolDownPeriod`, `setDefaultReviewPeriod`, `setMinReviewPeriod`, `setMaxReviewPeriod`, `setBlockQuorumBps`, `setRewardPerBlockWood`.

Views:
- `guardianStake(address)`, `ownerStake(address vault)`, `totalGuardianStake()`, `isActiveGuardian(address)`, `hasOwnerStake(address vault)`, `getReview(uint256)`, `getEmergencyReview(uint256)`, `preparedStakeOf(address owner)`, `canCreateVault(address owner)`, `pendingBlockReward(address guardian, uint256 proposalId)`.

### 3.2 Modified: `SyndicateGovernor.sol`

Minimal changes, scoped to what the governor has to know.

- **Enum:** append `GuardianReview` at end of `ProposalState`. New order: `{Draft, Pending, Approved, Rejected, Expired, Executed, Settled, Cancelled, GuardianReview}`. Appending (not inserting) preserves existing storage slots for in-flight proposals on test deployments; on mainnet this is a fresh redeploy under `feat/mainnet-redeployment-params`.
- **Struct:** append `uint256 reviewEnd` at end of `StrategyProposal`. Storage-safe append (mapping entries are independent slots). Stamped at proposal creation alongside `voteEnd` and `executeBy`.
- **Storage:** add `address private _guardianRegistry` and reduce `__gap` by one.
- **Initializer:** accept `guardianRegistry` address.
- **`propose()` signature change:** adds a trailing `uint256 reviewPeriodOverride` parameter. Proposer passes `0` to use `registry.defaultReviewPeriod()`, or a concrete value in `[registry.minReviewPeriod(), registry.maxReviewPeriod()]`. This gives time-sensitive strategies (funding-rate, oracle-reactive) a path to a shorter review at the cost of a higher perceived risk to guardians. Governor reverts with `InvalidReviewPeriod` if the override is outside the registry bounds at propose time.
- **`propose()` body:** after computing `voteEnd` (non-collaborative) or when collaborative consent completes in **`approveCollaboration()`**, stamp `reviewEnd = voteEnd + resolvedReviewPeriod` and shift `executeBy = reviewEnd + executionWindow` (execution window is measured from the *end of guardian review*, not the end of voting). This keeps the full lifecycle deterministic from creation — no mid-flight parameter drift and no registry call needed at Pending → GuardianReview transition.
- **`_resolveStateView` / `_resolveState`:** when `stored == Pending` and voting ended with no veto quorum:
  - If `block.timestamp <= proposal.reviewEnd`: return `GuardianReview` (lazy transition; no registry call).
  - Else: call `registry.resolveReview(proposalId)` → if `blocked == true`, transition to `Rejected` (registry auto-slashes approvers inside `resolveReview`). Else transition to `Approved`.
  - When `stored == GuardianReview`: same logic as above after voteEnd.
  - `Approved` → `Expired` logic is unchanged, just using the shifted `executeBy`.
- **`executeProposal`:** unchanged preconditions — still requires `state == Approved`. (The new gate is earlier: `Approved` is now only reachable after successful guardian review.)
- **`vetoProposal`:** narrow — allow only `Pending` state. Remove `Approved`/`GuardianReview` branch. (Rationale: once the proposal is in `GuardianReview`, owner unilateral veto is disempowering to guardians and bypasses the economic-security layer.)
- **`emergencyCancel`:** narrow — allow only `Draft` and `Pending`. Remove `Approved`/`GuardianReview` branches. In those states, if owner wants to stop execution, they stake WOOD as a guardian and vote Block like everyone else.
- **Remove `emergencySettle`.** Replace with three functions:
  - `unstick(uint256 proposalId)` — owner-only. Runs only the pre-committed `_settlementCalls` (no fallback, no custom calldata). Intended for cases where the settlement calls themselves are correct but need to be force-triggered (e.g., after strategy duration elapsed and proposer is unresponsive). Reverts if calls revert. Transitions proposal to `Settled`. Replaces the owner-instant path in today's `emergencySettle`.
  - `emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. Stores `calls` as committed settlement override. Calls `registry.openEmergencyReview(proposalId, keccak256(abi.encode(calls)))`. Does **not** execute calls yet — opens the review window. Emits `EmergencySettleProposed(proposalId, owner, callsHash, reviewEnd)`.
  - `finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. Callable after `reviewEnd`. Reverifies `keccak256(abi.encode(calls)) == committed hash`. Calls `registry.resolveEmergencyReview(proposalId)`:
    - If `blocked`: registry slashes owner; function reverts (owner must try `unstick` or propose new calls, posting fresh stake first).
    - If not blocked: executes calls via `vault.executeGovernorBatch(calls)`, transitions proposal to `Settled`.

### 3.3 Modified: `SyndicateFactory.sol`

- Store `address public guardianRegistry` (owner-settable, timelock-gated same as `governor`).
- In `createSyndicate`: before deploying the vault, call `guardianRegistry.canCreateVault(msg.sender)` (reverts if no prepared stake). After vault address is known, call `guardianRegistry.bindOwnerStake(msg.sender, vaultAddr)`. If bind fails, the whole creation reverts (atomic).
- `setGuardianRegistry(address)` — owner, timelocked.

### 3.4 Modified: `ISyndicateGovernor.sol`

New enum value, new struct field, new errors, new events, new function signatures:

- Errors: `NotInGuardianReview`, `EmergencySettleBlocked`, `EmergencySettleNotReady`, `EmergencySettleMismatch`, `RegistryNotSet`, `InvalidReviewPeriod`.
- Events: `GuardianReviewResolved(uint256 indexed proposalId, bool blocked)`, `EmergencySettleProposed(uint256 indexed proposalId, address indexed owner, bytes32 callsHash, uint256 reviewEnd)`, `EmergencySettleFinalized(uint256 indexed proposalId, int256 pnl)`, `GuardianRegistryUpdated(address old, address new)`.
- Function changes: drop `emergencySettle`; add `unstick`, `emergencySettleWithCalls`, `finalizeEmergencySettle`. `propose()` now takes a trailing `uint256 reviewPeriodOverride` argument.

## 4. Data flow — key scenarios

**Normal happy path:**
1. Agent submits proposal → `Pending` → voting. On `propose()` the governor already stamped `reviewEnd = voteEnd + reviewPeriod` and `executeBy = reviewEnd + executionWindow`.
2. `voteEnd` elapses. State derivation in `_resolveStateView` returns `GuardianReview` (no transactions needed).
3. Guardians vote Approve (majority) / Block (minority); first vote snapshots `totalStakeAtOpen` in the registry. Neither tally hits block quorum.
4. `reviewEnd` elapses. Anyone calls `executeProposal`; governor calls `registry.resolveReview` defensively → `resolved=true, blocked=false`. Transitions to `Approved` then immediately proceeds through execution logic.
5. Strategy runs; proposer calls `settleProposal`. Proposal → `Settled`. No slashing.

**Malicious-calldata detection during review:**
1. `voteEnd` elapses. Proposal implicitly enters `GuardianReview`.
2. Guardian A, B, C vote Approve at hour 2. First vote stakes the quorum denominator. Guardian D, E, F, G vote Block starting at hour 10. Combined Block stake weight crosses `blockQuorumBps` threshold at hour 14.
3. Anyone can call `registry.resolveReview` as soon as `reviewEnd` elapses at hour 24 (don't need to wait for the first execute attempt). Registry sees `blocked=true`, slashes A, B, C, and returns `true`. Next call to governor state resolution transitions the proposal to `Rejected`.

**Owner abuses emergency settle:**
1. Proposal executes cleanly. Strategy runs its duration.
2. Owner calls `emergencySettleWithCalls(id, maliciousCalls)` at hour 0 of review window. Registry commits `callsHash`, opens 24h EmergencyReview.
3. Guardians vote Block; crosses quorum at hour 10.
4. Owner calls `finalizeEmergencySettle(id, maliciousCalls)` at hour 25. Registry returns `blocked=true`, slashes owner stake, governor reverts.
5. Vault is now ownerless-for-governance-purposes: owner must `prepareOwnerStake` + re-bind before proposing/vetoing anything. (Non-governance owner functions like `rescueERC20` remain on the vault owner.)
6. Stuck assets can still be recovered by the legitimate path: `unstick(id)` runs pre-committed settlement calls. (If pre-committed calls are themselves broken and funds are truly stuck, the protocol multisig has to intervene — same exposure we have today.)

**Compromised owner tries to veto guardians:**
1. Proposal in `GuardianReview`. Owner calls `vetoProposal`. Reverts (`NotInPendingState` — narrowed).
2. Only path for owner to block execution: stake as guardian, vote Block. This means owner can participate in the guardian economy on equal footing, but cannot unilaterally override the quorum.

## 5. Parameters (initial values)

| Parameter | Default | Bounds | Rationale |
|---|---|---|---|
| `minGuardianStake` | 10_000 WOOD | ≥ 1 WOOD | Low enough for early ecosystem, high enough that slashing is a real cost. |
| `minOwnerStake` | 10_000 WOOD | ≥ 1_000 WOOD | Lowered from 50k per business review — onboarding friction for small creators. Can scale up via timelocked parameter change as TVL grows. |
| `coolDownPeriod` | 7 days | 1–30 days | Matches issue #227; aligns with Sherwood's existing multi-day governance rhythms. |
| `defaultReviewPeriod` | 24 hours | — | Used when proposer passes `reviewPeriodOverride = 0`. |
| `minReviewPeriod` | 6 hours | 1h–defaultReviewPeriod | Floor on per-proposal override. 6h gives time-sensitive strategies (funding-rate, oracle-reactive) a fast path while still allowing guardian agents a single cron cycle to react. |
| `maxReviewPeriod` | 7 days | defaultReviewPeriod–30 days | Ceiling on per-proposal override. |
| `blockQuorumBps` | 3000 (30%) | 1000–10000 | Below 50% so a motivated guardian minority can stop clearly malicious proposals; high enough that random dissent doesn't grief. |
| `rewardPerBlockWood` | 500 WOOD | — | Flat bounty, split pro-rata among Block voters on a resolved-as-blocked proposal. Small but non-zero — enough to cover gas and create a weak positive expectancy, without needing a full emissions schedule. |
| **Slash destination** | **BURN** (`0x…dEaD`) | — | Chosen over treasury per business review: cleaner regulatory posture (slash is not protocol-controlled revenue), aligns with WOOD scarcity narrative, removes any treasury-capture incentive to over-slash. Wrongful slashes are made whole via the appeal path (see §7), funded from a separate treasury reserve, not from burned tokens. |

All parameters are timelocked using the same queue/finalize pattern as `GovernorParameters.sol`, with `MIN_PARAM_CHANGE_DELAY = 6 hours` and `MAX_PARAM_CHANGE_DELAY = 7 days`.

## 6. Security notes

- **Gas-bounded slashing:** `_slashApprovers` iterates `_approvers[proposalId]`. Bounded by an invariant cap `MAX_APPROVERS_PER_PROPOSAL = 100`. Guardians attempting to Approve after the cap is hit revert (but can still Block). This prevents griefing via thousands of dust-stakers joining to brick slash resolution.
- **Stake snapshot vs. current:** guardian vote weight = `stakedAmount` at vote time (snapshotted into `_votes`). If a guardian tops up after voting, the extra doesn't count. Prevents sandwich-style weight manipulation.
- **Unstake griefing:** requesting unstake immediately removes voting weight, but the guardian's past votes already count toward their proposal reviews. Slashing still applies during cool-down (stake is held in contract, just earmarked for release). This is critical — otherwise a guardian could Approve a malicious proposal and immediately unstake to dodge slashing.
- **Owner re-stake after slash:** a slashed owner can restake and resume governance powers, but past slashing events are recorded and queryable. Off-chain reputation is out-of-scope for V1.
- **Double-voting prevention:** `_votes[proposalId][guardian]` must be default `None` for first vote; subsequent calls revert.
- **Factory/registry trust:** registry trusts governor to call its hooks honestly and vice-versa. Both upgrades routed through the same multisig.
- **Reentrancy:** slashing and cool-down claims touch WOOD ERC-20 transfers. Reuse `nonReentrant` modifier pattern from existing governor.
- **Owner can't front-run guardian block:** owner's `emergencyCancel` is narrowed to `Draft`/`Pending`. Once in `GuardianReview`, the only cancel vector is guardian Block quorum.
- **`unstick` abuse:** owner could spam `unstick` on a proposal that legitimately needs emergency settle. Mitigation: `unstick` is only callable after the proposal's strategy duration has elapsed (same precondition as current `emergencySettle`), and the call reverts if pre-committed settlement calls themselves revert. This matches current behavior.

## 7. Bootstrap policy & appeal path

Two commitments published before mainnet — documented in `mintlify-docs/learn/guardians.mdx` (new page) and cross-referenced here so both technical reviewers and LPs can see the governance surface around slashing.

### 7.1 Guardian-of-last-resort (bootstrap, weeks 1–12)

During the first 12 weeks after mainnet launch, the Sherwood protocol multisig commits to:

- Running a guardian agent that votes on **every** proposal across every registered vault.
- Publishing weekly guardian-coverage reports in the Sherwood forum (proposals reviewed, Approves, Blocks, outcomes).
- Staking ≥ `minGuardianStake` from protocol treasury.

This closes the "what if no guardians show up" failure mode during bootstrap and gives external guardians a reference implementation to benchmark against. After week 12, the multisig's guardian participation becomes optional and cohort health is measured independently (see §11).

### 7.2 Appeal path for wrongful slashes

Slashing is on-chain and final (WOOD is burned). Appeals are handled as treasury-funded refunds, **not** on-chain slash reversals, which keeps the slashing contract simple and the economic signal unambiguous.

Flow:
1. Slashed party opens an appeal by posting an on-forum case with proposal simulation / calldata analysis / reasoning within 30 days of the slash event.
2. Protocol governance (veWOOD voters) votes on the appeal; quorum and threshold set by tokenomics governance, not by this spec.
3. If upheld, the protocol multisig calls `GuardianRegistry.refundSlash(recipient, amount)` — a permissioned, per-epoch-capped function that transfers WOOD from a dedicated **Slash Appeal Reserve** (funded via treasury allocation at deployment, topped up by governance vote).
4. Refund cap per epoch prevents a compromised multisig from draining the reserve in a single transaction.
5. All refunds emit `SlashRefunded(recipient, amount, appealId)` events for transparency.

This intentionally makes appeals expensive (requires governance vote) but possible (prevents "one wrongful slash kills the guardian narrative" outcome). The cap and governance gate together limit the damage from a compromised multisig.

## 8. Testing plan

All tests live in `contracts/test/`. New files:

- `test/GuardianRegistry.t.sol` — unit tests for staking, cool-down, voting, slashing math.
- `test/governor/GuardianReviewLifecycle.t.sol` — integration: full proposal lifecycle with guardians approving, blocking, and slashing.
- `test/governor/EmergencySettleReview.t.sol` — owner-slashing path via `emergencySettleWithCalls`.
- `test/factory/OwnerStakeAtCreation.t.sol` — factory reverts without prepared stake; binds correctly.
- `test/invariants/GuardianInvariants.t.sol` — `StdInvariant` handler covering: total WOOD in registry == sum(stakes) + sum(prepared), slashed guardians have zero active stake, one active proposal per vault at all times.

Must-pass scenarios:
1. Happy path — proposal survives review, executes, settles.
2. Block-quorum rejection — Approvers slashed, Blockers keep stake.
3. Unstake griefing — guardian Approves then requests unstake; slashing still applies before claim.
4. Owner attempts `vetoProposal` during `GuardianReview` → reverts.
5. Owner attempts `emergencyCancel` on `Approved` → reverts.
6. `emergencySettleWithCalls` blocked by guardians → owner slashed; `finalizeEmergencySettle` reverts.
7. `emergencySettleWithCalls` not blocked → executes normally after `reviewEnd`.
8. `unstick` with working pre-committed settlement calls → succeeds.
9. Factory `createSyndicate` without prepared owner stake → reverts.
10. Max-approvers cap — 101st Approve reverts, 101st Block succeeds.

Fuzz targets:
- Randomized vote sequences; assert `blockStakeWeight + approveStakeWeight <= totalGuardianStakeAtReviewOpen`.
- Randomized stake/unstake sequences; assert total WOOD conservation.

## 9. Deployment plan

1. Deploy `GuardianRegistry` behind UUPS proxy. Owner = protocol multisig.
2. Configure initial parameters (see §5).
3. Deploy new `SyndicateGovernor` implementation. Proxy upgrade existing governor (still pre-mainnet — no in-flight proposals to migrate).
4. Deploy new `SyndicateFactory` implementation. Proxy upgrade.
5. Protocol multisig calls `factory.setGuardianRegistry(registry)` and `governor.setGuardianRegistry(registry)` (both timelocked).
6. Seed initial guardian cohort (protocol team + launch partners) by distributing WOOD and having them call `stakeAsGuardian`.
7. Existing vault owners (if any on testnets) call `prepareOwnerStake` + a new `factory.bindExistingVault(vault)` admin function (owner-only, one-time, used only for pre-mainnet migration of Base Sepolia test vaults) OR we simply redeploy vaults as part of the mainnet redeployment branch already in flight.

Given this is on `feat/mainnet-redeployment-params`, option 7b (redeploy) is preferred — no migration code needed.

8. **Fund the Slash Appeal Reserve** with an initial WOOD allocation from treasury (amount proposed in the V1 deployment governance vote).
9. **Publish bootstrap commitments** (§7.1 + §7.2) to `mintlify-docs/learn/guardians.mdx` and announce on the Sherwood forum.

## 10. Success metrics

Tracked via the existing Sherwood subgraph (new `Guardian`, `ProposalReview`, and `SlashEvent` entities) and surfaced on the protocol dashboard. These gate "V1 is working" — below-threshold metrics at month 3 or 6 trigger a review of V1.5 priorities.

| Metric | Month 3 | Month 6 | Month 12 | Failure signal |
|---|---|---|---|---|
| Independent guardian stakers (active) | ≥ 15 | ≥ 40 | ≥ 80 | Cohort stuck at protocol-team-only → trust assumption unchanged, pull rewards forward |
| Stake distribution Gini | — | < 0.7 | < 0.6 | Concentrated stake → vulnerable to collusion, raise `minGuardianStake` or introduce per-guardian cap |
| Proposals receiving ≥ 1 guardian vote | ≥ 80% | ≥ 95% | ≥ 98% | Guardians not watching → feature is theater, investigate skill/cron gaps |
| Proposals correctly Blocked (true positives) | ≥ 1 **or** documented near-miss | ≥ 2 **or** near-misses | — | Zero activity → either no attacks (good but unprovable) or asleep guardians (bad) |
| Wrongful slashes (refunded via appeal) / total slashes | < 30% | < 20% | < 10% | High wrongful-slash rate → guardians too trigger-happy, retune thresholds or block-quorum |
| New-syndicate-creation rate (vs. 30-day pre-launch baseline) | ≥ 70% | ≥ 90% | ≥ 100% | Sustained >30% drop → owner-stake friction too high, lower `minOwnerStake` |
| `emergencySettleWithCalls` events | — | — | — | Any single event here is a live fire-drill — track outcomes (blocked vs. executed) individually |

## 11. Follow-up specs (explicitly out of scope)

- **Correct-Approve rewards + weekly cron** — Minter emissions allocated to guardians whose Approve votes matched the subsequent execution outcome (proposal executed successfully without emergency actions). Requires EAS schema for attestations. (V1 already ships the **Block**-side reward via `rewardPerBlockWood` from treasury — see §3.1. What's deferred is the Minter-emissions funding source and the correct-Approve reward loop.)
- **EAS attestation schema** — `GUARDIAN_REVIEW_VOTE` schema capturing (proposalId, guardian, support, reasoning hash). Feeds reward computation.
- **LLM knowledge base** — compiled good/bad attestations + reasoning → off-chain dataset for Hermes guardian skill training.
- **Shareholder challenge (Option C)** — post-settlement jury-style adjudication for malicious proposals that slipped past guardians.
- **Vault-asset slash redirect** — swap slashed WOOD to vault asset at slash time, pay directly to LPs harmed.
- **Guardian reputation decay** — aged-out stake, repeated-correct-vote multipliers.
- **Hermes `guardian` skill** — off-chain agent runtime that scans proposals across all syndicates and calls `voteOnProposal`.

## 12. Changelog — scope changes from business review (2026-04-19)

Applied wholesale from the business-analyst review of this spec:

- **Slash destination:** burn (not treasury). Final. See §5 and §3.1.
- **Owner stake default:** lowered 50k → 10k WOOD to protect onboarding. See §5.
- **Per-proposal `reviewPeriod` override:** `min=6h`, `default=24h`, `max=7d`. See §3.2 and §5.
- **Block-side rewards in V1:** `rewardPerBlockWood` flat bounty from treasury-funded `rewardPool`. Correct-Approve rewards still deferred. See §3.1 and §11.
- **Bootstrap commitments:** multisig runs guardian weeks 1–12, appeal path via treasury reserve. See §7.
- **Success metrics:** cohort size, coverage, correct-block ratio, wrongful-slash ratio, creator-onboarding drag. See §10.

## 13. Open questions (want your call before writing the plan)

1. **`unstick` access control**: owner-only, or permissionless after strategy duration + N hours? Today's `emergencySettle` is owner-only; unchanged here, but worth flagging.
2. **Guardian cap per proposal**: is 100 the right ceiling for `MAX_APPROVERS_PER_PROPOSAL`? Too low risks legitimate large cohorts not all being able to Approve. Too high risks gas griefing on slash.
3. **Factory `bindOwnerStake` atomicity**: spec has factory calling registry *after* vault deploy. If bind reverts, the whole `createSyndicate` reverts and vault deployment is rolled back — confirm this is the desired ordering vs. binding before deploy (which requires computing vault address via CREATE2).
4. **Slash Appeal Reserve sizing**: opening allocation (e.g. 1% of total WOOD supply?) and per-epoch refund cap. Propose via tokenomics governance, not fixed here.
5. **Owner dual-use optimization**: should vault owners be allowed to double-count their owner-stake as guardian-stake on *other* vaults (so their capital isn't fully idle)? Adds reward-eligibility and active participation incentive, at the cost of extra accounting. Flag for V1.5 unless there's pressure to ship in V1.
