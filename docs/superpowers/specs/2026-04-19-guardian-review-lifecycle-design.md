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

// Guardian voting uses a SEPARATE enum from ISyndicateGovernor.VoteType (which is {For, Against, Abstain}).
// Keeping these distinct prevents enum-variant confusion at the ABI boundary between governor and registry.
enum GuardianVoteType { None, Approve, Block }

// Proposal review state (created by permissionless openReview() at voteEnd)
struct Review {
    bool opened;                // set true by openReview()
    bool resolved;              // set true by resolveReview()
    bool blocked;               // set true inside resolveReview() if block quorum
    bool cohortTooSmall;        // set true at openReview() if totalStakeAtOpen < MIN_COHORT_STAKE_AT_OPEN
    uint128 totalStakeAtOpen;   // _totalGuardianStake snapshot at openReview() call
    uint128 approveStakeWeight;
    uint128 blockStakeWeight;
}
// reviewEnd is NOT stored here — it lives on StrategyProposal.reviewEnd (governor).
mapping(uint256 proposalId => Review) private _reviews;
mapping(uint256 => mapping(address => GuardianVoteType)) private _votes;
mapping(uint256 => mapping(address => uint128)) private _voteStake; // weight at vote time; used for tally math + epoch attribution
mapping(uint256 => address[]) private _approvers;  // for batch-slashing — CAPPED at MAX_APPROVERS_PER_PROPOSAL
mapping(uint256 => address[]) private _blockers;   // for epoch-reward accounting — UNCAPPED (see §6 "Gas-bounded iteration — asymmetric by design" for why capping this would be a DoS vector)
// Index mappings enable O(1) removal from the arrays above during vote-change
// (1-indexed; 0 means "not in the array"; on remove, swap-and-pop + update index)
mapping(uint256 => mapping(address => uint256)) private _approverIndex;
mapping(uint256 => mapping(address => uint256)) private _blockerIndex;
// Slashing burn is pull-based as a fallback — see _slashApprovers for CEI reasoning
mapping(address => uint256) private _pendingBurn;  // WOOD that couldn't be burned in a loop iteration; anyone can call flushBurn(guardian)

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
uint256 public minOwnerStake;     // default: 10_000 WOOD  (flat floor — see §5 and requiredOwnerBond below)
uint256 public coolDownPeriod;    // default: 7 days
uint256 public reviewPeriod;      // default: 24 hours (single global value; no per-proposal override)
uint256 public blockQuorumBps;    // default: 3000 (30% of total guardian stake)

// Hardened constants (not timelocked — load-bearing safety bounds)
uint256 public constant MIN_COHORT_STAKE_AT_OPEN = 50_000 * 1e18; // cold-start fallback threshold (§ "Cold-start handling" below)
uint256 public constant MAX_APPROVERS_PER_PROPOSAL = 100;          // bounds _slashApprovers gas
uint256 public constant SWEEP_DELAY = 12 weeks;                    // sweepUnclaimed cannot fire earlier
uint256 public constant LATE_VOTE_LOCKOUT_BPS = 1000;              // forbid vote-change in final 10% of review window
uint256 public constant MAX_REFUND_PER_EPOCH_BPS = 2000;           // 20% of slash appeal reserve per epoch
uint256 public constant DEADMAN_UNPAUSE_DELAY = 7 days;            // pause auto-lifts after this

// Pause state (multisig-controllable circuit breaker for economic functions)
bool public paused;
uint64 public pausedAt;  // used for deadman auto-unpause

// Slash Appeal Reserve (separate WOOD pool; topped up by treasury; refundSlash draws from here only)
uint256 public slashAppealReserve;
mapping(uint256 epochId => uint256) public refundedInEpoch;  // enforces MAX_REFUND_PER_EPOCH_BPS

// Slashing: WOOD is burned (not sent to treasury) — see §5 rationale
address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

// Privileged addresses. UUPS-proxied storage, so no Solidity `immutable` keyword — instead
// these are set once in initialize() and NEVER reassigned (no setters exist). See Trust Assumptions.
address public governor;          // set-once at initialize(); no setter — see §3.1.Trust
address public factory;           // set-once at initialize(); no setter — see §3.1.Trust
address public minter;            // settable by owner (timelocked); authorizes fundEpoch() calls from the Minter
IERC20 public wood;               // WOOD token, set-once at initialize(); no setter — see §3.1.Trust
```

**Public / external functions:**

Guardian role:
- `stakeAsGuardian(uint256 amount, uint256 agentId)` — pull WOOD, register caller as active guardian. Requires `amount >= minGuardianStake`. Idempotent: existing guardians can top up (agentId is recorded once on first stake; subsequent calls ignore the agentId arg). The `agentId` is the caller's ERC-8004 identity NFT token ID; verified via `IdentityRegistry.ownerOf(agentId) == msg.sender`. V1 does nothing with this data beyond storage + event emission, but storing it now means the V2 reputation/EAS layer can read it without a migration. V1 accepts `agentId = 0` as "unregistered" for easier bootstrap — V2 migration will require a one-time `bindAgentId` call.
- `requestUnstakeGuardian()` — marks `unstakeRequestedAt = block.timestamp`. Guardian immediately loses voting power (removed from `_totalGuardianStake`). Cannot re-vote until unstake is either cancelled or claimed.
- `cancelUnstakeGuardian()` — reverses an unstake request; stake becomes voting-eligible again.
- `claimUnstakeGuardian()` — after `coolDownPeriod` elapses, releases WOOD to guardian. Zero-stake guardians are fully deregistered.
- `openReview(uint256 proposalId)` — **permissionless**. Callable once `block.timestamp >= proposal.voteEnd`. Snapshots `_totalGuardianStake` into `Review.totalStakeAtOpen` and marks `opened = true`. Subsequent calls are no-ops (idempotent). This is the **cold-start gate**: if `totalStakeAtOpen < MIN_COHORT_STAKE_AT_OPEN`, the review is treated as inactive-cohort — `resolveReview` returns `blocked = false` unconditionally and emits `CohortTooSmallToReview(proposalId, totalStakeAtOpen)`. Under cold-start conditions the owner's `vetoProposal` remains the only real defence. Moving the snapshot from first-vote to `openReview()` closes the denominator-manipulation attack where a cartel could freeze a high denominator then unstake honest supply. `openReview` can be called defensively by the governor at state-resolution time, by honest guardians before voting, or by anyone running a keeper.
- `voteOnProposal(uint256 proposalId, GuardianVoteType support)` — `Approve` or `Block` (distinct enum from governor's `VoteType` — see storage section). Requires `Review.opened == true` (otherwise the voter calls `openReview` first). Vote is allowed only when `voteEnd <= now < reviewEnd`. Snapshots the guardian's current `guardianStake` into `_voteStake[proposalId][msg.sender]` on first vote for the proposal. **Guardians MAY change their vote, but only up until `reviewEnd - (reviewPeriod * LATE_VOTE_LOCKOUT_BPS / 10_000)`** — i.e. the last 10% of the window is locked. Changing in an earlier window subtracts the guardian's `_voteStake` from the old side's tally and adds it to the new side; does NOT re-snapshot stake (prevents up-stake then late-switch gaming). Vote-change updates `_approvers` / `_blockers` array membership; both arrays use index mappings for O(1) removal. Calling with the same support you already recorded reverts with `NoVoteChange`; calling during the lockout window reverts with `VoteChangeLockedOut`; switching from Block → Approve reverts with `NewSideFull` if Approve cap is already reached. Approves are capped at `MAX_APPROVERS_PER_PROPOSAL` (emits `ApproverCapReached`); Blocks are uncapped. Honest vote-change in the early window is essential to prevent the cartel-slashing equilibrium (honest early Approver is strictly worse off than abstainer without it).

Owner role:
- `prepareOwnerStake(uint256 amount)` — pull WOOD into the registry under `_prepared[msg.sender]`. Does **not** yet bind to a vault. Must be ≥ `minOwnerStake` (the floor) — at prepare time we don't know which vault the stake will bind to, so we can't check the TVL-scaled bond yet. If the chosen vault's TVL-scaled bond exceeds the prepared amount at `bindOwnerStake` time, the bind reverts and the owner must top up and re-bind. One prepared stake per owner at a time.
- `cancelPreparedStake()` — only callable if not yet bound by the factory; refunds WOOD.
- `requestUnstakeOwner(address vault)` — vault owner only. Signals intent to exit; begins cool-down. Unstaking is **blocked while the vault has an active proposal** (any state between `Pending` and `Executed`) to prevent rage-quit around malicious executions.
- `claimUnstakeOwner(address vault)` — after cool-down, releases WOOD. Post-claim the vault is in a **grace-period** state (`ownerStaked == false`): new proposals cannot be created until owner re-binds a fresh stake.

Governor hooks:
- `openEmergencyReview(uint256 proposalId, bytes32 callsHash)` — **onlyGovernor**. Commits the calldata hash when owner calls `emergencySettleWithCalls`. Opens the window and snapshots `totalStakeAtOpen` immediately (this path has no separate openReview since there are no pre-emergency votes).
- `resolveReview(uint256 proposalId) returns (bool blocked)` — **permissionless**, **`nonReentrant`**, idempotent. Reads `reviewEnd` from the governor; requires `block.timestamp >= reviewEnd`. If `Review.opened == false` (nobody ever called `openReview`), returns `blocked = false` immediately — no activity means no block. If `totalStakeAtOpen < MIN_COHORT_STAKE_AT_OPEN`, returns `blocked = false` (cold-start cohort-too-small fallback). Otherwise computes `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`. **CEI ordering:** sets `resolved = true` and `blocked` flag BEFORE any token transfer. If `blocked == true`, calls `_slashApprovers` which zeros each approver's stake (state mutation) in a loop, then attempts a single bulk `wood.transfer(BURN_ADDRESS, total)` at the end — if that transfer reverts, the slashed amount is credited to `_pendingBurn[address(this)]` and anyone can call `flushBurn()` later to retry. State transitions already committed either way; review cannot get stuck. Governor calls this defensively from `_resolveState`; keepers can call it to trigger slashing independently.
- `resolveEmergencyReview(uint256 proposalId) returns (bool blocked)` — **permissionless**, **`nonReentrant`**, idempotent. Same CEI + pull-based burn pattern as `resolveReview`. Invokes `_slashOwner` when blocked.

**Note on lifecycle integration:** the Pending → GuardianReview transition happens via `_resolveStateView` once `block.timestamp > voteEnd`. The registry-side `Review` struct is created by `openReview()` (permissionless keeper call) rather than lazily on first vote — this closes the denominator-manipulation attack and serves as the cold-start detection point.

Factory hooks (onlyFactory):
- `bindOwnerStake(address owner, address vault)` — consumes `_prepared[owner]`, binds it as `_ownerStakes[vault]`. Reverts if no prepared stake, or if prepared amount `< requiredOwnerBond(vault)` (i.e. below `minOwnerStake`).
- `transferOwnerStakeSlot(address vault, address newOwner)` — called from `SyndicateFactory.rotateOwner` after the previous owner's stake has been slashed or unstaked. Reassigns the vault's owner-stake slot to `newOwner`, who must have called `prepareOwnerStake` first with ≥ `requiredOwnerBond(vault)`. Reverts if the previous owner still has an active stake on this vault (guards against hostile takeover while a legitimate owner is staked).

Emergency-settle vote:
- `voteBlockEmergencySettle(uint256 proposalId)` — active guardians vote to block. Any single vote adds their stake weight to `blockStakeWeight`. When `blockStakeWeight >= blockQuorumBps * _totalGuardianStake / 10_000`, the review is flagged blocked (resolved at `resolveEmergencyReview` time).

Slashing (internal, triggered by `resolveReview` / `resolveEmergencyReview` / governor):
- `_slashApprovers(uint256 proposalId)` — internal. **CEI order**: (1) read approvers list, (2) compute total amount, (3) zero each approver's `_guardians[g].stakedAmount` and decrement `_totalGuardianStake`, (4) single `wood.transfer(BURN_ADDRESS, total)` at the end. If the transfer reverts, total is moved to `_pendingBurn[address(this)]` and `PendingBurnRecorded(total)` is emitted — anyone can call `flushBurn()` later. State mutations already committed, so review is never stuck. Bounded by `MAX_APPROVERS_PER_PROPOSAL = 100`.
- `_slashOwner(address vault)` — internal. Same CEI + pull-burn pattern. Zeros `_ownerStakes[vault].stakedAmount`, burns WOOD via end-of-function transfer with `_pendingBurn` fallback.
- `flushBurn()` — **permissionless**, **`nonReentrant`**. Retries pending bulk burn from `_pendingBurn[address(this)]` → `BURN_ADDRESS`. Emits `BurnFlushed(amount)`.
- **Appeal path — `refundSlash(address recipient, uint256 amount)`:** **onlyOwner**, **`nonReentrant`**. Transfers WOOD from `slashAppealReserve` (a separate internal balance, NOT from the contract's general WOOD pool) to `recipient`. **Hard-coded cap per epoch**: `require(refundedInEpoch[currentEpoch()] + amount <= slashAppealReserve * MAX_REFUND_PER_EPOCH_BPS / 10_000)`. 20% ceiling means a compromised multisig cannot drain the reserve in a single call. `fundSlashAppealReserve(amount)` — **onlyOwner** — tops up the reserve via `wood.transferFrom(owner, registry, amount)`; no timelock since additions are always safe.

Reward distribution (Block-side, epoch-based):
- `fundEpoch(uint256 epochId, uint256 amount)` — **onlyOwner or onlyMinter**, **`nonReentrant`**. Pulls WOOD and adds `amount` to `epochBudget[epochId]`. Allowed for current and future epochs. For **past epochs**: allowed only if `epochBudget[epochId] == 0` (no funding yet, so nothing has been claimable). Once any funding lands for a past epoch, further top-ups are disallowed — this preserves deterministic per-claim accounting while still allowing the multisig to fund epochs retroactively after a missed cadence. Expected flow is one `fundEpoch` per epoch from the Minter (V1.5); in V1 the multisig funds each epoch.
- **How blocks accrue weight:** inside `resolveReview`, when the proposal resolves `blocked = true`, the registry iterates `_blockers[proposalId]` (UNCAPPED; only approvers have a cap since only they are burned in a loop). For each guardian:
  - `epochId = (block.timestamp - epochGenesis) / EPOCH_DURATION` — attribution uses the `resolveReview` *call* timestamp, not `proposal.reviewEnd`. This removes the proposer-side manipulation where a proposer picks a `reviewEnd` to land in a low-competition epoch (irrelevant once `reviewPeriodOverride` is gone, but still correct against future reintroduction).
  - `epochGuardianBlockWeight[epochId][guardian] += _voteStake[proposalId][guardian]`
  - `epochTotalBlockWeight[epochId] += _voteStake[proposalId][guardian]`
- `claimEpochReward(uint256 epochId)` — **`nonReentrant`**. Active or unstaking guardians claim pro-rata share after the epoch ends (`block.timestamp >= epochGenesis + (epochId + 1) * EPOCH_DURATION`). Payout = `epochBudget[epochId] * epochGuardianBlockWeight[epochId][msg.sender] / epochTotalBlockWeight[epochId]`. **CEI**: mark `epochRewardClaimed[epochId][msg.sender] = true` before the `wood.transfer` so reentrancy during an ERC-20 hook cannot double-claim. **Reverts with `NothingToClaim` if the computed payout is zero** — covers both (a) guardian had no block-weight that epoch and (b) the epoch has no budget yet. This is critical: if we only checked weight, an unfunded epoch would silently mark the claim slot true (`payout = 0 * weight / total`), permanently locking the guardian out of that epoch even if it gets funded later.
- `sweepUnclaimed(uint256 epochId)` — **permissionless** after `SWEEP_DELAY = 12 weeks` past epoch end. Transfers residual `epochBudget[epochId]` into `epochBudget[currentEpoch()]`. Previously owner-only with 4w delay; moving to 12w + permissionless prevents the owner-theft cycle where a compromised admin can `fundEpoch → wait → sweep → fundEpoch` against honest late claimants.
- Note: no reward for correct Approve in V1. Correct-Approve rewards (the full "good guardians rewarded weekly" loop from issue #227) are deferred to V1.5 with EAS. V1 only rewards the *active-defence* action (Block) because that is the one that materially prevented an LP loss.

Parameter setters (timelocked — reuses `GovernorParameters` timelock pattern):
- `setMinGuardianStake`, `setMinOwnerStake`, `setCoolDownPeriod`, `setReviewPeriod`, `setBlockQuorumBps`.
- `setMinter(address)` — owner-only, timelocked. Authorizes the Minter to call `fundEpoch` directly once emissions integration lands (V1.5).

Views:
- `guardianStake(address)`, `ownerStake(address vault)`, `totalGuardianStake()`, `isActiveGuardian(address)`, `hasOwnerStake(address vault)`, `getReview(uint256)`, `getEmergencyReview(uint256)`, `preparedStakeOf(address owner)`, `canCreateVault(address owner)`.
- `currentEpoch() returns (uint256)` — derives from `(block.timestamp - epochGenesis) / EPOCH_DURATION`.
- `pendingEpochReward(address guardian, uint256 epochId) returns (uint256)` — computes the guardian's claimable amount for that epoch. Returns 0 if the epoch hasn't ended, if already claimed, or if the guardian had no Block weight.
- `requiredOwnerBond(address vault) returns (uint256)` — returns `minOwnerStake`. Used by `bindOwnerStake` and `transferOwnerStakeSlot` to gate whether a prepared stake is sufficient. TVL-scaling was explored and rejected: it mixes decimals (WOOD 18 vs. vault asset decimals — 6 for USDC) and doesn't improve deterrence since drain and slash are mutually exclusive outcomes (`finalizeEmergencySettle` reverts when the block quorum is reached).

**Circuit breaker (pause / unpause):**
- `pause()` — **onlyOwner**. Sets `paused = true`, `pausedAt = block.timestamp`. Freezes: `voteOnProposal`, `openReview`, `resolveReview`, `resolveEmergencyReview`, `voteBlockEmergencySettle`, `claimEpochReward`, `flushBurn`, `_slashApprovers`, `_slashOwner` call sites. Does NOT freeze `stakeAsGuardian`, `requestUnstake*`, `claimUnstake*`, `prepareOwnerStake` — guardians and owners must always be able to exit positions they control.
- `unpause()` — **onlyOwner** or **permissionless** after `DEADMAN_UNPAUSE_DELAY = 7 days`. Deadman clause prevents a compromised/dead multisig from permanently halting the protocol. Emits `Unpaused(address caller, bool deadman)`.

**Cold-start handling:**

During weeks 1–12 (guardian cohort bootstrap), honest cohort size is small and `totalStakeAtOpen` may be below `MIN_COHORT_STAKE_AT_OPEN`. The gating is deterministic and on-chain:

1. `openReview(proposalId)` snapshots `totalStakeAtOpen`. If below threshold, the review is flagged `cohortTooSmall` (bit on `Review`, not shown in storage schema for brevity).
2. `resolveReview` on a cohort-too-small review returns `blocked = false` unconditionally. The review layer is effectively disabled for that proposal.
3. During cohort-too-small windows, the only defence is the vault owner's `vetoProposal` (still allowed in `Pending` state). Spec §7.1 already commits the protocol multisig to running a guardian-of-last-resort, but that is policy — the `MIN_COHORT_STAKE_AT_OPEN` constant is the mechanical guarantee.
4. Once cohort grows past threshold, the gating is automatic — no parameter flip needed.

This closes the fail-open window while bootstrapping; no new failure mode beyond "governance falls back to today's optimistic model until guardians show up," which is the system's actual cold-start property.

**Trust assumptions (explicit — codify in registry NatSpec):**

1. **WOOD token is fixed-behavior ERC-20.** No transfer hooks (ERC-777/1363), no transfer fees, no rebasing, no upgradeability with semantic changes. The slashing burn path and claim path assume `wood.transfer(x, n)` transfers exactly `n` tokens to `x` with no callback to `msg.sender`. If WOOD is ever upgraded to an ERC-777-like token, the slashing path becomes reentrancy-exposed via `tokensReceived` callbacks. Documented as a trust assumption parallel to the existing "delegatecall to BatchExecutorLib only" assumption flagged in CLAUDE.md §Safety.
2. **`governor` and `factory` addresses on the registry are stamped at `initialize()` and NEVER reassigned.** No `setGovernor` / `setFactory` setters. Any rewiring requires a full registry redeploy + upgrade — routed through UUPS, same multisig that controls governor upgrade. Closes the "registry drift" attack where governor and factory could point at different registries.
3. **`BURN_ADDRESS` has no known private key.** Using `0x...dEaD` rather than `address(0)` because some tokens revert on transfers to `address(0)`.
4. **Protocol multisig controls upgrade + pause + param timelock + refundSlash.** A compromised multisig can: pause for up to 7 days (deadman unpause), refund up to 20% of the slash appeal reserve per epoch, queue parameter changes (6h–7d timelock). Cannot: drain stakes, change governor/factory addresses, mint WOOD, or reverse a burn.
5. **ERC-8004 `IdentityRegistry` is correctly deployed and `ownerOf(agentId)` is a reliable view.** Used in `stakeAsGuardian(agentId)`. If the registry is compromised, guardians could bind fake `agentId`s, but V1 does nothing with this data so the damage is zero.

### 3.2 Modified: `SyndicateGovernor.sol`

Minimal changes, scoped to what the governor has to know.

- **Enum:** insert `GuardianReview` between `Pending` and `Approved` in `ProposalState`. Full ordering: `{Draft, Pending, GuardianReview, Approved, Rejected, Expired, Executed, Settled, Cancelled}`. All contracts are being redeployed on `feat/mainnet-redeployment-params` — no need to preserve existing enum slot values.
- **Struct:** add `uint256 reviewEnd` to `StrategyProposal`. Stamped at proposal creation alongside `voteEnd` and `executeBy`.
- **Storage:** add `address private _guardianRegistry`. Governor storage layout is fresh — no `__gap` gymnastics needed.
- **Initializer:** accept `guardianRegistry` address.
- **`propose()` signature:** unchanged from today (no `reviewPeriodOverride`). Single global `reviewPeriod` from the registry applies to every proposal. If specific strategies later demand shorter windows, that belongs in V1.5 alongside stake-at-risk controls for the proposer — not as a free knob in V1.
- **`propose()` body:** after computing `voteEnd` (non-collaborative) or when collaborative consent completes in **`approveCollaboration()`** (the existing entrypoint where the final co-proposer's approval stamps `voteEnd` for collaborative proposals — see `SyndicateGovernor.sol:378`), stamp `reviewEnd = voteEnd + registry.reviewPeriod()` and shift `executeBy = reviewEnd + executionWindow` (execution window is measured from the *end of guardian review*, not the end of voting). This keeps the full lifecycle deterministic from creation — no mid-flight parameter drift and no registry call needed at Pending → GuardianReview transition.
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
  - `unstick(uint256 proposalId)` — owner-only. Runs only the pre-committed `_settlementCalls` (no fallback, no custom calldata). Intended for cases where the settlement calls themselves are correct but need to be force-triggered (e.g., after strategy duration elapsed and proposer is unresponsive). Reverts if calls revert. Transitions proposal to `Settled`. Replaces the owner-instant path in today's `emergencySettle`. **`unstick` does NOT require active owner stake** — pre-committed settlement calls were already approved via normal governance + guardian review, so an owner whose bond was slashed via `finalizeEmergencySettle` on a different proposal must still be able to finalize legitimately-approved settlements on this one. This prevents a single slash from bricking every other in-flight proposal on the same vault.
  - `emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. **Re-checks owner bond at call time**: reverts with `OwnerBondInsufficient` if `registry.ownerStake(vault) < registry.requiredOwnerBond(vault)`. This prevents the "stake at TVL=0, drain at TVL=10M" attack — the bond must be sufficient for the vault's *current* size, not just what it was at bind time. Stores `calls` as committed settlement override. Calls `registry.openEmergencyReview(proposalId, keccak256(abi.encode(calls)))`. Does **not** execute calls yet — opens the review window. Emits `EmergencySettleProposed(proposalId, owner, callsHash, reviewEnd)`.
  - `cancelEmergencySettle(uint256 proposalId)` — owner-only. Callable any time before `reviewEnd`. Clears the committed calldata hash, closes the emergency review window without slashing. Lets an owner self-recall a mistaken `emergencySettleWithCalls` (e.g. wrong calldata) rather than forcing them to wait through a guaranteed-blocked review and get slashed. Does NOT refund gas. Emits `EmergencySettleCancelled(proposalId, owner)`.
  - `finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. Callable after `reviewEnd`. Reverifies `keccak256(abi.encode(calls)) == committed hash`. Calls `registry.resolveEmergencyReview(proposalId)`:
    - If `blocked`: registry slashes owner; function reverts (owner must try `unstick` or propose new calls, posting fresh stake first).
    - If not blocked: executes calls via `vault.executeGovernorBatch(calls)`, transitions proposal to `Settled`.

### 3.3 Modified: `SyndicateFactory.sol`

- Store `address public guardianRegistry` — **set-once at factory `initialize()` and NEVER reassigned (no setter exists)**. UUPS proxies can't use Solidity's `immutable` keyword for initializer-set state, so the invariant is enforced by absence of a write path rather than by the compiler. Matches the registry-side trust assumption (§3.1.Trust #2) that governor-registry and factory-registry cannot diverge. Any rewiring requires a full factory redeploy (UUPS upgrade with new implementation + `initialize` cannot overwrite already-set storage). The previously-proposed `setGuardianRegistry` timelocked setter is removed.
- In `createSyndicate`: before deploying the vault, call `guardianRegistry.canCreateVault(msg.sender)` (reverts if no prepared stake). After vault address is known, call `guardianRegistry.bindOwnerStake(msg.sender, vaultAddr)`. If bind fails, the whole creation reverts (atomic).
- **Assert registry consistency at call sites that cross contracts**: `rotateOwner` verifies `SyndicateGovernor(_governor).guardianRegistry() == guardianRegistry` before calling `transferOwnerStakeSlot`. A `RegistryMismatch` error surfaces any governance-process bug that wires the two contracts to different registries. `rotateOwner` is the primary cross-registry path; `createSyndicate` also reads both (via `canCreateVault` on the factory's registry and `addVault` on the governor), and both pointers are set-once-at-init on their respective contracts, so a post-init drift is the only failure mode — this `RegistryMismatch` guard surfaces it immediately.
- **`rotateOwner(address vault, address newOwner)` — factory owner, timelocked.** Recovery path for vaults whose current owner has been slashed (or abandoned keys / rage-quit). Requires the current owner's stake to be **already slashed or fully unstaked** (`registry.hasOwnerStake(vault) == false`) — prevents hostile owner-takeover while a legitimate owner is staked. Calls `SyndicateVault.transferOwnership(newOwner)` and `registry.transferOwnerStakeSlot(vault, newOwner)` so the new owner can post fresh stake. Without this function, a slashed owner who walks away leaves the vault permanently unable to create new proposals — a dead-vault risk flagged by Carlos's review (PR #229). Timelock + multisig gating keeps it from being a bypass of the slashing economics.

### 3.4 Modified: `ISyndicateGovernor.sol`

New enum value, new struct field, new errors, new events, new function signatures:

- Errors: `NotInGuardianReview`, `EmergencySettleBlocked`, `EmergencySettleNotReady`, `EmergencySettleMismatch`, `RegistryNotSet`, `OwnerBondInsufficient`, `RegistryMismatch`, `VoteChangeLockedOut`, `NoVoteChange`, `NewSideFull`, `CohortTooSmallToReview` (event, not error — informational), `Paused`.
- Events (governor-side): `GuardianReviewResolved(uint256 indexed proposalId, bool blocked)`, `EmergencySettleProposed(uint256 indexed proposalId, address indexed owner, bytes32 callsHash, uint256 reviewEnd)`, `EmergencySettleCancelled(uint256 indexed proposalId, address indexed owner)`, `EmergencySettleFinalized(uint256 indexed proposalId, int256 pnl)`.
- Events (registry-side): `ReviewOpened(uint256 indexed proposalId, uint128 totalStakeAtOpen)`, `CohortTooSmallToReview(uint256 indexed proposalId, uint256 totalStakeAtOpen)`, `EpochFunded(uint256 indexed epochId, address indexed funder, uint256 amount)`, `EpochRewardClaimed(uint256 indexed epochId, address indexed guardian, uint256 amount)`, `EpochUnclaimedSwept(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount)`, `ApproverCapReached(uint256 indexed proposalId)`, `PendingBurnRecorded(uint256 amount)`, `BurnFlushed(uint256 amount)`, `Paused(address indexed by)`, `Unpaused(address indexed by, bool deadman)`, `SlashAppealRefunded(address indexed recipient, uint256 amount, uint256 epochId)`, `SlashAppealReserveFunded(address indexed by, uint256 amount)`.
- Function changes: drop `emergencySettle`; add `unstick`, `emergencySettleWithCalls`, `cancelEmergencySettle`, `finalizeEmergencySettle`. `propose()` signature unchanged.

## 4. Data flow — key scenarios

**Normal happy path:**
1. Agent submits proposal → `Pending` → voting. On `propose()` the governor already stamped `reviewEnd = voteEnd + reviewPeriod` and `executeBy = reviewEnd + executionWindow`.
2. `voteEnd` elapses. State derivation in `_resolveStateView` returns `GuardianReview` (no transactions needed).
3. After `voteEnd`, any keeper (including an honest guardian) calls `openReview(proposalId)` — this snapshots `totalStakeAtOpen` in the registry. Guardians then vote Approve (majority) / Block (minority); neither tally hits block quorum.
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
| `minGuardianStake` | 10_000 WOOD | ≥ 1 WOOD | Mainnet floor set by multisig timelock; absolute `≥ 1 WOOD` bound is a testnet-only floor so dust-stake tests work. Timelock a real mainnet minimum before launch. |
| `minOwnerStake` | 10_000 WOOD | ≥ 1_000 WOOD | Lowered from 50k per business review — onboarding friction for small creators. Flat floor; `requiredOwnerBond(vault) == minOwnerStake`. |
| `coolDownPeriod` | 7 days | 1–30 days | Matches issue #227; aligns with Sherwood's existing multi-day governance rhythms. |
| `reviewPeriod` | 24 hours | 6h–7 days | Single global review window. No per-proposal override in V1 — if a strategy needs a shorter window, that's a V1.5 question tied to proposer stake-at-risk, not a V1 knob. |
| `blockQuorumBps` | 3000 (30%) | 1000–10000 | Below 50% so a motivated guardian minority can stop clearly malicious proposals; high enough that random dissent doesn't grief. |
| `EPOCH_DURATION` | 7 days | — (constant) | Matches the Minter emissions epoch so guardian rewards can be wired into the same weekly cycle once V1.5 lands. |
| `MIN_COHORT_STAKE_AT_OPEN` | 50_000 WOOD | — (constant) | Cold-start threshold. Reviews opened with less stake than this fall back to `blocked=false` + owner-only defence. Mechanical guarantee that the review layer cannot be the *sole* defence during bootstrap. |
| `MAX_APPROVERS_PER_PROPOSAL` | 100 | — (constant) | Bounds `_slashApprovers` gas. `ApproverCapReached` event fires when reached. No corresponding cap on blockers — intentionally asymmetric, see §6. |
| `SWEEP_DELAY` | 12 weeks | — (constant) | Minimum time after epoch end before `sweepUnclaimed` is callable. Long window protects honest late claimants. Permissionless after the delay. |
| `LATE_VOTE_LOCKOUT_BPS` | 1000 (10%) | — (constant) | Final 10% of the review window is locked for vote changes. Prevents cartel stake-up + late-switch gaming. |
| `MAX_REFUND_PER_EPOCH_BPS` | 2000 (20%) | — (constant) | Ceiling on `refundSlash` per epoch, enforced in-code. Compromised multisig cannot drain the slash appeal reserve in a single call. |
| `DEADMAN_UNPAUSE_DELAY` | 7 days | — (constant) | If owner pauses and goes silent, anyone can unpause after this delay. |
| Per-epoch reward budget | **set per-epoch** | — | No static rate parameter. The protocol calls `fundEpoch(epochId, amount)` each epoch with whatever WOOD it chooses to allocate (initially via multisig; later via Minter emissions). Guardians split the epoch's pool pro-rata by their Block-vote stake weight on proposals that resolved blocked during that epoch. |
| **Slash destination** | **BURN** (`0x…dEaD`) | — | Chosen over treasury per business review: cleaner regulatory posture (slash is not protocol-controlled revenue), aligns with WOOD scarcity narrative, removes any treasury-capture incentive to over-slash. Wrongful slashes are made whole via the appeal path (see §7), funded from a separate slash appeal reserve (internal balance, separate from general WOOD pool, capped at 20% refund per epoch). |

All parameters are timelocked using the same queue/finalize pattern as `GovernorParameters.sol`, with `MIN_PARAM_CHANGE_DELAY = 6 hours` and `MAX_PARAM_CHANGE_DELAY = 7 days`.

## 6. Security notes

- **Gas-bounded iteration — asymmetric by design.** `_slashApprovers` iterates `_approvers[proposalId]` AND zeroes each stake AND does a token transfer — bounded by `MAX_APPROVERS_PER_PROPOSAL = 100`. `_blockers[proposalId]` iteration inside `resolveReview` only updates epoch-weight mappings (no token transfers, no per-element SSTORE to zero) — does NOT need a cap. Capping blockers would create a DoS against honest defence (a 100-wallet cartel could fill the Block side on every proposal; later honest blockers would revert). No `MAX_BLOCKERS_PER_PROPOSAL` constant exists in this spec.
- **CEI on slash + pull-based burn fallback.** `_slashApprovers` / `_slashOwner` write all state (zero stakes, decrement `_totalGuardianStake`, set `resolved = true`, set `blocked = true`) BEFORE the `wood.transfer(BURN_ADDRESS, total)`. If the transfer reverts (pathological WOOD upgrade, paused token, etc.), the amount moves to `_pendingBurn[address(this)]` and `flushBurn()` can retry later — state transition is already committed, so the review is never stuck.
- **Pause mechanism + deadman auto-unpause.** Registry has `pause()` / `unpause()` gated by owner, with a 7-day deadman clause that lets anyone unpause if the owner goes silent. Freezes `voteOnProposal`, `openReview`, both `resolve*`, `voteBlockEmergencySettle`, `claimEpochReward`, `flushBurn`, and the slashing call sites. Intentionally does NOT freeze unstake/claim paths — positions must remain exitable.
- **Reentrancy:** every external entrypoint that moves WOOD is `nonReentrant`: `stakeAsGuardian`, `claimUnstakeGuardian`, `prepareOwnerStake`, `cancelPreparedStake`, `claimUnstakeOwner`, `fundEpoch`, `claimEpochReward`, `sweepUnclaimed`, `flushBurn`, `refundSlash`, `fundSlashAppealReserve`, `resolveReview`, `resolveEmergencyReview`. Plus the trust assumption that WOOD has no transfer hooks (§3.1.Trust #1) — belt + suspenders.
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
- **Known minor asymmetry on `NewSideFull`:** a guardian who voted Block early cannot switch to Approve if the approver cap (100) is already saturated. Under the guardian-vote-change mechanics this reverts with `NewSideFull`. Not outcome-affecting — block quorum is a percentage of total guardian stake, not of votes cast, so a saturated Approve side doesn't flip the outcome. But it's a UX edge case: a guardian who changes their mind late on a popular proposal may be locked out of the new side. Acceptable in V1 because it only fires once 100 wallets have already voted Approve — a signal that the proposal is being heavily scrutinized on the Approve side, so a switch to Block (always available; Block is uncapped) is almost certainly the safer action for an uncertain guardian anyway.

## 7. Bootstrap policy & appeal path

Two commitments published before mainnet — documented in `mintlify-docs/learn/guardians.mdx` (new page) and cross-referenced here so both technical reviewers and LPs can see the governance surface around slashing.

### 7.1 Guardian-of-last-resort (bootstrap, weeks 1–12)

During the first 12 weeks after mainnet launch, the Sherwood protocol multisig commits to:

- Running a guardian agent that votes on **every** proposal across every registered vault.
- Publishing weekly guardian-coverage reports in the Sherwood forum (proposals reviewed, Approves, Blocks, outcomes).
- Staking ≥ `minGuardianStake` from protocol treasury.
- **Funding `epochBudget` each week during bootstrap.** The multisig commits to calling `fundEpoch(currentEpoch, X)` at the start of each epoch, with `X` sized so the flat bounty lands above expected guardian gas costs per proposal. Unfunded epochs do NOT revert claims — guardians still accrue `epochGuardianBlockWeight` and can claim zero if no WOOD is allocated. This explicit bootstrap budget replaces the V1.5 Minter emissions wiring until it lands.

This closes the "what if no guardians show up" failure mode during bootstrap and gives external guardians a reference implementation to benchmark against. After week 12, the multisig's guardian participation becomes optional and cohort health is measured independently (see §11).

### 7.2 Appeal path for wrongful slashes

Slashing is on-chain and final (WOOD is burned). Appeals are handled as treasury-funded refunds, **not** on-chain slash reversals, which keeps the slashing contract simple and the economic signal unambiguous.

Flow:
1. Slashed party opens an appeal by posting an on-forum case with proposal simulation / calldata analysis / reasoning within 30 days of the slash event.
2. Protocol governance (veWOOD voters) votes on the appeal; quorum and threshold set by tokenomics governance, not by this spec.
3. If upheld, the protocol multisig calls `GuardianRegistry.refundSlash(recipient, amount)` — a permissioned, per-epoch-capped function that transfers WOOD from a dedicated **Slash Appeal Reserve** (funded via treasury allocation at deployment, topped up by governance vote).
4. Refund cap per epoch prevents a compromised multisig from draining the reserve in a single transaction.
5. All refunds emit `SlashAppealRefunded(address indexed recipient, uint256 amount, uint256 epochId)` events for transparency (see §3.4 event list).

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
2. Block-quorum rejection — Approvers slashed, Blockers keep stake and accrue epoch-weight.
3. Unstake griefing — guardian Approves then requests unstake; slashing still applies before claim.
4. Owner attempts `vetoProposal` during `GuardianReview` → reverts.
5. Owner attempts `emergencyCancel` on `Approved` → reverts.
6. `emergencySettleWithCalls` blocked by guardians → owner slashed; `finalizeEmergencySettle` reverts.
7. `emergencySettleWithCalls` not blocked → executes normally after `reviewEnd`.
8. `unstick` with working pre-committed settlement calls → succeeds.
9. Factory `createSyndicate` without prepared owner stake → reverts.
10. Max-approvers cap — 101st Approve reverts, 101st Block succeeds (blockers uncapped).
11. **Cold-start fallback** — proposal opens with `totalStakeAtOpen < MIN_COHORT_STAKE_AT_OPEN`, block votes cast, `resolveReview` returns `blocked=false` regardless of tally, `CohortTooSmallToReview` emitted.
12. **Denominator-manipulation** — attempt to freeze `totalStakeAtOpen` before Block votes by having a cartel vote dust early; asserts that `openReview` was called at `voteEnd` and cartel can't pre-empt the snapshot.
13. **Late-vote lockout** — vote-change in final 10% of review window reverts with `VoteChangeLockedOut`.
14. **CEI + pull-burn** — mock WOOD transfer to reject on first call; `resolveReview` still sets `resolved=true`, amount goes to `_pendingBurn`, `flushBurn()` succeeds on retry.
15. **Pause + deadman** — owner pauses, tries to vote → reverts; wait 7 days + 1 second, any address calls `unpause()` → succeeds.
16. **Refund cap** — multisig calls `refundSlash` for >20% of reserve in one epoch → reverts; second call same epoch staying under cumulative cap → succeeds.
17. **Sweep delay** — `sweepUnclaimed(epochId)` before `SWEEP_DELAY` elapses → reverts; after → permissionless success.
18. **`emergencySettleWithCalls` with insufficient bond** — owner bond was slashed below `minOwnerStake`; `emergencySettleWithCalls` reverts with `OwnerBondInsufficient` until owner tops up.
19. **`cancelEmergencySettle`** — owner submits bad calldata, self-recalls before `reviewEnd`, no slash; re-submits correct calldata.
20. **Registry mismatch** — factory `rotateOwner` with a governor whose `guardianRegistry != factory.guardianRegistry` reverts with `RegistryMismatch`.

Fuzz targets:
- Randomized vote sequences; assert `blockStakeWeight + approveStakeWeight <= totalGuardianStakeAtReviewOpen`.
- Randomized stake/unstake sequences; assert total WOOD conservation.

## 9. Deployment plan

1. Deploy `GuardianRegistry` behind UUPS proxy. Owner = protocol multisig.
2. Configure initial parameters (see §5).
3. Deploy new `SyndicateGovernor` implementation. Proxy upgrade existing governor (still pre-mainnet — no in-flight proposals to migrate).
4. Deploy new `SyndicateFactory` implementation. Proxy upgrade.
5. Factory and governor are deployed with `guardianRegistry` stamped at their `initialize()` — there is no post-deploy setter. Address consistency between governor and factory is enforced via the immutable stamp + the `rotateOwner` `RegistryMismatch` assert.
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
| Add `cancelEmergencySettle` (owner self-recall, clears committed hash) | +200 |
| Add `finalizeEmergencySettle` (hash reverify, calls loop, slashing branch) | +600 |
| `_resolveStateView` / `_resolveState` new GuardianReview branch | +400 |
| `reviewEnd` stamping in `propose()` / `approveCollaboration()` | +200 |
| New errors + events | +150 |
| Set-once `_guardianRegistry` init param + storage read (no setter) | +120 |
| **Additions subtotal** | **+2,470 bytes** |
| **Net estimated delta after `emergencySettle` removal** | **+970 to +1,670 bytes** (larger number = worse; depends on solc optimizer) |

Even the optimistic case (+970) blows the 53-byte margin. This must be mitigated before implementation or the governor won't deploy. Actual measurement required after Option B prototype lands.

### Mitigation options (in order of preference)

**Option B — extract `GovernorEmergency.sol` abstract contract.** Preferred.

- Create `contracts/src/GovernorEmergency.sol` — abstract, matching the pattern of `GovernorParameters.sol`.
- Move **all four** emergency entrypoints — `unstick`, `emergencySettleWithCalls`, `cancelEmergencySettle`, `finalizeEmergencySettle` — and their internal helpers (`_tryPrecommittedSettle`, `_verifyCallsHash`) into it. Keeping them together makes the abstract's state-machine single-purpose.
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
- **`bindAgentId(uint256 agentId)`** — V2 migration entrypoint for guardians who staked with `agentId = 0` during V1 bootstrap. Required when the EAS reputation layer lands (Approve-side rewards + slash-appeal reputation). Verifies `IdentityRegistry.ownerOf(agentId) == msg.sender`, stores once per guardian, immutable thereafter.
- **LLM knowledge base** — compiled good/bad attestations + reasoning → off-chain dataset for Hermes guardian skill training.
- **Shareholder challenge (Option C)** — post-settlement jury-style adjudication for malicious proposals that slipped past guardians.
- **Vault-asset slash redirect** — swap slashed WOOD to vault asset at slash time, pay directly to LPs harmed.
- **Guardian reputation decay** — aged-out stake, repeated-correct-vote multipliers.
- **Hermes `guardian` skill** — off-chain agent runtime that scans proposals across all syndicates and calls `voteOnProposal`.

## 13. Open questions

1. **Slash Appeal Reserve sizing** — opening allocation and per-epoch refund cap beyond the hardcoded `MAX_REFUND_PER_EPOCH_BPS = 2000`. Owned by tokenomics governance (treasury allocation), not this spec; resolved by a separate governance vote before mainnet launch.

All other open questions resolved during review (PR #229 comment thread has the full history). Spec is ready for implementation plan pending the Option B prototype (§11) and `forge build --sizes` check.
