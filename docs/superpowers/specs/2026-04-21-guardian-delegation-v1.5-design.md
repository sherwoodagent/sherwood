# Guardian Delegation V1.5 — Design Spec

**Status:** Draft, awaiting review
**Branch:** `feat/guardian-delegation-v1.5` (off `feat/guardian-review-lifecycle`)
**Date:** 2026-04-21
**Depends on:** `feat/guardian-review-lifecycle` (PR #229) merged

---

## 1. Motivation

### Problem 1 — Top-up-before-vote bias

`voteOnProposal` and `voteBlockEmergencySettle` read the guardian's *live* `stakedAmount` at first-vote time, while `totalStakeAtOpen` is frozen at `openReview` / `openEmergencyReview`. A guardian who stakes additional WOOD between the review open and their first vote contributes their new weight to the numerator while the denominator stays fixed. This biases quorum in favour of the voting side and is present in both standard and emergency review paths.

### Problem 2 — No way for non-operational WOOD holders to participate in governance

A WOOD holder who trusts a specific agent's judgement currently has two options: run their own guardian operation (monitor, review, respond within 24h windows) or have no governance voice at all. The activation floor (`minGuardianStake` = 10k WOOD) and the operational burden put passive delegation out of reach. The guardian cohort is smaller and less legitimate than it should be because WOOD supply sitting in passive wallets contributes zero quorum weight.

### Problem 3 — Approve-bias (asymmetric incentives)

Under V1, approving carries slashing risk with zero upside: if a proposal passes optimistic review but was malicious, approvers are slashed; if it passes and was good, approvers earn nothing. Rational guardians only vote Block (or abstain), never Approve — there is no economic reason to signal a *good* proposal. The optimistic-governance model assumes an active Approve side that doesn't materialize under V1 incentives. V1.5 fixes this with a **guardian fee** slice of settled performance that flows to approvers pro-rata by their vote weight, restoring incentive symmetry.

### What V1.5 delivers

1. **Checkpoint-based vote weight.** Replace live `stakedAmount` reads with `getPastStake(g, openedAt)` at the review open time. Both numerator and denominator are now measured at the same instant — top-up bias eliminated.
2. **Stake-pool delegation.** Any WOOD holder can `delegateStake(delegate, amount)`, moving WOOD from their wallet into the registry. The delegate's vote weight at a review = own stake + sum of delegated stakes (all checkpointed at `openedAt`). Delegators can `requestUnstakeDelegation` with the same 7-day cooldown as guardians.
3. **DPoS commission split.** Each delegate sets a `commissionBps` (default 0, max `MAX_COMMISSION_BPS` = 5000). When a delegate earns epoch rewards from Block-voting on blocked proposals, `commissionBps` of the reward flows to the delegate and `(10000 - commissionBps)` flows pro-rata to their delegators. Delegators claim via a pull function.
4. **WOOD as ERC20VotesUpgradeable.** Redeploy WOOD to standard OZ `ERC20VotesUpgradeable` for off-chain governance UX (vote-weight indexers, Snapshot-style signalling tools). Not used for on-chain registry logic — registry uses its own checkpoints because it needs per-delegator-per-delegate attribution that ERC20Votes doesn't provide natively.
5. **Guardian fee on settled performance.** New timelocked `guardianFeeBps` governor parameter (default 100 bps = 1%, max 500 bps = 5%). On successful settlement, `grossPnL * guardianFeeBps / 10_000` is carved out before agent fee and funneled to the proposal's approvers pro-rata by their frozen `_voteStake`. Applies DPoS commission split: `commissionBps` to the approver (delegate), remainder to their delegators. Fixes Problem 3 and closes the incentive asymmetry.

---

## 2. Architecture

### Contract topology

```
┌──────────────────────────┐
│  WOOD                    │   ERC20VotesUpgradeable (for off-chain UX)
│  — redeployed            │   holders delegate for Snapshot-style signalling
└──────────────┬───────────┘
               │ stake() / delegateStake()
               ▼
┌──────────────────────────┐
│  GuardianRegistry V1.5   │
│                          │
│  OwnStake checkpoints    │   Checkpoints.Trace224 per guardian
│  DelegatedStake pool     │   per-(delegate, delegator) locked balance
│  Commission config       │   per-delegate: commissionBps + cooldown
│  Epoch reward accounting │   per-epoch: delegate total, delegator pro-rata
└──────────────────────────┘
```

### What lives where

- **WOOD ERC20Votes machinery** is used only for off-chain signalling (dashboards, Snapshot). No on-chain registry logic reads `getPastVotes`.
- **Own-stake + delegation accounting** lives entirely in `GuardianRegistry`. Custody of delegated WOOD moves into the registry at `delegateStake` time, same as guardian own-stake.
- **Slashing** is unchanged in scope — only a delegate's own stake is slashable. Delegators are not parties to any approval vote and cannot be slashed. When a delegate is slashed, the delegation pool is untouched; delegators simply have a deactivated delegate and can `requestUnstakeDelegation` or `redelegate` (see §4.7).

---

## 3. Core invariants

- **INV-V1.5-1** (single stake vs delegation source): `_guardians[g].stakedAmount` = WOOD transferred in via `stakeAsGuardian`; `_delegatedInbound[delegate]` = sum of `_delegations[delegator][delegate]` over all delegators; the two pools are disjoint.
- **INV-V1.5-2** (vote weight sum): `getPastVoteWeight(delegate, t) == getPastStake(delegate, t) + getPastDelegated(delegate, t)` for all `t`.
- **INV-V1.5-3** (denominator parity): `totalStakeAtOpen + totalDelegatedAtOpen` at `openReview` time exactly equals `sum(getPastVoteWeight(g, openedAt))` over the active cohort at `openedAt`.
- **INV-V1.5-4** (delegation custody): `IERC20(WOOD).balanceOf(registry) == totalGuardianStake + totalDelegatedStake + slashAppealReserve + pendingBurn + pendingEpochRewards`.
- **INV-V1.5-5** (reward split): for any epoch E and delegate D, `commissionPaid[D][E] + sum(delegatorReward[D][delegator][E]) == totalRewardEarned[D][E]`; nothing is created or destroyed in the split.
- **INV-V1.5-6** (commission bounds): `0 <= commissionBps[D] <= MAX_COMMISSION_BPS` at all times.
- **INV-V1.5-7** (no retroactive commission): commission rate applied at reward claim is the rate checkpointed at the epoch end, not the current rate.
- **INV-V1.5-8** (guardian-fee sum): for any settled proposal P, `sum(claimedProposalReward[P][approver]) + sum(claimedDelegatorProposalReward[P][*][delegator]) <= _proposalGuardianPool[P].amount`; the reverse inequality holds once all claims resolve.
- **INV-V1.5-9** (guardian-fee bounds): `0 <= guardianFeeBps <= MAX_GUARDIAN_FEE_BPS = 500` at all times; enforced at queue AND finalize.
- **INV-V1.5-10** (fee-waterfall ordering): in `_distributeFees`, `protocolFee + guardianFee + agentFee + mgmtFee <= grossPnL` by construction (each taken from remaining).

---

## 4. Core flows

### 4.1 Delegator: delegate stake

```
delegator ──delegateStake(delegate, amount)──▶ GuardianRegistry
                                                - require delegate != 0, amount > 0
                                                - transfer WOOD from delegator
                                                - _delegations[delegator][delegate] += amount
                                                - _delegatedInbound[delegate] += amount
                                                - push delegate inbound checkpoint
                                                - emit DelegationIncreased
```

Notes:
- Delegator can split WOOD across multiple delegates; `_delegations` is a mapping, not a single-delegate field.
- No cap on how many delegators can point at one delegate.
- Delegate need not be an active guardian at time of delegation — delegation is permissive (decision #2 locked).

### 4.2 Delegator: request unstake + claim

```
delegator ──requestUnstakeDelegation(delegate)──▶ GuardianRegistry
                                                  - _unstakeDelegation[delegator][delegate] = now
                                                  - emit DelegationUnstakeRequested

(after UNSTAKE_COOLDOWN = 7 days)

delegator ──claimUnstakeDelegation(delegate)──▶ GuardianRegistry
                                                - check cooldown elapsed
                                                - amount = _delegations[delegator][delegate]
                                                - _delegations[delegator][delegate] = 0
                                                - _delegatedInbound[delegate] -= amount
                                                - push delegate inbound checkpoint
                                                - WOOD.safeTransfer(delegator, amount)
                                                - emit DelegationUnstakeClaimed
```

Notes:
- Same 7-day cooldown as guardian unstake, for consistency and to prevent rapid-switch gaming of review-window weights.
- A delegator can `cancelUnstakeDelegation` to restore voting power (mirrors guardian path).

### 4.3 Vote weight at review time

```
At openReview(proposalId):
  r.totalStakeAtOpen    = _totalStakeCheckpoint.upperLookupRecent(now)
  r.totalDelegatedAtOpen = _totalDelegatedCheckpoint.upperLookupRecent(now)

At voteOnProposal(proposalId) — first vote:
  weight = getPastStake(msg.sender, r.openedAt)
         + getPastDelegated(msg.sender, r.openedAt)
  r.<side>StakeWeight += weight
  _voteStake[proposalId][msg.sender] = weight
```

Both numerator and denominator now reference the same `openedAt` snapshot. Top-up bias eliminated.

### 4.4 Slashing (unchanged in spec, checkpoint-aware in impl)

```
_slashApprovers(proposalId):
  for each approver a:
    snapshot = _voteStake[proposalId][a]                     // already frozen at vote time
    burn    = min(snapshot, _guardians[a].stakedAmount)      // cap at own stake only
    _guardians[a].stakedAmount -= burn
    push own-stake checkpoint (new value)
    emit ApproverSlashed(a, burn)
```

Delegators are never slashed. A slashed delegate's `_delegatedInbound` is unchanged by the slash itself — but `getPastVoteWeight` for future reviews will reflect the delegate's reduced own stake. Delegators see their delegate become less effective (lower own weight) and can re-delegate.

### 4.5 Epoch rewards — earning

```
On resolveReview(proposalId) when blocked:
  for each blocker b:
    weight = _voteStake[proposalId][b]
    _blockerWeightInEpoch[currentEpoch][b] += weight
    _totalBlockerWeightInEpoch[currentEpoch] += weight
```

Per-delegate per-epoch weight is tracked. Rewards pool for epoch E is funded via `fundEpoch(E, amount)`.

### 4.6 Epoch rewards — claiming

```
delegate ──claimEpochReward(epochId)──▶ GuardianRegistry
                                         - w = _blockerWeightInEpoch[epochId][delegate]
                                         - pool = _epochBudget[epochId]
                                         - gross = (pool * w) / _totalBlockerWeightInEpoch[epochId]
                                         - rate = _commissionAtEpoch[delegate][epochId]   // checkpointed, INV-V1.5-7
                                         - commission = (gross * rate) / 10_000
                                         - remainder = gross - commission
                                         - _delegateReward[delegate][epochId] = commission
                                         - _delegatorPool[delegate][epochId] = remainder
                                         - transfer `commission` to delegate
                                         - emit EpochRewardClaimed(delegate, epochId, gross, commission, remainder)

delegator ──claimDelegatorReward(delegate, epochId)──▶ GuardianRegistry
                                                       - pool = _delegatorPool[delegate][epochId]
                                                       - my = getPastDelegationTo(msg.sender, delegate, epochEnd[epochId])
                                                       - total = getPastDelegated(delegate, epochEnd[epochId])
                                                       - share = (pool * my) / total
                                                       - require !_delegatorClaimed[delegate][epochId][msg.sender]
                                                       - _delegatorClaimed[...] = true
                                                       - transfer `share` to delegator
                                                       - emit DelegatorRewardClaimed(delegator, delegate, epochId, share)
```

Notes:
- **Two-step claim:** the delegate MUST claim first to seed `_delegatorPool[delegate][epochId]`. Delegators then claim their share. Delegate skipping the claim → delegators can't claim. Counter-incentive: delegate's own commission is also gated on the same call, so they're aligned to claim promptly.
- **Attribution timestamp:** `epochEnd[epochId]` is used for `getPastDelegationTo` / `getPastDelegated` lookups. A delegator who delegated on day 3 of a 7-day epoch gets proportional credit for days 3–7 (weighted by TIME × AMOUNT via the checkpoint integration). See §4.8.
- **No double-claim:** per-epoch flag prevents a delegator from claiming twice.

### 4.7 Commission configuration

```
delegate ──setCommission(newBps)──▶ GuardianRegistry
                                    - require newBps <= MAX_COMMISSION_BPS (5000 = 50%)
                                    - require not raising too fast (see below)
                                    - _commissionBps[delegate] = newBps
                                    - push checkpoint (epochId, newBps)
                                    - emit CommissionSet
```

**Increase-rate limit:** commission can only be raised by `MAX_COMMISSION_INCREASE_PER_EPOCH` (default 500 = 5%) per epoch, cumulative. This prevents a delegate from instant-ramping to 50% right before claim, rugging delegators. Decreases are unbounded. Implementation: track `_lastCommissionRaiseEpoch[delegate]` and cap `newBps - oldBps` if in the same epoch as the last raise.

**Checkpointed application (INV-V1.5-7):** at epoch rollover, the commission-at-epoch is frozen. Claims for past epochs use the frozen rate, not the current rate.

### 4.8 Guardian-fee flow (approver reward on settled performance)

```
_distributeFees(proposalId, vault, asset, proposer, perfFeeBps, grossPnl):
  protocolFee = grossPnl * protocolFeeBps / 10000
  guardianFee = grossPnl * guardianFeeBps / 10000            ← NEW
  remaining   = grossPnl - protocolFee - guardianFee
  agentFee    = remaining * perfFeeBps / 10000
  mgmtFee     = (remaining - agentFee) * mgmtFeeBps / 10000

  _payFee(vault, asset, protocolRecipient, protocolFee)
  _fundGuardianPool(proposalId, vault, asset, guardianFee)    ← NEW
  _distributeAgentFee(...)
  _payFee(vault, asset, vaultOwner, mgmtFee)

_fundGuardianPool(proposalId, vault, asset, amount):
  if (amount == 0) return
  ISyndicateVault(vault).transferPerformanceFee(asset, address(registry), amount)
  IGuardianRegistry(registry).fundProposalGuardianPool(proposalId, asset, amount)
  emit ProposalGuardianPoolFunded(proposalId, asset, amount)
```

```
approver ──claimProposalReward(proposalId)──▶ GuardianRegistry
                                               - pool = _proposalGuardianPool[proposalId]
                                               - require pool.amount > 0
                                               - w = _voteStakeAtReview(proposalId, msg.sender) // Approve-side only
                                               - require w > 0 (was an Approver)
                                               - require !_approverClaimed[proposalId][msg.sender]
                                               - _approverClaimed[proposalId][msg.sender] = true
                                               - total = r.approveStakeWeight (from the Review)
                                               - gross = (pool.amount * w) / total
                                               - rate = _commissionCheckpoints[msg.sender]
                                                          .upperLookupRecent(settledAt)
                                               - commission = (gross * rate) / 10_000
                                               - remainder  = gross - commission
                                               - _delegatorProposalPool[msg.sender][proposalId] = remainder
                                               - IERC20(pool.asset).safeTransfer(msg.sender, commission)
                                               - emit ApproverRewardClaimed(
                                                   proposalId, msg.sender, gross, commission, remainder
                                                 )

delegator ──claimDelegatorProposalReward(delegate, proposalId)──▶ GuardianRegistry
                                                                 - pool = _delegatorProposalPool[delegate][proposalId]
                                                                 - my = getPastDelegationTo(msg.sender, delegate, settledAt)
                                                                 - total = getPastDelegated(delegate, settledAt)
                                                                 - share = (pool * my) / total
                                                                 - require !_delegatorProposalClaimed[delegate][proposalId][msg.sender]
                                                                 - _delegatorProposalClaimed[...] = true
                                                                 - transfer share in pool.asset
                                                                 - emit DelegatorProposalRewardClaimed
```

Notes:
- **Approve-side-only:** only Approvers earn guardian fee. Blockers on a settled (not-blocked) proposal earn nothing — they lost the vote, the proposal passed optimistic review, and the strategy executed.
- **Non-settled → no pool:** if a proposal is Blocked, never executes, so `_distributeFees` never runs, so `_proposalGuardianPool[proposalId].amount == 0`. Blockers earn via the epoch pool as before.
- **Two-step claim:** approver (delegate) claims first, seeding `_delegatorProposalPool[delegate][proposalId]`. Delegators then claim their pro-rata share. Same attribution timestamp: `settledAt` (frozen when `_fundGuardianPool` is called).
- **W-1 escrow:** if the approver is USDC-blacklisted at claim time, the registry escrows the `commission` amount in `_unclaimedApproverFees[keccak256(proposalId, approver, asset)]`. Same pattern as governor's `_unclaimedFees`, keyed by `(proposalId, approver, asset)` to prevent cross-proposal drain.

### 4.9 Time-weighted delegation attribution (§4.6 refinement)

Naive `getPastDelegationTo(delegator, delegate, epochEnd)` returns the balance AT epoch end — punishes delegators who delegated late-epoch and rewards those who unstaked mid-epoch with their full original balance. Time-weighted attribution is correct but more complex.

**Two options:**

- **V1.5a (simpler):** use epoch-end balance. Delegators who held at epoch end share the pool; those who unstaked before epoch end get nothing. Incentive: delegators stay delegated through epoch end. Downside: sharp cliff at epoch boundary.
- **V1.5b (correct):** integrate checkpoints over the epoch to get time-weighted average balance. `weightedAvg = ∫(balance × dt) / epochDuration`. More storage-expensive and bytecode-heavier.

**Recommendation: ship V1.5a.** The 7-day epoch + 7-day unstake cooldown means delegators can't rapidly in-and-out anyway; epoch-end snapshot is good enough for V1.5. Upgrade to V1.5b if attribution disputes arise.

---

## 5. Storage layout

### GuardianRegistry additions (append-only, UUPS-safe)

```solidity
// After existing storage (post-PR-229 layout)...

using Checkpoints for Checkpoints.Trace224;

// Per-guardian own-stake history
mapping(address => Checkpoints.Trace224) private _stakeCheckpoints;

// Per-delegate inbound total history
mapping(address => Checkpoints.Trace224) private _delegatedInboundCheckpoints;

// Global totals for quorum denominator
Checkpoints.Trace224 private _totalStakeCheckpoint;
Checkpoints.Trace224 private _totalDelegatedCheckpoint;

// Per-(delegator, delegate) balance (current) + checkpoint (historical)
mapping(address => mapping(address => uint256)) private _delegations;
mapping(address => mapping(address => Checkpoints.Trace224)) private _delegationCheckpoints;
mapping(address => mapping(address => uint256)) private _unstakeDelegationRequestedAt;

// Delegate totals
mapping(address => uint256) private _delegatedInbound;
uint256 public totalDelegatedStake;

// Commission
uint256 public constant MAX_COMMISSION_BPS = 5000;             // 50%
uint256 public constant MAX_COMMISSION_INCREASE_PER_EPOCH = 500; // 5%
mapping(address => uint256) private _commissionBps;              // current rate
mapping(address => uint256) private _lastCommissionRaiseEpoch;
mapping(address => Checkpoints.Trace224) private _commissionCheckpoints; // history for lazy lookup
mapping(address => mapping(uint256 => uint256)) private _commissionAtEpoch; // cache populated at first claim

// Reward accounting — per-delegate
mapping(uint256 => mapping(address => uint256)) private _blockerWeightInEpoch;  // epoch => delegate => weight
mapping(uint256 => uint256) private _totalBlockerWeightInEpoch;                  // epoch => total
mapping(address => mapping(uint256 => bool)) private _delegateEpochClaimed;     // delegate => epoch => claimed

// Reward accounting — per-delegator (epoch pool)
mapping(address => mapping(uint256 => uint256)) private _delegatorPool;         // delegate => epoch => remainder
mapping(address => mapping(uint256 => mapping(address => bool))) private _delegatorClaimed;

// ── Guardian fee pool (proposal-level approver reward, NEW in V1.5) ──
struct ProposalRewardPool {
    address asset;
    uint128 amount;
    uint64 settledAt;
}
mapping(uint256 => ProposalRewardPool) private _proposalGuardianPool;                       // proposalId => pool
mapping(uint256 => mapping(address => bool)) private _approverClaimed;                      // proposalId => approver => claimed
mapping(address => mapping(uint256 => uint256)) private _delegatorProposalPool;             // delegate => proposalId => remainder
mapping(address => mapping(uint256 => mapping(address => bool))) private _delegatorProposalClaimed;
mapping(bytes32 => uint256) private _unclaimedApproverFees;                                 // keccak256(proposalId, approver, asset) => amount

uint256[28] private __gap; // reduced from current value by slot count above (was 33 pre-guardian-fee; 5 slots added)
```

**Slot cost:** ~15 new slots (mostly for the mappings' base slots; checkpoints grow O(N) on history but that's per-user cost, not fixed).

### WOOD additions

```solidity
// Minimal: add ERC20VotesUpgradeable as a mixin
contract WOOD is ERC20VotesUpgradeable, ... {
    // Nothing else changes. No custom delegation logic.
}
```

---

## 6. External interface (V1.5 additions)

```solidity
interface IGuardianRegistryV15 is IGuardianRegistry {
    // Delegator — stake-pool delegation
    function delegateStake(address delegate, uint256 amount) external;
    function requestUnstakeDelegation(address delegate) external;
    function cancelUnstakeDelegation(address delegate) external;
    function claimUnstakeDelegation(address delegate) external;

    // Views
    function delegationOf(address delegator, address delegate) external view returns (uint256);
    function delegatedInbound(address delegate) external view returns (uint256);
    function getPastStake(address guardian, uint256 timestamp) external view returns (uint256);
    function getPastDelegated(address delegate, uint256 timestamp) external view returns (uint256);
    function getPastDelegationTo(address delegator, address delegate, uint256 timestamp)
        external view returns (uint256);
    function getPastVoteWeight(address delegate, uint256 timestamp) external view returns (uint256);

    // Commission
    function setCommission(uint256 newBps) external;
    function commissionOf(address delegate) external view returns (uint256);
    function commissionAtEpoch(address delegate, uint256 epochId) external view returns (uint256);

    // Epoch-pool reward claims
    function claimEpochReward(uint256 epochId) external; // overrides V1 — now two-step
    function claimDelegatorReward(address delegate, uint256 epochId) external;
    function pendingDelegatorReward(address delegator, address delegate, uint256 epochId)
        external view returns (uint256);

    // Guardian-fee reward claims (proposal-level, approver-only)
    function fundProposalGuardianPool(uint256 proposalId, address asset, uint256 amount) external; // onlyGovernor
    function claimProposalReward(uint256 proposalId) external;                                     // approver pulls
    function claimDelegatorProposalReward(address delegate, uint256 proposalId) external;          // delegator pulls
    function pendingProposalReward(uint256 proposalId, address approver) external view returns (uint256);
    function pendingDelegatorProposalReward(address delegator, address delegate, uint256 proposalId)
        external view returns (uint256);
    function proposalGuardianPool(uint256 proposalId) external view returns (address asset, uint256 amount, uint64 settledAt);

    // Events
    event DelegationIncreased(address indexed delegator, address indexed delegate, uint256 amount);
    event DelegationUnstakeRequested(address indexed delegator, address indexed delegate, uint256 at);
    event DelegationUnstakeCancelled(address indexed delegator, address indexed delegate);
    event DelegationUnstakeClaimed(address indexed delegator, address indexed delegate, uint256 amount);
    event CommissionSet(address indexed delegate, uint256 oldBps, uint256 newBps);
    event DelegatorRewardClaimed(
        address indexed delegator, address indexed delegate, uint256 indexed epochId, uint256 share
    );
    event EpochRewardSplit(
        address indexed delegate, uint256 indexed epochId, uint256 gross, uint256 commission, uint256 remainder
    );
    event ProposalGuardianPoolFunded(uint256 indexed proposalId, address indexed asset, uint256 amount);
    event ApproverRewardClaimed(
        uint256 indexed proposalId, address indexed approver, uint256 gross, uint256 commission, uint256 remainder
    );
    event DelegatorProposalRewardClaimed(
        address indexed delegator, address indexed delegate, uint256 indexed proposalId, uint256 share
    );
}
```

---

## 6a. Governor additions (V1.5)

### New parameter: `guardianFeeBps`

Standard timelocked parameter (queue → delay → finalize → cancel pattern, like every other fee param):

```solidity
// GovernorParameters bounds
uint256 public constant MAX_GUARDIAN_FEE_BPS = 500;  // 5%
bytes32 public constant PARAM_GUARDIAN_FEE_BPS = keccak256("guardianFeeBps");

// Storage (appended to SyndicateGovernor)
uint256 private _guardianFeeBps;

// Setter (in GovernorParameters virtual chain)
function setGuardianFeeBps(uint256 newBps) external onlyOwner {
    _queueChange(PARAM_GUARDIAN_FEE_BPS, newBps);
}

// Validation (in _applyChange dispatcher)
if (key == PARAM_GUARDIAN_FEE_BPS) {
    require(newValue <= MAX_GUARDIAN_FEE_BPS, InvalidGuardianFeeBps());
    uint256 old = _guardianFeeBps;
    _guardianFeeBps = newValue;
    return old;
}
```

**Launch default:** 100 bps (1%). Owner-timelocked, adjustable up to 500 bps cap.

### Fee waterfall change in `_distributeFees`

```solidity
function _distributeFees(
    uint256 proposalId, address vault, address asset, address proposer, uint256 perfFeeBps, uint256 profit
) internal returns (uint256 agentFee, uint256 totalFee) {
    uint256 protocolFee = 0;
    uint256 guardianFee = 0;

    if (_protocolFeeBps > 0) {
        protocolFee = (profit * _protocolFeeBps) / 10000;
        if (protocolFee > 0) {
            if (_protocolFeeRecipient == address(0)) revert InvalidProtocolFeeRecipient();
            _payFee(vault, asset, _protocolFeeRecipient, protocolFee);
        }
    }

    if (_guardianFeeBps > 0) {                                              // ← NEW BRANCH
        guardianFee = (profit * _guardianFeeBps) / 10000;
        if (guardianFee > 0) {
            address registry = _getRegistry();
            if (registry == address(0)) revert RegistryNotSet();
            ISyndicateVault(vault).transferPerformanceFee(asset, registry, guardianFee);
            IGuardianRegistry(registry).fundProposalGuardianPool(proposalId, asset, guardianFee);
        }
    }

    uint256 remaining = profit - protocolFee - guardianFee;
    agentFee = (remaining * perfFeeBps) / 10000;
    if (agentFee > 0) {
        _distributeAgentFee(proposalId, vault, asset, proposer, agentFee);
    }

    uint256 netRemaining = remaining - agentFee;
    uint256 mgmtFee = (netRemaining * ISyndicateVault(vault).managementFeeBps()) / 10000;
    if (mgmtFee > 0) {
        _payFee(vault, asset, OwnableUpgradeable(vault).owner(), mgmtFee);
    }

    totalFee = protocolFee + guardianFee + agentFee + mgmtFee;
    return (agentFee, totalFee);
}
```

**Bytecode impact:** ~80 bytes added to `SyndicateGovernor`. Current margin: 46 bytes under CI gate, 72 under EIP-170 → tight but feasible. Reclaim options if needed: drop `ProposalGuardianPoolFunded` event emission (mirrored in registry event), share `_getRegistry()` lookup across `_fundGuardianPool` and existing registry-call sites.

### Registry call hook: `fundProposalGuardianPool`

```solidity
// In GuardianRegistry
function fundProposalGuardianPool(uint256 proposalId, address asset, uint256 amount) external {
    if (msg.sender != governor) revert OnlyGovernor();
    if (amount == 0) return;
    // asset is trusted — governor just transferred it in; re-check balance as defense:
    // (omitted for brevity — spec invariant INV-V1.5-4)

    // Look up settledAt from governor if not already set
    uint64 settledAt = uint64(block.timestamp);

    _proposalGuardianPool[proposalId] = ProposalRewardPool({
        asset: asset,
        amount: uint128(amount),
        settledAt: settledAt
    });

    emit ProposalGuardianPoolFunded(proposalId, asset, amount);
}
```

## 7. Voting weight integration

### Standard review

`voteOnProposal` already snapshots `weight` to `_voteStake[proposalId][msg.sender]` (PR #229). V1.5 change: `weight` is now computed as `getPastStake(msg.sender, r.openedAt) + getPastDelegated(msg.sender, r.openedAt)` instead of live `_guardians[msg.sender].stakedAmount`.

`openReview` now also snapshots `totalDelegatedAtOpen` in addition to `totalStakeAtOpen`. Quorum denominator = `totalStakeAtOpen + totalDelegatedAtOpen`.

### Emergency review

`voteBlockEmergencySettle` changes mirror standard: weight = `getPastStake + getPastDelegated` at `er.openedAt` (new field added to `EmergencyReview` struct).

### Cold-start (MIN_COHORT_STAKE_AT_OPEN)

`MIN_COHORT_STAKE_AT_OPEN` check now compares against `stakeAtOpen + delegatedAtOpen`, so delegated WOOD helps pass the cold-start threshold.

---

## 8. Deployment

### Fresh deployment — no migration

V1.5 ships as a clean redeploy alongside the V1 mainnet launch. There are no pre-existing guardian stakes or delegations to preserve:

- **WOOD** deploys once as `ERC20VotesUpgradeable`. No airdrop, no snapshot — test balances on Base Sepolia can be re-issued trivially.
- **GuardianRegistry** deploys once with V1.5 storage layout. No lazy/eager migration branch needed because every stake push naturally writes its own checkpoint at `stakeAsGuardian` call time. First-ever checkpoint for each guardian = their first stake.
- Update `WOOD_TOKEN` + `GUARDIAN_REGISTRY` addresses in `contracts/chains/{chainId}.json`, `cli/src/lib/addresses.ts`, and `mintlify-docs/reference/deployments.mdx`.

### Implication for UUPS

Since this is a fresh deployment (not an upgrade of an already-deployed V1 registry), the storage layout can be authored freshly rather than appended. The `__gap` still matters for *future* upgrades past V1.5, but V1.5 doesn't need to honor a prior layout.

---

## 9. Bytecode budget

- `GuardianRegistry` post-PR-229: 17,489 / 24,576. Headroom: 7,087 bytes.
- `Checkpoints` library: ~1,200 bytes if not already linked. Likely OK.
- New functions (delegateStake, request/cancel/claim unstake, setCommission, two-step reward claim, views): ~3,500 bytes.
- Total new: ~4,700 bytes → registry lands around ~22,200. Still under EIP-170 with ~2,300-byte margin.
- If tight: extract delegation into a separate `DelegationModule` contract that the registry calls into (adds one external call per vote, gas cost trade).

`SyndicateGovernor` unchanged by V1.5. Still at 24,504.

---

## 9a. Guardian-fee test matrix additions

- Settle proposal with `guardianFeeBps > 0`, 2 approvers of different weights → each claims pro-rata share
- Settle with `guardianFeeBps == 0` → no pool funded, claim reverts with `NoPoolFunded`
- Settle with 0 profit → `guardianFee == 0` → no pool funded (no division-by-zero on claim since `r.approveStakeWeight` could be arbitrary)
- Blocked proposal → never settles → no pool → no approver can claim (view returns 0)
- Approver + delegator commission split — verify `commission + sum(delegator shares) == gross`
- Double-claim reverts
- W-1 escrow: approver blacklisted on USDC → `commission` transfer fails → escrowed in `_unclaimedApproverFees` → claim after unblacklist works
- Fee-sum invariant extended: `protocolFee + guardianFee + agentFee + mgmtFee <= grossPnL` (INV-V1.5-10)

## 10. Test matrix (V1.5)

### Unit tests

- Delegate stake / request unstake / cancel / claim happy path
- Unstake cooldown enforcement (7 days)
- Multiple delegators → one delegate; sum of _delegations == _delegatedInbound
- One delegator splitting across multiple delegates
- Vote weight = own + delegated (spot check three deltas: only own, only delegated, both)
- Checkpoint lookup at past timestamps (pre-stake, mid-stake, post-unstake)
- Slashing: delegate's own stake burns; delegator balance unaffected
- Commission: set → setCommission → change reflected at next epoch, not mid-epoch (INV-V1.5-7)
- Commission increase-rate limit (`MAX_COMMISSION_INCREASE_PER_EPOCH`)
- Commission bounds (`MAX_COMMISSION_BPS`)
- Two-step claim: delegate claim before delegator claim; delegator claim without delegate claim reverts
- Delegator double-claim reverts
- Reward math: commission + remainder == gross (INV-V1.5-5)

### Integration

- Full guardian-review lifecycle with delegated votes reaching quorum (block on delegated weight alone)
- Emergency review with delegated votes
- Cold-start threshold passes thanks to delegated stake

### Invariant fuzz

- INV-V1.5-1 through INV-V1.5-7 as `StdInvariant` assertions
- Fuzz actions: stake, unstake, delegate, re-delegate, slash, vote, claim

### Regression

- PR #229 invariants still hold (INV-2, INV-3, INV-9, INV-10 structural; INV-11 property)
- Existing 683 tests pass

---

## 11. Security considerations

### Re-entrancy

- All new external-write functions have `nonReentrant` where they touch WOOD transfers.
- `claimEpochReward` + `claimDelegatorReward` use CEI: state write → transfer.

### MEV / front-running

- Commission-set is public. A delegate could front-run a delegator's claim by setting high commission right before claim. Mitigated by:
  - Checkpoint at epoch (INV-V1.5-7): rate is frozen per epoch at epoch rollover, not at claim time.
  - Increase-rate limit: can't jump commission more than 5%/epoch.

### Sybil-proof-ness

- Permissive delegation (decision #2): any address can be a delegate. A delegate must still have own-stake ≥ `minGuardianStake` to be an *active guardian* who can vote.
- A delegator can delegate to a non-active address — that WOOD is locked but contributes zero vote weight. Delegator can undelegate after cooldown. Griefing vector: delegator's WOOD is locked for 7 days; no material loss.
- Mitigation: UI warns on delegation to non-active delegates.

### Governance-attack economics

- Delegation amplifies the cartel-farming attack (§V2 notes in brainstorm). A cartel with delegate ≥ 30% combined weight can block benign proposals to farm rewards, slashing honest approvers. Pre-existing issue; tracked separately. V1.5 does not introduce new attack vectors beyond what the V1 block-reward pool already enables.

### Upgrade risk

- Storage layout strictly append-only. `__gap` reduced by exact slot count.
- First-deploy migration script (or lazy migration) must backfill checkpoints idempotently.

---

## 12. Out-of-scope for V1.5

- **Time-weighted attribution (§4.8 V1.5b).** Ship the simpler epoch-end snapshot.
- **Auto-compound of delegator rewards.** Manual claim only. Auto-compound is a nice-to-have V2.
- **Multi-token staking.** Still WOOD only.
- **Slashing insurance for delegators.** Delegators choose their delegate; bad choices lose vote weight when the delegate is slashed. No insurance pool.
- **Governance over commission ceiling.** `MAX_COMMISSION_BPS` is a constant. Future PR can timelock it as a parameter.
- **ERC20Votes-based off-chain governance integration.** WOOD is redeployed as ERC20VotesUpgradeable but V1.5 does not ship any on-chain feature that reads `WOOD.getPastVotes`. Dashboards / Snapshot integration is a separate workstream.

---

## 13. Resolved design decisions

All four open questions resolved pre-implementation (2026-04-21):

1. ✅ **Commission-at-epoch: lazy.** Do NOT write `_commissionAtEpoch[delegate][epochId]` at epoch rollover (would cost O(N) SSTOREs across all delegates). Instead, store a per-delegate `Checkpoints.Trace224` of commission history (`_commissionCheckpoints[delegate]`). At claim time, resolve the rate with `_commissionCheckpoints[delegate].upperLookupRecent(epochEndTimestamp[epochId])`. Cache the resolved value into `_commissionAtEpoch[delegate][epochId]` on first claim so subsequent delegator claims don't re-walk the checkpoint history.

2. ✅ **No migration — fresh deployment.** There are no pre-existing guardian stakes to preserve. Every stake push naturally writes its own first checkpoint at `stakeAsGuardian` call time. No backfill branch needed in contract code. See §8.

3. ✅ **Self-delegation disallowed.** `require(delegate != msg.sender, CannotSelfDelegate())` in `delegateStake`. Reasoning: self-delegation is semantically identical to `stakeAsGuardian` but would create parallel accounting (own-stake vs delegated-to-self) that slashing and reward paths would have to disambiguate. Disallow keeps the two pools strictly disjoint (INV-V1.5-1).

4. ✅ **Unstake-delegation during active review: allowed.** Under checkpoint-at-open semantics, a delegator's weight was frozen into the review at `openedAt`. A later `requestUnstakeDelegation` does not retroactively change the review outcome — the review's `_voteStake[proposalId][delegate]` already captured the delegate's total weight including that delegator's contribution. The 7-day cooldown means the delegator can't get their WOOD back before the review resolves anyway. No special-case needed.

---

## 14. Acceptance criteria

- [ ] All INV-V1.5-1 through INV-V1.5-7 pass fuzz harness (128k runs)
- [ ] All new test matrix items pass
- [ ] All PR #229 regression tests pass (683 baseline)
- [ ] `GuardianRegistry` under EIP-170 (24,576 bytes)
- [ ] `SyndicateGovernor` unchanged size (24,504)
- [ ] Migration runbook documented for mainnet deploy
- [ ] CLI update for `sherwood guardian delegate <address> <amount>` command
- [ ] Mintlify docs updated: `protocol/guardians/delegation.mdx`
