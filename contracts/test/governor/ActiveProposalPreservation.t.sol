// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

/// @title ActiveProposalPreservation.t
/// @notice Regression tests for **G-C2 / G-C3** — the historical bug where
///         `cancelProposal` / `vetoProposal` / `emergencyCancel` blindly called
///         `delete _activeProposal[proposal.vault]`. If proposal A was already
///         `Executed` on the vault (so `_activeProposal[V] == A`) and a later,
///         unrelated proposal B reached Pending state, cancelling/vetoing B
///         would wipe the pointer to A — silently unlocking redemptions and
///         stranding the live strategy.
///
///         The fix (commits `ef5cf55` + `770a929`) narrowed the cancel paths
///         to Draft/Pending only and removed the blanket `delete`. Now only
///         `executeProposal` writes to `_activeProposal`, and only
///         `_finishSettlement` clears it.
///
///         These tests pin the behaviour: driving A to `Executed`, creating
///         an unrelated B on the same vault, and cancelling B via each of the
///         three paths must leave `_activeProposal[V] == A` untouched.
contract ActiveProposalPreservationTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    GuardianRegistry public registry;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public wood;
    ERC20Mock public targetToken;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");

    address public g1 = makeAddr("guardian1");
    address public g2 = makeAddr("guardian2");
    address public g3 = makeAddr("guardian3");
    address public g4 = makeAddr("guardian4");
    address public g5 = makeAddr("guardian5");

    address public factoryEoa;
    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000;
    uint256 constant GUARDIAN_STAKE = 20_000e18;

    function setUp() public {
        factoryEoa = address(this);

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        agentNftId = agentRegistry.mint(agent);

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
                    managementFeeBps: 0
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);

        // Governor + registry — circular init dep resolved by predicting the
        // registry proxy via `vm.computeCreateAddress`: govImpl (+0),
        // govProxy (+1), regImpl (+2), regProxy (+3).
        uint256 baseNonce = vm.getNonce(address(this));
        address predictedRegistryProxy = vm.computeCreateAddress(address(this), baseNonce + 3);

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
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                predictedRegistryProxy
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

        GuardianRegistry regImpl = new GuardianRegistry();
        bytes memory regInit = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                address(governor),
                factoryEoa,
                address(wood),
                MIN_GUARDIAN_STAKE,
                MIN_OWNER_STAKE,
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(regImpl), regInit)));
        require(address(registry) == predictedRegistryProxy, "registry addr mismatch");

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

        wood.mint(owner, 100_000e18);
        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.prank(factoryEoa);
        registry.bindOwnerStake(owner, address(vault));

        _stakeGuardian(g1, GUARDIAN_STAKE, 1);
        _stakeGuardian(g2, GUARDIAN_STAKE, 2);
        _stakeGuardian(g3, GUARDIAN_STAKE, 3);
        _stakeGuardian(g4, GUARDIAN_STAKE, 4);
        _stakeGuardian(g5, GUARDIAN_STAKE, 5);
    }

    function _stakeGuardian(address who, uint256 amount, uint256 agentId) internal {
        wood.mint(who, amount);
        vm.prank(who);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(who);
        registry.stakeAsGuardian(amount, agentId);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
    }

    function _settleCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
    }

    function _propose(string memory uri) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId =
            governor.propose(address(vault), uri, 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers());
    }

    function _voteFor(uint256 pid) internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
    }

    /// @dev Drives proposal A all the way to `Executed`. After this returns:
    ///      - `governor.getProposal(A).state == Executed`
    ///      - `governor.getActiveProposal(V) == A`
    ///      - `vault.redemptionsLocked() == true`
    function _driveToExecuted() internal returns (uint256 pidA) {
        pidA = _propose("ipfs://A");
        _voteFor(pidA);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pidA);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        governor.executeProposal(pidA);

        // Sanity: A is live on the vault.
        assertEq(
            uint256(governor.getProposal(pidA).state),
            uint256(ISyndicateGovernor.ProposalState.Executed),
            "A should be Executed"
        );
        assertEq(governor.getActiveProposal(address(vault)), pidA, "_activeProposal[V] == A");
        assertTrue(vault.redemptionsLocked(), "vault locked by A");
    }

    /// @dev Shared post-condition: A still tracked, Executed, vault still locked.
    function _assertAStillLive(uint256 pidA) internal view {
        assertEq(governor.getActiveProposal(address(vault)), pidA, "_activeProposal[V] still == A after cancelling B");
        assertEq(
            uint256(governor.getProposal(pidA).state),
            uint256(ISyndicateGovernor.ProposalState.Executed),
            "A must remain Executed"
        );
        assertTrue(vault.redemptionsLocked(), "vault must remain locked");
    }

    // ──────────────────────────────────────────────────────────────
    // G-C2 / G-C3 regression tests
    // ──────────────────────────────────────────────────────────────

    /// @notice G-M1 supersedes the original G-C2 scenario: creating proposal B
    ///         on a vault that already has a non-terminal proposal A is now
    ///         blocked at `propose` time with `VaultHasOpenProposal`. The
    ///         `_activeProposal[V]` pointer therefore cannot be reached by any
    ///         cancel path targeting a concurrent B. This test pins the new
    ///         invariant: the attack surface is closed at the entry point.
    function test_cancelProposal_preservesActiveProposalOfDifferentPid() public {
        uint256 pidA = _driveToExecuted();

        // Attempt to create a second proposal on the same vault — must revert.
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultHasOpenProposal.selector);
        governor.propose(address(vault), "ipfs://B", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers());

        // A remains live, pointer untouched.
        _assertAStillLive(pidA);
    }

    /// @notice G-M1 supersedes the original G-C3 scenario (vetoProposal path).
    ///         The concurrent-proposal surface is closed before `vetoProposal`
    ///         can be reached on a distinct B; pointer preservation follows
    ///         trivially.
    function test_vetoProposal_preservesActiveProposalOfDifferentPid() public {
        uint256 pidA = _driveToExecuted();

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultHasOpenProposal.selector);
        governor.propose(address(vault), "ipfs://B", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers());

        _assertAStillLive(pidA);
    }

    /// @notice G-M1 supersedes the original G-C3 scenario (emergencyCancel path).
    ///         Same reasoning as above — the concurrent-proposal surface is
    ///         closed at `propose` time.
    function test_emergencyCancel_preservesActiveProposalOfDifferentPid() public {
        uint256 pidA = _driveToExecuted();

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultHasOpenProposal.selector);
        governor.propose(address(vault), "ipfs://B", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers());

        _assertAStillLive(pidA);
    }
}
