# Guardian Delegation V1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship V1.5 — checkpoint-based vote weight, stake-pool delegation, on-chain commission config, guardian fee carved from settled PnL — resolving the top-up-bias + approve-bias findings and unlocking passive WOOD holder participation.

**Architecture:** WOOD multi-inherits OFT + ERC20Votes + ERC20Permit (preserves LayerZero). `GuardianRegistry` extends with `Checkpoints.Trace224` for own-stake + per-delegate inbound totals + per-(delegator, delegate) balances, and stores only `commissionBps` (no on-chain reward accounting). Governor adds `guardianFeeBps` + `merklDistributor` timelocked parameters and transfers the guardian-fee slice of settled PnL directly to **Merkl's distributor** (Angle Labs). Registry + governor emit events; Merkl's off-chain bot computes per-claimant attribution (DPoS commission split + time-weighted delegator share) and publishes Merkle roots; users claim via merkl.xyz.

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

## Phase 3 — Commission + hybrid rewards

> **Scope change (2026-04-22):** two distribution tracks — (a) WOOD epoch
> block-rewards route through Merkl (inflationary, controlled by us), (b)
> vault-asset guardian fee stays on-chain (real capital, full audit trail).
> Phase 3 ships: (1) `commissionBps` setter + rate limit + checkpoint
> history, (2) remove V1 on-chain epoch-claim machinery (replaced by
> `BlockerAttributed` events for Merkl), (3) governor `guardianFeeBps` +
> `guardianFeeRecipient` timelocked params, (4) `_distributeFees` branch
> that calls `registry.fundProposalGuardianPool`, (5) registry claim
> functions `claimProposalReward` / `claimDelegatorProposalReward` with
> DPoS split + W-1 escrow.

### Task 3.1 — Commission setter + rate limit

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`
- Modify: `contracts/src/interfaces/IGuardianRegistry.sol`
- Test: `contracts/test/GuardianRegistryCommission.t.sol`

- [ ] **Step 1: Write tests**

```solidity
function test_setCommission_happyPath() public {
    vm.prank(delegate_);
    registry.setCommission(1000); // 10%
    assertEq(registry.commissionOf(delegate_), 1000);
}

function test_setCommission_exceedsMaxReverts() public {
    vm.expectRevert(IGuardianRegistry.CommissionExceedsMax.selector);
    vm.prank(delegate_);
    registry.setCommission(6000); // > MAX_COMMISSION_BPS (5000)
}

function test_setCommission_raiseRateLimit() public {
    vm.prank(delegate_);
    registry.setCommission(1000);

    vm.expectRevert(IGuardianRegistry.CommissionRaiseExceedsLimit.selector);
    vm.prank(delegate_);
    registry.setCommission(2000); // raise > 500 bps in same epoch

    // After epoch boundary, another 500 bps raise is allowed
    vm.warp(vm.getBlockTimestamp() + 7 days);
    vm.prank(delegate_);
    registry.setCommission(1500);
}

function test_setCommission_decreaseUnbounded() public {
    vm.prank(delegate_);
    registry.setCommission(5000); // max
    vm.prank(delegate_);
    registry.setCommission(0); // free to lower
}
```

- [ ] **Step 2: Implement**

```solidity
uint256 public constant MAX_COMMISSION_BPS = 5000;
uint256 public constant MAX_COMMISSION_INCREASE_PER_EPOCH = 500;

error CommissionExceedsMax();
error CommissionRaiseExceedsLimit();

mapping(address => uint256) private _commissionBps;
mapping(address => uint256) private _lastCommissionRaiseEpoch;
mapping(address => Checkpoints.Trace224) private _commissionCheckpoints;

event CommissionSet(address indexed delegate, uint256 oldBps, uint256 newBps);

function setCommission(uint256 newBps) external {
    if (newBps > MAX_COMMISSION_BPS) revert CommissionExceedsMax();
    uint256 old = _commissionBps[msg.sender];
    uint256 curEpoch = currentEpoch();
    if (newBps > old) {
        uint256 lastRaise = _lastCommissionRaiseEpoch[msg.sender];
        if (lastRaise == curEpoch && newBps - old > MAX_COMMISSION_INCREASE_PER_EPOCH) {
            revert CommissionRaiseExceedsLimit();
        }
        _lastCommissionRaiseEpoch[msg.sender] = curEpoch;
    }
    _commissionBps[msg.sender] = newBps;
    _commissionCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(newBps));
    emit CommissionSet(msg.sender, old, newBps);
}

function commissionOf(address delegate) external view returns (uint256) {
    return _commissionBps[delegate];
}

function commissionAt(address delegate, uint256 timestamp) external view returns (uint256) {
    return _commissionCheckpoints[delegate].upperLookupRecent(uint32(timestamp));
}
```

- [ ] **Step 3: Commit** — `feat(registry): setCommission + raise-rate limit`

### Task 3.2 — Remove V1 on-chain epoch-reward machinery

V1 (PR #229) shipped `fundEpoch`, `claimEpochReward`, `_blockerWeightInEpoch`,
`_totalBlockerWeightInEpoch`, `_epochBudget`, `pendingEpochReward`, `sweepUnclaimed`,
and `_pendingEpochRewards` in GuardianRegistry. All of this moves off-chain to Merkl.

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol` — delete reward-accounting storage + functions
- Modify: `contracts/src/interfaces/IGuardianRegistry.sol` — drop deleted functions
- Delete test files covering removed features (or repurpose as docs)
- Modify: `contracts/src/SyndicateGovernor.sol` — remove `_attributeBlockWeightToEpoch` call in `resolveReview`

- [ ] **Step 1: Identify removal targets** via `grep -n "_blockerWeightInEpoch\|_totalBlockerWeightInEpoch\|_epochBudget\|fundEpoch\|claimEpochReward\|pendingEpochReward\|sweepUnclaimed\|_pendingEpochRewards" src/GuardianRegistry.sol`

- [ ] **Step 2: Delete each site**, update storage gap.

- [ ] **Step 3: Add single event** the off-chain attribution will read:

```solidity
event BlockerAttributed(
    uint256 indexed proposalId,
    uint256 indexed epochId,
    address indexed blocker,
    uint256 weight
);
```

Emit this in `resolveReview` when `blocked_ == true`, iterating `_blockers[proposalId]`:

```solidity
if (blocked_) {
    uint256 curEpoch = currentEpoch();
    address[] storage blockers = _blockers[proposalId];
    for (uint256 i = 0; i < blockers.length; i++) {
        address b = blockers[i];
        uint256 w = _voteStake[proposalId][b];
        emit BlockerAttributed(proposalId, curEpoch, b, w);
    }
    _slashApprovers(proposalId);
}
```

This is all the data Merkl's bot needs to build the epoch campaign roots.

- [ ] **Step 4: Run existing tests** — expect many removed-feature tests to delete (not fail). Update their shape.

- [ ] **Step 5: Commit** — `refactor(registry): remove on-chain epoch rewards (moved to Merkl)`

### Task 3.3 — Governor: `guardianFeeBps` timelocked parameter

**Files:**
- Modify: `contracts/src/GovernorParameters.sol`
- Modify: `contracts/src/SyndicateGovernor.sol`
- Test: `contracts/test/governor/GuardianFeeBpsTimelock.t.sol`

- [ ] **Step 1: Test the timelock flow**

```solidity
function test_setGuardianFeeBps_timelockFlow() public {
    vm.prank(owner);
    governor.setGuardianFeeBps(100);
    vm.expectRevert(); // cannot finalize before delay
    governor.finalizeParameterChange(governor.PARAM_GUARDIAN_FEE_BPS());

    vm.warp(vm.getBlockTimestamp() + PARAM_CHANGE_DELAY + 1);
    governor.finalizeParameterChange(governor.PARAM_GUARDIAN_FEE_BPS());
    assertEq(governor.guardianFeeBps(), 100);
}

function test_setGuardianFeeBps_aboveCapReverts() public {
    vm.expectRevert(ISyndicateGovernor.InvalidGuardianFeeBps.selector);
    vm.prank(owner);
    governor.setGuardianFeeBps(600); // > MAX_GUARDIAN_FEE_BPS (500)
}
```

- [ ] **Step 2: Implement in GovernorParameters**

Add `PARAM_GUARDIAN_FEE_BPS` constant + `MAX_GUARDIAN_FEE_BPS = 500` + `setGuardianFeeBps(bps)` that calls `_queueChange`. Validation in `_applyChange` dispatcher.

- [ ] **Step 3: Add storage + getter in SyndicateGovernor**

```solidity
uint256 private _guardianFeeBps;
function guardianFeeBps() external view returns (uint256) { return _guardianFeeBps; }
// Reduce __gap by 1.
```

- [ ] **Step 4: Run size check** after adding — if governor exceeds 24,550, apply reclaim from CLAUDE.md §85.

- [ ] **Step 5: Commit** — `feat(governor): guardianFeeBps timelocked parameter`

### Task 3.4 — Governor: `guardianFeeRecipient` timelocked address param

Same timelock pattern as `factory` / `protocolFeeRecipient`.

- [ ] Add `PARAM_GUARDIAN_FEE_RECIPIENT` + `setGuardianFeeRecipient(address)` + `_guardianFeeRecipient` storage.
- [ ] Zero-check at `_distributeFees` time (revert `GuardianFeeRecipientNotSet` only if `guardianFeeBps > 0`).
- [ ] Set at deploy to `GuardianRegistry` proxy address.
- [ ] Test + commit — `feat(governor): guardianFeeRecipient timelocked parameter`

### Task 3.5 — Governor: `_distributeFees` guardian-fee branch

**Files:**
- Modify: `contracts/src/SyndicateGovernor.sol`
- Test: `contracts/test/governor/GuardianFeeDistribution.t.sol`

- [ ] **Step 1: Tests**

```solidity
function test_settle_withGuardianFee_fundsRegistryPool() public {
    // guardianFeeBps=100, recipient=registry, 10k USDC profit -> 100 USDC to registry.
    _settleProposal(10_000e6);
    (address asset, uint256 amount,) = registry.proposalGuardianPool(proposalId);
    assertEq(asset, address(usdc));
    assertEq(amount, 100e6);
}

function test_settle_withGuardianFee_revertsIfRecipientUnset() public {
    vm.expectRevert(ISyndicateGovernor.GuardianFeeRecipientNotSet.selector);
    _settleProposal(10_000e6);
}

function test_settle_zeroGuardianFee_noFunding() public {
    _settleProposal(10_000e6);
    (, uint256 amount,) = registry.proposalGuardianPool(proposalId);
    assertEq(amount, 0);
}
```

- [ ] **Step 2: Implement** per spec §6a:

```solidity
if (_guardianFeeBps > 0) {
    guardianFee = (profit * _guardianFeeBps) / 10000;
    if (guardianFee > 0) {
        address recipient = _guardianFeeRecipient;
        if (recipient == address(0)) revert GuardianFeeRecipientNotSet();
        ISyndicateVault(vault).transferPerformanceFee(asset, recipient, guardianFee);
        IGuardianRegistry(recipient).fundProposalGuardianPool(proposalId, asset, guardianFee);
        emit GuardianFeeAccrued(proposalId, asset, recipient, guardianFee, uint64(block.timestamp));
    }
}
```

- [ ] **Step 3: Check governor size** — likely +80 bytes. If over 24,550, reclaim per CLAUDE.md §85 (consolidate `transferPerformanceFee` call sites, drop redundant event fields).

- [ ] **Step 4: Commit** — `feat(governor): guardian-fee branch funds registry pool`

### Task 3.6 — Registry: `fundProposalGuardianPool`

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`
- Test: `contracts/test/GuardianRegistryProposalReward.t.sol`

- [ ] **Step 1: Test** onlyGovernor; struct stamped with correct `{asset, amount, settledAt}`; idempotent no-op on `amount == 0`; double-fund reverts (or overwrites — pick and document).

- [ ] **Step 2: Implement** per spec §4.8:

```solidity
function fundProposalGuardianPool(uint256 proposalId, address asset, uint256 amount)
    external
{
    if (msg.sender != governor) revert NotGovernor();
    if (amount == 0) return;
    // Assume the governor just transferred exactly `amount` of `asset` to us.
    _proposalGuardianPool[proposalId] = ProposalRewardPool({
        asset: asset,
        amount: uint128(amount),
        settledAt: uint64(block.timestamp)
    });
    emit ProposalGuardianPoolFunded(proposalId, asset, amount);
}
```

- [ ] Commit — `feat(registry): fundProposalGuardianPool governor hook`

### Task 3.7 — Registry: `claimProposalReward` (approver)

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`
- Test: `contracts/test/GuardianRegistryProposalReward.t.sol`

- [ ] **Step 1: Tests**

```solidity
function test_claimProposalReward_approverPaysCommission() public {
    _settleApproved(10_000e6); // 100 USDC guardian fee
    // One approver with 100% of approveStakeWeight, 2000 bps commission
    vm.prank(approver1);
    registry.setCommission(2000);
    _openReview(); _approve(approver1); _resolve(); _settle();

    uint256 before = usdc.balanceOf(approver1);
    vm.prank(approver1);
    registry.claimProposalReward(proposalId);
    assertEq(usdc.balanceOf(approver1) - before, 100e6 * 2000 / 10_000);  // 20 USDC commission
    // remainder 80 USDC stays in registry under _delegatorProposalPool[approver1][pid]
}

function test_claimProposalReward_blockerReverts() public {
    // ...
    vm.expectRevert(IGuardianRegistry.NotApprover.selector);
    vm.prank(blocker1);
    registry.claimProposalReward(proposalId);
}

function test_claimProposalReward_doubleReverts() public { /* ... */ }
function test_claimProposalReward_commissionAtSettledAt_notAtClaim() public { /* ... */ }
function test_claimProposalReward_blockedProposal_reverts_NoPoolFunded() public { /* ... */ }
```

- [ ] **Step 2: Implement** per spec §4.8 (full Solidity shown there, including DPoS split + `_safeRewardTransfer` for W-1 escrow).

- [ ] Commit — `feat(registry): claimProposalReward (approver DPoS commission)`

### Task 3.8 — Registry: `claimDelegatorProposalReward`

- [ ] Test: delegator pulls pro-rata share of `_delegatorProposalPool[delegate][pid]`; requires delegate to have claimed first; double-claim reverts; no-delegation-at-settledAt reverts.

- [ ] Implement per spec §4.8 (reads `_delegationCheckpoints[delegator][delegate].upperLookupRecent(settledAt)`).

- [ ] Commit — `feat(registry): claimDelegatorProposalReward (DPoS delegator share)`

### Task 3.9 — Registry: W-1 escrow + `flushUnclaimedApproverFee`

- [ ] Add `_safeRewardTransfer(asset, recipient, amount, proposalId)` internal that wraps `safeTransfer` in try/catch; on failure records `_unclaimedApproverFees[keccak256(proposalId, recipient, asset)] += amount` + emits `ApproverFeeEscrowed`.

- [ ] Add external `flushUnclaimedApproverFee(proposalId, recipient)` that transfers the escrowed amount to `recipient` if still > 0 (idempotent).

- [ ] **Regression test** the cross-proposal drain fix from PR #229 review: escrow on proposal A cannot be pulled via proposal B's flush path (key must include proposalId).

- [ ] Commit — `feat(registry): W-1 escrow for guardian-fee reward transfers`

### Task 3.10 — Registry: emit `EpochBudgetFunded` helper

Lightweight indexer helper for the WOOD epoch pool funded on Merkl:

```solidity
event EpochBudgetFunded(uint256 indexed epochId, uint256 amount);

/// @notice Permissionless — caller transfers WOOD to `guardianFeeRecipient`
///         (or any Merkl distributor address) separately; this function only
///         emits the event so Merkl's bot + indexers can correlate the
///         campaign deposit with an epoch. No token movement happens here.
function recordEpochBudget(uint256 epochId, uint256 amount) external {
    emit EpochBudgetFunded(epochId, amount);
}
```

- [ ] Test + commit — `feat(registry): EpochBudgetFunded helper`

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
- [ ] Subcommands: `stake`, `unstake` (request/cancel/claim), `status`, `set-commission`. **No `claim` subcommand** — rewards claimed via merkl.xyz.
- [ ] `claim-rewards` subcommand: print a link to `merkl.xyz/sherwood?user=<addr>` + summary of pending amounts fetched from Merkl API
- [ ] Integrate with existing config/addresses.ts (new `GUARDIAN_REGISTRY` + `WOOD_TOKEN` + `MERKL_DISTRIBUTOR`)
- [ ] Bump `cli/package.json` to `0.41.0`
- [ ] Typecheck + tests
- [ ] Commit

### Task 5.4 — Update CLAUDE.md + punchlist

- [ ] CLAUDE.md: add V1.5 to architecture table, note guardian-fee parameter + Merkl distributor param, update bytecode figures, add note on Merkl off-chain dependency
- [ ] `docs/pre-mainnet-punchlist.md`: close the top-up bias finding + the approve-bias finding (both closed by V1.5)
- [ ] Commit

---

## Phase 6 — Merkl campaign setup (off-chain)

### Task 6.1 — Register campaigns on Merkl

- [ ] Liaise with Angle team for Sherwood custom-attribution campaigns (if standard campaign types don't cover DPoS + time-weighted attribution natively)
- [ ] Register **Epoch Block-Reward campaign** (WOOD, recurring per 7-day epoch): eligibility = block-voters on blocked proposals within the epoch; split by `BlockerAttributed` event weight, DPoS commission applied
- [ ] Register **Guardian Fee campaign** (vault asset, per-settle): eligibility = approvers on settled proposals; split by `GuardianVoteCast` weight (Approve side), DPoS commission applied

### Task 6.2 — Dune queries for custom attribution

- [ ] Publish Dune query for epoch campaign: reads `BlockerAttributed`, `DelegationIncreased`, `DelegationUnstakeClaimed`, `CommissionSet` events → outputs `(claimant, epoch, amount)` with DPoS split + time-weighted delegator attribution
- [ ] Publish Dune query for guardian-fee campaign: reads `GuardianFeeAccrued` + `GuardianVoteCast` (Approve side) events → outputs `(claimant, proposalId, amount)`
- [ ] Register Dune query URLs with Merkl bot

### Task 6.3 — Frontend + docs

- [ ] Add "Claim rewards" link on Sherwood dashboard pointing to merkl.xyz/sherwood
- [ ] Document claim UX in `mintlify-docs/protocol/guardians/rewards.mdx`
- [ ] Commit

---

## Acceptance gate

- [ ] All INV-V1.5-1 through INV-V1.5-9 invariants pass 128k fuzz
- [ ] All new unit tests pass
- [ ] All PR #229 tests still pass (683 baseline)
- [ ] Governor bytecode ≤ 24,550
- [ ] Registry bytecode ≤ 24,576 (expected ~20.5k post-V1.5 after removing V1 on-chain reward code)
- [ ] Mintlify docs published (delegation.mdx + rewards.mdx)
- [ ] CLI `guardian delegate` commands work against a local anvil fork
- [ ] Merkl campaigns live on Base Sepolia + roots publishing
- [ ] Migration runbook: N/A (fresh deployment)
- [ ] Spec `§14 Acceptance criteria` checkboxes all ticked
