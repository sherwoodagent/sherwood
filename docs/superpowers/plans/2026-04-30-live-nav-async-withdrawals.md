# Live-NAV + Async-Withdrawal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two gaps vs. Concrete: (Phase 1) let LPs queue redemptions during an active proposal, drained automatically post-settle; (Phase 2) expose live per-strategy NAV through `BaseStrategy.positionValue()` so vault `totalAssets()` is correct mid-strategy and deposit/withdraw can stay open when the active strategy reports live NAV.

**Architecture:**

- Phase 1 ships a per-vault `VaultWithdrawalQueue` (share-escrow, FIFO, share-burn at fill). Users transfer shares to the queue while `redemptionsLocked()`; anyone calls `claim()` after settle and the queue redeems at the post-settle NAV. Deposits stay locked during active proposals — governance integrity unchanged.
- Phase 2 adds an `_activeStrategyAdapter` slot on the vault, populated by `SyndicateGovernor.executeProposal` when a proposal binds an `IStrategy` clone. `SyndicateVault.totalAssets()` becomes `float + adapter.positionValue()` when the adapter reports `valid=true`. When valid, deposits and standard withdrawals are unlocked; when invalid (Mamo/Venice/off-chain), the vault falls back to Phase 1 queue behavior.
- No storage layout changes for live mainnet vaults: V1.5 is a fresh redeployment so we append slots. New errors and events are additive.

**Tech Stack:** Solidity 0.8.28, Foundry, OpenZeppelin upgradeable v5 (UUPS, ERC4626, ERC20Votes), `via_ir = true`, ReentrancyGuardTransient.

**Spec reference:** `docs/superpowers/specs/2026-04-30-live-nav-async-withdrawals-design.md` (created in Task 0). Competitor analysis: Concrete `ConcreteMultiStrategyVault.totalAssets()` polls per-adapter `convertToAssets(strategy.balanceOf(vault))`; their `WithdrawalQueue.requestWithdrawal` is a Lido-fork. We adopt the same shape but bind it to our proposal lifecycle instead of an owner-finalized epoch.

---

## File Structure

**New:**
- `contracts/src/queue/VaultWithdrawalQueue.sol` — per-vault share-escrow queue. ~200 LoC.
- `contracts/src/interfaces/IVaultWithdrawalQueue.sol` — interface + structs + errors.
- `contracts/test/queue/VaultWithdrawalQueue.t.sol` — unit tests.
- `contracts/test/SyndicateVault.AsyncRedeem.t.sol` — vault↔queue integration (Phase 1).
- `contracts/test/SyndicateVault.LiveNAV.t.sol` — NAV aggregation + open-deposit-during-strategy tests (Phase 2).
- `docs/superpowers/specs/2026-04-30-live-nav-async-withdrawals-design.md` — design doc.

**Modified:**
- `contracts/src/SyndicateVault.sol` — adds `_withdrawalQueue` storage, `requestRedeem` / `claimRedeem` external, `setWithdrawalQueue` admin, `_activeStrategyAdapter` (Phase 2), `totalAssets` override (Phase 2), `maxDeposit` / `maxWithdraw` overrides, gates queue reservation in `_withdraw`.
- `contracts/src/SyndicateGovernor.sol` — adds optional `strategyAdapter` field on `StrategyProposal`, sets/clears `vault._activeStrategyAdapter` in `executeProposal` / `_finishSettlement`.
- `contracts/src/strategies/BaseStrategy.sol` — no behavior change; promote `positionValue()` semantics in NatSpec only.
- `contracts/src/interfaces/ISyndicateVault.sol` — add new errors, events, function signatures.
- `contracts/src/interfaces/ISyndicateGovernor.sol` — add `strategyAdapter` to `StrategyProposal` (only for proposals using the adapter rail; `address(0)` for batch-only proposals).
- `contracts/src/SyndicateFactory.sol` — deploy queue alongside vault and bind via `setWithdrawalQueue` in the same tx.
- `CLAUDE.md` — document the new lock semantics under "Architecture" / "Governor Key Concepts".

---

## Self-contained worktree

Run all tasks on branch `feat/live-nav-async-withdrawals`. Phase 1 must be fully green before Phase 2 starts so we can ship them as separate PRs (or stop after Phase 1).

---

# Phase 0 — Spec & Branch Setup

### Task 0: Spec doc + branch

**Files:**
- Create: `docs/superpowers/specs/2026-04-30-live-nav-async-withdrawals-design.md`

- [ ] **Step 1:** Create branch
```bash
git stash -u || true
git checkout -b feat/live-nav-async-withdrawals origin/main
```

- [ ] **Step 2:** Write the design doc (use the "Architecture" section above as the body, expand with: lock-state truth table, queue lifecycle diagram, NAV math, fallback to queue when adapter is invalid, list of strategies that DO and DO NOT support live NAV today). Save to the path above.

- [ ] **Step 3:** Commit
```bash
git add docs/superpowers/specs/2026-04-30-live-nav-async-withdrawals-design.md
git commit -m "docs: spec for live-NAV + async-withdrawal queue"
```

---

# Phase 1 — Async Withdrawal Queue

## Task 1: IVaultWithdrawalQueue interface

**Files:**
- Create: `contracts/src/interfaces/IVaultWithdrawalQueue.sol`

- [ ] **Step 1: Write the interface**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVaultWithdrawalQueue {
    // ── Errors ──
    error NotVault();
    error NotQueueOwner();
    error AlreadyClaimed();
    error AlreadyCancelled();
    error RequestNotFound();
    error VaultLocked();
    error ZeroShares();
    error InsufficientShares();
    error TransferFailed();

    // ── Structs ──
    struct Request {
        address owner;       // owner of the escrowed shares (and recipient on claim)
        uint128 shares;      // shares escrowed in the queue
        uint40  requestedAt; // block.timestamp when queued
        bool    claimed;
        bool    cancelled;
    }

    // ── Events ──
    event WithdrawalQueued(uint256 indexed requestId, address indexed owner, uint256 shares);
    event WithdrawalClaimed(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);

    // ── External ──
    function vault() external view returns (address);
    function queueRequest(address owner, uint256 shares) external returns (uint256 requestId);
    function claim(uint256 requestId) external returns (uint256 assets);
    function cancel(uint256 requestId) external;

    // ── Views ──
    function getRequest(uint256 requestId) external view returns (Request memory);
    function pendingShares() external view returns (uint256);
    function getRequestsByOwner(address owner_) external view returns (uint256[] memory);
    function nextRequestId() external view returns (uint256);
}
```

- [ ] **Step 2:** Compile to confirm syntax
```bash
cd contracts && forge build --skip test
```
Expected: clean build (interface only adds, no behavior).

- [ ] **Step 3:** Commit
```bash
git add contracts/src/interfaces/IVaultWithdrawalQueue.sol
git commit -m "feat(queue): IVaultWithdrawalQueue interface"
```

---

## Task 2: VaultWithdrawalQueue implementation — happy path

**Files:**
- Create: `contracts/src/queue/VaultWithdrawalQueue.sol`
- Create: `contracts/test/queue/VaultWithdrawalQueue.t.sol`

- [ ] **Step 1: Write the failing test (queue + claim)**

```solidity
// contracts/test/queue/VaultWithdrawalQueue.t.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultWithdrawalQueue} from "../../src/queue/VaultWithdrawalQueue.sol";
import {IVaultWithdrawalQueue} from "../../src/interfaces/IVaultWithdrawalQueue.sol";
import {MockVault} from "./mocks/MockVault.sol";

contract VaultWithdrawalQueueTest is Test {
    MockVault vault;
    VaultWithdrawalQueue queue;
    address alice = makeAddr("alice");

    function setUp() public {
        vault = new MockVault();
        queue = new VaultWithdrawalQueue(address(vault));
        vault.setQueue(address(queue));
        vault.mint(alice, 1_000e18);
    }

    function test_queueRequest_escrowsShares() public {
        vm.startPrank(alice);
        vault.approve(address(queue), 100e18);
        // Vault calls queueRequest on alice's behalf — simulate via prank
        vm.stopPrank();
        vm.prank(address(vault));
        uint256 id = queue.queueRequest(alice, 100e18);

        assertEq(id, 1);
        assertEq(vault.balanceOf(address(queue)), 100e18);
        IVaultWithdrawalQueue.Request memory r = queue.getRequest(1);
        assertEq(r.owner, alice);
        assertEq(uint256(r.shares), 100e18);
        assertFalse(r.claimed);
    }

    function test_claim_revertsWhileLocked() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.setLocked(true);
        vm.expectRevert(IVaultWithdrawalQueue.VaultLocked.selector);
        queue.claim(1);
    }

    function test_claim_redeemsAndPays() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.setLocked(false);
        vault.setRedeemRate(2e18); // 1 share -> 2 assets
        uint256 assets = queue.claim(1);
        assertEq(assets, 200e18);
        assertEq(vault.lastRedeemReceiver(), alice);
        IVaultWithdrawalQueue.Request memory r = queue.getRequest(1);
        assertTrue(r.claimed);
    }
}
```

- [ ] **Step 2: Write the mock vault**

Create `contracts/test/queue/mocks/MockVault.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockVault is ERC20("MV", "MV") {
    bool public locked;
    address public queue;
    uint256 public redeemRate = 1e18;
    address public lastRedeemReceiver;

    function setQueue(address q) external { queue = q; }
    function setLocked(bool l) external { locked = l; }
    function setRedeemRate(uint256 r) external { redeemRate = r; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }

    function redemptionsLocked() external view returns (bool) { return locked; }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        require(msg.sender == queue || msg.sender == owner, "auth");
        _burn(owner, shares);
        lastRedeemReceiver = receiver;
        return shares * redeemRate / 1e18;
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**
```bash
cd contracts && forge test --match-contract VaultWithdrawalQueueTest -vv
```
Expected: build error or test failure ("VaultWithdrawalQueue not found").

- [ ] **Step 4: Implement VaultWithdrawalQueue.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultWithdrawalQueue} from "../interfaces/IVaultWithdrawalQueue.sol";
import {ISyndicateVault} from "../interfaces/ISyndicateVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IRedeemableVault {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function redemptionsLocked() external view returns (bool);
}

contract VaultWithdrawalQueue is IVaultWithdrawalQueue, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable override vault;

    Request[] private _requests; // index 0 unused (sentinel)
    mapping(address => uint256[]) private _byOwner;
    uint256 private _pendingShares;

    constructor(address vault_) {
        if (vault_ == address(0)) revert NotVault();
        vault = vault_;
        _requests.push(); // sentinel slot
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    /// @notice Vault transfers shares into this contract, then calls queueRequest.
    function queueRequest(address owner_, uint256 shares) external onlyVault returns (uint256 id) {
        if (shares == 0) revert ZeroShares();
        if (shares > type(uint128).max) revert InsufficientShares();
        id = _requests.length;
        _requests.push(Request({
            owner: owner_,
            shares: uint128(shares),
            requestedAt: uint40(block.timestamp),
            claimed: false,
            cancelled: false
        }));
        _byOwner[owner_].push(id);
        _pendingShares += shares;
        emit WithdrawalQueued(id, owner_, shares);
    }

    function claim(uint256 requestId) external nonReentrant returns (uint256 assets) {
        if (requestId == 0 || requestId >= _requests.length) revert RequestNotFound();
        Request storage r = _requests[requestId];
        if (r.claimed) revert AlreadyClaimed();
        if (r.cancelled) revert AlreadyCancelled();
        if (IRedeemableVault(vault).redemptionsLocked()) revert VaultLocked();

        uint256 shares = uint256(r.shares);
        r.claimed = true;
        _pendingShares -= shares;

        // Queue is the share owner (shares were transferred in by the vault on requestRedeem).
        assets = IRedeemableVault(vault).redeem(shares, r.owner, address(this));
        emit WithdrawalClaimed(requestId, r.owner, shares, assets);
    }

    function cancel(uint256 requestId) external nonReentrant {
        if (requestId == 0 || requestId >= _requests.length) revert RequestNotFound();
        Request storage r = _requests[requestId];
        if (msg.sender != r.owner) revert NotQueueOwner();
        if (r.claimed) revert AlreadyClaimed();
        if (r.cancelled) revert AlreadyCancelled();

        uint256 shares = uint256(r.shares);
        r.cancelled = true;
        _pendingShares -= shares;
        IERC20(vault).safeTransfer(r.owner, shares);
        emit WithdrawalCancelled(requestId, r.owner, shares);
    }

    function getRequest(uint256 id) external view returns (Request memory) { return _requests[id]; }
    function pendingShares() external view returns (uint256) { return _pendingShares; }
    function getRequestsByOwner(address owner_) external view returns (uint256[] memory) { return _byOwner[owner_]; }
    function nextRequestId() external view returns (uint256) { return _requests.length; }
}
```

- [ ] **Step 5: Run tests to verify they pass**
```bash
cd contracts && forge test --match-contract VaultWithdrawalQueueTest -vv
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**
```bash
git add contracts/src/queue/VaultWithdrawalQueue.sol \
        contracts/test/queue/VaultWithdrawalQueue.t.sol \
        contracts/test/queue/mocks/MockVault.sol
git commit -m "feat(queue): VaultWithdrawalQueue happy path + cancel"
```

---

## Task 3: Cancel + double-claim + zero-shares edge cases

**Files:**
- Modify: `contracts/test/queue/VaultWithdrawalQueue.t.sol`

- [ ] **Step 1:** Add three edge-case tests (zero shares revert, double claim revert, cancel returns shares to owner, non-owner cancel reverts).

```solidity
function test_queueRequest_zeroSharesReverts() public {
    vm.prank(address(vault));
    vm.expectRevert(IVaultWithdrawalQueue.ZeroShares.selector);
    queue.queueRequest(alice, 0);
}

function test_claim_twiceReverts() public {
    vm.prank(address(vault));
    queue.queueRequest(alice, 100e18);
    vault.setLocked(false);
    queue.claim(1);
    vm.expectRevert(IVaultWithdrawalQueue.AlreadyClaimed.selector);
    queue.claim(1);
}

function test_cancel_returnsSharesToOwner() public {
    vm.prank(address(vault));
    queue.queueRequest(alice, 100e18);
    // shares already in queue (mocked transfer omitted; queue holds via vault.mint)
    vault.mint(address(queue), 100e18); // simulate vault transfer
    vm.prank(alice);
    queue.cancel(1);
    assertEq(vault.balanceOf(alice), 1_000e18 + 100e18); // re-credited
    assertEq(queue.pendingShares(), 0);
}

function test_cancel_nonOwnerReverts() public {
    vm.prank(address(vault));
    queue.queueRequest(alice, 100e18);
    vm.expectRevert(IVaultWithdrawalQueue.NotQueueOwner.selector);
    queue.cancel(1);
}
```

- [ ] **Step 2: Run** `forge test --match-contract VaultWithdrawalQueueTest -vv` → all pass.

- [ ] **Step 3: Commit**
```bash
git add contracts/test/queue/VaultWithdrawalQueue.t.sol
git commit -m "test(queue): cancel + double-claim + zero-shares edges"
```

---

## Task 4: Vault wires `requestRedeem` / `claimRedeem` / queue setter

**Files:**
- Modify: `contracts/src/interfaces/ISyndicateVault.sol`
- Modify: `contracts/src/SyndicateVault.sol`

- [ ] **Step 1: Extend ISyndicateVault**

Append to interface:
```solidity
error WithdrawalQueueNotSet();
error WithdrawalQueueAlreadySet();
error InsufficientShares();

event WithdrawalQueueSet(address indexed queue);
event RedeemRequested(uint256 indexed requestId, address indexed owner, uint256 shares);

function setWithdrawalQueue(address queue) external; // factory-only, set-once
function withdrawalQueue() external view returns (address);
function requestRedeem(uint256 shares, address owner_) external returns (uint256 requestId);
function pendingQueueShares() external view returns (uint256);
function reservedQueueAssets() external view returns (uint256);
```

- [ ] **Step 2: Add storage + setter on the vault**

In `SyndicateVault.sol` storage block (after `_cachedDecimalsOffset`, BEFORE `__gap` — and reduce `__gap` from 38 to 37):
```solidity
/// @notice Per-vault async withdrawal queue (set-once at deploy by the factory).
address private _withdrawalQueue;
```

In ADMIN region (right below `unpause`):
```solidity
function setWithdrawalQueue(address q) external {
    if (msg.sender != _factory) revert NotFactory();
    if (q == address(0)) revert ZeroAddress();
    if (_withdrawalQueue != address(0)) revert WithdrawalQueueAlreadySet();
    _withdrawalQueue = q;
    emit WithdrawalQueueSet(q);
}

function withdrawalQueue() external view returns (address) { return _withdrawalQueue; }
```

- [ ] **Step 3: Add the test (red)**

Create `contracts/test/SyndicateVault.AsyncRedeem.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {VaultWithdrawalQueue} from "../src/queue/VaultWithdrawalQueue.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {VaultDeployHelper} from "./helpers/VaultDeployHelper.sol"; // existing

contract VaultAsyncRedeemTest is Test {
    SyndicateVault vault;
    VaultWithdrawalQueue queue;
    address alice = makeAddr("alice");

    function setUp() public {
        vault = VaultDeployHelper.deploy();
        queue = new VaultWithdrawalQueue(address(vault));
        // pretend the test contract is the factory
        vm.prank(vault.factory());
        vault.setWithdrawalQueue(address(queue));
    }

    function test_requestRedeem_revertsWhenUnlocked() public {
        // not locked = standard redeem path applies
        vm.prank(alice);
        vm.expectRevert(); // exact selector added in Task 5
        vault.requestRedeem(1e6, alice);
    }
}
```

- [ ] **Step 4: Run** `forge test --match-contract VaultAsyncRedeemTest -vv` → fails (function not implemented).

- [ ] **Step 5: Implement `requestRedeem` on the vault**

In `SyndicateVault.sol` (new section above RESCUE):
```solidity
// ==================== ASYNC REDEEM ====================

/// @notice Burn-deferred redemption used while a proposal is active.
///         Transfers `shares` from `owner_` into the queue and records a claim
///         that anyone can settle once `redemptionsLocked() == false`.
function requestRedeem(uint256 shares, address owner_)
    external
    nonReentrant
    whenNotPaused
    returns (uint256 requestId)
{
    if (_withdrawalQueue == address(0)) revert WithdrawalQueueNotSet();
    if (!redemptionsLocked()) revert RedemptionsNotLocked(); // standard redeem applies
    if (shares == 0) revert InsufficientShares();
    if (msg.sender != owner_) {
        _spendAllowance(owner_, msg.sender, shares);
    }
    // Move shares into queue custody — they vote with the queue address (no delegate by default).
    _transfer(owner_, _withdrawalQueue, shares);
    requestId = IVaultWithdrawalQueue(_withdrawalQueue).queueRequest(owner_, shares);
    emit RedeemRequested(requestId, owner_, shares);
}

function pendingQueueShares() public view returns (uint256) {
    if (_withdrawalQueue == address(0)) return 0;
    return IVaultWithdrawalQueue(_withdrawalQueue).pendingShares();
}

function reservedQueueAssets() public view returns (uint256) {
    return convertToAssets(pendingQueueShares());
}
```

Add the new error to ISyndicateVault: `error RedemptionsNotLocked();`. Add imports for `IVaultWithdrawalQueue` at the top of the vault.

- [ ] **Step 6: Update test to assert specific revert**

```solidity
function test_requestRedeem_revertsWhenUnlocked() public {
    vm.prank(alice);
    vm.expectRevert(ISyndicateVault.RedemptionsNotLocked.selector);
    vault.requestRedeem(1e6, alice);
}
```

- [ ] **Step 7: Run** `forge test --match-contract VaultAsyncRedeemTest -vv` → passes.

- [ ] **Step 8: Run vault build with sizes** to verify EIP-170 margin
```bash
cd contracts && forge build --sizes | grep SyndicateVault
```
Expected: SyndicateVault still under 22,000 (CI gate). Note delta in commit message.

- [ ] **Step 9: Commit**
```bash
git add contracts/src/SyndicateVault.sol contracts/src/interfaces/ISyndicateVault.sol \
        contracts/test/SyndicateVault.AsyncRedeem.t.sol
git commit -m "feat(vault): requestRedeem + setWithdrawalQueue (factory-set-once)"
```

---

## Task 5: Reserve float for the queue in `_withdraw` / `maxWithdraw`

**Files:**
- Modify: `contracts/src/SyndicateVault.sol`
- Modify: `contracts/test/SyndicateVault.AsyncRedeem.t.sol`

- [ ] **Step 1: Write red tests**

```solidity
function test_maxWithdraw_capsAtFloatMinusReserve() public {
    // alice deposits 1000 USDC
    _deposit(alice, 1_000e6);
    // bob deposits 1000 USDC
    address bob = makeAddr("bob");
    _deposit(bob, 1_000e6);

    // simulate active proposal -> redemptionsLocked = true
    _setMockProposalActive(true);

    // alice queues 500e shares (mock convertToAssets so reserve is 500e6 USDC)
    vm.prank(alice);
    vault.requestRedeem(500e18, alice);  // shares amount in test scale

    _setMockProposalActive(false); // settled

    // bob's standard withdraw can pull at most (float - reservedQueueAssets)
    uint256 cap = vault.maxWithdraw(bob);
    assertLe(cap, vault.totalAssets() - vault.reservedQueueAssets());
}

function test_withdraw_revertsIfWouldUnderflowQueueReserve() public {
    _deposit(alice, 1_000e6);
    _setMockProposalActive(true);
    vm.prank(alice);
    vault.requestRedeem(500e18, alice);
    _setMockProposalActive(false);

    address bob = makeAddr("bob");
    _deposit(bob, 100e6);
    vm.prank(bob);
    // bob trying to take 1000e6 of float would starve queue
    vm.expectRevert(); // QueueReserveBreached
    vault.withdraw(1_000e6, bob, bob);
}
```

(Add `_setMockProposalActive` test helper that sets the mock governor to return a non-zero active proposal.)

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Implement reservation in `_withdraw` and `maxWithdraw`**

In `SyndicateVault.sol`:
```solidity
function maxWithdraw(address owner_) public view override returns (uint256) {
    if (paused() || redemptionsLocked()) return 0;
    uint256 userMax = super.maxWithdraw(owner_);
    uint256 reserve = reservedQueueAssets();
    uint256 float = IERC20(asset()).balanceOf(address(this));
    uint256 available = float > reserve ? float - reserve : 0;
    return userMax > available ? available : userMax;
}

function maxRedeem(address owner_) public view override returns (uint256) {
    if (paused() || redemptionsLocked()) return 0;
    uint256 userMax = super.maxRedeem(owner_);
    uint256 reserveShares = pendingQueueShares();
    uint256 totalShares = totalSupply();
    if (totalShares == 0 || reserveShares >= totalShares) return 0;
    uint256 availableShares = totalShares - reserveShares;
    return userMax > availableShares ? availableShares : userMax;
}
```

Add a hard assert in `_withdraw` (defense-in-depth):
```solidity
function _withdraw(address caller, address receiver, address _owner, uint256 assets, uint256 shares)
    internal
    override
    whenNotPaused
{
    if (redemptionsLocked()) revert RedemptionsLocked();
    // Allow the queue to drain past the reservation when it claims back into itself.
    if (caller != _withdrawalQueue) {
        uint256 reserve = reservedQueueAssets();
        uint256 float = IERC20(asset()).balanceOf(address(this));
        if (assets + reserve > float) revert QueueReserveBreached();
    }
    super._withdraw(caller, receiver, _owner, assets, shares);
}
```

Add `error QueueReserveBreached();` to the interface.

- [ ] **Step 4: Run all vault tests** `forge test --match-contract VaultAsyncRedeemTest -vv` → pass.

- [ ] **Step 5: Run full vault suite** to catch regressions
```bash
cd contracts && forge test --no-match-path "test/integration/**" --match-path "test/SyndicateVault*"
```
Expected: green.

- [ ] **Step 6: Commit**
```bash
git add contracts/src/SyndicateVault.sol contracts/src/interfaces/ISyndicateVault.sol \
        contracts/test/SyndicateVault.AsyncRedeem.t.sol
git commit -m "feat(vault): reserve float for pending queue claims"
```

---

## Task 6: Factory deploys queue alongside vault

**Files:**
- Modify: `contracts/src/SyndicateFactory.sol`
- Modify: `contracts/test/SyndicateFactory.t.sol` (existing)

- [ ] **Step 1: Add red test**

```solidity
function test_createSyndicate_deploysQueueAndBindsToVault() public {
    address vaultAddr = factory.createSyndicate(/* existing args */);
    SyndicateVault v = SyndicateVault(vaultAddr);
    assertTrue(v.withdrawalQueue() != address(0));
    assertEq(VaultWithdrawalQueue(v.withdrawalQueue()).vault(), vaultAddr);
}
```

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: In `SyndicateFactory.createSyndicate`** (between vault initialize and the registry binding):
```solidity
VaultWithdrawalQueue queue = new VaultWithdrawalQueue(address(vault));
vault.setWithdrawalQueue(address(queue));
emit WithdrawalQueueDeployed(address(vault), address(queue));
```

Add event to interface; import the queue contract.

- [ ] **Step 4:** Run factory + vault tests → green.

- [ ] **Step 5: Commit**
```bash
git add contracts/src/SyndicateFactory.sol contracts/src/interfaces/ISyndicateFactory.sol \
        contracts/test/SyndicateFactory.t.sol
git commit -m "feat(factory): deploy VaultWithdrawalQueue per syndicate"
```

---

## Task 7: End-to-end async-redeem invariants

**Files:**
- Create: `contracts/test/invariants/AsyncRedeemInvariants.t.sol`

- [ ] **Step 1: Write invariants**
- INV-Q1: `pendingQueueShares == sum of unclaimed/uncancelled requests`
- INV-Q2: `reservedQueueAssets <= float` after settle
- INV-Q3: `totalSupply == sum(balanceOf) including queue` (queue holds escrowed shares — no shares destroyed in `requestRedeem`, only in `claim`)
- INV-Q4: `requestRedeem` only succeeds while `redemptionsLocked == true`; `claim` only succeeds while `false`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {AsyncRedeemHandler} from "./handlers/AsyncRedeemHandler.sol";
// ... harness wires vault + queue + handler with random LP actions ...

contract AsyncRedeemInvariantsTest is StdInvariant, Test {
    AsyncRedeemHandler handler;
    function setUp() public { handler = new AsyncRedeemHandler(); targetContract(address(handler)); }

    function invariant_pendingSharesMatchesQueue() public view {
        assertEq(handler.vault().pendingQueueShares(), handler.queue().pendingShares());
        assertEq(handler.queue().pendingShares(), handler.expectedPending());
    }

    function invariant_reserveLeqFloatPostSettle() public view {
        if (!handler.vault().redemptionsLocked()) {
            assertLe(handler.vault().reservedQueueAssets(),
                     IERC20(handler.vault().asset()).balanceOf(address(handler.vault())));
        }
    }
}
```

(Handler implementation modeled after `test/invariants/handlers/RegistryHandler.sol`.)

- [ ] **Step 2: Run** `forge test --match-contract AsyncRedeemInvariantsTest --fuzz-runs 256 -vv` → green.

- [ ] **Step 3: Commit**
```bash
git add contracts/test/invariants/
git commit -m "test(invariants): async-redeem queue invariants"
```

---

## Task 8: Phase 1 wrap — sizes, fmt, full test, docs

- [ ] **Step 1:** `cd contracts && forge fmt && forge build --sizes`
   Expected: vault under 22,000; governor unchanged (Phase 1 makes no governor edits).

- [ ] **Step 2:** `forge test --no-match-path "test/integration/**"` — full unit/invariant suite green.

- [ ] **Step 3:** Update `CLAUDE.md` "Architecture" table with `VaultWithdrawalQueue` row, and add a "Async withdrawal queue" subsection under "Architecture" describing the lifecycle. Also add to `mintlify-docs/` (`protocol/architecture.mdx` — note the new flow under "Withdrawals during active proposals").

- [ ] **Step 4: Commit + tag Phase 1 ready**
```bash
git add CLAUDE.md mintlify-docs/protocol/architecture.mdx
git commit -m "docs: async-withdrawal queue architecture"
git tag phase-1-async-redeem
```

- [ ] **Step 5: Open PR** for Phase 1 — title: `feat: async withdrawal queue (Concrete-style requestRedeem)`. Body covers ref codes A-AR1..AR8.

---

# Phase 2 — Live NAV via Strategy Adapters

## Task 9: Bind active strategy adapter on the vault

**Files:**
- Modify: `contracts/src/interfaces/ISyndicateVault.sol`
- Modify: `contracts/src/SyndicateVault.sol`
- Create: `contracts/test/SyndicateVault.LiveNAV.t.sol`

- [ ] **Step 1: Extend the interface**
```solidity
error NotGovernorOrFactory();
error AdapterAlreadyBound();

event ActiveStrategyAdapterSet(address indexed adapter);
event ActiveStrategyAdapterCleared();

function activeStrategyAdapter() external view returns (address);
function setActiveStrategyAdapter(address adapter) external; // governor-only
function clearActiveStrategyAdapter() external;              // governor-only
```

- [ ] **Step 2: Add storage** (decrement `__gap` from 37 → 36):
```solidity
address private _activeStrategyAdapter;
```

- [ ] **Step 3: Implement setters**
```solidity
function setActiveStrategyAdapter(address adapter) external onlyGovernor {
    if (adapter == address(0)) revert ZeroAddress();
    if (_activeStrategyAdapter != address(0)) revert AdapterAlreadyBound();
    _activeStrategyAdapter = adapter;
    emit ActiveStrategyAdapterSet(adapter);
}

function clearActiveStrategyAdapter() external onlyGovernor {
    _activeStrategyAdapter = address(0);
    emit ActiveStrategyAdapterCleared();
}

function activeStrategyAdapter() external view returns (address) { return _activeStrategyAdapter; }
```

- [ ] **Step 4: Write red test** in `SyndicateVault.LiveNAV.t.sol` (mock governor calls `setActiveStrategyAdapter`, asserts only-governor revert for non-governor caller).

- [ ] **Step 5:** Run → red → implement → green.

- [ ] **Step 6: Commit**
```bash
git commit -am "feat(vault): bind/clear activeStrategyAdapter (governor-only)"
```

---

## Task 10: `totalAssets` aggregates float + adapter NAV

**Files:**
- Modify: `contracts/src/SyndicateVault.sol`
- Modify: `contracts/test/SyndicateVault.LiveNAV.t.sol`

- [ ] **Step 1: Red test**
```solidity
function test_totalAssets_includesAdapterNAVWhenValid() public {
    _deposit(alice, 1_000e6);
    MockAdapter adapter = new MockAdapter();
    adapter.setValue(2_000e6, true); // strategy reports 2000 USDC live NAV, valid

    vm.prank(address(governor));
    vault.setActiveStrategyAdapter(address(adapter));

    // float was reduced by execute (mock pushes 1000 into adapter)
    deal(address(usdc), address(vault), 0); // simulate funds deployed

    assertEq(vault.totalAssets(), 2_000e6);
}

function test_totalAssets_ignoresAdapterWhenInvalid() public {
    _deposit(alice, 1_000e6);
    MockAdapter adapter = new MockAdapter();
    adapter.setValue(0, false); // valid=false (e.g. Mamo / Venice)

    vm.prank(address(governor));
    vault.setActiveStrategyAdapter(address(adapter));

    // float intact (no adapter contribution)
    assertEq(vault.totalAssets(), 1_000e6);
}
```

`MockAdapter` exposes `positionValue() returns (uint256, bool)`.

- [ ] **Step 2: Implement override**

Replace ERC4626's default by overriding:
```solidity
function totalAssets() public view override returns (uint256) {
    uint256 float = IERC20(asset()).balanceOf(address(this));
    address adapter = _activeStrategyAdapter;
    if (adapter == address(0)) return float;
    (uint256 value, bool valid) = IStrategy(adapter).positionValue();
    return valid ? float + value : float;
}
```

Add `IStrategy` import.

- [ ] **Step 3: Run** all `LiveNAV` tests → green. Run full suite to confirm no `totalAssets`-dependent tests broke.

- [ ] **Step 4: Commit**
```bash
git commit -am "feat(vault): totalAssets aggregates active strategy adapter NAV"
```

---

## Task 11: Governor binds adapter on `executeProposal`, clears on `_finishSettlement`

**Files:**
- Modify: `contracts/src/interfaces/ISyndicateGovernor.sol` (add `address strategyAdapter` to `StrategyProposal`)
- Modify: `contracts/src/SyndicateGovernor.sol`
- Modify: `contracts/test/SyndicateGovernor.t.sol` (add adapter-binding tests)

- [ ] **Step 1: Add `strategyAdapter` field** to `StrategyProposal` (append, do NOT reorder existing fields — proxy storage). Update `propose` to accept and persist it.

- [ ] **Step 2: In `executeProposal`** after the existing `executeGovernorBatch`:
```solidity
if (proposal.strategyAdapter != address(0)) {
    ISyndicateVault(vault).setActiveStrategyAdapter(proposal.strategyAdapter);
}
```

- [ ] **Step 3: In `_finishSettlement`** before resetting `_activeProposal`:
```solidity
if (proposal.strategyAdapter != address(0)) {
    ISyndicateVault(proposal.vault).clearActiveStrategyAdapter();
}
```

- [ ] **Step 4: Tests** — red/green for: (a) propose without adapter (legacy path) keeps `activeStrategyAdapter == address(0)`; (b) propose with adapter sets and clears at the right edges; (c) governor size check.

- [ ] **Step 5:** Run `forge build --sizes | grep SyndicateGovernor` — expect minor delta. If it pushes over 24,576, apply a bytecode-reduction lever from CLAUDE.md (drop a typed event, hoist `keccak256(abi.encode(...))` etc.).

- [ ] **Step 6: Commit**
```bash
git commit -am "feat(governor): bind strategy adapter on execute, clear on settle"
```

---

## Task 12: Relax deposit/withdraw lock when adapter reports valid live NAV

**Files:**
- Modify: `contracts/src/SyndicateVault.sol`
- Modify: `contracts/test/SyndicateVault.LiveNAV.t.sol`

- [ ] **Step 1: Define helper**
```solidity
function _liveNAVAvailable() internal view returns (bool) {
    address adapter = _activeStrategyAdapter;
    if (adapter == address(0)) return false;
    (, bool valid) = IStrategy(adapter).positionValue();
    return valid;
}
```

- [ ] **Step 2: Update `_deposit` lock check**
```solidity
function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
    internal
    override
    whenNotPaused
{
    if (redemptionsLocked() && !_liveNAVAvailable()) revert DepositsLocked();
    if (!_openDeposits && !_approvedDepositors.contains(receiver)) revert NotApprovedDepositor();
    super._deposit(caller, receiver, assets, shares);
    if (delegates(receiver) == address(0)) _delegate(receiver, receiver);

    // Forward live deposits to the adapter so capital is at work immediately.
    address adapter = _activeStrategyAdapter;
    if (adapter != address(0) && _liveNAVAvailable()) {
        IStrategy(adapter).onLiveDeposit(assets); // new optional hook (Task 13)
    }
}
```

- [ ] **Step 3: Update `_withdraw` similarly** — allow withdraw if live NAV available AND vault has float; else fall back to `revert RedemptionsLocked()` (user can `requestRedeem` instead).

- [ ] **Step 4: Tests**
```solidity
function test_deposit_allowedDuringLiveStrategy() public {
    MockAdapter adapter = new MockAdapter();
    adapter.setValue(1_000e6, true);
    vm.prank(address(governor));
    vault.setActiveStrategyAdapter(address(adapter));
    _setMockProposalActive(true);

    _deposit(alice, 100e6); // should NOT revert
    assertGt(vault.balanceOf(alice), 0);
}

function test_deposit_blockedWhenAdapterInvalid() public {
    MockAdapter adapter = new MockAdapter();
    adapter.setValue(0, false);
    vm.prank(address(governor));
    vault.setActiveStrategyAdapter(address(adapter));
    _setMockProposalActive(true);
    vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
    vm.prank(alice);
    vault.deposit(100e6, alice);
}
```

- [ ] **Step 5:** Run, green, commit.
```bash
git commit -am "feat(vault): allow deposit/withdraw under live-NAV adapters"
```

---

## Task 13: `onLiveDeposit` hook on `BaseStrategy`

**Files:**
- Modify: `contracts/src/interfaces/IStrategy.sol`
- Modify: `contracts/src/strategies/BaseStrategy.sol`
- Modify: `contracts/src/strategies/MoonwellSupplyStrategy.sol` (override)

- [ ] **Step 1: Add to interface**
```solidity
/// @notice Optional hook — vault calls after a deposit so the strategy
///         can route the new capital into its live position. No-op by default.
function onLiveDeposit(uint256 assets) external;
```

- [ ] **Step 2: Default impl in BaseStrategy** (only callable by vault, only when `_state == Executed`):
```solidity
function onLiveDeposit(uint256 assets) external virtual onlyVault {
    if (_state != State.Executed) return;
    _onLiveDeposit(assets);
}

function _onLiveDeposit(uint256 assets) internal virtual {
    // default: do nothing — strategies that can absorb new capital override
}
```

- [ ] **Step 3: Override in MoonwellSupplyStrategy** — pull `assets` USDC from vault and call `mToken.mint(assets)`.

- [ ] **Step 4: Tests** — `forge test --match-contract MoonwellSupplyStrategyTest` green; add a test that a mid-strategy `deposit` increases the strategy's mToken balance.

- [ ] **Step 5: Commit**
```bash
git commit -am "feat(strategy): onLiveDeposit hook (default no-op)"
```

---

## Task 14: Phase 2 wrap — sizes, fmt, full test, docs, PR

- [ ] **Step 1:** `forge fmt && forge build --sizes` — verify `SyndicateGovernor` ≤ 24,550 and `SyndicateVault` ≤ 22,000.

- [ ] **Step 2:** Run integration tests including the Moonwell fork (must have `BASE_RPC_URL`):
```bash
forge test --match-path "test/integration/**" -vv
```

- [ ] **Step 3: Update docs**
- `CLAUDE.md` "Governor Key Concepts" — replace `redemptionsLocked()` description with the live-NAV branch.
- `CLAUDE.md` "Architecture" — describe `IStrategyAdapter` and which strategies support live NAV (Moonwell yes; Mamo/Venice no).
- `mintlify-docs/protocol/architecture.mdx` — Concrete-style table of "supports live deposits / supports live withdrawals / queue fallback".
- `docs/pre-mainnet-punchlist.md` — close the corresponding row (or add A-LN1 if not yet listed).

- [ ] **Step 4: Commit + push + PR**
```bash
git commit -am "docs: live-NAV adapter rail + lock truth table"
git push -u origin feat/live-nav-async-withdrawals
gh pr create --title "feat: live NAV + async withdrawal queue" --body "$(cat <<'EOF'
## Summary
- Phase 1: VaultWithdrawalQueue lets LPs queue redemptions during active proposals; claims drain post-settle.
- Phase 2: SyndicateVault.totalAssets aggregates float + active strategy adapter NAV; deposits/withdrawals stay open when adapter reports valid live NAV.

## Test plan
- [ ] forge test (full unit + invariants)
- [ ] forge build --sizes (vault < 22000, governor < 24550)
- [ ] integration tests under test/integration/** with BASE_RPC_URL
- [ ] manual: queue → settle → claim flow on Base Sepolia
- [ ] manual: deposit during a live MoonwellSupplyStrategy
EOF
)"
```

---

## Self-Review Checklist (run before announcing plan complete)

- [ ] Spec coverage: every section of the design doc maps to at least one task. ✅ async queue (Tasks 1–8), live NAV (Tasks 9–13), docs/PR (Task 14).
- [ ] No placeholders: searched for "TBD" / "TODO" / "appropriate error handling" / "similar to Task N" — none.
- [ ] Type consistency: `requestRedeem` / `claim` / `queueRequest` / `setWithdrawalQueue` / `activeStrategyAdapter` / `setActiveStrategyAdapter` / `onLiveDeposit` / `_liveNAVAvailable` / `pendingQueueShares` / `reservedQueueAssets` — referenced consistently across tasks.
- [ ] Storage layout: `_withdrawalQueue` (Task 4) and `_activeStrategyAdapter` (Task 9) appended; `__gap` reduced 38 → 37 → 36.
- [ ] Bytecode budget: governor delta in Task 11 — explicit recheck step. Vault delta in Tasks 4/9/10/12 — recheck in Task 8 and Task 14.
- [ ] Phase boundary: Tasks 1–8 produce shippable software (Phase 1 PR / tag) without any of Phase 2.
