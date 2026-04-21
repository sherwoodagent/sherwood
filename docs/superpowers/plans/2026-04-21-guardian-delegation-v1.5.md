# Guardian Delegation V1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship V1.5 — checkpoint-based vote weight, stake-pool delegation, DPoS commission split, and approver reward from guardian fee — resolving the top-up-bias + approve-bias findings and unlocking passive WOOD holder participation.

**Architecture:** WOOD redeploys as `ERC20VotesUpgradeable`; `GuardianRegistry` extends with `Checkpoints.Trace224` for own-stake + per-delegate inbound totals + per-(delegator, delegate) balances; governor adds `guardianFeeBps` parameter and routes a slice of settled PnL to the registry's proposal pool. Delegators claim via pull mechanism with DPoS commission split.

**Tech Stack:** Solidity 0.8.28, Foundry, OpenZeppelin v5 upgradeable (`ERC20VotesUpgradeable`, `Checkpoints`), UUPS, via_ir.

**Spec:** `docs/superpowers/specs/2026-04-21-guardian-delegation-v1.5-design.md`

**Dependency:** `feat/guardian-review-lifecycle` (PR #229) merged — V1.5 builds on its review lifecycle.

---

## File structure

### New files

- `contracts/src/Wood.sol` — WOOD token as `ERC20VotesUpgradeable` (fresh deployment)
- `contracts/test/WoodDelegationToken.t.sol` — ERC20Votes integration smoke
- `contracts/test/GuardianRegistryDelegation.t.sol` — delegation core
- `contracts/test/GuardianRegistryCommission.t.sol` — commission config + claims
- `contracts/test/GuardianRegistryProposalReward.t.sol` — guardian fee approver reward
- `contracts/test/invariants/DelegationInvariants.t.sol` — INV-V1.5-1..10
- `contracts/test/integration/DelegationFullLifecycle.t.sol` — delegate → review → settle → claim
- `cli/src/commands/guardian-delegate.ts` — `sherwood guardian delegate` CLI command
- `mintlify-docs/protocol/guardians/delegation.mdx` — user-facing doc

### Modified files

- `contracts/src/GuardianRegistry.sol` — main contract
- `contracts/src/interfaces/IGuardianRegistry.sol` — interface additions
- `contracts/src/SyndicateGovernor.sol` — `_distributeFees` + `guardianFeeBps` param
- `contracts/src/GovernorParameters.sol` — `PARAM_GUARDIAN_FEE_BPS` dispatcher
- `contracts/src/interfaces/ISyndicateGovernor.sol` — parameter events + getter
- `contracts/src/interfaces/IGovernorMinimal.sol` — if `getProposalView` needs extension
- `contracts/script/Deploy.s.sol` — deploy WOOD, wire registry
- `contracts/chains/{chainId}.json` — `WOOD_TOKEN` address (auto-written)
- `docs/tokenomics-wood.md` — note ERC20Votes extension
- `docs/contracts.md` — arch diagram + delegation section
- `CLAUDE.md` — architecture table, bytecode figures post-implementation
- `docs/pre-mainnet-punchlist.md` — close top-up bias finding, cross-reference V1.5

---

## Phase 1 — WOOD redeploy + stake checkpoints

Closes the top-up-bias finding on its own (without delegation). Valuable as a standalone commit boundary.

### Task 1.1 — WOOD as ERC20VotesUpgradeable

**Files:**
- Create: `contracts/src/Wood.sol`
- Test: `contracts/test/WoodDelegationToken.t.sol`

- [ ] **Step 1: Write the failing test**

```solidity
// test/WoodDelegationToken.t.sol
function test_wood_supportsDelegation() public {
    address a = makeAddr("a");
    address b = makeAddr("b");
    wood.mint(a, 1000e18);
    vm.prank(a);
    wood.delegate(b);
    assertEq(wood.getVotes(b), 1000e18);
    assertEq(wood.getVotes(a), 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

`forge test --match-test test_wood_supportsDelegation` → FAIL (Wood contract not found).

- [ ] **Step 3: Implement WOOD**

```solidity
// contracts/src/Wood.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20VotesUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";

contract Wood is
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, uint256 initialSupply) external initializer {
        __ERC20_init("Sherwood WOOD", "WOOD");
        __ERC20Permit_init("Sherwood WOOD");
        __ERC20Votes_init();
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        if (initialSupply > 0) _mint(owner_, initialSupply);
    }

    // ── Required OZ hook overrides ──

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20PermitUpgradeable, NoncesUpgradeable)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Optional admin mint (for bootstrap) ──
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
```

- [ ] **Step 4: Run test — verify pass + smoke other ERC20 operations**

`forge test --match-path "test/WoodDelegationToken.t.sol"` → PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(wood): redeploy as ERC20VotesUpgradeable"`

### Task 1.2 — Checkpoints storage for guardian own-stake

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`
- Test: `contracts/test/GuardianRegistryDelegation.t.sol`

- [ ] **Step 1: Write the failing test for getPastStake**

```solidity
function test_getPastStake_returnsHistoricalValue() public {
    address g = guardians[0];
    vm.prank(g);
    registry.stakeAsGuardian(10_000e18, 1);
    uint256 t1 = block.timestamp;

    vm.warp(block.timestamp + 1 days);
    vm.prank(g);
    registry.stakeAsGuardian(5_000e18, 1);
    uint256 t2 = block.timestamp;

    assertEq(registry.getPastStake(g, t1), 10_000e18, "past stake at t1");
    assertEq(registry.getPastStake(g, t2), 15_000e18, "past stake at t2");
}
```

- [ ] **Step 2: Add Checkpoints storage + push sites**

```solidity
// Imports
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

// In GuardianRegistry contract body
using Checkpoints for Checkpoints.Trace224;

mapping(address => Checkpoints.Trace224) private _stakeCheckpoints;
Checkpoints.Trace224 private _totalStakeCheckpoint;

// In stakeAsGuardian — at end, after updating stakedAmount:
_stakeCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(gs.stakedAmount));
_totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

// In claimUnstakeGuardian — after stakedAmount reset:
_stakeCheckpoints[msg.sender].push(uint32(block.timestamp), 0);
_totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

// In _slashApprovers — after stakedAmount deducted:
_stakeCheckpoints[approver].push(uint32(block.timestamp), uint224(gs.stakedAmount));
_totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

// External view
function getPastStake(address guardian, uint256 timestamp) external view returns (uint256) {
    return _stakeCheckpoints[guardian].upperLookupRecent(uint32(timestamp));
}

function getPastTotalStake(uint256 timestamp) external view returns (uint256) {
    return _totalStakeCheckpoint.upperLookupRecent(uint32(timestamp));
}
```

**Storage layout note:** append-only, `__gap` reduced by slots used.

- [ ] **Step 3: Run unit test — PASS**

- [ ] **Step 4: Commit**

`git commit -m "feat(registry): add Checkpoints.Trace224 for guardian own-stake history"`

### Task 1.3 — Switch vote weight to getPastStake

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`

- [ ] **Step 1: Capture `openedAt` on openReview and openEmergencyReview**

Add to `Review` and `EmergencyReview` structs:

```solidity
struct Review {
    // ... existing fields ...
    uint64 openedAt;   // NEW
}

struct EmergencyReview {
    // ... existing fields ...
    uint64 openedAt;   // NEW
}
```

Set at open:

```solidity
r.openedAt = uint64(block.timestamp);     // in openReview
er.openedAt = uint64(block.timestamp);    // in openEmergencyReview
```

- [ ] **Step 2: Switch voteOnProposal to use getPastStake**

Replace live read:

```solidity
// BEFORE
uint128 weight = _guardians[msg.sender].stakedAmount;

// AFTER
uint128 weight = uint128(_stakeCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt)));
```

- [ ] **Step 3: Same change in voteBlockEmergencySettle**

Replace:

```solidity
uint128 weight = uint128(_stakeCheckpoints[msg.sender].upperLookupRecent(uint32(er.openedAt)));
```

- [ ] **Step 4: Write regression test for top-up bias**

```solidity
function test_voteOnProposal_topUpAfterOpenDoesNotInflateWeight() public {
    address g = guardians[0];
    vm.prank(g);
    registry.stakeAsGuardian(10_000e18, 1);

    // Open review (via governor mock)
    uint256 pid = _openReview();

    // Guardian tops up AFTER open
    vm.prank(g);
    registry.stakeAsGuardian(90_000e18, 1);

    // Vote
    vm.prank(g);
    registry.voteOnProposal(pid, GuardianVoteType.Block);

    // Weight should be 10_000 (at open), not 100_000 (live)
    (, , , , , uint128 blockWeight) = registry.getReviewStateExtended(pid);
    assertEq(blockWeight, 10_000e18, "weight is stake-at-open, not live");
}
```

- [ ] **Step 5: Run all invariants — particularly INV-V1.5-2**

`forge test --match-path "test/invariants/**"`

- [ ] **Step 6: Commit**

`git commit -m "feat(registry): vote weight reads checkpoint at openedAt (closes top-up bias)"`

---

## Phase 2 — Delegation core

### Task 2.1 — Delegation storage + state struct

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`

- [ ] **Step 1: Add storage**

```solidity
// Per-(delegator, delegate) balance (current) + checkpoint (historical)
mapping(address => mapping(address => uint256)) private _delegations;
mapping(address => mapping(address => Checkpoints.Trace224)) private _delegationCheckpoints;
mapping(address => mapping(address => uint64)) private _unstakeDelegationRequestedAt;

// Per-delegate inbound total (current + checkpoint history)
mapping(address => uint256) private _delegatedInbound;
mapping(address => Checkpoints.Trace224) private _delegatedInboundCheckpoints;

// Global delegated total (for quorum denominator)
uint256 public totalDelegatedStake;
Checkpoints.Trace224 private _totalDelegatedCheckpoint;
```

Update `__gap` size.

- [ ] **Step 2: Commit (storage only, no behavior)**

`git commit -m "feat(registry): delegation storage slots"`

### Task 2.2 — delegateStake

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`, `contracts/src/interfaces/IGuardianRegistry.sol`
- Test: `contracts/test/GuardianRegistryDelegation.t.sol`

- [ ] **Step 1: Test**

```solidity
function test_delegateStake_increasesInbound() public {
    address delegator = makeAddr("delegator");
    address delegate = guardians[0];
    wood.mint(delegator, 100e18);
    vm.prank(delegator);
    wood.approve(address(registry), type(uint256).max);

    vm.prank(delegator);
    registry.delegateStake(delegate, 50e18);

    assertEq(registry.delegationOf(delegator, delegate), 50e18);
    assertEq(registry.delegatedInbound(delegate), 50e18);
    assertEq(registry.totalDelegatedStake(), 50e18);
}

function test_delegateStake_revertsOnSelf() public {
    address delegate = guardians[0];
    wood.mint(delegate, 100e18);
    vm.prank(delegate);
    wood.approve(address(registry), type(uint256).max);

    vm.expectRevert(IGuardianRegistry.CannotSelfDelegate.selector);
    vm.prank(delegate);
    registry.delegateStake(delegate, 50e18);
}
```

- [ ] **Step 2: Implement**

```solidity
error CannotSelfDelegate();

function delegateStake(address delegate, uint256 amount) external nonReentrant {
    if (delegate == msg.sender) revert CannotSelfDelegate();
    if (delegate == address(0)) revert InvalidDelegate();
    if (amount == 0) revert AmountZero();

    // Clear any in-flight unstake request (re-delegation implicitly cancels)
    _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;

    wood.safeTransferFrom(msg.sender, address(this), amount);

    _delegations[msg.sender][delegate] += amount;
    _delegatedInbound[delegate] += amount;
    totalDelegatedStake += amount;

    _delegationCheckpoints[msg.sender][delegate]
        .push(uint32(block.timestamp), uint224(_delegations[msg.sender][delegate]));
    _delegatedInboundCheckpoints[delegate]
        .push(uint32(block.timestamp), uint224(_delegatedInbound[delegate]));
    _totalDelegatedCheckpoint
        .push(uint32(block.timestamp), uint224(totalDelegatedStake));

    emit DelegationIncreased(msg.sender, delegate, amount);
}
```

- [ ] **Step 3: Run + commit**

`git commit -m "feat(registry): delegateStake with per-(delegator,delegate) checkpoints"`

### Task 2.3 — request / cancel / claim unstake-delegation

Three sub-tasks mirroring guardian unstake flow.

- [ ] **Step 1: Test happy path + cooldown**

```solidity
function test_claimUnstakeDelegation_afterCooldown_returnsBalance() public {
    // ... stake, request, warp UNSTAKE_COOLDOWN + 1, claim ...
}
function test_claimUnstakeDelegation_beforeCooldown_reverts() public {
    // ... stake, request, claim → UnstakeCooldownActive ...
}
```

- [ ] **Step 2: Implement**

```solidity
function requestUnstakeDelegation(address delegate) external nonReentrant {
    if (_delegations[msg.sender][delegate] == 0) revert NoActiveDelegation();
    if (_unstakeDelegationRequestedAt[msg.sender][delegate] != 0) revert UnstakeAlreadyRequested();
    _unstakeDelegationRequestedAt[msg.sender][delegate] = uint64(block.timestamp);
    emit DelegationUnstakeRequested(msg.sender, delegate, block.timestamp);
}

function cancelUnstakeDelegation(address delegate) external {
    if (_unstakeDelegationRequestedAt[msg.sender][delegate] == 0) revert NoUnstakeRequest();
    _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;
    emit DelegationUnstakeCancelled(msg.sender, delegate);
}

function claimUnstakeDelegation(address delegate) external nonReentrant {
    uint64 requestedAt = _unstakeDelegationRequestedAt[msg.sender][delegate];
    if (requestedAt == 0) revert NoUnstakeRequest();
    if (block.timestamp < requestedAt + UNSTAKE_COOLDOWN) revert UnstakeCooldownActive();

    uint256 amount = _delegations[msg.sender][delegate];
    _delegations[msg.sender][delegate] = 0;
    _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;
    _delegatedInbound[delegate] -= amount;
    totalDelegatedStake -= amount;

    _delegationCheckpoints[msg.sender][delegate].push(uint32(block.timestamp), 0);
    _delegatedInboundCheckpoints[delegate]
        .push(uint32(block.timestamp), uint224(_delegatedInbound[delegate]));
    _totalDelegatedCheckpoint.push(uint32(block.timestamp), uint224(totalDelegatedStake));

    wood.safeTransfer(msg.sender, amount);
    emit DelegationUnstakeClaimed(msg.sender, delegate, amount);
}
```

- [ ] **Step 3: Commit**

### Task 2.4 — Historical views

- [ ] Add `getPastDelegated`, `getPastDelegationTo`, `getPastVoteWeight`:

```solidity
function getPastDelegated(address delegate, uint256 timestamp) external view returns (uint256) {
    return _delegatedInboundCheckpoints[delegate].upperLookupRecent(uint32(timestamp));
}

function getPastDelegationTo(address delegator, address delegate, uint256 timestamp)
    external
    view
    returns (uint256)
{
    return _delegationCheckpoints[delegator][delegate].upperLookupRecent(uint32(timestamp));
}

function getPastVoteWeight(address delegate, uint256 timestamp) external view returns (uint256) {
    uint256 own = _stakeCheckpoints[delegate].upperLookupRecent(uint32(timestamp));
    uint256 delegated = _delegatedInboundCheckpoints[delegate].upperLookupRecent(uint32(timestamp));
    return own + delegated;
}

function getPastTotalDelegated(uint256 timestamp) external view returns (uint256) {
    return _totalDelegatedCheckpoint.upperLookupRecent(uint32(timestamp));
}
```

- [ ] Test and commit.

### Task 2.5 — Vote weight integration: include delegated

- [ ] In `voteOnProposal` + `voteBlockEmergencySettle`, replace:

```solidity
uint128 weight = uint128(_stakeCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt)));
```

with:

```solidity
uint256 own = _stakeCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt));
uint256 delegated = _delegatedInboundCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt));
uint128 weight = uint128(own + delegated);
```

- [ ] In `openReview`, snapshot both halves:

```solidity
r.totalStakeAtOpen = uint128(_totalStakeCheckpoint.upperLookupRecent(uint32(block.timestamp)));
r.totalDelegatedAtOpen = uint128(_totalDelegatedCheckpoint.upperLookupRecent(uint32(block.timestamp)));
```

Add `totalDelegatedAtOpen` to `Review` and `EmergencyReview` structs.

- [ ] Update quorum calc to use combined denominator:

```solidity
bool blocked_ = (uint256(r.blockStakeWeight) * 10_000
    >= blockQuorumBps * (uint256(r.totalStakeAtOpen) + uint256(r.totalDelegatedAtOpen)));
```

- [ ] Update cold-start threshold check similarly.

- [ ] Write test: delegate-only weight (delegate has 0 own stake, 100k delegated) → can Block if `minGuardianStake` has been satisfied (note: delegate still needs own stake ≥ `minGuardianStake` to be an active guardian).

- [ ] Commit.

---

## Phase 3 — DPoS commission + rewards

### Task 3.1 — Commission storage + setCommission

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`

- [ ] **Step 1: Storage**

```solidity
uint256 public constant MAX_COMMISSION_BPS = 5000;
uint256 public constant MAX_COMMISSION_INCREASE_PER_EPOCH = 500;

mapping(address => uint256) private _commissionBps;
mapping(address => uint256) private _lastCommissionRaiseEpoch;
mapping(address => Checkpoints.Trace224) private _commissionCheckpoints;
mapping(address => mapping(uint256 => uint256)) private _commissionAtEpoch;
```

- [ ] **Step 2: Test**

```solidity
function test_setCommission_raiseRateLimited() public {
    address delegate = guardians[0];
    vm.prank(delegate);
    registry.setCommission(1000); // 10%

    // Same epoch: can't raise above 1500 (1000 + 500)
    vm.expectRevert(IGuardianRegistry.CommissionRaiseExceedsLimit.selector);
    vm.prank(delegate);
    registry.setCommission(2000);

    // Next epoch: can raise by another 500
    vm.warp(block.timestamp + 7 days);
    vm.prank(delegate);
    registry.setCommission(1500);
}
```

- [ ] **Step 3: Implement**

```solidity
error CommissionExceedsMax();
error CommissionRaiseExceedsLimit();

function setCommission(uint256 newBps) external {
    if (newBps > MAX_COMMISSION_BPS) revert CommissionExceedsMax();

    uint256 old = _commissionBps[msg.sender];
    uint256 currentEpochId = currentEpoch();

    if (newBps > old) {
        uint256 lastRaise = _lastCommissionRaiseEpoch[msg.sender];
        if (lastRaise == currentEpochId) {
            if (newBps - old > MAX_COMMISSION_INCREASE_PER_EPOCH) revert CommissionRaiseExceedsLimit();
        }
        _lastCommissionRaiseEpoch[msg.sender] = currentEpochId;
    }

    _commissionBps[msg.sender] = newBps;
    _commissionCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(newBps));
    emit CommissionSet(msg.sender, old, newBps);
}
```

- [ ] **Step 4: Commit**

### Task 3.2 — Lazy commission lookup

- [ ] **Step 1: Implement** `_resolveCommissionAtEpoch(delegate, epochId)`:

```solidity
function _resolveCommissionAtEpoch(address delegate, uint256 epochId) internal returns (uint256) {
    uint256 cached = _commissionAtEpoch[delegate][epochId];
    if (cached != 0) return cached;
    // 0 is ambiguous with "never set" — use a sentinel. Pack with +1 on write:
    // Or: re-resolve every time; cheap.
    uint256 epochEndTs = epochGenesis + (epochId + 1) * EPOCH_DURATION - 1;
    uint256 rate = _commissionCheckpoints[delegate].upperLookupRecent(uint32(epochEndTs));
    _commissionAtEpoch[delegate][epochId] = rate + 1; // +1 sentinel: 0 = not resolved
    return rate;
}
```

- [ ] **Step 2: Test** rate is frozen once resolved; subsequent setCommission doesn't affect past claims.

- [ ] **Step 3: Commit**

### Task 3.3 — Two-step epoch reward claim

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`

- [ ] **Step 1: Refactor existing claimEpochReward**

The existing V1 claim pays to the blocker directly. V1.5 refactor:
1. Compute `gross` share.
2. Resolve commission rate.
3. Split into `commission` (pay to delegate) + `remainder` (store in `_delegatorPool[delegate][epochId]`).
4. Mark `_delegateEpochClaimed[delegate][epochId] = true`.

```solidity
function claimEpochReward(uint256 epochId) external nonReentrant whenNotPaused {
    if (_delegateEpochClaimed[msg.sender][epochId]) revert AlreadyClaimed();
    uint256 w = _blockerWeightInEpoch[epochId][msg.sender];
    uint256 totalW = _totalBlockerWeightInEpoch[epochId];
    uint256 pool = _epochBudget[epochId];
    if (w == 0 || totalW == 0 || pool == 0) revert NothingToClaim();

    uint256 gross = (pool * w) / totalW;
    uint256 rate = _resolveCommissionAtEpoch(msg.sender, epochId);
    uint256 commission = (gross * rate) / 10_000;
    uint256 remainder = gross - commission;

    _delegateEpochClaimed[msg.sender][epochId] = true;
    _delegatorPool[msg.sender][epochId] = remainder;

    if (commission > 0) wood.safeTransfer(msg.sender, commission);
    emit EpochRewardSplit(msg.sender, epochId, gross, commission, remainder);
}
```

- [ ] **Step 2: Test** delegate-first enforcement + pool populated.

- [ ] **Step 3: Commit**

### Task 3.4 — claimDelegatorReward (epoch pool)

```solidity
function claimDelegatorReward(address delegate, uint256 epochId) external nonReentrant whenNotPaused {
    if (_delegatorClaimed[delegate][epochId][msg.sender]) revert AlreadyClaimed();
    uint256 pool = _delegatorPool[delegate][epochId];
    if (pool == 0) revert DelegatePoolEmpty(); // delegate hasn't claimed yet, or no rewards

    uint256 epochEndTs = epochGenesis + (epochId + 1) * EPOCH_DURATION - 1;
    uint256 my = _delegationCheckpoints[msg.sender][delegate].upperLookupRecent(uint32(epochEndTs));
    uint256 total = _delegatedInboundCheckpoints[delegate].upperLookupRecent(uint32(epochEndTs));
    if (my == 0 || total == 0) revert NoDelegationAtEpoch();

    uint256 share = (pool * my) / total;
    _delegatorClaimed[delegate][epochId][msg.sender] = true;

    if (share > 0) wood.safeTransfer(msg.sender, share);
    emit DelegatorRewardClaimed(msg.sender, delegate, epochId, share);
}
```

- [ ] Test + commit.

### Task 3.5 — Guardian fee pool funding (governor-side)

**Files:**
- Modify: `contracts/src/SyndicateGovernor.sol`, `contracts/src/GovernorParameters.sol`, `contracts/src/interfaces/ISyndicateGovernor.sol`

- [ ] **Step 1: Add `guardianFeeBps` parameter**

In `GovernorParameters`:

```solidity
bytes32 public constant PARAM_GUARDIAN_FEE_BPS = keccak256("guardianFeeBps");
uint256 public constant MAX_GUARDIAN_FEE_BPS = 500;

function setGuardianFeeBps(uint256 newBps) external onlyOwner {
    if (newBps > MAX_GUARDIAN_FEE_BPS) revert InvalidGuardianFeeBps();
    _queueChange(PARAM_GUARDIAN_FEE_BPS, newBps);
}
```

In `_applyChange` dispatcher:

```solidity
} else if (key == PARAM_GUARDIAN_FEE_BPS) {
    if (newValue > MAX_GUARDIAN_FEE_BPS) revert InvalidGuardianFeeBps();
    old = _guardianFeeBps;
    _guardianFeeBps = newValue;
}
```

Storage slot for `_guardianFeeBps` in governor, reduce `__gap` by 1.

- [ ] **Step 2: Modify _distributeFees**

Insert guardian fee branch after protocol fee:

```solidity
uint256 guardianFee = 0;
if (_guardianFeeBps > 0) {
    guardianFee = (profit * _guardianFeeBps) / 10000;
    if (guardianFee > 0) {
        address registry = address(_getRegistry());
        ISyndicateVault(vault).transferPerformanceFee(asset, registry, guardianFee);
        IGuardianRegistry(registry).fundProposalGuardianPool(proposalId, asset, guardianFee);
    }
}
uint256 remaining = profit - protocolFee - guardianFee;
```

- [ ] **Step 3: Check governor size**

`forge build --sizes --json | jq -r '.SyndicateGovernor.runtime_size'` — must be ≤ 24,550. If not, apply reclaim levers from CLAUDE.md:85 (drop events, factor keccak, etc.).

- [ ] **Step 4: Test**

```solidity
function test_settle_with_guardianFee_fundsPool() public {
    // Set guardianFeeBps = 100 via queue + finalize
    // Propose + execute + settle a positive-PnL proposal
    // Assert _proposalGuardianPool[proposalId].amount == profit * 100 / 10000
}
```

- [ ] **Step 5: Commit**

### Task 3.6 — fundProposalGuardianPool + claimProposalReward + delegator claim

- [ ] Implement `fundProposalGuardianPool` (registry-side, onlyGovernor)
- [ ] Implement `claimProposalReward(proposalId)` — approver pulls, DPoS split
- [ ] Implement `claimDelegatorProposalReward(delegate, proposalId)`
- [ ] W-1 escrow for approver blacklist case: `_unclaimedApproverFees[keccak256(proposalId, approver, asset)]`
- [ ] Tests: full approver-claim lifecycle, commission split, blacklist escrow, double-claim revert
- [ ] Commit

---

## Phase 4 — Invariant harness + integration tests

### Task 4.1 — DelegationInvariants.t.sol

Create `contracts/test/invariants/DelegationInvariants.t.sol` + a `DelegationHandler.sol` that drives: stake, unstake (request/cancel/claim), delegateStake, unstakeDelegation (request/cancel/claim), setCommission, slash, vote, fund guardian pool, claimEpochReward, claimDelegatorReward, claimProposalReward, warp.

- [ ] INV-V1.5-1: own stake + delegated pools disjoint (assert `totalGuardianStake + totalDelegatedStake == wood.balanceOf(registry) - slashAppealReserve - pendingBurn - pendingEpochRewards`)
- [ ] INV-V1.5-2: `getPastVoteWeight(g, t) == getPastStake(g, t) + getPastDelegated(g, t)`
- [ ] INV-V1.5-3: denominator parity
- [ ] INV-V1.5-4: WOOD balance conservation
- [ ] INV-V1.5-5: reward split sum (commission + delegator shares == gross)
- [ ] INV-V1.5-6: commission bounds
- [ ] INV-V1.5-7: no retroactive commission (resolved value stable after first lookup)
- [ ] INV-V1.5-8: guardian-fee sum conservation
- [ ] INV-V1.5-9: guardianFeeBps bounds
- [ ] INV-V1.5-10: fee-waterfall ordering (protocol + guardian + agent + mgmt <= gross)

128k fuzz runs; all invariants must pass. Commit per invariant.

### Task 4.2 — Full-lifecycle integration test

`test/integration/DelegationFullLifecycle.t.sol`:

- [ ] Setup: 3 guardians, 5 delegators, WOOD distributed
- [ ] Guardians stake; delegators `delegateStake` across guardians
- [ ] Propose → vote (Approve) → execute → settle with positive PnL
- [ ] Approver `claimProposalReward` → commission in USDC
- [ ] Delegators `claimDelegatorProposalReward` → pro-rata USDC
- [ ] Sum of claims == `_proposalGuardianPool.amount`
- [ ] Epoch boundary passes → block proposal → `claimEpochReward` → `claimDelegatorReward`
- [ ] Commit

---

## Phase 5 — Deploy + docs + CLI

### Task 5.1 — Deploy script: WOOD + registry wiring

- [ ] Add WOOD proxy deploy step to `script/Deploy.s.sol` (before registry, since registry references WOOD address)
- [ ] Write `WOOD_TOKEN` to `contracts/chains/{chainId}.json`
- [ ] Registry `initialize` takes `wood` as existing parameter — point to new WOOD proxy
- [ ] `_validateRegistry` checks WOOD address
- [ ] Commit

### Task 5.2 — Mintlify docs

- [ ] Create `mintlify-docs/protocol/guardians/delegation.mdx` covering: what delegation is, how to delegate, commission split, claim flow
- [ ] Update `mintlify-docs/protocol/guardians/overview.mdx` with guardian fee, approve-side reward
- [ ] Commit submodule
- [ ] Update `docs/tokenomics-wood.md` noting ERC20Votes extension + guardian fee
- [ ] Update `docs/contracts.md` architecture diagram

### Task 5.3 — CLI `sherwood guardian delegate`

- [ ] Create `cli/src/commands/guardian-delegate.ts`
- [ ] Subcommands: `stake`, `unstake`, `status`, `claim`, `set-commission`
- [ ] Integrate with existing config/addresses.ts (new `GUARDIAN_REGISTRY` + `WOOD_TOKEN`)
- [ ] Bump `cli/package.json` to `0.41.0` (new feature → minor)
- [ ] Typecheck + tests
- [ ] Commit

### Task 5.4 — Update CLAUDE.md + punchlist

- [ ] CLAUDE.md: add V1.5 to architecture table, note guardian fee parameter, update bytecode figures
- [ ] `docs/pre-mainnet-punchlist.md`: close the top-up bias finding (now fixed by Phase 1), note V1.5 as incentive-design addition
- [ ] Commit

---

## Acceptance gate

- [ ] All 10 INV-V1.5 invariants pass 128k fuzz
- [ ] All new unit tests pass
- [ ] All PR #229 tests still pass (683 baseline)
- [ ] Governor bytecode ≤ 24,550
- [ ] Registry bytecode ≤ 24,576 (current headroom 7k; expected ~22k post-V1.5)
- [ ] Mintlify docs published
- [ ] CLI `guardian delegate` commands work against a local anvil fork
- [ ] Migration runbook: N/A (fresh deployment)
- [ ] Spec `§14 Acceptance criteria` checkboxes all ticked
