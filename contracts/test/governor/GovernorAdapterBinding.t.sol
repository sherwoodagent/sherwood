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
import {MockStrategyAdapter} from "../mocks/MockStrategyAdapter.sol";

/// @title GovernorAdapterBindingTest
/// @notice Coverage for `bindProposalAdapter` (size-aware redesign: governor
///         pushes adapter onto vault directly, no governor-side mapping;
///         vault `totalAssets` ignores stale pointers via lock-gated read).
///         See Task 11 of the live-NAV plan.
contract GovernorAdapterBindingTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public targetToken;
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
    uint256 constant MAX_STRATEGY_DURATION = 30 days;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
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
                    managementFeeBps: 50
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
                    protocolFeeBps: 200,
                    protocolFeeRecipient: owner,
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        // Vault reads governor via factory.governor() — this test contract acts as the factory.
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(governor)));

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

    // ==================== HELPERS ====================

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory cs = new BatchExecutorLib.Call[](1);
        cs[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        return cs;
    }

    function _settleCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory cs = new BatchExecutorLib.Call[](1);
        cs[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return cs;
    }

    function _propose() internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://test", 1500, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers()
        );
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    function _proposeAndApprove() internal returns (uint256 proposalId) {
        proposalId = _propose();
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
    }

    function _proposeAndExecute() internal returns (uint256 proposalId) {
        proposalId = _proposeAndApprove();
        governor.executeProposal(proposalId);
    }

    // ==================== TESTS ====================

    function test_bindProposalAdapter_proposerOnly() public {
        uint256 proposalId = _propose();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotProposer.selector);
        governor.bindProposalAdapter(proposalId, address(adapter));
    }

    function test_bindProposalAdapter_setsAndEmits() public {
        uint256 proposalId = _propose();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.expectEmit(true, true, false, false, address(governor));
        emit ISyndicateGovernor.ProposalAdapterBound(proposalId, address(adapter));
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(adapter));
        // Bind pushes synchronously to the vault.
        assertEq(vault.activeStrategyAdapter(), address(adapter));
    }

    function test_bindProposalAdapter_zeroAddressUnbinds() public {
        uint256 proposalId = _propose();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(adapter));
        assertEq(vault.activeStrategyAdapter(), address(adapter));
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(0));
        assertEq(vault.activeStrategyAdapter(), address(0));
    }

    function test_bindProposalAdapter_overwritesExisting() public {
        uint256 proposalId = _propose();
        MockStrategyAdapter a1 = new MockStrategyAdapter();
        MockStrategyAdapter a2 = new MockStrategyAdapter();
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(a1));
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(a2));
        assertEq(vault.activeStrategyAdapter(), address(a2));
    }

    function test_bindProposalAdapter_postExecuteReverts() public {
        uint256 proposalId = _proposeAndExecute();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.AdapterBindingClosed.selector);
        governor.bindProposalAdapter(proposalId, address(adapter));
    }

    function test_executeProposal_preservesBoundAdapter() public {
        uint256 proposalId = _proposeAndApprove();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(adapter));
        // Already bound on the vault before execute.
        assertEq(vault.activeStrategyAdapter(), address(adapter));

        governor.executeProposal(proposalId);

        // Execute does not touch the adapter — still bound.
        assertEq(vault.activeStrategyAdapter(), address(adapter));
    }

    function test_executeProposal_noAdapterIsBenign() public {
        // Standard flow with no bindProposalAdapter call — vault adapter must remain unset.
        uint256 proposalId = _proposeAndApprove();
        governor.executeProposal(proposalId);
        assertEq(vault.activeStrategyAdapter(), address(0));
    }

    function test_settleProposal_implicitlyClearsAdapter() public {
        uint256 proposalId = _proposeAndApprove();
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        // Adapter NAV would be 9_999e6 if read.
        adapter.setValue(9_999e6, true);
        vm.prank(agent);
        governor.bindProposalAdapter(proposalId, address(adapter));
        governor.executeProposal(proposalId);
        assertEq(vault.activeStrategyAdapter(), address(adapter));

        // Proposer can settle anytime
        vm.prank(agent);
        governor.settleProposal(proposalId);

        // Implicit clear: storage pointer remains, but `redemptionsLocked()`
        // is false post-settle so `totalAssets` short-circuits to float-only.
        assertFalse(vault.redemptionsLocked());
        // Behaviorally cleared — totalAssets returns float, not adapter NAV.
        assertEq(vault.totalAssets(), 100_000e6);
    }
}
