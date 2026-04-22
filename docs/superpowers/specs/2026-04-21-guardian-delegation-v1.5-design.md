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
3. **DPoS commission split via Merkl.** Each delegate sets an on-chain `commissionBps` (max 5000 = 50%, max raise 500 bps / epoch). On-chain reward distribution is **moved off-chain to Merkl** (Angle Labs) — registry + governor emit events with all attribution data; Merkl's off-chain bot computes per-claimant amounts (including DPoS commission + delegator pro-rata splits + time-weighted attribution) and publishes Merkle roots to Merkl's distributor contract. Claimants pull rewards via Merkl's standard claim flow. On-chain storage for reward accounting collapses to ~0.
4. **WOOD as ERC20VotesUpgradeable.** Redeploy WOOD to standard OZ `ERC20VotesUpgradeable` for off-chain governance UX (vote-weight indexers, Snapshot-style signalling tools). Not used for on-chain registry logic — registry uses its own checkpoints because it needs per-delegator-per-delegate attribution that ERC20Votes doesn't provide natively.
5. **Guardian fee on settled performance.** New timelocked `guardianFeeBps` governor parameter (default 100 bps = 1%, max 500 bps = 5%). On successful settlement, `grossPnL * guardianFeeBps / 10_000` is carved out before agent fee and transferred to Merkl's distributor contract along with a `GuardianFeeAccrued(proposalId, asset, amount, settledAt)` event. Merkl's off-chain attribution reads registry events (`GuardianVoteCast`, `ReviewResolved`, `DelegationIncreased`, `CommissionSet`) to allocate per-claimant amounts (approvers + their delegators via DPoS split). Fixes Problem 3 and closes the incentive asymmetry.

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
- **INV-V1.5-4** (delegation custody): `IERC20(WOOD).balanceOf(registry) == totalGuardianStake + totalDelegatedStake + slashAppealReserve + pendingBurn`. (No `pendingEpochRewards` term — epoch budget goes directly to Merkl.)
- **INV-V1.5-5** (commission bounds): `0 <= commissionBps[D] <= MAX_COMMISSION_BPS` at all times.
- **INV-V1.5-6** (commission raise-rate): per epoch, `commissionBps[D]` can only increase by at most `MAX_COMMISSION_INCREASE_PER_EPOCH`.
- **INV-V1.5-7** (guardian-fee bounds): `0 <= guardianFeeBps <= MAX_GUARDIAN_FEE_BPS = 500` at all times; enforced at queue AND finalize.
- **INV-V1.5-8** (fee-waterfall ordering): in `_distributeFees`, `protocolFee + guardianFee + agentFee + mgmtFee <= grossPnL` by construction (each taken from remaining).
- **INV-V1.5-9** (guardian-fee destination): every `GuardianFeeAccrued(proposalId, asset, amount, settledAt)` emit is preceded by `IERC20(asset).balanceOf(merklDistributor) += amount` in the same tx. (Merkl is the sole settlement sink.)

Reward-distribution correctness (sum-conservation, no-double-claim, commission-retroactive) is a Merkl-side concern — verified via off-chain Merkle root inspection, not on-chain invariants.

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

### 4.5 Commission configuration (only on-chain reward-related state)

```
delegate ──setCommission(newBps)──▶ GuardianRegistry
                                    - require newBps <= MAX_COMMISSION_BPS (5000 = 50%)
                                    - require not raising too fast (see below)
                                    - _commissionBps[delegate] = newBps
                                    - emit CommissionSet(delegate, oldBps, newBps)
```

**Increase-rate limit:** commission can only be raised by `MAX_COMMISSION_INCREASE_PER_EPOCH` (default 500 = 5%) per epoch, cumulative. Decreases are unbounded. Implementation: track `_lastCommissionRaiseEpoch[delegate]` and cap `newBps - oldBps` if in the same epoch as the last raise. Prevents delegates from instant-ramping to 50% right before a reward cycle, rugging delegators.

**No on-chain commission checkpointing** — Merkl's off-chain bot reads the `CommissionSet` event at the moment attribution runs (per-epoch / per-settle) and freezes the rate into that round's Merkle root. The rate at Merkle-root time is the rate that applies; subsequent `setCommission` calls affect future rounds only.

### 4.6 Reward distribution — Merkl integration

**All reward attribution and distribution happens off-chain via Merkl.** The registry emits events with all data Merkl needs to compute per-claimant amounts; the governor transfers reward tokens to Merkl's distributor contract; users claim via Merkl's standard UI / SDK with a Merkle proof.

**On-chain surface (minimal):**

```
GuardianRegistry emits:
- GuardianVoteCast(proposalId, guardian, VoteType, weight)   // Approve / Block, weight = own + delegated @ openedAt
- GuardianVoteChanged(proposalId, guardian, oldType, newType)
- ReviewResolved(proposalId, blocked, slashedAmount)
- EmergencyBlockVoteCast(proposalId, guardian, weight)
- EmergencyReviewResolved(proposalId, blocked, slashedAmount)
- DelegationIncreased(delegator, delegate, amount)
- DelegationUnstakeClaimed(delegator, delegate, amount)
- CommissionSet(delegate, oldBps, newBps)
// All exist today or minor extensions.

SyndicateGovernor on settle:
- _distributeFees carves guardianFee = grossPnl * guardianFeeBps / 10000
- IERC20(asset).safeTransfer(merklDistributor, guardianFee)
- emit GuardianFeeAccrued(proposalId, asset, amount, settledAt)
- No registry call. No proposalGuardianPool accounting.

Protocol epoch funding:
- Owner calls WOOD.safeTransfer(merklDistributor, epochBudget) + emits EpochBudgetFunded(epochId, amount)
- Alternatively: register campaign directly on Merkl's UI and fund from treasury.
```

**Off-chain attribution (Merkl bot + Dune query):**

Two campaigns registered on Merkl:

1. **Epoch block-reward campaign** (WOOD, recurring per-7-day epoch)
   - Eligibility: guardians who cast `Block` votes on proposals that resolved `blocked = true` during the epoch
   - Allocation: pro-rata by `weight` from `GuardianVoteCast` (Block side), summed over the epoch
   - DPoS split: delegate earns `commissionBps` × share; delegators earn `(10000 − commissionBps)` × share × (delegator's `getPastDelegationTo(delegate, epochEnd)` / delegate's `getPastDelegated(delegate, epochEnd)`)
   - Commission rate frozen at `CommissionSet` event-time for each round (see §4.5)

2. **Guardian-fee campaign** (per vault asset — usually USDC, per-settle rolling)
   - Eligibility: guardians who cast `Approve` on a proposal that settled with `guardianFee > 0`
   - Allocation: pro-rata by Approve-side `weight`, per proposal
   - DPoS split: same as epoch
   - Attribution timestamp: `settledAt` from `GuardianFeeAccrued` event

**Merkle root publication:** Merkl's multisig publishes roots per campaign at the cadence they define (typically daily or per epoch). Sherwood's off-chain dependency is limited to Merkl — we don't run our own bot.

**Claim UX:** `merkl.xyz/sherwood` or equivalent. Merkl's SDK produces proofs; user calls `AngleDistributor.claim(proofs[], users[], tokens[], amounts[])`.

**W-1 blacklist resilience:** if a claimant is USDC-blacklisted, their Merkle leaf just sits unclaimed — no on-chain escrow, no special path. Claim becomes possible once the blacklist is lifted. Merkle preservation: unclaimed funds stay in Merkl distributor indefinitely.

### 4.7 Time-weighted delegation attribution

Merkl supports arbitrary attribution logic off-chain. Sherwood will use **time-weighted integration** as the default (V1.5b from the earlier draft): for each delegator–delegate pair and each epoch, compute `∫(balance × dt) / epochDuration` from the on-chain checkpoints. Delegators who delegated mid-epoch get proportional credit; those who unstaked mid-epoch get partial credit for the time they were delegated. This is the "correct" attribution and was previously deferred due to on-chain cost — no longer a constraint.

---

## 5. Storage layout

### GuardianRegistry additions (append-only, UUPS-safe)

```solidity
using Checkpoints for Checkpoints.Trace224;

// ── Phase 1: vote-weight checkpoints ──
mapping(address => Checkpoints.Trace224) private _stakeCheckpoints;
Checkpoints.Trace224 private _totalStakeCheckpoint;

// ── Phase 2: stake-pool delegation ──
mapping(address delegator => mapping(address delegate => uint256)) private _delegations;
mapping(address delegator => mapping(address delegate => Checkpoints.Trace224)) private _delegationCheckpoints;
mapping(address delegator => mapping(address delegate => uint64)) private _unstakeDelegationRequestedAt;
mapping(address delegate => uint256) private _delegatedInbound;
mapping(address delegate => Checkpoints.Trace224) private _delegatedInboundCheckpoints;
uint256 public totalDelegatedStake;
Checkpoints.Trace224 private _totalDelegatedCheckpoint;

// ── Phase 3: commission rate (on-chain; Merkl reads as-of event-time) ──
uint256 public constant MAX_COMMISSION_BPS = 5000;
uint256 public constant MAX_COMMISSION_INCREASE_PER_EPOCH = 500;
mapping(address => uint256) private _commissionBps;
mapping(address => uint256) private _lastCommissionRaiseEpoch;

// __gap reduced accordingly. No reward-accounting storage — Merkl owns that.
uint256[38] private __gap;
```

**What's NOT stored on-chain** (moved to Merkl):
- Per-epoch blocker weights / totals / budget
- Per-proposal guardian-fee pools
- Per-(delegate, epoch) claimed flags
- Per-(delegator, delegate, epoch) remainder pools + claim flags
- Commission checkpoints + epoch cache
- W-1 approver-fee escrow
- Any reward-claim entry points

**Slot cost delta from V1.5 previous plan:** −15 slots. Registry bytecode estimate: ~20.5k (vs ~23k full on-chain) — ~2.5k bytes reclaimed.

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
    function totalDelegatedStake() external view returns (uint256);
    function getPastStake(address guardian, uint256 timestamp) external view returns (uint256);
    function getPastTotalStake(uint256 timestamp) external view returns (uint256);
    function getPastDelegated(address delegate, uint256 timestamp) external view returns (uint256);
    function getPastDelegationTo(address delegator, address delegate, uint256 timestamp)
        external view returns (uint256);
    function getPastTotalDelegated(uint256 timestamp) external view returns (uint256);
    function getPastVoteWeight(address delegate, uint256 timestamp) external view returns (uint256);

    // Commission (rate only — no epoch cache, no checkpoint history; Merkl reads on emit)
    function setCommission(uint256 newBps) external;
    function commissionOf(address delegate) external view returns (uint256);

    // NO on-chain claim functions. Rewards distributed off-chain via Merkl.
    // Merkl reads the following events to compute attribution.

    event DelegationIncreased(address indexed delegator, address indexed delegate, uint256 amount);
    event DelegationUnstakeRequested(address indexed delegator, address indexed delegate, uint256 at);
    event DelegationUnstakeCancelled(address indexed delegator, address indexed delegate);
    event DelegationUnstakeClaimed(address indexed delegator, address indexed delegate, uint256 amount);
    event CommissionSet(address indexed delegate, uint256 oldBps, uint256 newBps);
}
```

### Governor-side events for Merkl attribution

```solidity
// Emitted in SyndicateGovernor._distributeFees when guardianFeeBps > 0.
event GuardianFeeAccrued(
    uint256 indexed proposalId, address indexed asset, uint256 amount, uint64 settledAt
);

// Emitted when the protocol owner tops up an epoch's reward campaign.
// Owner/minter simply calls WOOD.safeTransfer(merklDistributor, amount) and
// invokes this explicitly via a protocol helper so the event is indexed.
event EpochBudgetFunded(uint256 indexed epochId, uint256 amount);
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
            address merkl = _merklDistributor;
            if (merkl == address(0)) revert MerklDistributorNotSet();
            ISyndicateVault(vault).transferPerformanceFee(asset, merkl, guardianFee);
            emit GuardianFeeAccrued(proposalId, asset, guardianFee, uint64(block.timestamp));
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

**Bytecode impact:** ~60 bytes added to `SyndicateGovernor` for the guardian-fee branch + `_merklDistributor` storage slot + `setMerklDistributor` timelocked setter. Current margin: 46 bytes under CI gate, 72 under EIP-170 — may need minor reclaim (e.g., consolidating `ISyndicateVault.transferPerformanceFee` call sites).

### `_merklDistributor` address management

Timelocked governor parameter (`PARAM_MERKL_DISTRIBUTOR`), set once at deploy to Merkl's Base mainnet distributor address and changeable only via the standard parameter-change timelock. Set to `address(0)` at initialize; cannot settle with `guardianFeeBps > 0` until Merkl address is finalized.

**No registry hook needed** — governor transfers directly to Merkl's distributor; registry is not in the reward funding path.

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

- Settle proposal with `guardianFeeBps > 0` → Merkl distributor's asset balance increased by exactly `guardianFee`; `GuardianFeeAccrued` event emitted with correct `(proposalId, asset, amount, settledAt)`.
- Settle with `guardianFeeBps == 0` → no Merkl transfer; no event.
- Settle with 0 profit → `guardianFee == 0` → no Merkl transfer; no event.
- Settle with `_merklDistributor == address(0)` and `guardianFeeBps > 0` → reverts `MerklDistributorNotSet`.
- Blocked proposal → settlement never runs → no Merkl transfer (verified by asset-balance before/after).
- Fee-waterfall sum: `protocolFee + guardianFee + agentFee + mgmtFee <= grossPnL` (INV-V1.5-8).
- (Merkle distribution correctness — per-claimant amounts, DPoS split, commission application — is tested in the off-chain worker / Dune-query test harness, not in Solidity.)

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

- [ ] All INV-V1.5-1 through INV-V1.5-9 pass fuzz harness (128k runs)
- [ ] All new test matrix items pass
- [ ] All PR #229 regression tests pass (683 baseline)
- [ ] `GuardianRegistry` under EIP-170 (24,576 bytes); expected ~20.5k post-V1.5
- [ ] `SyndicateGovernor` ≤ 24,550 CI gate (small +60 byte increase for guardian-fee branch + Merkl address param)
- [ ] Merkl campaign(s) registered on Merkl UI (epoch pool in WOOD, guardian-fee pool in vault asset)
- [ ] Dune query (or Merkl custom attribution config) published for each campaign with Sherwood's DPoS + time-weighted logic
- [ ] CLI update: `sherwood guardian delegate <address> <amount>` + `sherwood guardian set-commission <bps>` commands
- [ ] Mintlify docs updated: `protocol/guardians/delegation.mdx` (delegation UX) + `protocol/guardians/rewards.mdx` (Merkl claim flow, link to merkl.xyz UI)
