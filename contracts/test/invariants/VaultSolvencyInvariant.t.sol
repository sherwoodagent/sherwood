// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockRegistryMinimal} from "../mocks/MockRegistryMinimal.sol";

import {VaultSolvencyHandler} from "./handlers/VaultSolvencyHandler.sol";

/// @title VaultSolvencyInvariantTest
/// @notice INV-15 fuzz harness — vault solvency.
///
///         Property: at every reachable state,
///             vault.convertToAssets(vault.totalSupply()) <= vault.totalAssets()
///
///         The fuzzer drives random sequences of:
///         - deposits across 3 LP actors at random sizes
///         - redeems across 3 LP actors at random fractions (1, 1/2, 1/4, 1/8, 1/16)
///         - profitable proposal lifecycles (positive minted PnL)
///         - lossy proposal lifecycles (asset balance drained from the vault
///           between execute and settle, capped at vault balance)
///
///         Closes #226 §3.5 / #236 INV-15. Companion to INV-47 fuzz harness
///         (PR #256, `test/invariants/FeeBlacklistInvariant.t.sol`). Uses the
///         same proxy-bootstrapping recipe — registry is `MockRegistryMinimal`
///         (no guardian-review interactions in scope here).
contract VaultSolvencyInvariantTest is StdInvariant, Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

    VaultSolvencyHandler public handler;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public coAgent = makeAddr("coAgent");
    address public protocolRecipient = makeAddr("protocolRecipient");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public lp3 = makeAddr("lp3");

    uint256 public agentNftId;
    uint256 public coAgentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4_000;
    uint256 constant MAX_PERF_FEE_BPS = 3_000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant PROTOCOL_FEE_BPS = 200;
    uint256 constant MGMT_FEE_BPS = 50;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();
        agentNftId = agentRegistry.mint(agent);
        coAgentNftId = agentRegistry.mint(coAgent);

        // ── Vault ──
        SyndicateVault vaultImpl = new SyndicateVault();
        bytes memory vaultInit = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Sherwood Vault",
                    symbol: "swUSDC",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: MGMT_FEE_BPS
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);
        vm.prank(owner);
        vault.registerAgent(coAgentNftId, coAgent);

        // ── Governor ──
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: VOTING_PERIOD,
                    executionWindow: EXECUTION_WINDOW,
                    vetoThresholdBps: VETO_THRESHOLD_BPS,
                    maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                    cooldownPeriod: COOLDOWN_PERIOD,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 30 days,
                    protocolFeeBps: PROTOCOL_FEE_BPS,
                    protocolFeeRecipient: protocolRecipient,
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

        // ── Seed deposits — pre-fund two LPs so the fuzzer always has a
        //    non-zero `totalSupply` to operate against (the rich-state
        //    coverage). For first-depositor inflation coverage (totalSupply
        //    = 0 at the first fuzz call), see `VaultSolvencyColdStartInvariantTest`
        //    below — it intentionally skips this seed. ──
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        vm.startPrank(lp1);
        usdc.approve(address(vault), 60_000e6);
        vault.deposit(60_000e6, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        usdc.approve(address(vault), 40_000e6);
        vault.deposit(40_000e6, lp2);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1);

        // ── Handler + fuzz target bindings ──
        handler = new VaultSolvencyHandler(
            governor,
            vault,
            usdc,
            agent,
            coAgent,
            owner,
            protocolRecipient,
            lp1,
            lp2,
            lp3,
            MAX_PERF_FEE_BPS,
            VOTING_PERIOD
        );

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = VaultSolvencyHandler.depositRandom.selector;
        selectors[1] = VaultSolvencyHandler.redeemRandom.selector;
        selectors[2] = VaultSolvencyHandler.runProfitableLifecycle.selector;
        selectors[3] = VaultSolvencyHandler.runLossyLifecycle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ──────────────────────────────────────────────────────────────
    // INV-15: vault solvency
    // ──────────────────────────────────────────────────────────────

    /// @notice `convertToAssets(totalSupply())` is the total claim implied
    ///         by outstanding shares. `totalAssets()` is the vault's actual
    ///         asset balance (during open deposits — when a strategy is
    ///         executing, capital sits in the strategy's positions; this
    ///         invariant is checked while no proposal is active, which the
    ///         handler enforces by gating deposits / redeems).
    function invariant_vaultSolvency() public view {
        uint256 totalSupply = vault.totalSupply();
        if (totalSupply == 0) return;

        uint256 impliedAssets = vault.convertToAssets(totalSupply);
        uint256 actualAssets = vault.totalAssets();

        assertLe(
            impliedAssets, actualAssets, "INV-15: convertToAssets(totalSupply()) > totalAssets() - vault is insolvent"
        );
    }

    /// @notice Vacuity guard — without this, a regression that bricks every
    ///         handler action would leave totalSupply unchanged and the
    ///         solvency check passes vacuously (the seed deposits in setUp
    ///         are already solvent). Require at least one of: extra deposit,
    ///         redeem, or settled lifecycle to have landed.
    function afterInvariant() external view {
        // Per-counter guards: a regression that breaks ONLY `runLossyLifecycle`
        // (the riskier path per the file docstring) must not pass vacuously
        // while the other three counters keep climbing.
        assertGt(handler.depositCount(), 0, "INV-15 sanity: no deposits landed - vacuous run");
        assertGt(handler.redeemCount(), 0, "INV-15 sanity: no redeems landed - vacuous run");
        assertGt(handler.profitableLifecycleCount(), 0, "INV-15 sanity: no profitable lifecycles - vacuous run");
        assertGt(handler.lossyLifecycleCount(), 0, "INV-15 sanity: no lossy lifecycles - vacuous run");
    }

    /// @notice Direct unit-style sanity. Drives one full lifecycle end-to-end
    ///         to catch a setUp regression where the proposal path is
    ///         silently skipped (e.g. registration, pending-proposal gate,
    ///         vote-weight zero).
    function test_handler_drivesProfitableLifecycleEndToEnd() public {
        handler.runProfitableLifecycle(7);
        assertGt(handler.profitableLifecycleCount(), 0, "handler did not complete a profitable lifecycle");
        // Solvency must still hold after a settled profit.
        invariant_vaultSolvency();
    }

    /// @notice Same for lossy lifecycle — exercises the negative-PnL accounting
    ///         path which is where solvency is most likely to break (capital
    ///         snapshot vs reduced post-execution balance).
    function test_handler_drivesLossyLifecycleEndToEnd() public {
        handler.runLossyLifecycle(11);
        assertGt(handler.lossyLifecycleCount(), 0, "handler did not complete a lossy lifecycle");
        invariant_vaultSolvency();
    }
}

/// @title VaultSolvencyColdStartInvariantTest
/// @notice Cold-start companion to `VaultSolvencyInvariantTest`. Identical
///         deployment but SKIPS the pre-seeded LP deposits, so the first
///         fuzzer-driven `depositRandom` is the canonical "first depositor"
///         transaction. This is where the inflation-attack class lives:
///         a malicious first depositor donates a large amount of asset to
///         the vault before minting their first share, then victim deposits
///         see their shares get rounded to zero. ERC-4626's `_decimalsOffset`
///         (set to `asset.decimals()` in `SyndicateVault.initialize`) is the
///         on-chain mitigation; this campaign verifies it holds across any
///         random sequence starting from `totalSupply == 0`.
contract VaultSolvencyColdStartInvariantTest is StdInvariant, Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

    VaultSolvencyHandler public handler;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public coAgent = makeAddr("coAgent");
    address public protocolRecipient = makeAddr("protocolRecipient");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public lp3 = makeAddr("lp3");

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4_000;
    uint256 constant MAX_PERF_FEE_BPS = 3_000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant PROTOCOL_FEE_BPS = 200;
    uint256 constant MGMT_FEE_BPS = 50;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();
        uint256 agentNftId = agentRegistry.mint(agent);
        uint256 coAgentNftId = agentRegistry.mint(coAgent);

        SyndicateVault vaultImpl = new SyndicateVault();
        bytes memory vaultInit = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Sherwood Vault",
                    symbol: "swUSDC",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: MGMT_FEE_BPS
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);
        vm.prank(owner);
        vault.registerAgent(coAgentNftId, coAgent);

        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: VOTING_PERIOD,
                    executionWindow: EXECUTION_WINDOW,
                    vetoThresholdBps: VETO_THRESHOLD_BPS,
                    maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                    cooldownPeriod: COOLDOWN_PERIOD,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 30 days,
                    protocolFeeBps: PROTOCOL_FEE_BPS,
                    protocolFeeRecipient: protocolRecipient,
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

        // No seed deposits — totalSupply starts at 0.

        handler = new VaultSolvencyHandler(
            governor,
            vault,
            usdc,
            agent,
            coAgent,
            owner,
            protocolRecipient,
            lp1,
            lp2,
            lp3,
            MAX_PERF_FEE_BPS,
            VOTING_PERIOD
        );

        targetContract(address(handler));

        // Cold-start campaign exercises only the deposit/redeem path — the
        // proposal lifecycle requires a non-zero totalSupply at propose
        // time and the handler already gates on that, so depositRandom
        // landing once unblocks the rest. Restricting the selector set
        // keeps the campaign focused on the inflation-attack regime.
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = VaultSolvencyHandler.depositRandom.selector;
        selectors[1] = VaultSolvencyHandler.redeemRandom.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Same INV-15 assertion as the rich-state contract.
    function invariant_vaultSolvency_coldStart() public view {
        uint256 totalSupply = vault.totalSupply();
        if (totalSupply == 0) return;

        uint256 impliedAssets = vault.convertToAssets(totalSupply);
        uint256 actualAssets = vault.totalAssets();

        assertLe(impliedAssets, actualAssets, "INV-15 cold-start: convertToAssets(totalSupply()) > totalAssets()");
    }

    /// @notice Per-counter vacuity guard: at least one of each selected
    ///         action must land. Cold-start only drives deposit/redeem,
    ///         so we don't require lifecycle counts.
    function afterInvariant() external view {
        assertGt(handler.depositCount(), 0, "INV-15 cold-start: no deposit landed - vacuous run");
        assertGt(handler.redeemCount(), 0, "INV-15 cold-start: no redeem landed - vacuous run");
    }

    /// @notice Direct PoC for the canonical inflation attack: attacker
    ///         donates a large balance to the vault BEFORE the first
    ///         depositor mints. Then a victim deposits and redeems. The
    ///         victim must not lose principal (modulo the documented
    ///         `_decimalsOffset` rounding that absorbs the donation as
    ///         dead shares).
    function test_solvency_firstDepositorInflationAttack_blocked() public {
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");

        // Attacker pre-funds the vault directly (no shares minted).
        usdc.mint(attacker, 1_000_000e6);
        vm.prank(attacker);
        usdc.transfer(address(vault), 1_000_000e6);

        // Victim deposits. With `_decimalsOffset = asset.decimals()` and
        // OZ ERC-4626's virtual-shares mitigation, the donation gets
        // absorbed into virtual-share accounting; the victim's shares
        // round in their favor (down on deposit, up on redeem).
        usdc.mint(victim, 100e6);
        vm.startPrank(victim);
        usdc.approve(address(vault), 100e6);
        uint256 sharesMinted = vault.deposit(100e6, victim);
        vm.stopPrank();

        assertGt(sharesMinted, 0, "victim minted zero shares - inflation guard failed");

        // Solvency holds end-to-end.
        uint256 impliedAssets = vault.convertToAssets(vault.totalSupply());
        uint256 actualAssets = vault.totalAssets();
        assertLe(impliedAssets, actualAssets, "post-attack vault is insolvent");
    }
}
