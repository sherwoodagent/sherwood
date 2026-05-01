// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../../src/interfaces/IGuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

/// @title Governor_emergencyCancelOnSettle — MS-H2 regression
/// @notice Confirms `_finishSettlement` no longer auto-cancels an open
///         emergency review. Without this fix, a vault owner who opened
///         `emergencySettleWithCalls` and saw block-votes accruing could race
///         a `settleProposal` to wipe the registry's emergency state and
///         dodge the slash. After the fix, `settleProposal` leaves the
///         emergency review intact; `resolveEmergencyReview` resolves it at
///         `reviewEnd` based on actual block votes — slashing the owner if
///         guardians reached quorum.
contract Governor_emergencyCancelOnSettle_Test is Test {
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
    address public guardianA = makeAddr("guardianA");
    address public guardianB = makeAddr("guardianB");
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
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%
    uint256 constant GUARDIAN_STAKE = 30_000e18;

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

        // Predict registry address: govImpl(+0), govProxy(+1), regImpl(+2), regProxy(+3).
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
        wood.mint(guardianA, 100_000e18);
        wood.mint(guardianB, 100_000e18);

        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.prank(factoryEoa);
        registry.bindOwnerStake(owner, address(vault));

        vm.prank(guardianA);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(guardianA);
        registry.stakeAsGuardian(GUARDIAN_STAKE, 1);
        vm.prank(guardianB);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(guardianB);
        registry.stakeAsGuardian(GUARDIAN_STAKE, 2);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        return calls;
    }

    function _settleCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    function _customCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    function _createExecutedProposal(uint256 duration) internal returns (uint256 pid) {
        vm.prank(agent);
        pid = governor.propose(
            address(vault), "ipfs://emergency-cancel", 1000, duration, _execCalls(), _settleCalls(), _emptyCoProposers()
        );
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        governor.executeProposal(pid);
    }

    /// @notice MS-H2: when an emergency review is open with block votes near
    ///         quorum, a `settleProposal` call MUST NOT auto-cancel the
    ///         emergency review. The owner cannot dodge the slash by racing
    ///         a normal settle.
    function test_settleProposal_doesNotCancelOpenEmergency_whenBlockVotesPresent() public {
        uint256 pid = _createExecutedProposal(7 days);

        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Owner opens emergency settle.
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertTrue(registry.isEmergencyOpen(pid), "emergency review opened");

        // Both guardians vote block (60k / 60k = 100% ≥ 30% quorum).
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);
        vm.prank(guardianB);
        registry.voteBlockEmergencySettle(pid);

        // Anyone (here: lp1) settles via the standard path.
        vm.prank(lp1);
        governor.settleProposal(pid);

        // Proposal is settled — but the emergency review stays open so guardians
        // can still slash via `resolveEmergencyReview`.
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertTrue(registry.isEmergencyOpen(pid), "emergency review NOT auto-cancelled");

        // Warp past reviewEnd and resolve — owner stake gets slashed.
        uint256 stakeBefore = registry.ownerStake(address(vault));
        assertEq(stakeBefore, MIN_OWNER_STAKE);

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        registry.resolveEmergencyReview(pid);

        assertFalse(registry.isEmergencyOpen(pid), "emergency review resolved post-resolve");
        // Slashed because block-quorum was reached.
        assertEq(registry.ownerStake(address(vault)), 0, "owner stake slashed by emergency review");
    }

    /// @notice MS-H2 negative case: when an emergency review is open with NO
    ///         block votes, a normal settle still leaves the review open
    ///         (resolves harmlessly at reviewEnd). The owner is NOT slashed.
    function test_settleProposal_doesNotCancelOpenEmergency_whenNoBlockVotes() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Owner opens emergency, no guardians vote block.
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        vm.prank(lp1);
        governor.settleProposal(pid);

        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        // Emergency review is no longer cleared by settle (post-fix).
        assertTrue(registry.isEmergencyOpen(pid), "emergency review still open after settle");

        uint256 stakeBefore = registry.ownerStake(address(vault));
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        registry.resolveEmergencyReview(pid);

        // No block votes → not slashed.
        assertEq(registry.ownerStake(address(vault)), stakeBefore, "owner not slashed without block votes");
        assertFalse(registry.isEmergencyOpen(pid), "emergency review resolved");
    }

    /// @notice MS-H2: the owner can still cleanly withdraw a non-malicious
    ///         emergency via `cancelEmergencySettle` — that path is unchanged.
    function test_owner_canStillCancelEmergency_explicitly() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertTrue(registry.isEmergencyOpen(pid));

        vm.prank(owner);
        governor.cancelEmergencySettle(pid);

        assertFalse(registry.isEmergencyOpen(pid), "owner-initiated cancel still works");
    }
}
