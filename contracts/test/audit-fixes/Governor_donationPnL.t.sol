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

/// @title Governor_donationPnL — MS-H1 regression
/// @notice Confirms `_finishSettlement` caps PnL at
///         `_capitalSnapshots[id] * MAX_PNL_RETURN_MULTIPLIER` (10x), so a
///         third party who direct-transfers asset to the vault during the
///         Executed window cannot inflate the proposer's `performanceFeeBps`
///         skim. Excess donation stays in the vault (benefits LPs).
contract Governor_donationPnL_Test is Test {
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
    address public donor = makeAddr("donor");

    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant MAX_STRATEGY_DURATION = 30 days;

    uint256 constant DEPOSIT_LP1 = 60_000e6;
    uint256 constant DEPOSIT_LP2 = 40_000e6;
    uint256 constant SNAPSHOT = DEPOSIT_LP1 + DEPOSIT_LP2; // 100k USDC

    uint256 constant PERF_FEE_BPS = 2000; // 20%
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

        usdc.mint(lp1, DEPOSIT_LP1);
        usdc.mint(lp2, DEPOSIT_LP2);
        vm.startPrank(lp1);
        usdc.approve(address(vault), DEPOSIT_LP1);
        vault.deposit(DEPOSIT_LP1, lp1);
        vm.stopPrank();
        vm.startPrank(lp2);
        usdc.approve(address(vault), DEPOSIT_LP2);
        vault.deposit(DEPOSIT_LP2, lp2);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal pure returns (BatchExecutorLib.Call[] memory) {
        // No-op: empty data triggers fallback / nothing — but we need a non-zero target.
        // Use a self-targeting call that's a no-op (transfer 0 to self).
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
        // No-op execute calls; vault keeps full asset balance during the run.
        vm.prank(agent);
        pid = governor.propose(
            address(vault),
            "ipfs://donation",
            PERF_FEE_BPS,
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
        // MockRegistryMinimal returns reviewPeriod==0 + getReviewState resolved=true, so
        // the vote-end edge maps straight to Approved.
        governor.executeProposal(pid);
    }

    /// @notice MS-H1: a donation 100x the snapshot must NOT inflate
    ///         the proposer's performance fee — PnL is capped at 10x snapshot.
    function test_donation_above10x_isCapped() public {
        uint256 pid = _createAndExecute();

        // Donate 100x the snapshot directly to the vault.
        uint256 donation = SNAPSHOT * 100;
        usdc.mint(donor, donation);
        vm.prank(donor);
        usdc.transfer(address(vault), donation);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        // Settle past the strategy duration (any caller).
        vm.warp(vm.getBlockTimestamp() + STRATEGY_DURATION + 1);
        governor.settleProposal(pid);

        uint256 agentBalAfter = usdc.balanceOf(agent);
        uint256 agentFee = agentBalAfter - agentBalBefore;

        // PnL is capped at SNAPSHOT * 10 = 1,000,000 USDC. Agent perf fee is
        // 20% of the (net of protocol/guardian, which are 0 here) capped PnL.
        // We allow 1 wei rounding slack because of mgmtFee = 0 path.
        uint256 cappedPnL = SNAPSHOT * 10;
        uint256 expectedAgentFee = (cappedPnL * PERF_FEE_BPS) / 10_000;
        assertEq(agentFee, expectedAgentFee, "agent fee must be on capped PnL, not donation-inflated");

        // Sanity: uncapped fee would have been much higher.
        uint256 uncappedFee = (donation * PERF_FEE_BPS) / 10_000;
        assertGt(uncappedFee, expectedAgentFee, "uncapped fee should exceed capped");
    }

    /// @notice MS-H1: donation under 10x is not capped (legitimate yields).
    function test_donation_below10x_isNotCapped() public {
        uint256 pid = _createAndExecute();

        // Donate 5x the snapshot — within the cap.
        uint256 donation = SNAPSHOT * 5;
        usdc.mint(donor, donation);
        vm.prank(donor);
        usdc.transfer(address(vault), donation);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.warp(vm.getBlockTimestamp() + STRATEGY_DURATION + 1);
        governor.settleProposal(pid);

        uint256 agentBalAfter = usdc.balanceOf(agent);
        uint256 agentFee = agentBalAfter - agentBalBefore;

        // Fee is 20% of donation (full PnL within cap).
        uint256 expectedAgentFee = (donation * PERF_FEE_BPS) / 10_000;
        assertEq(agentFee, expectedAgentFee, "below-cap profit must flow through unchanged");
    }

    /// @notice MS-H1: zero-snapshot edge — donation cannot fabricate any fee.
    /// @dev When `snapshot == 0`, the cap is `0 * 10 = 0`, so any donation is
    ///      capped to zero PnL. Agent fee is 0.
    function test_donation_zeroSnapshot_capsToZero() public {
        // Drain vault before propose so snapshot is zero at execute time.
        // Drain via a withdrawal of the LP shares.
        vm.startPrank(lp1);
        vault.redeem(vault.balanceOf(lp1), lp1, lp1);
        vm.stopPrank();
        vm.startPrank(lp2);
        vault.redeem(vault.balanceOf(lp2), lp2, lp2);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 0, "vault drained");

        uint256 pid = _createAndExecute();

        // Donate 1M USDC.
        uint256 donation = 1_000_000e6;
        usdc.mint(donor, donation);
        vm.prank(donor);
        usdc.transfer(address(vault), donation);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.warp(vm.getBlockTimestamp() + STRATEGY_DURATION + 1);
        governor.settleProposal(pid);

        uint256 agentBalAfter = usdc.balanceOf(agent);
        assertEq(agentBalAfter - agentBalBefore, 0, "zero-snapshot must yield zero fee");

        // Donation stays in the vault (LPs benefit on next deposit/redeem).
        assertEq(usdc.balanceOf(address(vault)), donation, "donation retained in vault");
    }
}
