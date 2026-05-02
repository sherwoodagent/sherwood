# HyperEVM Fork Integration Tests + minReturnAmount Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HyperEVM fork integration tests for `HyperliquidGridStrategy` (full syndicate lifecycle: deposit → propose → vote → guardian review → execute → grid orders → settle → sweep → redeem) and remove the `minReturnAmount` field from both Hyperliquid strategies (it permanently locks vault funds when the strategy loses money).

**Architecture:** New `HyperEVMIntegrationTest` abstract base mirrors `BaseIntegrationTest` / `RobinhoodIntegrationTest` but forks HyperEVM and deploys protocol fresh on the fork via the existing `Deploy.s.sol` and `DeployTemplates.s.sol` helpers. `HyperliquidGridFork.t.sol` runs 3 happy-path lifecycle tests. Contract changes drop `minReturnAmount` so a lossy strategy can still return whatever's left to the vault.

**Tech Stack:** Solidity 0.8.28, Foundry, OpenZeppelin Clones, HyperEVM precompiles (real `L1Read`, real `L1Write` event emission — no MockCoreWriter on fork).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `contracts/src/strategies/HyperliquidGridStrategy.sol` | Modify | Drop `minReturnAmount` from init/storage/sweep/error |
| `contracts/src/strategies/HyperliquidPerpStrategy.sol` | Modify | Same fix — drop `minReturnAmount` |
| `contracts/test/HyperliquidGridStrategy.t.sol` | Modify | Drop `MIN_RETURN`, drop min-return tests, update init shape |
| `contracts/test/HyperliquidPerpStrategy.t.sol` | Modify | Same — drop `MIN_RETURN` and dependent tests |
| `contracts/script/Deploy.s.sol` | Modify | Extract `_deployCore()` returning addresses; `run()` becomes a thin wrapper |
| `contracts/script/DeployTemplates.s.sol` | Modify | Extract `_deployHyperliquidTemplate()`; `run()` wraps + persists |
| `contracts/test/integration/HyperEVMIntegrationTest.sol` | Create | Abstract fork base — deploys protocol, funds LPs, helpers |
| `contracts/test/integration/HyperliquidGridFork.t.sol` | Create | 3 fork lifecycle tests |

---

### Task 1: Drop `minReturnAmount` from `HyperliquidGridStrategy`

**Files:**
- Modify: `contracts/src/strategies/HyperliquidGridStrategy.sol`

- [ ] **Step 1: Remove `minReturnAmount` from init decode**

In `_initialize`, change the decode tuple (currently around lines 79-95):

OLD:
```solidity
function _initialize(bytes calldata data) internal override {
    (
        address asset_,
        uint256 depositAmount_,
        uint256 minReturnAmount_,
        uint32 leverage_,
        uint256 maxOrderSize_,
        uint32 maxOrdersPerTick_,
        uint32[] memory assetIndices_
    ) = abi.decode(data, (address, uint256, uint256, uint32, uint256, uint32, uint32[]));
    // ...
    minReturnAmount = minReturnAmount_;
    // ...
}
```

NEW:
```solidity
function _initialize(bytes calldata data) internal override {
    (
        address asset_,
        uint256 depositAmount_,
        uint32 leverage_,
        uint256 maxOrderSize_,
        uint32 maxOrdersPerTick_,
        uint32[] memory assetIndices_
    ) = abi.decode(data, (address, uint256, uint32, uint256, uint32, uint32[]));
    // ... (no minReturnAmount assignment)
}
```

- [ ] **Step 2: Remove `minReturnAmount` storage variable**

Delete the line `uint256 public minReturnAmount;` from the storage block.

- [ ] **Step 3: Remove `InsufficientReturn` error**

Delete the line `error InsufficientReturn(uint256 actual, uint256 minimum);` from the errors block.

- [ ] **Step 4: Simplify `sweepToVault()`**

Replace the entire function:

```solidity
/// @notice Push USDC back to the vault after async transfer completes.
/// @dev Permissionless — funds only go to the vault, no diversion possible.
///      Repeatable for partial async arrivals. NO minReturnAmount guard:
///      a strategy that loses money must still be able to return whatever
///      remains. The cumulative tracker (`cumulativeSwept`) records totals
///      for off-chain monitoring but does not gate withdrawals.
function sweepToVault() external {
    if (!settled) revert NotSweepable();

    uint256 bal = IERC20(asset).balanceOf(address(this));
    if (bal == 0) revert InvalidAmount();

    cumulativeSwept += bal;

    uint256 vaultBefore = IERC20(asset).balanceOf(vault());
    _pushAllToVault(address(asset));
    uint256 actualTransferred = IERC20(asset).balanceOf(vault()) - vaultBefore;

    emit FundsSwept(actualTransferred);
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd contracts && forge build 2>&1 | tail -10`
Expected: Compilation errors in `test/HyperliquidGridStrategy.t.sol` (handled in Task 2). Source compiles.

- [ ] **Step 6: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/src/strategies/HyperliquidGridStrategy.sol
git commit -m "fix(grid): drop minReturnAmount — lossy strategies must return remaining funds"
```

---

### Task 2: Update `HyperliquidGridStrategy` tests

**Files:**
- Modify: `contracts/test/HyperliquidGridStrategy.t.sol`

- [ ] **Step 1: Drop `MIN_RETURN` constant**

Find and delete: `uint256 constant MIN_RETURN = 9_900e6;` (around line 18).

- [ ] **Step 2: Update `setUp()` init data encoding**

Find the existing line:
```solidity
bytes memory initData =
    abi.encode(address(usdc), DEPOSIT, MIN_RETURN, LEVERAGE, MAX_ORDER_SIZE, MAX_ORDERS, assets);
```

Replace with (drop MIN_RETURN):
```solidity
bytes memory initData =
    abi.encode(address(usdc), DEPOSIT, LEVERAGE, MAX_ORDER_SIZE, MAX_ORDERS, assets);
```

- [ ] **Step 3: Delete `test_sweepToVault_revertsIfBelowMinReturn`**

Find and remove this entire test function. The error it expects (`InsufficientReturn`) no longer exists.

- [ ] **Step 4: Delete `test_sweepToVault_dustRaceCannotBypassMinReturn`**

Find and remove this entire test function. The dust-race protection no longer exists (and isn't needed — funds always reach the vault).

- [ ] **Step 5: Update `test_sweepToVault_repeatableForPartialArrivals`**

The existing test sweeps DEPOSIT then 5,000 more. With minReturn gone, it just verifies cumulative tracking. Replace any `minReturnAmount` assertion with `cumulativeSwept` checks. The test should already work after the removal — just verify by running it.

- [ ] **Step 6: Update `test_initialize` to drop minReturnAmount assertion**

Find and remove any `assertEq(strategy.minReturnAmount(), MIN_RETURN);` line. (May or may not exist — search and clean.)

- [ ] **Step 7: Run all grid tests**

Run: `cd contracts && forge test --match-contract HyperliquidGridStrategyTest -vv 2>&1 | tail -25`
Expected: All remaining tests pass (probably 14 tests after dropping the 2 removed)

- [ ] **Step 8: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/test/HyperliquidGridStrategy.t.sol
git commit -m "test(grid): drop minReturnAmount tests + update init encoding"
```

---

### Task 3: Apply same fix to `HyperliquidPerpStrategy`

**Files:**
- Modify: `contracts/src/strategies/HyperliquidPerpStrategy.sol`
- Modify: `contracts/test/HyperliquidPerpStrategy.t.sol`

- [ ] **Step 1: Remove `minReturnAmount` from `_initialize` decode**

Find the existing decode (around line 96-105):
```solidity
function _initialize(bytes calldata data) internal override {
    (
        address asset_,
        uint256 depositAmount_,
        uint256 minReturnAmount_,
        uint32 perpAssetIndex_,
        uint32 leverage_,
        uint256 maxPositionSize_,
        uint32 maxTradesPerDay_
    ) = abi.decode(data, (address, uint256, uint256, uint32, uint32, uint256, uint32));
    // ...
    minReturnAmount = minReturnAmount_;
    // ...
}
```

Replace with:
```solidity
function _initialize(bytes calldata data) internal override {
    (
        address asset_,
        uint256 depositAmount_,
        uint32 perpAssetIndex_,
        uint32 leverage_,
        uint256 maxPositionSize_,
        uint32 maxTradesPerDay_
    ) = abi.decode(data, (address, uint256, uint32, uint32, uint256, uint32));
    // ... (no minReturnAmount assignment)
}
```

- [ ] **Step 2: Remove `minReturnAmount` storage**

Delete the line `uint256 public minReturnAmount;` from the storage block.

- [ ] **Step 3: Remove `InsufficientReturn` error**

Delete the line `error InsufficientReturn(uint256 actual, uint256 minimum);`.

- [ ] **Step 4: Simplify `sweepToVault()`**

Replace the function with:
```solidity
/// @notice Push USDC back to the vault after async transfer completes.
/// @dev Permissionless — funds only go to the vault, no diversion possible.
///      Repeatable for partial async arrivals. NO minReturnAmount guard:
///      a strategy that loses money must still be able to return whatever
///      remains. The cumulative tracker (`cumulativeSwept`) records totals
///      for off-chain monitoring but does not gate withdrawals.
function sweepToVault() external {
    if (!settled) revert NotSweepable();

    uint256 bal = IERC20(asset).balanceOf(address(this));
    if (bal == 0) revert InvalidAmount();

    cumulativeSwept += bal;

    uint256 vaultBefore = IERC20(asset).balanceOf(vault());
    _pushAllToVault(address(asset));
    uint256 actualTransferred = IERC20(asset).balanceOf(vault()) - vaultBefore;

    emit FundsSwept(actualTransferred);
}
```

- [ ] **Step 5: Update PerpStrategy tests**

In `contracts/test/HyperliquidPerpStrategy.t.sol`:

(a) Drop `MIN_RETURN` constant (around line 22):
```solidity
// DELETE: uint256 constant MIN_RETURN = 9_900e6;
```

(b) Update `setUp()` init data encoding (find and replace):

OLD:
```solidity
bytes memory initData =
    abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
```

NEW:
```solidity
bytes memory initData =
    abi.encode(address(usdc), DEPOSIT, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
```

(c) **Search and replace ALL** other `abi.encode(address(usdc), ...MIN_RETURN...)` occurrences in this file. There are several (in `test_initialize_*` helpers, `test_execute_dynamicAll_*`, `test_initialize_zeroDeposit_allowsDynamicAll`, etc.). Each should drop `MIN_RETURN` from the encoded params.

Run this command to find them all first:
```bash
cd /home/ana/code/sherwood/contracts
grep -n "MIN_RETURN" test/HyperliquidPerpStrategy.t.sol
```

(d) Drop `assertEq(strategy.minReturnAmount(), MIN_RETURN);` from `test_initialize` (around line 57).

(e) Delete entire test functions:
- `test_sweepToVault_enforces_minReturnAmount`
- `test_sweepToVault_dustRaceCannotBypassMinReturn`
- `test_sweepToVault_zeroMinReturn_skipsCheck`

(f) Update `test_sweepToVault_repeatable` and `test_sweepToVault_secondSweepWithCumulativeAboveMin` — they should still pass after removal of MIN_RETURN, but if they reference it, clean those references.

- [ ] **Step 6: Run all PerpStrategy tests**

Run: `cd contracts && forge test --match-contract HyperliquidPerpStrategyTest -vv 2>&1 | tail -10`
Expected: All remaining tests pass

- [ ] **Step 7: Verify both strategies' bytecode**

Run: `cd contracts && forge build --sizes 2>&1 | grep -E "Hyperliquid"`
Expected: Both contracts under 24,576 bytes (they should shrink slightly)

- [ ] **Step 8: Run forge fmt**

Run: `cd contracts && forge fmt`

- [ ] **Step 9: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/src/strategies/HyperliquidPerpStrategy.sol contracts/test/HyperliquidPerpStrategy.t.sol
git commit -m "fix(perp): drop minReturnAmount — same fix as grid strategy"
```

---

### Task 4: Refactor `Deploy.s.sol` to expose `_deployCore()`

**Files:**
- Modify: `contracts/script/Deploy.s.sol`

The existing `run()` does deployment + JSON persistence in one go. We need to extract the deployment so tests can call it without mutating `chains/{chainId}.json`.

- [ ] **Step 1: Extract `_deployCore()`**

In `contracts/script/Deploy.s.sol`, between the existing `run()` function and `_deployGovernorProxy()`, add:

```solidity
/// @notice Deployment helper extracted from `run()` for use in fork tests.
///         Performs all CREATE3 deploys + governor.setFactory() but does NOT:
///           - call `vm.startBroadcast()` / `vm.stopBroadcast()` (caller's responsibility)
///           - persist addresses to chains/{chainId}.json
///           - validate (callers can if they want)
/// @dev Used by `HyperEVMIntegrationTest.setUp()` to deploy on a fork without
///      writing to disk. Production deploys keep using `run()`.
function _deployCore(Config memory cfg) public returns (Deployed memory d) {
    d.deployer = msg.sender;

    Create3Factory c3 = new Create3Factory(d.deployer);

    d.executorLib = c3.deploy(SALT_EXECUTOR, abi.encodePacked(type(BatchExecutorLib).creationCode));
    d.vaultImpl = c3.deploy(SALT_VAULT_IMPL, abi.encodePacked(type(SyndicateVault).creationCode));

    address predictedRegistryProxy = c3.addressOf(SALT_REGISTRY_PROXY);
    address govImpl = c3.deploy(SALT_GOVERNOR_IMPL, abi.encodePacked(type(SyndicateGovernor).creationCode));
    d.governorProxy = _deployGovernorProxy(c3, govImpl, d.deployer, predictedRegistryProxy, cfg);

    address predictedFactoryProxy = c3.addressOf(SALT_FACTORY_PROXY);
    address registryImpl = c3.deploy(SALT_REGISTRY_IMPL, abi.encodePacked(type(GuardianRegistry).creationCode));
    d.registryProxy =
        _deployRegistryProxy(c3, registryImpl, d.deployer, d.governorProxy, predictedFactoryProxy, cfg);
    require(d.registryProxy == predictedRegistryProxy, "registry addr mismatch");

    address factoryImpl = c3.deploy(SALT_FACTORY_IMPL, abi.encodePacked(type(SyndicateFactory).creationCode));
    d.factoryProxy = _deployFactoryProxy(c3, factoryImpl, d, cfg);
    require(d.factoryProxy == predictedFactoryProxy, "factory addr mismatch");

    SyndicateGovernor(d.governorProxy).setFactory(d.factoryProxy);
}
```

- [ ] **Step 2: Refactor `run()` to use `_deployCore()`**

Replace the body of `run()` (the deployment portion between `vm.startBroadcast()` and `vm.stopBroadcast()`) so it calls `_deployCore()`:

```solidity
function run() external {
    Config memory cfg = Config({
        ensRegistrar: vm.envOr("ENS_REGISTRAR", address(0)),
        agentRegistry: vm.envOr("AGENT_REGISTRY", address(0)),
        managementFeeBps: vm.envOr("MANAGEMENT_FEE", uint256(50)),
        protocolFeeBps: vm.envOr("PROTOCOL_FEE", uint256(200)),
        maxStrategyDays: vm.envOr("MAX_STRATEGY_DAYS", uint256(14)),
        woodToken: vm.envOr("WOOD_TOKEN", _tryReadAddress("WOOD_TOKEN")),
        slashAppealSeed: vm.envOr("SLASH_APPEAL_SEED", DEFAULT_SLASH_APPEAL_SEED),
        epochZeroSeed: vm.envOr("EPOCH_ZERO_SEED", DEFAULT_EPOCH_ZERO_SEED)
    });
    require(cfg.woodToken != address(0), "WOOD_TOKEN not set (env or chains.json)");

    vm.startBroadcast();
    Deployed memory d = _deployCore(cfg);
    console.log("\nDeployer:", d.deployer);
    console.log("Chain ID:", block.chainid);
    console.log("BatchExecutorLib:", d.executorLib);
    console.log("VaultImpl:", d.vaultImpl);
    console.log("GovernorProxy:", d.governorProxy);
    console.log("GuardianRegistryProxy:", d.registryProxy);
    console.log("FactoryProxy:", d.factoryProxy);
    console.log("Governor.setFactory applied");

    _seedRegistry(d.deployer, d.registryProxy, cfg);

    vm.stopBroadcast();

    _validateGovernor(d.deployer, d.governorProxy, d.factoryProxy, cfg.maxStrategyDays);
    _validateFactory(
        d.deployer,
        d.governorProxy,
        d.factoryProxy,
        d.executorLib,
        d.vaultImpl,
        cfg.ensRegistrar,
        cfg.agentRegistry,
        cfg.managementFeeBps
    );
    _validateRegistry(d.registryProxy, d.governorProxy, d.factoryProxy, cfg.woodToken);

    _writeAddresses(_chainName(), d.deployer, d.factoryProxy, d.governorProxy, d.executorLib, d.vaultImpl);
    _patchAddress("GUARDIAN_REGISTRY", d.registryProxy);

    console.log("\nDeployment complete on %s (chain %s)", _chainName(), block.chainid);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd contracts && forge build 2>&1 | tail -5`
Expected: Compiles cleanly

- [ ] **Step 4: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/script/Deploy.s.sol
git commit -m "refactor(deploy): extract _deployCore() helper for fork tests"
```

---

### Task 5: Refactor `DeployTemplates.s.sol` to expose `_deployHyperliquidGridTemplate()`

**Files:**
- Modify: `contracts/script/DeployTemplates.s.sol`

- [ ] **Step 1: Add the import for `HyperliquidGridStrategy`**

Find the existing imports block and add:

```solidity
import {HyperliquidGridStrategy} from "../src/strategies/HyperliquidGridStrategy.sol";
```

- [ ] **Step 2: Add a public helper that deploys just the grid template**

In the contract body, add after the existing `run()`:

```solidity
/// @notice Test helper — deploys a fresh `HyperliquidGridStrategy` template.
///         Used by `HyperEVMIntegrationTest.setUp()`. Does not persist to JSON.
/// @dev Caller is responsible for `vm.startBroadcast()` if needed.
function _deployHyperliquidGridTemplate() public returns (address) {
    return address(new HyperliquidGridStrategy());
}

/// @notice Test helper — deploys a fresh `HyperliquidPerpStrategy` template.
function _deployHyperliquidPerpTemplate() public returns (address) {
    return address(new HyperliquidPerpStrategy());
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd contracts && forge build 2>&1 | tail -5`
Expected: Compiles cleanly

- [ ] **Step 4: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/script/DeployTemplates.s.sol
git commit -m "refactor(deploy): expose template-deployment helpers for fork tests"
```

---

### Task 6: Create `HyperEVMIntegrationTest` abstract base

**Files:**
- Create: `contracts/test/integration/HyperEVMIntegrationTest.sol`

- [ ] **Step 1: Create the file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {DeploySherwood} from "../../script/Deploy.s.sol";
import {DeployTemplates} from "../../script/DeployTemplates.s.sol";

/**
 * @title HyperEVMIntegrationTest
 * @notice Abstract base for fork-based integration tests on HyperEVM mainnet.
 *         Deploys protocol contracts fresh on the fork via the existing deploy
 *         scripts, funds LPs with HyperEVM-native USDC, and provides helpers
 *         for the full proposal lifecycle.
 *
 * @dev Skips if HYPEREVM_RPC_URL is not set. Run with:
 *      forge test --fork-url $HYPEREVM_RPC_URL --match-path "test/integration/HyperliquidGridFork.t.sol"
 */
abstract contract HyperEVMIntegrationTest is Test {
    // ── HyperEVM mainnet addresses ──
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    // Hyperliquid perp asset indices (current as of 2026-04)
    uint32 constant HL_BTC = 3;
    uint32 constant HL_ETH = 4;
    uint32 constant HL_SOL = 5;

    // ── Test actors ──
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");

    // ── Deployed protocol (fresh on fork) ──
    SyndicateGovernor governor;
    SyndicateFactory factory;
    GuardianRegistry registry;
    address vaultImpl;
    address executorLib;
    address hyperliquidGridTemplate;

    // ── Per-test syndicate ──
    SyndicateVault vault;
    uint256 agentNftId = 42;

    // ── Setup ──

    function setUp() public virtual {
        string memory rpc = vm.envOr("HYPEREVM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        _deployProtocol();
        _deployTemplates();

        // Fund LPs with HyperEVM-native USDC via deal()
        deal(USDC, lp1, 60_000e6);
        deal(USDC, lp2, 40_000e6);
    }

    // ── Protocol deployment via the existing scripts ──

    function _deployProtocol() internal {
        DeploySherwood deployScript = new DeploySherwood();
        DeploySherwood.Config memory cfg = DeploySherwood.Config({
            ensRegistrar: address(0),
            agentRegistry: address(0),
            managementFeeBps: 50,
            protocolFeeBps: 200,
            maxStrategyDays: 14,
            woodToken: address(this), // dummy — registry init requires non-zero, fork tests don't use WOOD
            slashAppealSeed: 0,
            epochZeroSeed: 0
        });
        vm.startBroadcast(owner);
        DeploySherwood.Deployed memory d = deployScript._deployCore(cfg);
        vm.stopBroadcast();

        governor = SyndicateGovernor(d.governorProxy);
        factory = SyndicateFactory(d.factoryProxy);
        registry = GuardianRegistry(d.registryProxy);
        vaultImpl = d.vaultImpl;
        executorLib = d.executorLib;
    }

    function _deployTemplates() internal {
        DeployTemplates t = new DeployTemplates();
        vm.startBroadcast(owner);
        hyperliquidGridTemplate = t._deployHyperliquidGridTemplate();
        vm.stopBroadcast();
    }

    // ── Test syndicate creation ──

    function _createSyndicate() internal returns (SyndicateVault) {
        SyndicateFactory.SyndicateConfig memory config = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://hyperliquid-fork-test",
            asset: IERC20(USDC),
            name: "HyperEVM Fork Test Vault",
            symbol: "hfUSDC",
            openDeposits: true,
            subdomain: "hyperliquid-fork-test"
        });

        vm.prank(owner);
        (, address vaultAddr) = factory.createSyndicate(agentNftId, config);
        SyndicateVault v = SyndicateVault(payable(vaultAddr));

        vm.prank(owner);
        v.registerAgent(43, agent);

        return v;
    }

    // ── Fund LPs and deposit ──

    function _fundAndDeposit(SyndicateVault v, uint256 lp1Amount, uint256 lp2Amount) internal {
        vm.startPrank(lp1);
        IERC20(USDC).approve(address(v), lp1Amount);
        v.deposit(lp1Amount, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        IERC20(USDC).approve(address(v), lp2Amount);
        v.deposit(lp2Amount, lp2);
        vm.stopPrank();
    }

    // ── Clone and initialize a strategy template ──

    function _cloneAndInit(address template, bytes memory initData) internal returns (address clone) {
        clone = Clones.clone(template);
        (bool success,) = clone.call(
            abi.encodeWithSignature("initialize(address,address,bytes)", address(vault), agent, initData)
        );
        require(success, "Strategy initialization failed");
    }

    // ── Propose, vote, advance to executable ──

    function _proposeVoteApprove(
        BatchExecutorLib.Call[] memory execCalls,
        BatchExecutorLib.Call[] memory settleCalls,
        uint256 feeBps,
        uint256 duration
    ) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://test", feeBps, duration, execCalls, settleCalls, _emptyCoProposers()
        );

        vm.warp(block.timestamp + 1);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Warp past voting period
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        vm.warp(block.timestamp + params.votingPeriod + 1);

        // Open guardian review (permissionless)
        registry.openReview(proposalId);

        // Warp past review period
        uint256 reviewPeriod = registry.reviewPeriod();
        vm.warp(block.timestamp + reviewPeriod + 1);

        // Resolve review (cohortTooSmall short-circuit if no guardians staked)
        registry.resolveReview(proposalId);

        // Now executable
        governor.executeProposal(proposalId);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd contracts && forge build 2>&1 | tail -5`
Expected: Compiles cleanly

- [ ] **Step 3: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/test/integration/HyperEVMIntegrationTest.sol
git commit -m "test(integration): HyperEVMIntegrationTest abstract base"
```

---

### Task 7: Write `HyperliquidGridFork.t.sol` — full lifecycle tests

**Files:**
- Create: `contracts/test/integration/HyperliquidGridFork.t.sol`

- [ ] **Step 1: Create the test file with the first happy-path lifecycle test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HyperEVMIntegrationTest} from "./HyperEVMIntegrationTest.sol";
import {HyperliquidGridStrategy} from "../../src/strategies/HyperliquidGridStrategy.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @title HyperliquidGridFork
 * @notice Full syndicate lifecycle on a HyperEVM mainnet fork using the real
 *         CoreWriter precompile (events emit on the fork — HyperCore can't
 *         process them, so USDC stays in the strategy and `sweepToVault()`
 *         returns it to the vault).
 */
contract HyperliquidGridForkTest is HyperEVMIntegrationTest {
    uint256 constant DEPOSIT = 50_000e6;
    uint32 constant LEVERAGE = 5;
    uint256 constant MAX_ORDER_SIZE = 10_000e6;
    uint32 constant MAX_ORDERS = 32;
    uint256 constant DURATION = 7 days;

    function setUp() public override {
        super.setUp();
        vault = _createSyndicate();
        _fundAndDeposit(vault, 60_000e6, 40_000e6);
        vm.warp(block.timestamp + 1); // snapshot block in the past for voting
    }

    function _initData() internal pure returns (bytes memory) {
        uint32[] memory assets = new uint32[](3);
        assets[0] = HL_BTC;
        assets[1] = HL_ETH;
        assets[2] = HL_SOL;
        return abi.encode(USDC, DEPOSIT, LEVERAGE, MAX_ORDER_SIZE, MAX_ORDERS, assets);
    }

    function _execAndSettleCalls(address clone)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle)
    {
        exec = new BatchExecutorLib.Call[](2);
        exec[0] = BatchExecutorLib.Call({
            target: USDC,
            data: abi.encodeCall(IERC20.approve, (clone, DEPOSIT)),
            value: 0
        });
        exec[1] = BatchExecutorLib.Call({
            target: clone,
            data: abi.encodeWithSignature("execute()"),
            value: 0
        });

        settle = new BatchExecutorLib.Call[](1);
        settle[0] = BatchExecutorLib.Call({
            target: clone,
            data: abi.encodeWithSignature("settle()"),
            value: 0
        });
    }

    function test_fullLifecycle_placeGridAndSettle() public {
        // 1. Clone + init strategy
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);

        // 2. Build proposal calls
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);

        // 3. Propose, vote, advance to executable, execute
        uint256 vaultBalanceBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // 4. Verify execute drained vault into strategy
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBalanceBefore - DEPOSIT, "vault drained");
        assertEq(IERC20(USDC).balanceOf(clone), DEPOSIT, "strategy holds DEPOSIT");

        // 5. Agent calls updateParams(ACTION_PLACE_GRID, ...) with 30 GTC orders
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](6);
        orders[0] = _gridOrder(HL_BTC, true, 76000_0, 1000, 1);  // BTC limitPx scaled
        orders[1] = _gridOrder(HL_BTC, false, 78000_0, 1000, 2);
        orders[2] = _gridOrder(HL_ETH, true, 2300_00, 100, 3);
        orders[3] = _gridOrder(HL_ETH, false, 2400_00, 100, 4);
        orders[4] = _gridOrder(HL_SOL, true, 85_0000, 100, 5);
        orders[5] = _gridOrder(HL_SOL, false, 90_0000, 100, 6);
        bytes memory placeData = abi.encode(uint8(1), orders);

        vm.recordLogs();
        vm.prank(agent);
        strategy.updateParams(placeData);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Each order emits one RawAction event from CORE_WRITER + one GridOrderPlaced from strategy
        uint256 rawActionCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER) rawActionCount++;
        }
        assertEq(rawActionCount, 6, "6 RawAction events");

        // 6. Warp past strategy duration, settle
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);

        // 7. Sweep — strategy USDC returns to vault (still has DEPOSIT since fork can't move it)
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(clone), 0, "strategy drained");
        assertGt(IERC20(USDC).balanceOf(address(vault)), 0, "vault refilled");

        // 8. LPs redeem proportional shares
        uint256 lp1Shares = vault.balanceOf(lp1);
        uint256 lp2Shares = vault.balanceOf(lp2);

        vm.prank(lp1);
        vault.redeem(lp1Shares, lp1, lp1);
        vm.prank(lp2);
        vault.redeem(lp2Shares, lp2, lp2);

        // Total returned ≈ deposited (no on-chain loss since HyperCore didn't process anything)
        assertApproxEqAbs(IERC20(USDC).balanceOf(lp1) + IERC20(USDC).balanceOf(lp2), 100_000e6, 100, "lps redeemed");
    }

    function _gridOrder(uint32 ai, bool isBuy, uint64 px, uint64 sz, uint128 cloid)
        internal
        pure
        returns (HyperliquidGridStrategy.GridOrder memory)
    {
        return HyperliquidGridStrategy.GridOrder({assetIndex: ai, isBuy: isBuy, limitPx: px, sz: sz, cloid: cloid});
    }
}
```

- [ ] **Step 2: Run the first test**

Run: `cd contracts && forge test --fork-url $HYPEREVM_RPC_URL --match-test test_fullLifecycle_placeGridAndSettle -vv 2>&1 | tail -25`
Expected: Test passes (or skips if HYPEREVM_RPC_URL is not set — `vm.skip(true)` handles that)

- [ ] **Step 3: Add the cancel-and-place rebalance test**

Append to the test contract:

```solidity
    function test_fullLifecycle_cancelAndPlaceRebalance() public {
        // Setup through initial place
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // Initial place (BTC only, 2 orders)
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](2);
        orders[0] = _gridOrder(HL_BTC, true, 76000_0, 1000, 100);
        orders[1] = _gridOrder(HL_BTC, false, 78000_0, 1000, 101);
        vm.prank(agent);
        strategy.updateParams(abi.encode(uint8(1), orders));

        // Cancel-and-place rebalance: cancel old CLOIDs, place new ones
        uint128[] memory oldCloids = new uint128[](2);
        oldCloids[0] = 100;
        oldCloids[1] = 101;
        HyperliquidGridStrategy.GridOrder[] memory newOrders = new HyperliquidGridStrategy.GridOrder[](2);
        newOrders[0] = _gridOrder(HL_BTC, true, 77000_0, 1000, 200);
        newOrders[1] = _gridOrder(HL_BTC, false, 79000_0, 1000, 201);

        vm.recordLogs();
        vm.prank(agent);
        strategy.updateParams(abi.encode(uint8(3), HL_BTC, oldCloids, newOrders));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Expect 4 RawAction events: 2 cancels + 2 places
        uint256 rawActionCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER) rawActionCount++;
        }
        assertEq(rawActionCount, 4, "2 cancels + 2 places");

        // Settle + sweep happy path
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(clone), 0);
    }
```

- [ ] **Step 4: Run the second test**

Run: `cd contracts && forge test --fork-url $HYPEREVM_RPC_URL --match-test test_fullLifecycle_cancelAndPlaceRebalance -vv 2>&1 | tail -25`
Expected: Test passes

- [ ] **Step 5: Add the lossy-strategy test**

Append:

```solidity
    function test_fullLifecycle_lossyStrategyStillReturnsFunds() public {
        // Setup through execute
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // Simulate a loss: drain most of the strategy's USDC to a burn address
        address burn = makeAddr("burn");
        uint256 leftover = 1_000e6; // strategy "lost" 49,000 USDC
        vm.prank(clone);
        IERC20(USDC).transfer(burn, DEPOSIT - leftover);
        assertEq(IERC20(USDC).balanceOf(clone), leftover, "strategy down to leftover");

        // Settle + sweep — must succeed despite the "loss"
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBefore + leftover, "vault gets remainder");
        assertEq(strategy.cumulativeSwept(), leftover, "cumulativeSwept advances");

        // LPs can still redeem proportional shares against the diminished vault
        uint256 lp1Shares = vault.balanceOf(lp1);
        vm.prank(lp1);
        uint256 lp1Got = vault.redeem(lp1Shares, lp1, lp1);
        assertGt(lp1Got, 0, "lp1 redeems non-zero (proportional to remaining)");
    }
```

- [ ] **Step 6: Run the third test**

Run: `cd contracts && forge test --fork-url $HYPEREVM_RPC_URL --match-test test_fullLifecycle_lossyStrategyStillReturnsFunds -vv 2>&1 | tail -25`
Expected: Test passes — proves the `minReturnAmount` removal works

- [ ] **Step 7: Run the full integration suite**

Run: `cd contracts && forge test --fork-url $HYPEREVM_RPC_URL --match-contract HyperliquidGridForkTest -vv 2>&1 | tail -25`
Expected: All 3 tests pass

- [ ] **Step 8: Verify the unit suite still passes (no regression)**

Run: `cd contracts && forge test --no-match-path "test/integration/**" 2>&1 | tail -5`
Expected: All ~740 tests pass

- [ ] **Step 9: Run `forge fmt`**

Run: `cd contracts && forge fmt`

- [ ] **Step 10: Commit**

```bash
cd /home/ana/code/sherwood
git add contracts/test/integration/HyperliquidGridFork.t.sol
git commit -m "test(integration): HyperliquidGridFork — 3 lifecycle tests on HyperEVM fork"
```

---

### Task 8: Push branch + open PR

- [ ] **Step 1: Push the branch**

```bash
cd /home/ana/code/sherwood
git push origin test/hyperliquid-fork-integration
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --repo sherwoodagent/sherwood --base main --head test/hyperliquid-fork-integration \
  --title "test(integration): HyperEVM fork tests for grid + minReturnAmount removal" \
  --body "$(cat <<'EOF'
## Summary

- Adds HyperEVM mainnet fork integration tests for `HyperliquidGridStrategy` covering the full syndicate lifecycle (deposit → propose → vote → guardian review → execute → grid orders → settle → sweep → redeem).
- Drops `minReturnAmount` from both `HyperliquidGridStrategy` and `HyperliquidPerpStrategy`. The previous behavior permanently locked vault funds when the strategy lost money (every sweep call reverted forever). Lossy strategies must always be able to return whatever remains.
- Refactors `Deploy.s.sol` and `DeployTemplates.s.sol` to expose internal `_deployCore()` / `_deployHyperliquidGridTemplate()` helpers so fork tests can deploy without writing to `chains/{chainId}.json`.

## Test plan

- [x] `forge test --no-match-path "test/integration/**"` — unit suite passes (no regression)
- [x] `forge test --fork-url \$HYPEREVM_RPC_URL --match-contract HyperliquidGridForkTest` — 3 fork lifecycle tests pass
- [x] `forge build --sizes` — both Hyperliquid strategies under EIP-170

## Spec & plan

- Design: `docs/superpowers/specs/2026-04-30-hyperliquid-fork-integration-design.md`
- Plan: `docs/superpowers/plans/2026-04-30-hyperliquid-fork-integration.md`

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```
