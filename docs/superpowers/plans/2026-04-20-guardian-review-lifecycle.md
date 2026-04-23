# Guardian Review Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the staked-guardian review layer between proposal approval and execution as specified in `docs/superpowers/specs/2026-04-19-guardian-review-lifecycle-design.md`.

**Architecture:** New `GuardianRegistry.sol` (UUPS, pausable) holds stake + review votes + slashing + epoch rewards + appeal reserve. `GovernorEmergency.sol` abstract extracted from governor for bytecode headroom; `SyndicateGovernor` inherits it. `SyndicateFactory` gets owner-stake binding at create-time + `rotateOwner` recovery. The canonical spec is authoritative; this plan is the build sequence.

**Tech Stack:** Solidity 0.8.28, Foundry, OpenZeppelin upgradeable (UUPS), WOOD token (ERC-20 LayerZero OFT), ERC-8004 identity.

**Pre-read before starting:**
- Spec: `docs/superpowers/specs/2026-04-19-guardian-review-lifecycle-design.md` (source of truth)
- Existing code: `contracts/src/SyndicateGovernor.sol`, `SyndicateFactory.sol`, `GovernorParameters.sol`
- Punch list: `docs/pre-mainnet-punchlist.md` (tracks which rows this plan closes)

**Hard gates:**
- **Gate A** (Task 2): `forge build --sizes` after GovernorEmergency extraction must show `SyndicateGovernor <= 24,400 bytes`. If not, STOP — re-plan with Option A (registry as state-machine oracle).
- **Gate B** (Task 0): `forge coverage` must run without Yul stack-too-deep. This is the coverage unblock from punch list item 1.

---

## File structure

**New files:**
```
contracts/src/
├── GuardianRegistry.sol                          [~800 LOC]
├── GovernorEmergency.sol                         [abstract, ~250 LOC]
├── interfaces/
│   └── IGuardianRegistry.sol                     [~150 LOC]

contracts/test/
├── GuardianRegistry.t.sol                        [unit tests]
├── governor/
│   ├── GuardianReviewLifecycle.t.sol             [integration]
│   └── EmergencySettleReview.t.sol               [integration]
├── factory/
│   └── OwnerStakeAtCreation.t.sol                [integration]
└── invariants/
    └── GuardianInvariants.t.sol                  [StdInvariant]
```

**Modified files:**
```
contracts/src/
├── SyndicateGovernor.sol                         [+GuardianReview state, +reviewEnd, inherit GovernorEmergency, narrow veto/cancel]
├── SyndicateFactory.sol                          [+guardianRegistry set-once, +rotateOwner, +bindOwnerStake flow]
├── interfaces/
│   ├── ISyndicateGovernor.sol                    [+enum variant, +struct field, +events/errors, -emergencySettle]
│   └── ISyndicateFactory.sol                     [+rotateOwner, +guardianRegistry view]

contracts/script/
├── Deploy.s.sol                                  [deploy GuardianRegistry, wire set-once pointers]
├── ScriptBase.sol                                [+helpers for GUARDIAN_REGISTRY address]

contracts/chains/{chainId}.json                   [GUARDIAN_REGISTRY key added by deploy]
```

---

## Task 0: Unblock `forge coverage`

**Why:** Punch list item 1 (#226 §3.1). `SyndicateGovernor.propose()` struct literal at line 213 causes `Yul stack-too-deep` on every coverage config. Prerequisite for measuring coverage on everything else.

**Files:**
- Modify: `contracts/src/SyndicateGovernor.sol:199-230` (the `propose()` body struct literal)

- [ ] **Step 1: Confirm the failure reproduces**

```bash
cd /Users/anajuliabittencourt/code/sherwood/contracts
forge coverage 2>&1 | grep -A 3 "stack-too-deep"
```

Expected: error mentioning `SyndicateGovernor.sol:213:32 snapshotTimestamp: isCollaborative ? 0 : block.timestamp,`

- [ ] **Step 2: Refactor struct literal into sequential assignments**

In `SyndicateGovernor.sol:199-230`, replace the inline struct construction with:

```solidity
// BEFORE (single struct literal — causes stack-too-deep):
_proposals[proposalId] = StrategyProposal({
    id: proposalId,
    proposer: msg.sender,
    // ... 12 fields
    state: isCollaborative ? ProposalState.Draft : ProposalState.Pending
});

// AFTER (sequential field assignments):
StrategyProposal storage p = _proposals[proposalId];
p.id = proposalId;
p.proposer = msg.sender;
p.vault = vault;
p.metadataURI = metadataURI;
p.performanceFeeBps = performanceFeeBps;
p.strategyDuration = strategyDuration;
p.snapshotTimestamp = isCollaborative ? 0 : block.timestamp;
p.voteEnd = isCollaborative ? 0 : block.timestamp + _params.votingPeriod;
p.executeBy = isCollaborative ? 0 : block.timestamp + _params.votingPeriod + _params.executionWindow;
p.state = isCollaborative ? ProposalState.Draft : ProposalState.Pending;
// votesFor / votesAgainst / votesAbstain / executedAt default to 0
```

- [ ] **Step 3: Run the existing governor test suite to verify no regression**

```bash
forge test --match-contract SyndicateGovernor -vvv
```

Expected: all existing tests pass.

- [ ] **Step 4: Run `forge coverage` to verify unblock**

```bash
forge coverage --report summary 2>&1 | tail -20
```

Expected: runs to completion, reports `SyndicateGovernor.sol` coverage % (any number — we just need it to not die).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/SyndicateGovernor.sol
git commit -m "fix(governor): unblock forge coverage — sequential field assignment in propose()

Refactors the StrategyProposal struct literal into sequential storage
writes to avoid Yul stack-too-deep. No semantic change.

closes punch-list item 1 (#226 §3.1)."
```

---

## Task 1: CI size gate

**Why:** Spec §11. Governor is at 24,523 / 24,576 (53-byte margin). Every subsequent task adds bytes; we need an automated trip-wire.

**Files:**
- Modify: `.github/workflows/contracts.yml` (or equivalent — check existing CI config first)

- [ ] **Step 1: Locate the existing contracts CI workflow**

```bash
ls -la /Users/anajuliabittencourt/code/sherwood/.github/workflows/
```

- [ ] **Step 2: Add a size-gate step**

Add this step to the workflow after the `forge build` step:

```yaml
- name: Enforce bytecode size budget
  working-directory: contracts
  run: |
    SIZE=$(forge build --sizes --json | jq -r '.SyndicateGovernor.runtime_size // empty')
    echo "SyndicateGovernor runtime size: $SIZE bytes"
    if [ -z "$SIZE" ]; then
      echo "::error::could not read SyndicateGovernor runtime size"
      exit 1
    fi
    if [ "$SIZE" -gt 24400 ]; then
      echo "::error::SyndicateGovernor $SIZE > 24400 byte budget"
      exit 1
    fi
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/contracts.yml
git commit -m "ci(contracts): enforce 24,400-byte budget on SyndicateGovernor

CLAUDE.md and punch list item 10 flag the 53-byte margin as a live
risk for every governor edit. Gate catches size regressions in CI.
"
```

---

## Task 2: GovernorEmergency abstract — prototype + GATE

**Why:** Spec §11 Option B. If this doesn't bring the governor under 24,400 bytes, we abort and re-plan with Option A.

**Files:**
- Create: `contracts/src/GovernorEmergency.sol`
- Modify: `contracts/src/SyndicateGovernor.sol` (inherit + remove extracted fns)

- [ ] **Step 1: Read the existing emergency logic**

```bash
grep -n "emergencySettle\|_tryPrecommittedThenFallback" contracts/src/SyndicateGovernor.sol
```

Note the line ranges of `emergencySettle` (currently ~L309-321) and `_tryPrecommittedThenFallback` (currently ~L659-678).

- [ ] **Step 2: Create `GovernorEmergency.sol` with stubs**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title GovernorEmergency
/// @notice Abstract — emergency settlement paths extracted for bytecode headroom.
///         Inherited by SyndicateGovernor alongside GovernorParameters.
abstract contract GovernorEmergency is ISyndicateGovernor {
    // Virtual accessors (implemented by SyndicateGovernor)
    function _getProposal(uint256) internal view virtual returns (StrategyProposal storage);
    function _getSettlementCalls(uint256) internal view virtual returns (BatchExecutorLib.Call[] storage);
    function _getRegistry() internal view virtual returns (IGuardianRegistry);
    function _emergencyReentrancyEnter() internal virtual;
    function _emergencyReentrancyLeave() internal virtual;

    modifier emergencyNonReentrant() {
        _emergencyReentrancyEnter();
        _;
        _emergencyReentrancyLeave();
    }

    /// @inheritdoc ISyndicateGovernor
    function unstick(uint256 proposalId) external emergencyNonReentrant { /* TODO Task 24 */ revert(); }

    /// @inheritdoc ISyndicateGovernor
    function emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external emergencyNonReentrant { /* TODO Task 24 */ revert(); }

    /// @inheritdoc ISyndicateGovernor
    function cancelEmergencySettle(uint256 proposalId) external emergencyNonReentrant { /* TODO Task 24 */ revert(); }

    /// @inheritdoc ISyndicateGovernor
    function finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external emergencyNonReentrant { /* TODO Task 24 */ revert(); }
}
```

- [ ] **Step 3: Make `SyndicateGovernor` inherit it and remove old `emergencySettle`**

In `SyndicateGovernor.sol`:
- Add `GovernorEmergency` to the inheritance list.
- Remove `emergencySettle`, `_tryPrecommittedThenFallback` (they'll be reimplemented in Task 25 via the abstract).
- Add the virtual accessor implementations:

```solidity
function _getProposal(uint256 id) internal view override returns (StrategyProposal storage) {
    return _proposals[id];
}
function _getSettlementCalls(uint256 id) internal view override returns (BatchExecutorLib.Call[] storage) {
    return _settlementCalls[id];
}
function _getRegistry() internal view override returns (IGuardianRegistry) {
    return IGuardianRegistry(_guardianRegistry);
}
function _emergencyReentrancyEnter() internal override nonReentrant {}  // reuses existing nonReentrant modifier path
function _emergencyReentrancyLeave() internal override {}
```

Also add storage slot:
```solidity
address internal _guardianRegistry; // wired in Task 26
```

- [ ] **Step 4: Run `forge build --sizes` — THE GATE**

```bash
forge build --sizes 2>&1 | grep -E "SyndicateGovernor|GovernorEmergency"
```

Expected: `SyndicateGovernor` runtime size should drop. Record exact bytes.

- [ ] **Step 5: GO/NO-GO decision**

- If `SyndicateGovernor runtime <= 24,400`: ✅ proceed to Task 3.
- If `24,400 < runtime <= 24,576`: ⚠️ technically deployable but margin is gone. Flag to user and decide: continue or add Option A refactoring to registry-as-state-oracle.
- If `runtime > 24,576`: ❌ STOP. Document measured size in the plan, abort, and re-plan with Option A.

- [ ] **Step 6: Run existing tests to confirm the stub doesn't break anything external (they all revert unreached because nothing calls them yet)**

```bash
forge test -vvv
```

Expected: any test that previously called `emergencySettle` may now revert; mark those tests skipped with a comment referencing this plan. No other regressions.

- [ ] **Step 7: Commit**

```bash
git add contracts/src/GovernorEmergency.sol contracts/src/SyndicateGovernor.sol
git commit -m "feat(governor): extract GovernorEmergency abstract (spec §11 Option B)

Governor runtime size: <BEFORE> → <AFTER> bytes.
Stubs only — Task 25 implements the emergency fns.
Closes gate A of the guardian-review plan."
```

---

## Task 3: IGuardianRegistry interface

**Why:** Freeze the ABI before implementation so tests can be written against a stable surface. TDD.

**Files:**
- Create: `contracts/src/interfaces/IGuardianRegistry.sol`

- [ ] **Step 1: Write the interface**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface IGuardianRegistry {
    // ── Enums ──
    enum GuardianVoteType { None, Approve, Block }

    // ── Errors ──
    error ZeroAddress();
    error InsufficientStake();
    error NoActiveStake();
    error CooldownNotElapsed();
    error UnstakeNotRequested();
    error UnstakeAlreadyRequested();
    error NotActiveGuardian();
    error AlreadyVoted();
    error NoVoteChange();
    error VoteChangeLockedOut();
    error NewSideFull();
    error ReviewNotOpen();
    error ReviewNotReadyForResolve();
    error NotFactory();
    error NotGovernor();
    error NotMinterOrOwner();
    error PreparedStakeNotFound();
    error PreparedStakeAlreadyBound();
    error VaultHasActiveProposal();
    error OwnerBondInsufficient();
    error InvalidEpoch();
    error EpochNotEnded();
    error NothingToClaim();
    error FundEpochLocked();
    error SweepTooEarly();
    error Paused();
    error NotPausedOrDeadmanNotElapsed();
    error RefundCapExceeded();
    error InvalidAgentId();

    // ── Events ──
    event GuardianStaked(address indexed guardian, uint256 amount, uint256 agentId);
    event GuardianUnstakeRequested(address indexed guardian, uint256 requestedAt);
    event GuardianUnstakeCancelled(address indexed guardian);
    event GuardianUnstakeClaimed(address indexed guardian, uint256 amount);
    event OwnerStakePrepared(address indexed owner, uint256 amount);
    event PreparedStakeCancelled(address indexed owner, uint256 amount);
    event OwnerStakeBound(address indexed owner, address indexed vault, uint256 amount);
    event OwnerStakeSlotTransferred(address indexed vault, address indexed oldOwner, address indexed newOwner);
    event OwnerUnstakeRequested(address indexed vault, uint256 requestedAt);
    event OwnerUnstakeClaimed(address indexed vault, address indexed owner, uint256 amount);
    event ReviewOpened(uint256 indexed proposalId, uint128 totalStakeAtOpen);
    event CohortTooSmallToReview(uint256 indexed proposalId, uint256 totalStakeAtOpen);
    event GuardianVoteCast(uint256 indexed proposalId, address indexed guardian, GuardianVoteType support, uint128 weight);
    event GuardianVoteChanged(uint256 indexed proposalId, address indexed guardian, GuardianVoteType from, GuardianVoteType to);
    event ApproverCapReached(uint256 indexed proposalId);
    event ReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    event EmergencyReviewOpened(uint256 indexed proposalId, bytes32 callsHash, uint64 reviewEnd);
    event EmergencyBlockVoteCast(uint256 indexed proposalId, address indexed guardian, uint128 weight);
    event EmergencyReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    event EpochFunded(uint256 indexed epochId, address indexed funder, uint256 amount);
    event EpochRewardClaimed(uint256 indexed epochId, address indexed guardian, uint256 amount);
    event EpochUnclaimedSwept(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);
    event PendingBurnRecorded(uint256 amount);
    event BurnFlushed(uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by, bool deadman);
    event SlashAppealReserveFunded(address indexed by, uint256 amount);
    event SlashAppealRefunded(address indexed recipient, uint256 amount, uint256 epochId);

    // ── Guardian fns ──
    function stakeAsGuardian(uint256 amount, uint256 agentId) external;
    function requestUnstakeGuardian() external;
    function cancelUnstakeGuardian() external;
    function claimUnstakeGuardian() external;
    function voteOnProposal(uint256 proposalId, GuardianVoteType support) external;

    // ── Owner fns ──
    function prepareOwnerStake(uint256 amount) external;
    function cancelPreparedStake() external;
    function requestUnstakeOwner(address vault) external;
    function claimUnstakeOwner(address vault) external;

    // ── Factory-only ──
    function bindOwnerStake(address owner, address vault) external;
    function transferOwnerStakeSlot(address vault, address newOwner) external;

    // ── Governor-only ──
    function openEmergencyReview(uint256 proposalId, bytes32 callsHash) external;

    // ── Permissionless ──
    function openReview(uint256 proposalId) external;
    function resolveReview(uint256 proposalId) external returns (bool blocked);
    function resolveEmergencyReview(uint256 proposalId) external returns (bool blocked);
    function voteBlockEmergencySettle(uint256 proposalId) external;
    function flushBurn() external;
    function sweepUnclaimed(uint256 epochId) external;

    // ── Epoch rewards ──
    function fundEpoch(uint256 epochId, uint256 amount) external;
    function claimEpochReward(uint256 epochId) external;

    // ── Slash appeal ──
    function fundSlashAppealReserve(uint256 amount) external;
    function refundSlash(address recipient, uint256 amount) external;

    // ── Pause ──
    function pause() external;
    function unpause() external;

    // ── Parameter setters (timelocked) ──
    function setMinGuardianStake(uint256) external;
    function setMinOwnerStake(uint256) external;
    function setOwnerStakeTvlBps(uint256) external;
    function setCoolDownPeriod(uint256) external;
    function setReviewPeriod(uint256) external;
    function setBlockQuorumBps(uint256) external;
    function setMinter(address) external;

    // ── Views ──
    function guardianStake(address guardian) external view returns (uint256);
    function ownerStake(address vault) external view returns (uint256);
    function totalGuardianStake() external view returns (uint256);
    function isActiveGuardian(address guardian) external view returns (bool);
    function hasOwnerStake(address vault) external view returns (bool);
    function preparedStakeOf(address owner) external view returns (uint256);
    function canCreateVault(address owner) external view returns (bool);
    function requiredOwnerBond(address vault) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function pendingEpochReward(address guardian, uint256 epochId) external view returns (uint256);
    function governor() external view returns (address);
    function factory() external view returns (address);
}
```

- [ ] **Step 2: Compile — interface-only check**

```bash
forge build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add contracts/src/interfaces/IGuardianRegistry.sol
git commit -m "feat(registry): define IGuardianRegistry interface (V1 ABI freeze)"
```

---

## Task 4: GuardianRegistry skeleton — UUPS + initialize + storage

**Files:**
- Create: `contracts/src/GuardianRegistry.sol`
- Create: `contracts/test/GuardianRegistry.t.sol`

- [ ] **Step 1: Write failing test — `initialize` wires fields**

```solidity
// contracts/test/GuardianRegistry.t.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";  // reuse existing

contract GuardianRegistryInitTest is Test {
    GuardianRegistry registry;
    MockERC20 wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);

    function setUp() public {
        wood = new MockERC20("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(GuardianRegistry.initialize, (
            owner, governor, factory, address(wood),
            10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000
        ));
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));
    }

    function test_initialize_setsFields() public {
        assertEq(registry.owner(), owner);
        assertEq(registry.governor(), governor);
        assertEq(registry.factory(), factory);
        assertEq(address(registry.wood()), address(wood));
        assertEq(registry.minGuardianStake(), 10_000e18);
        assertEq(registry.reviewPeriod(), 24 hours);
        assertEq(registry.blockQuorumBps(), 3000);
        assertFalse(registry.paused());
        assertGt(registry.epochGenesis(), 0);
    }

    function test_initialize_revertsOnZeroGovernor() public {
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(GuardianRegistry.initialize, (
            owner, address(0), factory, address(wood),
            10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000
        ));
        vm.expectRevert(GuardianRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }
}
```

- [ ] **Step 2: Run test — expect fail (no contract yet)**

```bash
forge test --match-contract GuardianRegistryInitTest -vvv
```

Expected: compile error, `GuardianRegistry` not found.

- [ ] **Step 3: Write the minimal `GuardianRegistry` skeleton**

```solidity
// contracts/src/GuardianRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract GuardianRegistry is IGuardianRegistry, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant MIN_COHORT_STAKE_AT_OPEN = 50_000 * 1e18;
    uint256 public constant MAX_APPROVERS_PER_PROPOSAL = 100;
    uint256 public constant SWEEP_DELAY = 12 weeks;
    uint256 public constant LATE_VOTE_LOCKOUT_BPS = 1000;
    uint256 public constant MAX_REFUND_PER_EPOCH_BPS = 2000;
    uint256 public constant DEADMAN_UNPAUSE_DELAY = 7 days;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Storage — see spec §3.1 for layout ──
    struct Guardian {
        uint128 stakedAmount;
        uint64 stakedAt;
        uint64 unstakeRequestedAt;
        uint256 agentId;
    }
    mapping(address => Guardian) internal _guardians;
    uint256 public totalGuardianStake;
    uint256 public activeGuardianCount;

    struct OwnerStake {
        uint128 stakedAmount;
        uint64 unstakeRequestedAt;
        address owner;
    }
    mapping(address vault => OwnerStake) internal _ownerStakes;

    struct PreparedOwnerStake {
        uint128 amount;
        uint64 preparedAt;
        bool bound;
    }
    mapping(address owner => PreparedOwnerStake) internal _prepared;

    struct Review {
        bool opened;
        bool resolved;
        bool blocked;
        bool cohortTooSmall;
        uint128 totalStakeAtOpen;
        uint128 approveStakeWeight;
        uint128 blockStakeWeight;
    }
    mapping(uint256 => Review) internal _reviews;
    mapping(uint256 => mapping(address => GuardianVoteType)) internal _votes;
    mapping(uint256 => mapping(address => uint128)) internal _voteStake;
    mapping(uint256 => address[]) internal _approvers;
    mapping(uint256 => address[]) internal _blockers;
    mapping(uint256 => mapping(address => uint256)) internal _approverIndex;
    mapping(uint256 => mapping(address => uint256)) internal _blockerIndex;

    struct EmergencyReview {
        bytes32 callsHash;
        uint64 reviewEnd;
        uint128 totalStakeAtOpen;
        uint128 blockStakeWeight;
        bool resolved;
        bool blocked;
    }
    mapping(uint256 => EmergencyReview) internal _emergencyReviews;
    mapping(uint256 => mapping(address => bool)) internal _emergencyBlockVotes;

    // Epoch rewards
    uint256 public epochGenesis;
    mapping(uint256 => uint256) public epochBudget;
    mapping(uint256 => uint256) public epochTotalBlockWeight;
    mapping(uint256 => mapping(address => uint256)) public epochGuardianBlockWeight;
    mapping(uint256 => mapping(address => bool)) public epochRewardClaimed;

    // Pending burn
    mapping(address => uint256) internal _pendingBurn;

    // Pause state
    bool public paused;
    uint64 public pausedAt;

    // Slash appeal
    uint256 public slashAppealReserve;
    mapping(uint256 => uint256) public refundedInEpoch;

    // Parameters
    uint256 public minGuardianStake;
    uint256 public minOwnerStake;
    uint256 public ownerStakeTvlBps;
    uint256 public coolDownPeriod;
    uint256 public reviewPeriod;
    uint256 public blockQuorumBps;

    // Pending parameter changes (timelocked — Task 24)
    struct PendingChange { uint256 newValue; uint64 effectiveAt; bool exists; }
    mapping(bytes32 => PendingChange) internal _pendingChanges;
    uint256 public parameterChangeDelay;

    // Privileged addresses
    address public governor;
    address public factory;
    address public minter;
    IERC20 public wood;

    // ── Initializer ──
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address owner_,
        address governor_,
        address factory_,
        address wood_,
        uint256 minGuardianStake_,
        uint256 minOwnerStake_,
        uint256 ownerStakeTvlBps_,
        uint256 coolDownPeriod_,
        uint256 reviewPeriod_,
        uint256 blockQuorumBps_
    ) external initializer {
        if (owner_ == address(0) || governor_ == address(0) || factory_ == address(0) || wood_ == address(0)) {
            revert ZeroAddress();
        }

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        governor = governor_;
        factory = factory_;
        wood = IERC20(wood_);
        minGuardianStake = minGuardianStake_;
        minOwnerStake = minOwnerStake_;
        ownerStakeTvlBps = ownerStakeTvlBps_;
        coolDownPeriod = coolDownPeriod_;
        reviewPeriod = reviewPeriod_;
        blockQuorumBps = blockQuorumBps_;
        parameterChangeDelay = 24 hours; // default; timelocked setter in Task 24
        epochGenesis = block.timestamp;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // All other fns stubbed — implemented in subsequent tasks.
    // For compile: revert unimplemented.

    function stakeAsGuardian(uint256, uint256) external { revert(); }
    function requestUnstakeGuardian() external { revert(); }
    function cancelUnstakeGuardian() external { revert(); }
    function claimUnstakeGuardian() external { revert(); }
    function voteOnProposal(uint256, GuardianVoteType) external { revert(); }
    function prepareOwnerStake(uint256) external { revert(); }
    function cancelPreparedStake() external { revert(); }
    function requestUnstakeOwner(address) external { revert(); }
    function claimUnstakeOwner(address) external { revert(); }
    function bindOwnerStake(address, address) external { revert(); }
    function transferOwnerStakeSlot(address, address) external { revert(); }
    function openEmergencyReview(uint256, bytes32) external { revert(); }
    function openReview(uint256) external { revert(); }
    function resolveReview(uint256) external returns (bool) { revert(); }
    function resolveEmergencyReview(uint256) external returns (bool) { revert(); }
    function voteBlockEmergencySettle(uint256) external { revert(); }
    function flushBurn() external { revert(); }
    function sweepUnclaimed(uint256) external { revert(); }
    function fundEpoch(uint256, uint256) external { revert(); }
    function claimEpochReward(uint256) external { revert(); }
    function fundSlashAppealReserve(uint256) external { revert(); }
    function refundSlash(address, uint256) external { revert(); }
    function pause() external { revert(); }
    function unpause() external { revert(); }
    function setMinGuardianStake(uint256) external { revert(); }
    function setMinOwnerStake(uint256) external { revert(); }
    function setOwnerStakeTvlBps(uint256) external { revert(); }
    function setCoolDownPeriod(uint256) external { revert(); }
    function setReviewPeriod(uint256) external { revert(); }
    function setBlockQuorumBps(uint256) external { revert(); }
    function setMinter(address) external { revert(); }

    // Views (minimal now; full impl in later tasks)
    function guardianStake(address g) external view returns (uint256) { return _guardians[g].stakedAmount; }
    function ownerStake(address v) external view returns (uint256) { return _ownerStakes[v].stakedAmount; }
    function isActiveGuardian(address g) external view returns (bool) { return _guardians[g].stakedAmount > 0 && _guardians[g].unstakeRequestedAt == 0; }
    function hasOwnerStake(address v) external view returns (bool) { return _ownerStakes[v].stakedAmount > 0; }
    function preparedStakeOf(address o) external view returns (uint256) { return _prepared[o].amount; }
    function canCreateVault(address o) external view returns (bool) { return _prepared[o].amount >= minOwnerStake && !_prepared[o].bound; }
    function requiredOwnerBond(address) external view returns (uint256) { return minOwnerStake; }  // Task 10 adds TVL scaling
    function currentEpoch() external view returns (uint256) { return (block.timestamp - epochGenesis) / EPOCH_DURATION; }
    function pendingEpochReward(address, uint256) external view returns (uint256) { return 0; } // Task 20
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
forge test --match-contract GuardianRegistryInitTest -vvv
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/GuardianRegistry.sol contracts/src/interfaces/IGuardianRegistry.sol contracts/test/GuardianRegistry.t.sol
git commit -m "feat(registry): GuardianRegistry skeleton — UUPS + initialize + storage"
```

---

## Task 5: Guardian stake (`stakeAsGuardian`)

**Files:**
- Modify: `contracts/src/GuardianRegistry.sol`
- Modify: `contracts/test/GuardianRegistry.t.sol`

- [ ] **Step 1: Write failing tests — first stake, top-up, min stake enforcement, agentId binding**

Add test contract `GuardianRegistryStakeTest` with helper `setUp` that mints and approves WOOD to the user. Tests:

```solidity
function test_stakeAsGuardian_firstStake_setsAllFields() public {
    vm.startPrank(alice);
    wood.approve(address(registry), 10_000e18);
    registry.stakeAsGuardian(10_000e18, 42);
    vm.stopPrank();

    assertEq(registry.guardianStake(alice), 10_000e18);
    assertEq(registry.totalGuardianStake(), 10_000e18);
    assertTrue(registry.isActiveGuardian(alice));
    // agentId stored — verify via dedicated view (added below) or event
}

function test_stakeAsGuardian_topUp_accumulates() public {
    vm.startPrank(alice);
    wood.approve(address(registry), 20_000e18);
    registry.stakeAsGuardian(10_000e18, 42);
    registry.stakeAsGuardian(5_000e18, 42); // agentId ignored on top-up
    vm.stopPrank();
    assertEq(registry.guardianStake(alice), 15_000e18);
}

function test_stakeAsGuardian_revertsIfBelowMin() public {
    vm.startPrank(alice);
    wood.approve(address(registry), 1);
    vm.expectRevert(IGuardianRegistry.InsufficientStake.selector);
    registry.stakeAsGuardian(1, 42);
}
```

- [ ] **Step 2: Implement `stakeAsGuardian`**

```solidity
function stakeAsGuardian(uint256 amount, uint256 agentId) external nonReentrant {
    if (paused) revert Paused();
    Guardian storage g = _guardians[msg.sender];
    uint256 newTotal = uint256(g.stakedAmount) + amount;
    if (newTotal < minGuardianStake) revert InsufficientStake();

    wood.safeTransferFrom(msg.sender, address(this), amount);

    bool wasInactive = g.stakedAmount == 0;
    g.stakedAmount = uint128(newTotal);
    if (wasInactive) {
        g.stakedAt = uint64(block.timestamp);
        g.agentId = agentId; // record once; ignored on top-up
        activeGuardianCount += 1;
    }
    totalGuardianStake += amount;
    emit GuardianStaked(msg.sender, amount, agentId);
}
```

- [ ] **Step 3: Run, verify pass**

```bash
forge test --match-contract GuardianRegistryStakeTest -vvv
```

- [ ] **Step 4: Commit**

```bash
git add contracts/src/GuardianRegistry.sol contracts/test/GuardianRegistry.t.sol
git commit -m "feat(registry): stakeAsGuardian with agentId binding"
```

---

## Tasks 6–24: Registry feature build-out

Each task below follows the same shape as Task 5: **red-test → implementation → green-test → commit**. For brevity, I list the spec-anchor, the key test, and the key implementation snippet. Engineer fills in the full test body and any missing tests using the spec §3.1 as the truth.

### Task 6: Guardian unstake flow
**Spec anchor:** §3.1 "Guardian role" — `requestUnstakeGuardian`, `cancelUnstakeGuardian`, `claimUnstakeGuardian`.

Key test: `test_requestUnstake_removesVotingPower` — after request, `isActiveGuardian == false`, `totalGuardianStake` decremented.
Key test: `test_claimUnstake_revertsBeforeCoolDown` — at `stakedAt + coolDownPeriod - 1`, reverts `CooldownNotElapsed`.
Key test: `test_claimUnstake_transfersWoodBack` — at `stakedAt + coolDownPeriod`, returns WOOD.

Key impl: `requestUnstakeGuardian` sets `unstakeRequestedAt = block.timestamp`, subtracts from `totalGuardianStake`, decrements `activeGuardianCount`. `cancelUnstakeGuardian` reverses it (adds back, requires no intervening `claim`). `claimUnstakeGuardian` requires `unstakeRequestedAt != 0 && block.timestamp >= unstakeRequestedAt + coolDownPeriod`; deletes the Guardian struct and transfers WOOD.

Commit: `feat(registry): guardian unstake flow with cool-down`

### Task 7: Owner stake — prepare + cancel
**Spec anchor:** §3.1 "Owner role" — `prepareOwnerStake`, `cancelPreparedStake`.

Key test: `test_prepareOwnerStake_storesPrepared` — `preparedStakeOf(alice) == 10_000e18`, `canCreateVault(alice) == true`.
Key test: `test_cancelPreparedStake_refunds` — refunds WOOD, clears state.
Key test: `test_prepareOwnerStake_revertsIfAlreadyPrepared` — second call reverts (`PreparedStakeAlreadyBound` or similar — pick `PreparedStakeAlreadyBound` but name may be confusing; consider a new error `PreparedStakeAlreadyExists` — add to interface).

Note: add `error PreparedStakeAlreadyExists();` to `IGuardianRegistry` if test dictates it.

Commit: `feat(registry): owner stake prepare + cancel`

### Task 8: Owner stake — bind (onlyFactory) + transferOwnerStakeSlot (onlyFactory)
**Spec anchor:** §3.1 "Factory hooks (onlyFactory)".

Modifier:
```solidity
modifier onlyFactory() { if (msg.sender != factory) revert NotFactory(); _; }
```

Key test: `test_bindOwnerStake_onlyFactory` — unauthorized reverts.
Key test: `test_bindOwnerStake_consumesPrepared` — after bind, `_prepared[owner].bound == true`, `_ownerStakes[vault].stakedAmount` set.
Key test: `test_bindOwnerStake_revertsIfBelowRequiredBond` — mock a vault with TVL that requires more than prepared.
Key test: `test_transferOwnerStakeSlot_reassigns` — after rotate, new owner owns the slot.
Key test: `test_transferOwnerStakeSlot_revertsIfPreviousOwnerStillStaked` — must be slashed/unstaked first.

Commit: `feat(registry): factory-gated owner stake bind and rotate`

### Task 9: Owner unstake flow
**Spec anchor:** §3.1 "Owner role" — `requestUnstakeOwner`, `claimUnstakeOwner`.

Key test: `test_requestUnstakeOwner_revertsIfActiveProposal` — mock governor returning active proposal id for vault → reverts `VaultHasActiveProposal`.
Key test: `test_claimUnstakeOwner_afterCoolDown_transfersWood`.

Commit: `feat(registry): owner unstake flow`

### Task 10: `requiredOwnerBond` with TVL scaling
**Spec anchor:** §3.1 views + §5.

```solidity
function requiredOwnerBond(address vault) public view returns (uint256) {
    uint256 floor = minOwnerStake;
    if (ownerStakeTvlBps == 0) return floor;
    uint256 scaled = (IERC4626(vault).totalAssets() * ownerStakeTvlBps) / 10_000;
    return scaled > floor ? scaled : floor;
}
```

Key test: `test_requiredOwnerBond_zeroBps_returnsFloor`.
Key test: `test_requiredOwnerBond_nonzeroBps_scales` — mock vault returning `totalAssets() = 10_000_000e6` USDC, bps = 50 → bond = 50_000 units (stress the units carefully).

Commit: `feat(registry): requiredOwnerBond with TVL scaling (k=0 default)`

### Task 11: `openReview` + cohort-too-small fallback
**Spec anchor:** §3.1 `openReview` + "Cold-start handling".

Requires a `IGovernorMinimal` interface or mock for reading `getProposal(id).voteEnd`. Since tests can mock, write:

```solidity
interface IGovernorMinimal {
    function getProposal(uint256 proposalId) external view returns (ISyndicateGovernor.StrategyProposal memory);
}
```

Use `IGovernorMinimal(governor).getProposal(id).voteEnd` to gate.

Key test: `test_openReview_revertsBeforeVoteEnd`.
Key test: `test_openReview_snapshotsTotalStakeAtOpen` — after enough guardians stake, `_reviews[id].totalStakeAtOpen == totalGuardianStake`.
Key test: `test_openReview_flagsCohortTooSmall` — total stake < `MIN_COHORT_STAKE_AT_OPEN` → `cohortTooSmall == true`, event emitted.
Key test: `test_openReview_idempotent` — second call is no-op.

Commit: `feat(registry): openReview keeper with cohort-too-small fallback`

### Task 12: `voteOnProposal` — first vote
**Spec anchor:** §3.1 `voteOnProposal` first-vote semantics.

Key test: `test_voteOnProposal_approve_updatesApprovers`.
Key test: `test_voteOnProposal_block_updatesBlockers`.
Key test: `test_voteOnProposal_revertsBeforeReviewOpen`.
Key test: `test_voteOnProposal_revertsAfterReviewEnd`.
Key test: `test_voteOnProposal_revertsIfNotActiveGuardian`.
Key test: `test_voteOnProposal_snapshotsStake`.
Key test: `test_voteOnProposal_capHitEmitsEventAndReverts` — 101st Approve.

Implement `_pushApprover` / `_pushBlocker` helpers writing into the index mappings (1-indexed, 0 = absent).

Commit: `feat(registry): voteOnProposal first vote + approver cap`

### Task 13: `voteOnProposal` — vote change with late-lockout + NewSideFull
**Spec anchor:** §3.1 `voteOnProposal` vote-change semantics + §6 asymmetry note.

Key test: `test_voteChange_approveToBlock_updatesArraysAndTallies`.
Key test: `test_voteChange_sameSide_revertsNoVoteChange`.
Key test: `test_voteChange_inLockoutWindow_reverts` — warp to `reviewEnd - reviewPeriod * 1000 / 10_000 + 1`.
Key test: `test_voteChange_blockToApprove_revertsIfApproverCapFull` — emits `NewSideFull`.

Implement `_removeApprover` / `_removeBlocker` with swap-and-pop + index update.

Commit: `feat(registry): vote-change with late-lockout and NewSideFull`

### Task 14: `resolveReview` + `_slashApprovers` (CEI + pull-burn)
**Spec anchor:** §3.1 `resolveReview` + "Slashing" + §6 "CEI on slash".

Key test: `test_resolveReview_beforeReviewEnd_reverts`.
Key test: `test_resolveReview_noReviewOpened_returnsFalse` — idempotent, no slash.
Key test: `test_resolveReview_quorumReached_slashesApprovers_burnsWood` — verify `wood.balanceOf(BURN_ADDRESS)` increases by slashed total, each approver's `guardianStake` is 0, `resolved` and `blocked` are true.
Key test: `test_resolveReview_cohortTooSmall_returnsFalseEvenWithBlockVotes`.
Key test: `test_resolveReview_idempotent`.

Implement CEI order: compute total, zero stakes + decrement `totalGuardianStake`, then `wood.transfer(BURN_ADDRESS, total)` (wrapped in try/catch — on failure, add to `_pendingBurn[address(this)]` and emit `PendingBurnRecorded`).

Commit: `feat(registry): resolveReview + CEI-compliant _slashApprovers`

### Task 15: `flushBurn` (pull-based fallback)
**Spec anchor:** §3.1 "Slashing" + §6.

Key test: `test_flushBurn_retriesPendingBurn`. Use a mock WOOD that reverts once then succeeds.

Implement:
```solidity
function flushBurn() external nonReentrant {
    uint256 amt = _pendingBurn[address(this)];
    if (amt == 0) return;
    _pendingBurn[address(this)] = 0;
    wood.safeTransfer(BURN_ADDRESS, amt);
    emit BurnFlushed(amt);
}
```

Commit: `feat(registry): flushBurn fallback for stuck slash transfers`

### Task 16: Emergency review — open, vote, resolve, slashOwner
**Spec anchor:** §3.1 `openEmergencyReview`, `voteBlockEmergencySettle`, `resolveEmergencyReview`.

Modifier `onlyGovernor`. `openEmergencyReview` snapshots `totalStakeAtOpen` immediately (no prior votes).

Key test: `test_openEmergencyReview_onlyGovernor`.
Key test: `test_voteBlockEmergencySettle_updatesTally`.
Key test: `test_resolveEmergencyReview_quorumReached_slashesOwner_burnsWood`.
Key test: `test_resolveEmergencyReview_cohortTooSmall_returnsFalse`.

Commit: `feat(registry): emergency review window + owner slashing`

### Task 17: Epoch infrastructure — `currentEpoch`, `fundEpoch`
**Spec anchor:** §3.1 "Reward distribution" + Carlos-third-pass fix.

Key test: `test_fundEpoch_currentEpoch_pullsWood`.
Key test: `test_fundEpoch_pastEpoch_allowedIfBudgetZero`.
Key test: `test_fundEpoch_pastEpoch_revertsIfAlreadyFunded` — second past-epoch call reverts `FundEpochLocked`.
Key test: `test_fundEpoch_onlyOwnerOrMinter`.

Modifier:
```solidity
modifier onlyMinterOrOwner() { if (msg.sender != minter && msg.sender != owner()) revert NotMinterOrOwner(); _; }
```

Implementation of past-epoch guard:
```solidity
uint256 cur = currentEpoch();
if (epochId < cur && epochBudget[epochId] != 0) revert FundEpochLocked();
wood.safeTransferFrom(msg.sender, address(this), amount);
epochBudget[epochId] += amount;
emit EpochFunded(epochId, msg.sender, amount);
```

Commit: `feat(registry): fundEpoch with past-epoch guard on budget-zero`

### Task 18: Block-weight attribution inside `resolveReview`
**Spec anchor:** §3.1 "How blocks accrue weight".

Modify `resolveReview`: after CEI writes, when `blocked == true`, iterate `_blockers[proposalId]`, credit `_voteStake[proposalId][g]` to:
- `epochGuardianBlockWeight[currentEpoch()][g] += _voteStake[proposalId][g]`
- `epochTotalBlockWeight[currentEpoch()] += _voteStake[proposalId][g]`

Note: attribution epoch is `currentEpoch()` at resolve time, NOT `proposal.reviewEnd`.

Key test: `test_resolveReview_blockedProposal_creditsEpochWeight`. Verify the mappings after a resolve, using a known `currentEpoch()`.

Commit: `feat(registry): credit block-weight to epoch on resolve`

### Task 19: `claimEpochReward` with zero-payout revert
**Spec anchor:** §3.1 `claimEpochReward` + Carlos-third-pass fix #2.

```solidity
function claimEpochReward(uint256 epochId) external nonReentrant {
    if (paused) revert Paused();
    uint256 cur = currentEpoch();
    if (epochId >= cur) revert EpochNotEnded();
    if (epochRewardClaimed[epochId][msg.sender]) revert NothingToClaim();

    uint256 weight = epochGuardianBlockWeight[epochId][msg.sender];
    uint256 total = epochTotalBlockWeight[epochId];
    uint256 budget = epochBudget[epochId];
    uint256 payout = (weight == 0 || total == 0) ? 0 : (budget * weight) / total;
    if (payout == 0) revert NothingToClaim(); // critical: revert on payout=0, not just weight=0

    epochRewardClaimed[epochId][msg.sender] = true; // CEI before transfer
    wood.safeTransfer(msg.sender, payout);
    emit EpochRewardClaimed(epochId, msg.sender, payout);
}
```

Key test: `test_claimEpochReward_revertsIfUnfunded` — weight > 0 but budget = 0 → `NothingToClaim`. Guardian must be able to claim LATER after funding lands.
Key test: `test_claimEpochReward_happy_paysProRata`.
Key test: `test_claimEpochReward_doubleClaim_reverts`.
Key test: `test_claimEpochReward_beforeEpochEnds_reverts`.

Commit: `feat(registry): claimEpochReward with zero-payout revert`

### Task 20: `sweepUnclaimed` (12w delay, permissionless)
**Spec anchor:** §3.1 "Unclaimed budget".

Key test: `test_sweepUnclaimed_revertsBeforeDelay`.
Key test: `test_sweepUnclaimed_permissionless`.
Key test: `test_sweepUnclaimed_moveBudgetToCurrentEpoch`.

Implementation:
```solidity
function sweepUnclaimed(uint256 epochId) external nonReentrant {
    uint256 epochEnd = epochGenesis + (epochId + 1) * EPOCH_DURATION;
    if (block.timestamp < epochEnd + SWEEP_DELAY) revert SweepTooEarly();
    uint256 residual = epochBudget[epochId];
    if (residual == 0) return;
    uint256 to = currentEpoch();
    epochBudget[epochId] = 0;
    epochBudget[to] += residual;
    emit EpochUnclaimedSwept(epochId, to, residual);
}
```

Note: residual computation should subtract already-claimed amounts. Simpler approach: keep `epochBudget` authoritative and decrement it inside `claimEpochReward` by `payout`. Update Task 19 accordingly.

Commit: `feat(registry): sweepUnclaimed after 12-week delay`

### Task 21: Slash Appeal Reserve + `refundSlash` (20% cap)
**Spec anchor:** §3.1 "Appeal path" + §7.2.

Key test: `test_refundSlash_onlyOwner`.
Key test: `test_refundSlash_enforcesEpochCap` — two refunds in same epoch whose sum exceeds 20% of reserve → second reverts `RefundCapExceeded`.
Key test: `test_refundSlash_capResetsNextEpoch`.

Implementation:
```solidity
function fundSlashAppealReserve(uint256 amount) external nonReentrant onlyOwner {
    wood.safeTransferFrom(msg.sender, address(this), amount);
    slashAppealReserve += amount;
    emit SlashAppealReserveFunded(msg.sender, amount);
}

function refundSlash(address recipient, uint256 amount) external nonReentrant onlyOwner {
    if (recipient == address(0)) revert ZeroAddress();
    uint256 cap = (slashAppealReserve * MAX_REFUND_PER_EPOCH_BPS) / 10_000;
    uint256 ep = currentEpoch();
    if (refundedInEpoch[ep] + amount > cap) revert RefundCapExceeded();
    refundedInEpoch[ep] += amount;
    slashAppealReserve -= amount;
    wood.safeTransfer(recipient, amount);
    emit SlashAppealRefunded(recipient, amount, ep);
}
```

Commit: `feat(registry): slash appeal reserve with 20% per-epoch cap`

### Task 22: Pause + deadman auto-unpause
**Spec anchor:** §3.1 "Circuit breaker".

Modifier:
```solidity
modifier whenNotPaused() { if (paused) revert Paused(); _; }
```

Apply to: `voteOnProposal`, `openReview`, `resolveReview`, `resolveEmergencyReview`, `voteBlockEmergencySettle`, `claimEpochReward`, `flushBurn`, and the slashing call sites. Explicitly NOT applied to: `stakeAsGuardian`, `requestUnstake*`, `claimUnstake*`, `prepareOwnerStake`, `cancelPreparedStake`.

Key test: `test_pause_freezesVoteOnProposal`.
Key test: `test_pause_doesNotFreezeClaimUnstake` — exit paths remain available.
Key test: `test_deadman_allowsAnyAddressToUnpauseAfter7Days`.

Implementation:
```solidity
function pause() external onlyOwner {
    paused = true;
    pausedAt = uint64(block.timestamp);
    emit Paused(msg.sender);
}

function unpause() external {
    if (!paused) revert NotPausedOrDeadmanNotElapsed();
    bool deadman = msg.sender != owner();
    if (deadman && block.timestamp < pausedAt + DEADMAN_UNPAUSE_DELAY) revert NotPausedOrDeadmanNotElapsed();
    paused = false;
    pausedAt = 0;
    emit Unpaused(msg.sender, deadman);
}
```

Commit: `feat(registry): pause + 7-day deadman auto-unpause`

### Task 23: Parameter setters (timelocked)
**Spec anchor:** §3.1 "Parameter setters".

Reuse the queue/finalize pattern from `GovernorParameters.sol`. Add:
```solidity
bytes32 constant PARAM_MIN_GUARDIAN_STAKE = keccak256("minGuardianStake");
// ... one per parameter

function _queueChange(bytes32 key, uint256 newValue) internal { /* same as GovernorParameters */ }
function finalizeParameterChange(bytes32 key) external onlyOwner { /* same */ }
function cancelParameterChange(bytes32 key) external onlyOwner { /* same */ }
```

Each setter (e.g. `setMinGuardianStake`) validates bounds then calls `_queueChange`.

`setMinter` is timelocked separately (single address, not numeric).

Key test: `test_setMinGuardianStake_queuesAndFinalizes` — can't take effect immediately, must wait `parameterChangeDelay`.

Commit: `feat(registry): timelocked parameter setters`

### Task 24: `GovernorEmergency` — full implementation
**Spec anchor:** §3.1 emergency + §3.2 emergency split.

Replace the Task 2 stubs with full bodies:

```solidity
function unstick(uint256 proposalId) external override emergencyNonReentrant {
    StrategyProposal storage p = _getProposal(proposalId);
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
    if (block.timestamp < p.executedAt + p.strategyDuration) revert StrategyDurationNotElapsed();
    // Note: does NOT require active owner stake — pre-committed calls were governance-approved.
    ISyndicateVault(p.vault).executeGovernorBatch(_getSettlementCalls(proposalId));
    _finishSettlementHook(proposalId, p);  // virtual — implemented in SyndicateGovernor
}

function emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external override emergencyNonReentrant {
    StrategyProposal storage p = _getProposal(proposalId);
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
    if (block.timestamp < p.executedAt + p.strategyDuration) revert StrategyDurationNotElapsed();
    IGuardianRegistry reg = _getRegistry();
    if (reg.ownerStake(p.vault) < reg.requiredOwnerBond(p.vault)) revert OwnerBondInsufficient();

    bytes32 h = keccak256(abi.encode(calls));
    _storeEmergencyCalls(proposalId, calls);  // virtual
    reg.openEmergencyReview(proposalId, h);
    emit EmergencySettleProposed(proposalId, msg.sender, h, uint64(block.timestamp + reg.reviewPeriod()));
}

function cancelEmergencySettle(uint256 proposalId) external override emergencyNonReentrant {
    StrategyProposal storage p = _getProposal(proposalId);
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    _clearEmergencyCalls(proposalId);  // virtual
    emit EmergencySettleCancelled(proposalId, msg.sender);
}

function finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external override emergencyNonReentrant {
    StrategyProposal storage p = _getProposal(proposalId);
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    bytes32 committed = _getEmergencyCallsHash(proposalId);  // virtual
    if (keccak256(abi.encode(calls)) != committed) revert EmergencySettleMismatch();

    IGuardianRegistry reg = _getRegistry();
    bool blocked = reg.resolveEmergencyReview(proposalId);
    if (blocked) revert EmergencySettleBlocked();

    ISyndicateVault(p.vault).executeGovernorBatch(calls);
    (int256 pnl,) = _finishSettlementHook(proposalId, p);  // virtual — see override in SyndicateGovernor
    emit EmergencySettleFinalized(proposalId, pnl);
}
```

Add virtual accessors in `GovernorEmergency` (all distinct names from the governor's concrete `_finishSettlement` to avoid override clash):
- `function _storeEmergencyCalls(uint256, BatchExecutorLib.Call[] calldata) internal virtual;`
- `function _clearEmergencyCalls(uint256) internal virtual;`
- `function _getEmergencyCallsHash(uint256) internal view virtual returns (bytes32);`
- `function _finishSettlementHook(uint256, StrategyProposal storage) internal virtual returns (int256 pnl, uint256 totalFee);`  — SyndicateGovernor's override calls its existing internal `_finishSettlement` (name preserved on the governor side).

Key test in `EmergencySettleReview.t.sol` (integration):
- `test_emergencySettleBlocked_reverts_ownerSlashed`
- `test_emergencySettleApproved_executes`
- `test_cancelEmergencySettle_allowsRetry`
- `test_emergencySettleInsufficientBond_reverts`

Commit: `feat(governor): GovernorEmergency full implementation`

---

## Task 25: SyndicateGovernor — GuardianReview lifecycle integration

**Spec anchor:** §3.2 governor modifications.

**Files:**
- Modify: `contracts/src/SyndicateGovernor.sol`
- Modify: `contracts/src/interfaces/ISyndicateGovernor.sol`

- [ ] **Step 1: Update ISyndicateGovernor**

- Insert `GuardianReview` between `Pending` and `Approved` in `ProposalState`.
- Add `uint256 reviewEnd` field to `StrategyProposal`.
- Add errors: `NotInGuardianReview`, `EmergencySettleBlocked`, `EmergencySettleNotReady`, `EmergencySettleMismatch`, `RegistryNotSet`, `OwnerBondInsufficient`, `RegistryMismatch`.
- Add events: `GuardianReviewResolved`, `EmergencySettleProposed`, `EmergencySettleCancelled`, `EmergencySettleFinalized`.
- Remove `emergencySettle` from interface (already removed from code in Task 2).
- Add: `unstick`, `emergencySettleWithCalls`, `cancelEmergencySettle`, `finalizeEmergencySettle`, `guardianRegistry()` view.

- [ ] **Step 2: Write failing test — full happy-path lifecycle**

In new file `contracts/test/governor/GuardianReviewLifecycle.t.sol`:

```solidity
function test_lifecycle_happyPath_proposalSurvivesReview_executes_settles() public {
    // 1. Guardians stake to form cohort ≥ MIN_COHORT_STAKE_AT_OPEN
    _stakeCohort(10, 10_000e18); // helper

    // 2. Agent proposes
    uint256 pid = _propose();  // helper

    // 3. Voting period elapses, no veto
    vm.warp(block.timestamp + votingPeriod + 1);

    // 4. Keeper calls openReview
    registry.openReview(pid);

    // 5. Guardians vote (majority Approve)
    _guardianVote(pid, 8, GuardianVoteType.Approve);
    _guardianVote(pid, 2, GuardianVoteType.Block);

    // 6. Review period elapses
    vm.warp(block.timestamp + reviewPeriod + 1);

    // 7. Anyone calls executeProposal — resolveReview is called inside _resolveState
    vm.prank(proposer);
    governor.executeProposal(pid);

    // 8. Proposal.state == Executed
    assertEq(uint8(governor.getProposal(pid).state), uint8(ProposalState.Executed));

    // 9. Settle normally
    vm.warp(block.timestamp + strategyDuration + 1);
    governor.settleProposal(pid);
    assertEq(uint8(governor.getProposal(pid).state), uint8(ProposalState.Settled));
}
```

- [ ] **Step 3: Modify `SyndicateGovernor.propose()` to stamp `reviewEnd`**

In `SyndicateGovernor.sol` `propose()` body (immediately after Task 0's sequential assignments):

```solidity
uint256 reviewEndValue = isCollaborative ? 0 : block.timestamp + _params.votingPeriod + _getRegistry().reviewPeriod();
p.reviewEnd = reviewEndValue;
p.executeBy = isCollaborative ? 0 : reviewEndValue + _params.executionWindow;
```

Similarly stamp `reviewEnd` in `approveCollaboration()` when transitioning Draft → Pending.

- [ ] **Step 4: Update `_resolveStateView` (non-mutating)**

```solidity
function _resolveStateView(StrategyProposal storage proposal) internal view returns (ProposalState) {
    ProposalState stored = proposal.state;
    // ... existing Draft / Pending-before-voteEnd logic ...

    if (stored == ProposalState.Pending && block.timestamp > proposal.voteEnd) {
        // Check veto first (unchanged)
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
        uint256 vetoThreshold = (pastTotalSupply * _params.vetoThresholdBps) / 10_000;
        if (proposal.votesAgainst >= vetoThreshold) return ProposalState.Rejected;

        // Voting passed — check guardian review
        if (block.timestamp <= proposal.reviewEnd) return ProposalState.GuardianReview;

        // Review ended — read cached resolution (view-only)
        IGuardianRegistry.Review memory r = _getRegistry().getReview(proposal.id);  // need view getter
        if (!r.resolved) return ProposalState.GuardianReview; // resolution pending — caller must mutate
        if (r.blocked) return ProposalState.Rejected;
        return block.timestamp > proposal.executeBy ? ProposalState.Expired : ProposalState.Approved;
    }
    // ... rest ...
}
```

Note: This requires a `getReview(uint256)` view on the registry returning a struct. Add to `IGuardianRegistry`.

- [ ] **Step 5: Update `_resolveState` (mutating) to drive resolution**

```solidity
function _resolveState(StrategyProposal storage proposal) internal returns (ProposalState) {
    ProposalState current = _resolveStateView(proposal);
    if (current == ProposalState.GuardianReview && block.timestamp > proposal.reviewEnd) {
        // Force resolution
        bool blocked = _getRegistry().resolveReview(proposal.id);
        current = blocked ? ProposalState.Rejected : ProposalState.Approved;
    }
    if (current != proposal.state) proposal.state = current;
    return current;
}
```

- [ ] **Step 6: Narrow `vetoProposal` to `Pending` only**

```solidity
function vetoProposal(uint256 proposalId) external {
    StrategyProposal storage p = _proposals[proposalId];
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    ProposalState cur = _resolveState(p);
    if (cur != ProposalState.Pending) revert ProposalNotCancellable();
    p.state = ProposalState.Rejected;
    emit ProposalVetoed(proposalId, msg.sender);
}
```

- [ ] **Step 7: Narrow `emergencyCancel` to `Draft`/`Pending` only**

```solidity
function emergencyCancel(uint256 proposalId) external {
    StrategyProposal storage p = _proposals[proposalId];
    if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
    ProposalState cur = _resolveState(p);
    if (cur != ProposalState.Pending && cur != ProposalState.Draft) revert ProposalNotCancellable();
    p.state = ProposalState.Cancelled;
    delete _activeProposal[p.vault];
    emit ProposalCancelled(proposalId, msg.sender);
}
```

- [ ] **Step 8: Implement GovernorEmergency virtual accessors in SyndicateGovernor**

Add storage:
```solidity
mapping(uint256 => bytes32) internal _emergencyCallsHashes;
mapping(uint256 => BatchExecutorLib.Call[]) internal _emergencyCalls;
```

Implement:
```solidity
function _storeEmergencyCalls(uint256 id, BatchExecutorLib.Call[] calldata calls) internal override {
    _emergencyCallsHashes[id] = keccak256(abi.encode(calls));
    delete _emergencyCalls[id];
    for (uint i = 0; i < calls.length; i++) _emergencyCalls[id].push(calls[i]);
}
function _clearEmergencyCalls(uint256 id) internal override {
    delete _emergencyCallsHashes[id];
    delete _emergencyCalls[id];
}
function _getEmergencyCallsHash(uint256 id) internal view override returns (bytes32) { return _emergencyCallsHashes[id]; }
function _finishSettlementHook(uint256 id, StrategyProposal storage p) internal override returns (int256, uint256) {
    return _finishSettlement(id, p);  // delegates to governor's existing internal _finishSettlement
}
```

No rename of `_finishSettlement` is needed — the governor keeps its existing function; the hook is a separate virtual name on the abstract.

- [ ] **Step 9: Add `setGuardianRegistry(address)` one-time setter callable only during init**

Already set in Task 2 via `_guardianRegistry`. Expose a view: `function guardianRegistry() external view returns (address) { return _guardianRegistry; }`.

The initializer gains a `guardianRegistry` parameter:
```solidity
function initialize(InitParams memory p, address guardianRegistry_) external initializer {
    if (guardianRegistry_ == address(0)) revert RegistryNotSet();
    _guardianRegistry = guardianRegistry_;
    // ... existing init ...
}
```

- [ ] **Step 10: Run lifecycle test, verify pass**

```bash
forge test --match-contract GuardianReviewLifecycleTest -vvv
```

- [ ] **Step 11: Verify CI size gate**

```bash
forge build --sizes | grep SyndicateGovernor
```

Expected: under 24,400.

- [ ] **Step 12: Commit**

```bash
git add contracts/src/SyndicateGovernor.sol contracts/src/interfaces/ISyndicateGovernor.sol contracts/test/governor/GuardianReviewLifecycle.t.sol
git commit -m "feat(governor): insert GuardianReview state + stamp reviewEnd + narrow veto/cancel"
```

---

## Task 26: SyndicateFactory — guardianRegistry set-once + createSyndicate binding + rotateOwner

**Spec anchor:** §3.3.

**Files:**
- Modify: `contracts/src/SyndicateFactory.sol`
- Modify: `contracts/src/interfaces/ISyndicateFactory.sol`
- Create: `contracts/test/factory/OwnerStakeAtCreation.t.sol`

- [ ] **Step 1: Add `guardianRegistry` storage + initializer param**

```solidity
address public guardianRegistry;  // set-once at initialize; no setter
```

Initializer receives and sets it; no `setGuardianRegistry` function anywhere.

- [ ] **Step 2: Update `createSyndicate` to call registry**

```solidity
function createSyndicate(SyndicateConfig calldata cfg, uint256 creatorAgentId) external returns (uint256 id, address vault) {
    if (!IGuardianRegistry(guardianRegistry).canCreateVault(msg.sender)) revert PreparedStakeNotFound();
    // ... existing deploy logic ...
    IGuardianRegistry(guardianRegistry).bindOwnerStake(msg.sender, vault);
    // ...
}
```

- [ ] **Step 3: Add `rotateOwner` with timelock + RegistryMismatch assert**

```solidity
function rotateOwner(address vault, address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert ZeroAddress();
    if (IGuardianRegistry(guardianRegistry).hasOwnerStake(vault)) revert VaultStillStaked();
    // Registry consistency
    if (ISyndicateGovernor(governor).guardianRegistry() != guardianRegistry) revert RegistryMismatch();
    SyndicateVault(vault).transferOwnership(newOwner);
    IGuardianRegistry(guardianRegistry).transferOwnerStakeSlot(vault, newOwner);
    emit OwnerRotated(vault, newOwner);
}
```

Add timelock via the existing pending-change pattern (or a simpler `proposeRotateOwner` + `executeRotateOwner` with delay).

- [ ] **Step 4: Write tests**

Key tests:
- `test_createSyndicate_revertsIfNoPreparedStake`
- `test_createSyndicate_bindsPreparedStakeAtomic`
- `test_rotateOwner_onlyOwner`
- `test_rotateOwner_revertsIfOldOwnerStillStaked`
- `test_rotateOwner_revertsOnRegistryMismatch`

- [ ] **Step 5: Commit**

```bash
git add contracts/src/SyndicateFactory.sol contracts/src/interfaces/ISyndicateFactory.sol contracts/test/factory/OwnerStakeAtCreation.t.sol
git commit -m "feat(factory): guardianRegistry set-once, createSyndicate bond binding, rotateOwner"
```

---

## Task 27: Integration tests — block quorum + emergency settle + pause

**Files:**
- Expand: `contracts/test/governor/GuardianReviewLifecycle.t.sol`
- Expand: `contracts/test/governor/EmergencySettleReview.t.sol`

- [ ] **Step 1: Block-quorum rejection + slashing**

```solidity
function test_blockQuorum_rejectsProposal_slashesApprovers() public {
    _stakeCohort(10, 10_000e18);
    uint256 pid = _propose();
    vm.warp(block.timestamp + votingPeriod + 1);
    registry.openReview(pid);
    _guardianVote(pid, 3, GuardianVoteType.Approve);  // will be slashed
    _guardianVote(pid, 5, GuardianVoteType.Block);     // 50% > 30% quorum
    vm.warp(block.timestamp + reviewPeriod + 1);

    bool blocked = registry.resolveReview(pid);
    assertTrue(blocked);
    for (uint i = 0; i < 3; i++) assertEq(registry.guardianStake(_approvers[i]), 0);
    assertGt(wood.balanceOf(registry.BURN_ADDRESS()), 0);
    assertEq(uint8(governor.getProposal(pid).state), uint8(ProposalState.Rejected));
}
```

- [ ] **Step 2: Emergency settle — blocked → owner slashed**

```solidity
function test_emergencySettle_guardiansBlock_ownerSlashed() public {
    // setup: executed proposal, owner stake present
    uint256 pid = _proposalInExecutedState();
    vm.warp(block.timestamp + strategyDuration + 1);

    BatchExecutorLib.Call[] memory bad = _maliciousCalls();
    vm.prank(vaultOwner);
    governor.emergencySettleWithCalls(pid, bad);

    // guardians block
    _stakeCohort(10, 10_000e18);
    _emergencyBlock(pid, 5);

    // 24h later owner tries to finalize
    vm.warp(block.timestamp + reviewPeriod + 1);
    vm.expectRevert(ISyndicateGovernor.EmergencySettleBlocked.selector);
    vm.prank(vaultOwner);
    governor.finalizeEmergencySettle(pid, bad);

    assertEq(registry.ownerStake(address(vault)), 0); // slashed
}
```

- [ ] **Step 3: Pause + deadman**

```solidity
function test_pause_deadmanUnpause() public {
    vm.prank(registry.owner());
    registry.pause();

    vm.expectRevert(IGuardianRegistry.Paused.selector);
    registry.voteOnProposal(1, GuardianVoteType.Approve);

    vm.warp(block.timestamp + 7 days + 1);
    vm.prank(address(0xB0B));
    registry.unpause();
    assertFalse(registry.paused());
}
```

- [ ] **Step 4: Run, verify pass**

```bash
forge test --match-path "contracts/test/governor/*" -vvv
```

- [ ] **Step 5: Commit**

```bash
git add contracts/test/governor/
git commit -m "test(governor): integration tests for block quorum, emergency settle, pause"
```

---

## Task 28: Invariant harness

**Spec anchor:** §8 + #226 §8 priority invariants INV-2, -3, -11, -15, -23.

**Files:**
- Create: `contracts/test/invariants/GuardianInvariants.t.sol`
- Create: `contracts/test/invariants/handlers/GuardianHandler.sol`

- [ ] **Step 1: Handler with bounded fuzz actions**

Handler exposes: `stake`, `unstake`, `vote`, `openReview`, `resolveReview`, `fundEpoch`, `claim`, `warpToVoteEnd`, etc.

- [ ] **Step 2: Define invariants**

```solidity
/// INV-STAKE-CONSERVATION: WOOD in registry == sum(guardian) + sum(owner) + sum(prepared) + appealReserve + sum(epochBudget)
function invariant_woodConservation() public { ... }

/// INV-APPROVER-EXCLUSION: every approver is NOT in blockers for the same proposal
function invariant_noDoubleSideVote() public { ... }

/// INV-QUORUM-COMPLETENESS: approveStakeWeight + blockStakeWeight <= totalStakeAtOpen
function invariant_voteWeightBounded() public { ... }

/// INV-SLASH-CONSISTENCY: every slashed guardian has stakedAmount == 0
function invariant_slashedGuardiansZero() public { ... }

/// INV-EPOCH-WEIGHT-MONOTONE: epochTotalBlockWeight[e] is monotone non-decreasing within an epoch
function invariant_epochWeightMonotone() public { ... }
```

- [ ] **Step 3: Run**

```bash
forge test --match-contract GuardianInvariants -vvv --fuzz-runs 256
```

- [ ] **Step 4: Commit**

```bash
git add contracts/test/invariants/
git commit -m "test(registry): invariant harness (5 priority invariants)"
```

---

## Task 29: Deployment script

**Files:**
- Modify: `contracts/script/Deploy.s.sol`
- Modify: `contracts/script/ScriptBase.sol` (+helper for GUARDIAN_REGISTRY)

- [ ] **Step 1: Deploy GuardianRegistry behind UUPS proxy**

```solidity
function _deployGuardianRegistry(
    address owner_, address governor_, address factory_, address wood_
) internal returns (address) {
    GuardianRegistry impl = new GuardianRegistry();
    bytes memory initData = abi.encodeCall(GuardianRegistry.initialize, (
        owner_, governor_, factory_, wood_,
        10_000e18,   // minGuardianStake
        10_000e18,   // minOwnerStake
        0,           // ownerStakeTvlBps (disabled)
        7 days,      // coolDownPeriod
        24 hours,    // reviewPeriod
        3000         // blockQuorumBps (30%)
    ));
    address proxy = address(new ERC1967Proxy(address(impl), initData));
    _writeAddress("GUARDIAN_REGISTRY", proxy);
    return proxy;
}
```

- [ ] **Step 2: Sequence the deployment**

Circular dependency: governor and factory need `guardianRegistry` at init; registry needs `governor` and `factory` at init; and all three are set-once (no setters). Resolve with deterministic address prediction using `vm.computeCreateAddress(deployer, nonce)`:

```solidity
function _predictAddress(address deployer, uint256 nonce) internal pure returns (address) {
    return vm.computeCreateAddress(deployer, nonce);
}

function run() external {
    address deployer = msg.sender;
    uint256 n = vm.getNonce(deployer);

    // Predict proxy addresses (each `new ERC1967Proxy(...)` increments nonce by 1;
    // each `new Contract()` for impls also increments)
    // Order the `new` calls to match the predictions below.

    // n+0: GuardianRegistry impl
    // n+1: SyndicateGovernor impl
    // n+2: SyndicateFactory impl
    // n+3: GuardianRegistry proxy
    // n+4: SyndicateGovernor proxy
    // n+5: SyndicateFactory proxy

    address registryProxyPredicted = _predictAddress(deployer, n + 3);
    address governorProxyPredicted = _predictAddress(deployer, n + 4);
    address factoryProxyPredicted  = _predictAddress(deployer, n + 5);

    // Impls (nonces n, n+1, n+2)
    GuardianRegistry regImpl = new GuardianRegistry();
    SyndicateGovernor govImpl = new SyndicateGovernor();
    SyndicateFactory facImpl = new SyndicateFactory();

    // Proxy n+3: registry — references governorProxyPredicted, factoryProxyPredicted
    ERC1967Proxy regProxy = new ERC1967Proxy(
        address(regImpl),
        abi.encodeCall(GuardianRegistry.initialize, (
            deployer, governorProxyPredicted, factoryProxyPredicted, address(wood),
            10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000
        ))
    );
    require(address(regProxy) == registryProxyPredicted, "registry addr mismatch");

    // Proxy n+4: governor — references registryProxyPredicted (now deployed)
    ERC1967Proxy govProxy = new ERC1967Proxy(
        address(govImpl),
        abi.encodeCall(SyndicateGovernor.initialize, (governorInitParams, registryProxyPredicted))
    );
    require(address(govProxy) == governorProxyPredicted, "governor addr mismatch");

    // Proxy n+5: factory — references registryProxyPredicted
    ERC1967Proxy facProxy = new ERC1967Proxy(
        address(facImpl),
        abi.encodeCall(SyndicateFactory.initialize, (factoryInitParams, registryProxyPredicted))
    );
    require(address(facProxy) == factoryProxyPredicted, "factory addr mismatch");

    _writeAddress("GUARDIAN_REGISTRY", address(regProxy));
    _writeAddress("SYNDICATE_GOVERNOR", address(govProxy));
    _writeAddress("SYNDICATE_FACTORY", address(facProxy));
}
```

The three `require` checks make the deployment script fail loudly if the address prediction is off (e.g. due to an extra CREATE the engineer didn't account for). If Foundry's script-runner inserts extra creates via libraries or something else, increase nonce offsets accordingly and re-test.

- [ ] **Step 3: Seed initial Slash Appeal Reserve + guardian cohort**

```solidity
function _seedProtocol() internal {
    // Fund slash appeal reserve
    wood.approve(guardianRegistry, 1_000_000e18);
    GuardianRegistry(guardianRegistry).fundSlashAppealReserve(1_000_000e18);

    // Fund first epoch
    wood.approve(guardianRegistry, 10_000e18);
    GuardianRegistry(guardianRegistry).fundEpoch(0, 10_000e18);

    // Note: protocol multisig registers as guardian-of-last-resort separately via stakeAsGuardian
}
```

- [ ] **Step 4: Run against a fork**

```bash
forge script script/Deploy.s.sol --fork-url $BASE_RPC_URL -vvv
```

- [ ] **Step 5: Commit**

```bash
git add contracts/script/
git commit -m "feat(deploy): deploy GuardianRegistry + wire governor/factory"
```

---

## Task 30: Docs sync + punch-list close

**Files:**
- Modify: `docs/pre-mainnet-punchlist.md` (mark rows closed)
- Modify: `CLAUDE.md` (remove "Designed not-yet-implemented" entries now live)
- Modify: `docs/governor-architecture.md` (drop drift banner for items now fixed)
- Modify: `docs/contracts.md` (add deployed `GuardianRegistry` address when on testnet)

- [ ] **Step 1: Punch list — mark closed**

In `docs/pre-mainnet-punchlist.md` §2:
- G-C4 → ✅ fixed-by-229 (link to this PR)
- #226 §2.6 → ✅
- #226 §2.10 → ✅

Add any V- / G- rows this plan addressed (V-C3 owner executeBatch bypass is out of scope — stays open; G-C6 `nonReentrant` partial — note `voteOnProposal` and others now have it).

- [ ] **Step 2: CLAUDE.md**

Move items from "Designed, not yet implemented (PR #229)" to "Architecture" bullets (strike the "once PR #229 lands" clauses — it has landed).

- [ ] **Step 3: governor-architecture.md**

Remove the known-drift banner entries for GuardianReview/reviewEnd/emergencySettle (they're no longer drifts). Keep entries still valid (capitalRequired, splitIndex — separate punch-list items).

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: sync guardian review lifecycle post-implementation, close punch-list rows"
```

---

## Self-review checklist

Before opening a PR:

- [ ] `forge build --sizes` shows `SyndicateGovernor` ≤ 24,400 bytes
- [ ] `forge test` all passing
- [ ] `forge coverage` runs without stack-too-deep; `GuardianRegistry` coverage ≥ 90%
- [ ] Invariant harness (Task 28) passes 256 runs with no counterexamples
- [ ] No `revert()` stubs remaining in `GuardianRegistry.sol` or `GovernorEmergency.sol`
- [ ] Every spec §3 function has a corresponding test
- [ ] Deployment script dry-run succeeds on a fork
- [ ] `docs/pre-mainnet-punchlist.md` rows marked with PR link
- [ ] CHANGELOG entry in `docs/roadmap.md` under "2026-04-XX"

---

## Out of scope for this plan (separate PRs)

Per spec §12 and `docs/pre-mainnet-punchlist.md`:
- Correct-Approve rewards + EAS attestations (V1.5)
- Minter emissions → `fundEpoch` wiring (V1.5)
- LLM knowledge base for guardian skill (V1.5)
- Shareholder challenge (Option C)
- Vault-asset slash redirect (V2)
- Guardian reputation decay (V2)
- Hermes guardian skill runtime
- Every ref code in punch list §3 not listed as fixed-by-229

Each of these is its own plan + PR. This plan is V1 guardian primitives only.
