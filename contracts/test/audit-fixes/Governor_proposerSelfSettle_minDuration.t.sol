// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockRegistryMinimal} from "../mocks/MockRegistryMinimal.sol";

/// @title Governor_proposerSelfSettle_minDuration — MS-H3 regression
/// @notice Confirms the proposer's self-settle fast-path requires at least
///         `MIN_STRATEGY_DURATION_BEFORE_SELF_SETTLE` (1 hour) elapsed since
///         execute, blocking the same-block execute → settle skim where a
///         proposer captured `performanceFeeBps` on a one-block trade.
contract Governor_proposerSelfSettle_minDuration_Test is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant MAX_STRATEGY_DURATION = 30 days;
    uint256 constant MIN_SELF_SETTLE = 1 hours;

    uint256 constant STRATEGY_DURATION = 7 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();
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
                    maxStrategyDuration: MAX_STRATEGY_DURATION,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

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
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal pure returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: address(0xdead), data: "", value: 0});
        return calls;
    }

    function _settleCalls() internal pure returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: address(0xdead), data: "", value: 0});
        return calls;
    }

    function _createAndExecute() internal returns (uint256 pid) {
        vm.prank(agent);
        pid = governor.propose(
            address(vault),
            "ipfs://self-settle",
            2000,
            STRATEGY_DURATION,
            _execCalls(),
            _settleCalls(),
            _emptyCoProposers()
        );
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        governor.executeProposal(pid);
    }

    /// @notice MS-H3: proposer cannot self-settle in the same block as execute.
    function test_proposerSelfSettle_sameBlock_reverts() public {
        uint256 pid = _createAndExecute();

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.settleProposal(pid);
    }

    /// @notice MS-H3: proposer self-settle reverts up to 1 second before
    ///         `MIN_STRATEGY_DURATION_BEFORE_SELF_SETTLE`.
    function test_proposerSelfSettle_belowMinDuration_reverts() public {
        uint256 pid = _createAndExecute();

        // Warp to just before the min-duration cutoff.
        vm.warp(vm.getBlockTimestamp() + MIN_SELF_SETTLE - 1);

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.settleProposal(pid);
    }

    /// @notice MS-H3: at exactly `MIN_STRATEGY_DURATION_BEFORE_SELF_SETTLE`
    ///         elapsed, the proposer fast-path succeeds.
    function test_proposerSelfSettle_atMinDuration_succeeds() public {
        uint256 pid = _createAndExecute();

        vm.warp(vm.getBlockTimestamp() + MIN_SELF_SETTLE);

        vm.prank(agent);
        governor.settleProposal(pid);

        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    /// @notice MS-H3: non-proposer caller still must wait the full
    ///         `strategyDuration` — the fast-path is proposer-only.
    function test_nonProposer_atMinDuration_reverts() public {
        uint256 pid = _createAndExecute();

        // Past the proposer min-duration but well before strategyDuration.
        vm.warp(vm.getBlockTimestamp() + MIN_SELF_SETTLE);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.settleProposal(pid);
    }

    /// @notice MS-H3: non-proposer caller succeeds at full strategyDuration
    ///         — original semantics preserved.
    function test_nonProposer_atStrategyDuration_succeeds() public {
        uint256 pid = _createAndExecute();

        vm.warp(vm.getBlockTimestamp() + STRATEGY_DURATION + 1);

        vm.prank(random);
        governor.settleProposal(pid);

        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }
}
