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
mapping(uint256 => mapping(address => uint128)) private _voteStake; // stake weight snapshot per (proposal, guardian) for vote-change math
mapping(uint256 => address[]) private _approvers; // for batch-slashing at resolution
mapping(uint256 => address[]) private _blockers;  // for epoch-reward accounting at resolution

// Epoch-based reward accounting (replaces fixed rewardPerBlockWood — see §5)
uint256 public constant EPOCH_DURATION = 7 days; // matches Minter emissions cadence
uint256 public epochGenesis;                     // stamped at initialize()
mapping(uint256 epochId => uint256) public epochBudget;                    // WOOD allocated for that epoch by fundEpoch()
mapping(uint256 epochId => uint256) public epochTotalBlockWeight;          // sum of snapshotted Block-vote stake on all blocked proposals that epoch
mapping(uint256 => mapping(address => uint256)) public epochGuardianBlockWeight; // per-guardian cumulative Block-vote stake per epoch
mapping(uint256 => mapping(address => bool)) public epochRewardClaimed;    // idempotent claims

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
uint256 public minOwnerStake;     // default: 10_000 WOOD  (floor — see §5 and requiredOwnerBond below)
uint256 public ownerStakeTvlBps;  // default: 0 (disabled). bounds [0, 500] = 5% cap. Bond = max(floor, totalAssets*bps/10_000) at bind time
uint256 public coolDownPeriod;    // default: 7 days
uint256 public reviewPeriod;      // default: 24 hours (single global value; no per-proposal override)
uint256 public blockQuorumBps;    // default: 3000 (30% of total guardian stake)
// Note: per-epoch reward *budget* is set by the protocol each epoch via fundEpoch() — no static rate
//       parameter. See epochBudget mapping above and §11 (Follow-up: Minter emissions integration).

// Slashing: WOOD is burned (not sent to treasury) — see §5 rationale
address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

// Privileged addresses
address public governor;
address public factory;
IERC20 public immutable wood;     // WOOD token
```

**Public / external functions:**

Guardian role:
- `stakeAsGuardian(uint256 amount, uint256 agentId)` — pull WOOD, register caller as active guardian. Requires `amount >= minGuardianStake`. Idempotent: existing guardians can top up (agentId is recorded once on first stake; subsequent calls ignore the agentId arg). The `agentId` is the caller's ERC-8004 identity NFT token ID; verified via `IdentityRegistry.ownerOf(agentId) == msg.sender`. V1 does nothing with this data beyond storage + event emission, but storing it now means the V2 reputation/EAS layer can read it without a migration. V1 accepts `agentId = 0` as "unregistered" for easier bootstrap — V2 migration will require a one-time `bindAgentId` call.
- `requestUnstakeGuardian()` — marks `unstakeRequestedAt = block.timestamp`. Guardian immediately loses voting power (removed from `_totalGuardianStake`). Cannot re-vote until unstake is either cancelled or claimed.
- `cancelUnstakeGuardian()` — reverses an unstake request; stake becomes voting-eligible again.
- `claimUnstakeGuardian()` — after `coolDownPeriod` elapses, releases WOOD to guardian. Zero-stake guardians are fully deregistered.
- `voteOnProposal(uint256 proposalId, VoteType support)` — `Approve` or `Block`. The registry reads `reviewEnd` from the governor via `ISyndicateGovernor.getProposal(proposalId)` and the proposal's `voteEnd`; vote is allowed only when `voteEnd <= now < reviewEnd`. On the first vote for a given proposalId, snapshots `_totalGuardianStake` into `Review.totalStakeAtOpen` — this fixes the quorum denominator and prevents dilution by late-joining stakers. First vote also snapshots the guardian's current `guardianStake` into `_voteStake[proposalId][msg.sender]`. **Guardians MAY change their vote up until `reviewEnd`.** Changing a vote subtracts the guardian's stake weight (from `_voteStake`) from the old side's tally and adds it to the new side; does NOT re-snapshot stake. The guardian is added to / removed from `_approvers` and `_blockers` arrays to keep them consistent. Calling the function with the *same* support you already recorded reverts with `NoVoteChange`. Vote-change is essential because of the cartel attack: without it, an honest early Approver is strictly worse off than an abstainer, which kills the optimistic-Approve equilibrium the system needs.

Owner role:
- `prepareOwnerStake(uint256 amount)` — pull WOOD into the registry under `_prepared[msg.sender]`. Does **not** yet bind to a vault. Must be ≥ `minOwnerStake` (the floor) — at prepare time we don't know which vault the stake will bind to, so we can't check the TVL-scaled bond yet. If the chosen vault's TVL-scaled bond exceeds the prepared amount at `bindOwnerStake` time, the bind reverts and the owner must top up and re-bind. One prepared stake per owner at a time.
- `cancelPreparedStake()` — only callable if not yet bound by the factory; refunds WOOD.
- `requestUnstakeOwner(address vault)` — vault owner only. Signals intent to exit; begins cool-down. Unstaking is **blocked while the vault has an active proposal** (any state between `Pending` and `Executed`) to prevent rage-quit around malicious executions.
- `claimUnstakeOwner(address vault)` — after cool-down, releases WOOD. Post-claim the vault is in a **grace-period** state (`ownerStaked == false`): new proposals cannot be created until owner re-binds a fresh stake.

Governor hooks:
- `openEmergencyReview(uint256 proposalId, bytes32 callsHash)` — **onlyGovernor**. Commits the calldata hash when owner calls `emergencySettleWithCalls`. Opens the window and snapshots `totalStakeAtOpen` immediately (unlike the proposal-review path, there's no earlier vote to piggyback on).
- `resolveReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Reads `reviewEnd` from the governor; requires `block.timestamp >= reviewEnd`. If no `Review` was ever created (no votes cast), returns `blocked = false` immediately. Otherwise computes `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`, sets `resolved = true`, and if `blocked`, invokes internal `_slashApprovers`. Returns cached `blocked` on subsequent calls. Governor calls this defensively from `_resolveState`; guardians/keepers can also call it to trigger slashing without waiting for someone to execute.
- `resolveEmergencyReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Same shape as `resolveReview` but resolves the emergency-settle window (using its own `reviewEnd` stored on the `EmergencyReview` struct) and invokes `_slashOwner` when blocked.

**Note on lifecycle integration:** the Pending → GuardianReview transition happens implicitly via `_resolveStateView` once `block.timestamp > voteEnd`. No external registry call is required at transition time — the registry only learns about the proposal when a guardian casts the first vote (or when `resolveReview` is called after `reviewEnd`).

Factory hooks (onlyFactory):
- `bindOwnerStake(address owner, address vault)` — consumes `_prepared[owner]`, binds it as `_ownerStakes[vault]`. Reverts if no prepared stake, or if prepared amount `< requiredOwnerBond(vault)`. For the factory-creation path `totalAssets()` is 0, so the TVL term is 0 and only the floor applies.
- `transferOwnerStakeSlot(address vault, address newOwner)` — called from `SyndicateFactory.rotateOwner` after the previous owner's stake has been slashed or unstaked. Reassigns the vault's owner-stake slot to `newOwner`, who must have called `prepareOwnerStake` first with ≥ `requiredOwnerBond(vault)`. Reverts if the previous owner still has an active stake on this vault (guards against hostile takeover while a legitimate owner is staked).

Emergency-settle vote:
- `voteBlockEmergencySettle(uint256 proposalId)` — active guardians vote to block. Any single vote adds their stake weight to `blockStakeWeight`. When `blockStakeWeight >= blockQuorumBps * _totalGuardianStake / 10_000`, the review is flagged blocked (resolved at `resolveEmergencyReview` time).

Slashing (internal, triggered by governor):
- `_slashApprovers(uint256 proposalId)` — internal; invoked from `resolveReview` when block quorum resolves, or from the governor when owner calls `emergencyCancel` on a proposal that had recorded Approves. Iterates `_approvers[proposalId]`, zeroes each approver's stake, and **burns** the total slashed WOOD by transferring to `BURN_ADDRESS`. Capped gas-wise by `MAX_APPROVERS_PER_PROPOSAL = 100` (see §6).
- `_slashOwner(address vault)` — internal; invoked from `resolveEmergencyReview` when blocked. Zeros `_ownerStakes[vault].stakedAmount` and **burns** the slashed WOOD. Vault transitions into "owner must re-stake" state.
- **Appeal path (off-chain → on-chain):** a slashed party can petition the protocol multisig for refund. Multisig executes `refundSlash(address recipient, uint256 amount)` — **onlyOwner** on the registry, capped per-epoch — which transfers WOOD from the treasury reserve to the refund recipient. Requires governance vote record; spec in §7 and §10. No on-chain slash reversal — the burn is final; refund is a new treasury-funded transfer.

Reward distribution (Block-side, epoch-based):
- `fundEpoch(uint256 epochId, uint256 amount)` — **onlyOwner or onlyMinter**. Pulls WOOD and adds `amount` to `epochBudget[epochId]`. Can be called multiple times per epoch to top up. Can be called for past epochs (adds to the pool; guardians who hadn't claimed yet see the updated share; already-claimed guardians are not topped up — they can claim the marginal via `topUpClaim(epochId)` — or we just document that budget additions after an epoch ends require a re-distribution. V1 simplification: disallow `fundEpoch` for an epoch that already has any claims). The expected flow is one `fundEpoch` call per epoch from the Minter (deferred to V1.5 — V1 uses multisig until emissions wiring lands).
- **How blocks accrue weight:** inside `resolveReview`, when the proposal resolves `blocked = true`, the registry iterates `_blockers[proposalId]` and for each guardian:
  - `epochId = (proposal.reviewEnd - epochGenesis) / EPOCH_DURATION`  (the epoch the review ended in)
  - `epochGuardianBlockWeight[epochId][guardian] += _voteStake[proposalId][guardian]`
  - `epochTotalBlockWeight[epochId] += _voteStake[proposalId][guardian]`
- `claimEpochReward(uint256 epochId)` — active or unstaking guardians claim their pro-rata share of `epochBudget[epochId]` after the epoch ends (`block.timestamp >= epochGenesis + (epochId + 1) * EPOCH_DURATION`). Payout = `epochBudget[epochId] * epochGuardianBlockWeight[epochId][msg.sender] / epochTotalBlockWeight[epochId]`. Idempotent per (epochId, guardian) via `epochRewardClaimed`. Reverts with `NothingToClaim` if the guardian had zero block-weight that epoch.
- **Unclaimed budget rolls to the next epoch** via an explicit `sweepUnclaimed(uint256 epochId)` — **onlyOwner**, callable 4 weeks after the epoch ends, transfers residual `epochBudget[epochId]` into `epochBudget[currentEpoch()]`. Keeps emissions productive if some guardians never claim.
- Note: no reward for correct Approve in V1. Correct-Approve rewards (the full "good guardians rewarded weekly" loop from issue #227) are deferred to V1.5 with EAS. V1 only rewards the *active-defence* action (Block) because that is the one that materially prevented an LP loss.

Parameter setters (timelocked — reuses `GovernorParameters` timelock pattern):
- `setMinGuardianStake`, `setMinOwnerStake`, `setOwnerStakeTvlBps`, `setCoolDownPeriod`, `setReviewPeriod`, `setBlockQuorumBps`.
- `setMinter(address)` — owner-only, timelocked. Authorizes the Minter to call `fundEpoch` directly once emissions integration lands (V1.5).

Views:
- `guardianStake(address)`, `ownerStake(address vault)`, `totalGuardianStake()`, `isActiveGuardian(address)`, `hasOwnerStake(address vault)`, `getReview(uint256)`, `getEmergencyReview(uint256)`, `preparedStakeOf(address owner)`, `canCreateVault(address owner)`.
- `currentEpoch() returns (uint256)` — derives from `(block.timestamp - epochGenesis) / EPOCH_DURATION`.
- `pendingEpochReward(address guardian, uint256 epochId) returns (uint256)` — computes the guardian's claimable amount for that epoch. Returns 0 if the epoch hasn't ended, if already claimed, or if the guardian had no Block weight.
- `requiredOwnerBond(address vault) returns (uint256)` — returns `max(minOwnerStake, IERC4626(vault).totalAssets() * ownerStakeTvlBps / 10_000)`. Used by `bindOwnerStake` and `transferOwnerStakeSlot` to gate whether a prepared stake is sufficient. With `ownerStakeTvlBps = 0` (V1 default) this returns `minOwnerStake` unconditionally — the scaling pipe is wired but inert. A multisig parameter flip activates it without a code change, with the timelock giving owners advance notice to top up before any existing vault becomes undercollateralized on the next rotate.

### 3.2 Modified: `SyndicateGovernor.sol`

Minimal changes, scoped to what the governor has to know.

- **Enum:** insert `GuardianReview` between `Pending` and `Approved` in `ProposalState`. Full ordering: `{Draft, Pending, GuardianReview, Approved, Rejected, Expired, Executed, Settled, Cancelled}`. All contracts are being redeployed on `feat/mainnet-redeployment-params` — no need to preserve existing enum slot values.
- **Struct:** add `uint256 reviewEnd` to `StrategyProposal`. Stamped at proposal creation alongside `voteEnd` and `executeBy`.
- **Storage:** add `address private _guardianRegistry`. Governor storage layout is fresh — no `__gap` gymnastics needed.
- **Initializer:** accept `guardianRegistry` address.
- **`propose()` signature:** unchanged from today (no `reviewPeriodOverride`). Single global `reviewPeriod` from the registry applies to every proposal. If specific strategies later demand shorter windows, that belongs in V1.5 alongside stake-at-risk controls for the proposer — not as a free knob in V1.
- **`propose()` body:** after computing `voteEnd` (non-collaborative) or when collaborative consent completes in **`approveCollaboration()`**, stamp `reviewEnd = voteEnd + registry.reviewPeriod()` and shift `executeBy = reviewEnd + executionWindow` (execution window is measured from the *end of guardian review*, not the end of voting). This keeps the full lifecycle deterministic from creation — no mid-flight parameter drift and no registry call needed at Pending → GuardianReview transition.
- **`_resolveStateView` (view, non-mutating):** when `stored == Pending` and voting ended with no veto quorum:
  - If `block.timestamp <= proposal.reviewEnd`: return `GuardianReview`.
  - Else: **still return `GuardianReview`** until `_resolveState` (mutating path) runs `registry.resolveReview`. Read `registry.getReview(proposalId).resolved` — if `true`, return `Rejected` or `Approved` based on `blocked`. If `false`, return `GuardianReview` (resolution pending; the caller must run a mutating function to force resolution).
  - The view never returns the final terminal state until the on-chain resolution has actually occurred. This is the tradeoff for keeping `resolveReview` mutating (needed for slashing + state caching).
  - **UI / indexer guidance** (added to `ISyndicateGovernor` NatSpec): do not poll `getProposalState(id)` to detect `Rejected`. Subscribe to the `GuardianReviewResolved` event, or call `registry.resolveReview(id)` yourself (permissionless) to force resolution.
- **`_resolveState` (mutating):** when a state transition out of `GuardianReview` is required (called from `executeProposal`, `cancelProposal`, `vetoProposal`, or any other function that reads/writes state after voteEnd):
  - If `block.timestamp <= proposal.reviewEnd`: persist as `GuardianReview`, return `GuardianReview`.
  - Else: call `registry.resolveReview(proposalId)` → if `blocked == true`, persist as `Rejected` (registry auto-slashes approvers inside `resolveReview`). Else persist as `Approved`.
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
- `setGuardianRegistry(address)` — factory owner, timelocked.
- **`rotateOwner(address vault, address newOwner)` — factory owner, timelocked.** Recovery path for vaults whose current owner has been slashed (or abandoned keys / rage-quit). Requires the current owner's stake to be **already slashed or fully unstaked** (`registry.hasOwnerStake(vault) == false`) — prevents hostile owner-takeover while a legitimate owner is staked. Calls `SyndicateVault.transferOwnership(newOwner)` and `registry.transferOwnerStakeSlot(vault, newOwner)` so the new owner can post fresh stake. Without this function, a slashed owner who walks away leaves the vault permanently unable to create new proposals — a dead-vault risk flagged by Carlos's review (PR #229). Timelock + multisig gating keeps it from being a bypass of the slashing economics.

### 3.4 Modified: `ISyndicateGovernor.sol`

New enum value, new struct field, new errors, new events, new function signatures:

- Errors: `NotInGuardianReview`, `EmergencySettleBlocked`, `EmergencySettleNotReady`, `EmergencySettleMismatch`, `RegistryNotSet`.
- Events (governor-side): `GuardianReviewResolved(uint256 indexed proposalId, bool blocked)`, `EmergencySettleProposed(uint256 indexed proposalId, address indexed owner, bytes32 callsHash, uint256 reviewEnd)`, `EmergencySettleFinalized(uint256 indexed proposalId, int256 pnl)`, `GuardianRegistryUpdated(address old, address new)`.
- Events (registry-side): `EpochFunded(uint256 indexed epochId, address indexed funder, uint256 amount)`, `EpochRewardClaimed(uint256 indexed epochId, address indexed guardian, uint256 amount)`, `EpochUnclaimedSwept(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount)`, `ApproverCapReached(uint256 indexed proposalId)`.
- Function changes: drop `emergencySettle`; add `unstick`, `emergencySettleWithCalls`, `finalizeEmergencySettle`. `propose()` signature unchanged (no `reviewPeriodOverride`).

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
| `minOwnerStake` | 10_000 WOOD | ≥ 1_000 WOOD | Lowered from 50k per business review — onboarding friction for small creators. Floor only; effective bond per vault = `requiredOwnerBond(vault)` (see below). |
| `ownerStakeTvlBps` | 0 (disabled) | [0, 500] (5% cap) | TVL-scaling multiplier. Effective owner bond = `max(minOwnerStake, totalAssets * ownerStakeTvlBps / 10_000)`. V1 ships at 0 (flat floor). Multisig timelocked flip activates scaling without a code change. Bond is checked at bind / rotate time only — no periodic top-up in V1. |
| `coolDownPeriod` | 7 days | 1–30 days | Matches issue #227; aligns with Sherwood's existing multi-day governance rhythms. |
| `reviewPeriod` | 24 hours | 6h–7 days | Single global review window. No per-proposal override in V1 — if a strategy needs a shorter window, that's a V1.5 question tied to proposer stake-at-risk, not a V1 knob. |
| `blockQuorumBps` | 3000 (30%) | 1000–10000 | Below 50% so a motivated guardian minority can stop clearly malicious proposals; high enough that random dissent doesn't grief. |
| `EPOCH_DURATION` | 7 days | — (constant) | Matches the Minter emissions epoch so guardian rewards can be wired into the same weekly cycle once V1.5 lands. |
| Per-epoch reward budget | **set per-epoch** | — | No static rate parameter. The protocol calls `fundEpoch(epochId, amount)` each epoch with whatever WOOD it chooses to allocate (initially via multisig; later via Minter emissions). Guardians split the epoch's pool pro-rata by their Block-vote stake weight on proposals that resolved blocked during that epoch. |
| **Slash destination** | **BURN** (`0x…dEaD`) | — | Chosen over treasury per business review: cleaner regulatory posture (slash is not protocol-controlled revenue), aligns with WOOD scarcity narrative, removes any treasury-capture incentive to over-slash. Wrongful slashes are made whole via the appeal path (see §7), funded from a separate treasury reserve, not from burned tokens. |

All parameters are timelocked using the same queue/finalize pattern as `GovernorParameters.sol`, with `MIN_PARAM_CHANGE_DELAY = 6 hours` and `MAX_PARAM_CHANGE_DELAY = 7 days`.

## 6. Security notes

- **Gas-bounded iteration:** `_slashApprovers` iterates `_approvers[proposalId]`; the blocked-resolution epoch-weight attribution iterates `_blockers[proposalId]`. Both are bounded by invariant caps `MAX_APPROVERS_PER_PROPOSAL = 100` and `MAX_BLOCKERS_PER_PROPOSAL = 100`. Guardians attempting to join a full side revert; they can still join the other side or wait for a subsequent proposal. This prevents griefing via thousands of dust-stakers joining to brick slash-resolution or epoch-reward resolution.
- **Stake snapshot vs. current:** guardian vote weight = `stakedAmount` at vote time (snapshotted into `_votes`). If a guardian tops up after voting, the extra doesn't count. Prevents sandwich-style weight manipulation.
- **Unstake griefing:** requesting unstake immediately removes voting weight, but the guardian's past votes already count toward their proposal reviews. Slashing still applies during cool-down (stake is held in contract, just earmarked for release). This is critical — otherwise a guardian could Approve a malicious proposal and immediately unstake to dodge slashing.
- **Owner re-stake after slash:** a slashed owner can restake and resume governance powers, but past slashing events are recorded and queryable. Off-chain reputation is out-of-scope for V1.
- **Double-voting prevention:** `_votes[proposalId][guardian]` must be default `None` for first vote; subsequent calls revert.
- **Factory/registry trust:** registry trusts governor to call its hooks honestly and vice-versa. Both upgrades routed through the same multisig.
- **Reentrancy:** slashing and cool-down claims touch WOOD ERC-20 transfers. Reuse `nonReentrant` modifier pattern from existing governor.
- **Owner can't front-run guardian block:** owner's `emergencyCancel` is narrowed to `Draft`/`Pending`. Once in `GuardianReview`, the only cancel vector is guardian Block quorum.
- **`unstick` abuse:** owner could spam `unstick` on a proposal that legitimately needs emergency settle. Mitigation: `unstick` is only callable after the proposal's strategy duration has elapsed (same precondition as current `emergencySettle`), and the call reverts if pre-committed settlement calls themselves revert. This matches current behavior.
- **Keeper incentive for `resolveReview`:** the function is permissionless but expensive (~500k gas to iterate 100 approvers + SSTORE zero + token burn). Nobody has a first-party incentive to pay. In practice, the next call to `executeProposal` forces resolution and the proposer pays — proposer becomes an unwilling keeper. This is acceptable for V1 (proposer is rewarded with execution anyway), but document it. V2 can add a small gas rebate from the burn amount (e.g. 0.5%) to any address that calls `resolveReview` first.
- **Blocker free-ride / V1 DoS attack surface:** Block voters have no stake at risk (slashing only hits Approvers). A 30%-stake cartel can Block every proposal across every vault with zero cost. V1 accepts this as a known attack surface — the mitigation belongs to V1.5:
  - Correct-Approve rewards (deferred, V1.5) create positive expectancy for honest guardians, diluting the cartel's relative weight.
  - A per-guardian "blocked but later refuted" penalty requires the shareholder-challenge / jury system (Option C, deferred).
  - Reputation-weighted quorum via EAS attestations (deferred, V1.5) breaks stake-concentration cartels.
  Document in `mintlify-docs/learn/guardians.mdx` so new guardians understand the honeymoon period.
- **ApproverCapReached signaling:** emit `ApproverCapReached(proposalId)` when the 101st Approve attempt reverts. Off-chain monitors use this to flag proposals where the system's participation assumption is being tested. Revisit the cap at >50 active independent guardians.

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

## 11. Bytecode impact & mitigation

`SyndicateGovernor` runtime: **24,523 / 24,576 bytes (53-byte margin)** as of 2026-04 (per `CLAUDE.md`). The proposed changes to the governor are net-additive:

| Change | Estimated delta |
|---|---|
| Remove `emergencySettle` + `_tryPrecommittedThenFallback` | **−800 to −1,500 bytes** (conservative; depends on solc optimizer) |
| Add `unstick` (simple, no hash check) | +300 |
| Add `emergencySettleWithCalls` (calldata → storage, hash commit) | +500 |
| Add `finalizeEmergencySettle` (hash reverify, calls loop, slashing branch) | +600 |
| `_resolveStateView` / `_resolveState` new GuardianReview branch | +400 |
| `reviewEnd` stamping in `propose()` / `approveCollaboration()` | +200 |
| New errors + events | +150 |
| `setGuardianRegistry` setter + init param + storage read | +250 |
| **Net estimated delta** | **+1,600 to +900 bytes** (range depends on how much `emergencySettle` removal saves) |

Even the optimistic case blows the 53-byte margin. This must be mitigated before implementation or the governor won't deploy.

### Mitigation options (in order of preference)

**Option B — extract `GovernorEmergency.sol` abstract contract.** Preferred.

- Create `contracts/src/GovernorEmergency.sol` — abstract, matching the pattern of `GovernorParameters.sol`.
- Move `unstick`, `emergencySettleWithCalls`, `finalizeEmergencySettle`, and their internal helpers (`_tryPrecommittedSettle`, `_verifyCallsHash`) into it.
- `SyndicateGovernor` inherits `GovernorEmergency` alongside `GovernorParameters`.
- Virtual accessors (following the `GovernorParameters` pattern) let the abstract read `_proposals`, `_settlementCalls`, `_registry`.
- Preserves the "governor owns lifecycle" invariant. No new cross-contract trust.
- Expected net bytecode after split: ~23,500 bytes (governor) + standalone abstract bytecode. Safe margin.

**Option A — move post-vote lifecycle math into `GuardianRegistry`.** Fallback if Option B doesn't buy enough.

- Registry becomes the state-machine oracle for `Pending` → `GuardianReview` → `Approved|Rejected`.
- Governor's `_resolveStateView` / `_resolveState` become thin delegates that read from registry.
- Biggest refactor; highest V1 risk; cleanest long-term shape.
- Defer to this only if Option B still lands over 24,400 bytes after implementation.

**Option C — move owner-settlement externals onto `SyndicateVault`.** Not recommended.

- Puts state-machine entry points on the vault (`unstick`, `emergencySettleWithCalls`) which already has `executeGovernorBatch`.
- Saves 1–1.5kB from governor but breaks the "governor owns lifecycle" invariant and forces every vault to carry the logic. Also harder to upgrade since vaults are non-upgradeable in the current factory.

### Required before implementation

1. Prototype Option B in a scratch branch; run `forge build --sizes` on the resulting `SyndicateGovernor`.
2. If governor > 24,400: add Option A on top.
3. CI check: add `forge build --sizes` to the contracts CI workflow; fail if any deployed contract > 24,400 bytes. (Complements the existing `CLAUDE.md` rule.)

## 12. Follow-up specs (explicitly out of scope)

- **Minter emissions → `fundEpoch`** — wire the existing Minter to call `GuardianRegistry.fundEpoch(currentEpoch, allocation)` each epoch, alongside the gauge emissions call. Requires a new "guardian emissions" slice in the Minter's allocation breakdown (proposed via tokenomics governance). V1 uses multisig-funded `fundEpoch`; V1.5 flips to Minter-funded.
- **Correct-Approve rewards** — extends the epoch reward pool to also include Approvers whose votes matched the subsequent execution outcome (proposal executed successfully without emergency actions). Requires EAS schema for attestations (below). The Block-side reward (§3.1) is already live in V1; what's deferred is the Approve-side and the attestation scheme feeding it.
- **EAS attestation schema** — `GUARDIAN_REVIEW_VOTE` schema capturing (proposalId, guardian, support, reasoning hash). Feeds reward computation.
- **LLM knowledge base** — compiled good/bad attestations + reasoning → off-chain dataset for Hermes guardian skill training.
- **Shareholder challenge (Option C)** — post-settlement jury-style adjudication for malicious proposals that slipped past guardians.
- **Vault-asset slash redirect** — swap slashed WOOD to vault asset at slash time, pay directly to LPs harmed.
- **Guardian reputation decay** — aged-out stake, repeated-correct-vote multipliers.
- **Hermes `guardian` skill** — off-chain agent runtime that scans proposals across all syndicates and calls `voteOnProposal`.

## 13. Changelog — scope changes from business review (2026-04-19)

Applied wholesale from the business-analyst review of this spec:

- **Slash destination:** burn (not treasury). Final. See §5 and §3.1.
- **Owner stake default:** lowered 50k → 10k WOOD to protect onboarding. See §5.
- **Per-proposal `reviewPeriod` override:** `min=6h`, `default=24h`, `max=7d`. See §3.2 and §5.
- **Block-side rewards in V1:** `rewardPerBlockWood` flat bounty from treasury-funded `rewardPool`. Correct-Approve rewards still deferred. See §3.1 and §11.
- **Bootstrap commitments:** multisig runs guardian weeks 1–12, appeal path via treasury reserve. See §7.
- **Success metrics:** cohort size, coverage, correct-block ratio, wrongful-slash ratio, creator-onboarding drag. See §10.

## 14. Changelog — Carlos code-review changes (2026-04-19 PR #229)

Applied from Carlos's review in response to blockers:

- **Bytecode mitigation plan added as §11** — Option B (`GovernorEmergency.sol` abstract extraction) recommended; Option A fallback documented. Prototype + `forge build --sizes` gate required before implementation.
- **View/mutation state-machine split** — `_resolveStateView` now returns `GuardianReview` (not transitioned) until `_resolveState` or direct `registry.resolveReview` runs. Indexer guidance added to `ISyndicateGovernor` NatSpec. See §3.2.
- **Guardians can change their vote** until `reviewEnd` — stake weight preserved from first vote, `_approvers` array kept consistent. Fixes cartel-slashing equilibrium flaw. See §3.1.
- **Owner rotation path** — `SyndicateFactory.rotateOwner(vault, newOwner)` behind owner + timelock. Only callable when current owner's stake is slashed or fully unstaked. See §3.3.
- **Guardian `agentId`** — `stakeAsGuardian` now takes ERC-8004 `agentId`; stored for V2 reputation layer, not used in V1. See §3.1.
- **Keeper incentive note** — proposer pays via `executeProposal`; V2 can add gas rebate from burn. See §6.
- **V1 blocker free-ride attack surface documented** — explicit V1 limitation; mitigations defer to V1.5 (correct-Approve rewards, EAS reputation). See §6.
- **`ApproverCapReached(proposalId)` event** added. See §6.
- **Open question 4 (factory bind ordering) resolved** as "bind-after-deploy, atomic via revert" per Carlos. Dropped.
- **Open question 3 resolved** — 100-approver cap retained; `ApproverCapReached` event added.

## 15. Changelog — Carlos follow-up review (2026-04-19 PR #229 second pass)

- **Owner stake TVL scaling pipe wired (§15.3 resolved).** New `ownerStakeTvlBps` param (default 0, bounds [0, 500]). `requiredOwnerBond(vault)` view returns `max(minOwnerStake, totalAssets * ownerStakeTvlBps / 10_000)`. Enforced at `bindOwnerStake` and `transferOwnerStakeSlot` only — no periodic top-up. Parameter flip by multisig activates scaling without a code change.
- **`ReviewPeriodOverridden` event added** (§3.4) — emitted from `propose()` when `reviewPeriodOverride != 0` so guardian agents can prioritize compressed-window proposals. ~~_(later reverted in §17 — `reviewPeriodOverride` dropped as overkill)_~~
- **`transferOwnerStakeSlot(vault, newOwner)` documented** as the registry-side onlyFactory hook called by `SyndicateFactory.rotateOwner` (§3.1). Fixes API-list omission noted in review.
- **§15.1 (`unstick` owner-only) — resolved.** Confirmed; left as spec default.
- **§15.2 (Slash Appeal Reserve sizing) — owned by tokenomics governance**, not this spec.
- **§15.4 (owner dual-use as guardian on other vaults) — deferred to V1.5.** Confirmed.

## 16. Changelog — reward model switched to epoch-based (2026-04-19)

Replaces flat `rewardPerBlockWood` param with per-epoch distribution:

- **Removed:** `rewardPerBlockWood`, `rewardPool`, `fundRewardPool`, `claimBlockReward`, `pendingBlockReward`.
- **Added:** `EPOCH_DURATION = 7 days` constant, `epochGenesis`, `epochBudget[epochId]`, `epochGuardianBlockWeight[epochId][guardian]`, `epochTotalBlockWeight[epochId]`, `epochRewardClaimed[epochId][guardian]`.
- **Added functions:** `fundEpoch(epochId, amount)`, `claimEpochReward(epochId)`, `sweepUnclaimed(epochId)` (4-week idle → next epoch), `pendingEpochReward`, `currentEpoch`, `setMinter`.
- **Added arrays:** `_blockers[proposalId]` (parallel to `_approvers`), with `MAX_BLOCKERS_PER_PROPOSAL = 100` cap.
- **Added storage:** `_voteStake[proposalId][guardian]` — explicit first-vote snapshot, used for vote-change accounting (was implicit before).
- **Attribution:** on `resolveReview` when `blocked = true`, registry iterates `_blockers`, credits each blocker's `_voteStake` to `epochGuardianBlockWeight[epochId][guardian]` and `epochTotalBlockWeight[epochId]`, where `epochId = (proposal.reviewEnd - epochGenesis) / EPOCH_DURATION`.
- **Economic model:** per-epoch pool, pro-rata distribution by Block stake on blocked proposals. Protocol funds each epoch with any amount it chooses (multisig in V1, Minter emissions in V1.5). No static rate parameter — "how much to distribute" is a policy decision made fresh each epoch.

Why this shape:

1. Matches existing WOOD/Minter 7-day epoch cadence — enables direct emissions integration in V1.5 with zero schema change.
2. Decouples reward amount from a timelocked parameter setter; protocol doesn't need to predict a good per-block number.
3. Self-regulating: epochs with many blocks → smaller per-block share (avoids over-rewarding during attack spikes). Epochs with no blocks → budget rolls forward to the next epoch via `sweepUnclaimed`.
4. `fundEpoch(pastEpochId, amount)` is disallowed once any claim on that epoch has been processed — keeps accounting deterministic.

## 17. Changelog — simplification + ToB review feedback (2026-04-19)

**Simplifications applied per user feedback:**

- **Dropped `reviewPeriodOverride` entirely.** Removed the trailing `propose()` parameter, `minReviewPeriod` / `maxReviewPeriod` / `defaultReviewPeriod` split, `ReviewPeriodOverridden` event, and `InvalidReviewPeriod` error. Single global `reviewPeriod` (24h default) applies to every proposal. Per-proposal short windows return as a V1.5 question tied to proposer stake-at-risk. Side benefit: closes the time-compression attack vector flagged by the ToB `insecure-defaults` review (A1 #3).
- **Dropped storage-layout preservation language.** All contracts are being redeployed on `feat/mainnet-redeployment-params` — enum values, struct field ordering, and `__gap` math are fresh. `GuardianReview` is inserted at its natural lifecycle position (between `Pending` and `Approved`) rather than appended at the end; `reviewEnd` is placed logically in the `StrategyProposal` struct.

**ToB-style review findings still open (see §18 open questions):**

Three parallel ToB skill reviews (`guidelines-advisor`, `insecure-defaults`, `entry-point-analyzer`) converged on a punch list that the next spec revision should address before implementation. Highest-impact items:

- **Cold-start fail-open.** At cohort size 0–2, `totalStakeAtOpen = 0` and the review layer is effectively a no-op. Add `MIN_COHORT_STAKE_AT_OPEN` fallback to owner-veto semantics.
- **Replace first-vote snapshot with permissionless `openReview(id)` keeper at `voteEnd`.** First-vote snapshot is manipulable (cartel votes dust, then unstakes honest supply elsewhere, leaving honest Block pushes against an inflated denominator).
- **Pause mechanism + explicit `nonReentrant` on all WOOD-transfer exits.** Standard hardening for new economic contracts; currently implicit in the spec.
- **Drop `MAX_BLOCKERS_PER_PROPOSAL`.** Only approvers need the cap (slashing iteration). Capping blockers creates a DoS against honest defence.
- **Hardcode `MAX_REFUND_PER_EPOCH` in `refundSlash`.** "Capped per-epoch" must be enforced in code, not a doc promise.
- **Registry address consistency.** Assert `governor.guardianRegistry() == factory.guardianRegistry()` on every lifecycle hook, or make immutable post-init.
- **Vote-change stake gaming.** Forbid vote-change in the final 10% of the review window, or re-snapshot only on stake *increase*.
- **Re-check `requiredOwnerBond` at `emergencySettleWithCalls`** — not just bind/rotate — so owners can't stake at TVL=0 and drain at TVL=$10M.
- **Ship V1 with `ownerStakeTvlBps = 50`**, not 0. "Built the safety knob, left it off" is the classic fail-open pattern.
- **Permissionless `sweepUnclaimed` after a longer delay** (12w not 4w) to prevent owner-key-abuse cycling unclaimed rewards.

Full review output retained in the PR #229 comment thread.

## 18. Open questions (remaining)

1. **Slash Appeal Reserve sizing** — opening allocation and per-epoch refund cap. Owned by tokenomics governance (WOOD emissions + treasury allocation), not this spec. Will be resolved by a separate governance vote before mainnet launch.

All other open questions resolved. Spec is **ready for implementation plan** pending Option B prototype (§11) and `forge build --sizes` check.
