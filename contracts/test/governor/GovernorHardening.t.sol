// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {GovernorParameters} from "../../src/GovernorParameters.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockRegistryMinimal} from "../mocks/MockRegistryMinimal.sol";

/// @notice Regression suite for G-H2 / G-H3 / G-H4 / G-H6 hardening fixes
///         from the pre-mainnet protocol checklist (#236).
contract GovernorHardeningTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

    address public owner = makeAddr("owner");
    address public leadAgent = makeAddr("leadAgent");
    address public co1 = makeAddr("co1");
    address public co2 = makeAddr("co2");
    address public co3 = makeAddr("co3");
    address public co4 = makeAddr("co4");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");

    ERC20Mock public targetToken;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();

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
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

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

        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(governor)));

        vm.startPrank(owner);
        vault.registerAgent(agentRegistry.mint(leadAgent), leadAgent);
        vault.registerAgent(agentRegistry.mint(co1), co1);
        vault.registerAgent(agentRegistry.mint(co2), co2);
        vault.registerAgent(agentRegistry.mint(co3), co3);
        vault.registerAgent(agentRegistry.mint(co4), co4);
        governor.addVault(address(vault));
        vm.stopPrank();

        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);
    }

    // ─── Helpers ───

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 1e6)), value: 0
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

    function _depositLps() internal {
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

    /// @dev Create a 5-party collab: lead + 4 co-props @ 10% each
    function _create5PartyCollab() internal returns (uint256 proposalId) {
        ISyndicateGovernor.CoProposer[] memory cps = new ISyndicateGovernor.CoProposer[](4);
        cps[0] = ISyndicateGovernor.CoProposer({agent: co1, splitBps: 1000});
        cps[1] = ISyndicateGovernor.CoProposer({agent: co2, splitBps: 1000});
        cps[2] = ISyndicateGovernor.CoProposer({agent: co3, splitBps: 1000});
        cps[3] = ISyndicateGovernor.CoProposer({agent: co4, splitBps: 1000});

        vm.prank(leadAgent);
        proposalId = governor.propose(address(vault), "ipfs://gh2", 2000, 7 days, _execCalls(), _settleCalls(), cps);
    }

    /// @dev Create a 2-party collab: lead + 1 co-prop to land in Draft quickly.
    function _create2PartyCollab() internal returns (uint256 proposalId) {
        ISyndicateGovernor.CoProposer[] memory cps = new ISyndicateGovernor.CoProposer[](1);
        cps[0] = ISyndicateGovernor.CoProposer({agent: co1, splitBps: 3000});
        vm.prank(leadAgent);
        proposalId = governor.propose(address(vault), "ipfs://draft", 2000, 7 days, _execCalls(), _settleCalls(), cps);
    }

    // ==================== FIX 2 — G-H3 ====================

    /// @notice Calling getVoteWeight on a Draft proposal must revert rather
    ///         than silently return 0.
    function test_getVoteWeight_revertsIfDraft() public {
        _depositLps();
        uint256 proposalId = _create2PartyCollab();

        vm.expectRevert(ISyndicateGovernor.ProposalInDraft.selector);
        governor.getVoteWeight(proposalId, lp1);
    }

    /// @notice Sanity: once the Draft transitions to Pending (all co-props
    ///         approve), getVoteWeight returns the snapshotted vote weight.
    function test_getVoteWeight_postDraft_returnsSnapshot() public {
        _depositLps();
        uint256 proposalId = _create2PartyCollab();

        vm.prank(co1);
        governor.approveCollaboration(proposalId);

        // Pending now — snapshotTimestamp is stamped.
        assertGt(governor.getVoteWeight(proposalId, lp1), 0);
    }

    // ==================== FIX 4 — G-H6 ====================

    /// @notice A finalize of setVetoThresholdBps mid-vote must not retroactively
    ///         change the threshold for in-flight proposals. The proposal must
    ///         use the bps value snapshotted at Draft -> Pending.
    ///
    /// @dev Scenario:
    ///     - Vault TVL: 100k (lp1=60k, lp2=40k)
    ///     - Snapshotted bps: 4000 (40% AGAINST to reject)
    ///     - Raised mid-vote to:    8000 (80% AGAINST to reject)
    ///     - AGAINST votes cast: lp1's 60k = 60% of supply
    ///     - Under snapshot → 60% >= 40% → Rejected. (correct, OLD bps used)
    ///     - Under live     → 60%  < 80% → Approved. (would be wrong)
    function test_vetoThresholdBps_snapshotAtPropose() public {
        _depositLps();

        // Propose under the current VETO_THRESHOLD_BPS = 4000.
        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://snap",
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
        vm.warp(vm.getBlockTimestamp() + 1);

        // Cast AGAINST votes while voting window is still open.
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);

        // Owner raises vetoThresholdBps to 8000 (applies immediately in V1.5).
        vm.prank(owner);
        governor.setVetoThresholdBps(8000);
        assertEq(governor.getGovernorParams().vetoThresholdBps, 8000);

        // Warp past voting window so state resolution fires on the next call.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);

        // Under the snapshotted bps (4000): 60k / 100k = 60% >= 40% → Rejected.
        // Under live (8000): 60% < 80% → Approved.
        ISyndicateGovernor.ProposalState state = governor.getProposalState(proposalId);
        assertEq(uint256(state), uint256(ISyndicateGovernor.ProposalState.Rejected));

        // Sanity: the proposal struct actually holds the snapshot.
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(p.vetoThresholdBps, VETO_THRESHOLD_BPS);
    }

    // ==================== FIX 3 — G-H4 ====================

    /// @notice When totalSupply is 0 at snapshot time, the veto threshold would
    ///         be 0 and `votesAgainst >= 0` is always true → auto-reject. The
    ///         guard must skip the veto check so the proposal transitions to
    ///         Approved (via GuardianReview).
    function test_veto_emptySupply_doesNotAutoReject() public {
        // Propose without any LP deposits — totalSupply stays 0.
        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://empty",
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
        vm.warp(vm.getBlockTimestamp() + 1);

        // Nobody votes. Warp past voting window.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);

        // With empty supply guard: state resolves to Approved (reviewPeriod=0
        // on MockRegistryMinimal, so GuardianReview collapses).
        ISyndicateGovernor.ProposalState state = governor.getProposalState(proposalId);
        assertEq(uint256(state), uint256(ISyndicateGovernor.ProposalState.Approved));
    }

    // ==================== FIX 1 — G-H2 ====================

    /// @notice With 4 of 4 co-props approved (all-but-none — actually every
    ///         co-prop; we build 4-of-5 by approving the first 3 of 4 below).
    ///         Uses the lead + 4-co arrangement: `total = 4`, approve 3 → lead
    ///         cancel must revert.
    function test_cancelProposal_Draft_revertsNearQuorum() public {
        uint256 proposalId = _create5PartyCollab();

        // 3 out of 4 co-props approve → one more approval away from quorum.
        vm.prank(co1);
        governor.approveCollaboration(proposalId);
        vm.prank(co2);
        governor.approveCollaboration(proposalId);
        vm.prank(co3);
        governor.approveCollaboration(proposalId);

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.CancelNotAllowedNearQuorum.selector);
        governor.cancelProposal(proposalId);
    }

    /// @notice With only 1 of 4 co-props approved, lead can still cancel the
    ///         Draft freely.
    function test_cancelProposal_Draft_earlyOk() public {
        uint256 proposalId = _create5PartyCollab();

        vm.prank(co1);
        governor.approveCollaboration(proposalId);

        vm.prank(leadAgent);
        governor.cancelProposal(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    // (remaining tests for G-H3, G-H4, G-H6 appended in later commits)

    // ==================== G-M7 — emergencyCancel rejects terminal states ====================

    /// @dev Helper: create a Pending solo proposal.
    function _createSoloPending() internal returns (uint256 proposalId) {
        vm.prank(leadAgent);
        proposalId = governor.propose(
            address(vault),
            "ipfs://term",
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    /// @notice G-M7: emergencyCancel on a Rejected proposal (reached via
    ///         vetoProposal) must revert — owner should not be able to "re-cancel"
    ///         a terminal state.
    function test_emergencyCancel_revertsOnRejectedProposal() public {
        _depositLps();
        uint256 proposalId = _createSoloPending();

        // Veto while Pending — flips to Rejected.
        vm.prank(owner);
        governor.vetoProposal(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Rejected));

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(proposalId);
    }

    /// @notice G-M7: emergencyCancel on a Cancelled proposal must revert.
    function test_emergencyCancel_revertsOnCancelledProposal() public {
        _depositLps();
        uint256 proposalId = _createSoloPending();

        // Proposer cancels (Pending -> Cancelled).
        vm.prank(leadAgent);
        governor.cancelProposal(proposalId);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(proposalId);
    }

    /// @notice G-M7: emergencyCancel on an Expired proposal must revert. An
    ///         Approved proposal whose executeBy has passed resolves to Expired;
    ///         owner cannot cancel what's already terminal.
    function test_emergencyCancel_revertsOnExpiredProposal() public {
        _depositLps();
        uint256 proposalId = _createSoloPending();

        // Vote YES, warp past voting so it resolves to Approved, then past
        // executeBy so it resolves to Expired.
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        vm.warp(p.executeBy + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(proposalId);
    }

    // ==================== G-M9 — addVault interface check ====================

    /// @notice G-M9: `addVault` must reject EOAs and other non-contract
    ///         addresses via an extcodesize probe. Catches operator typos
    ///         that would otherwise wire governance at a dead address.
    function test_addVault_revertsOnNonVault() public {
        address eoa = makeAddr("eoa");
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.NotASyndicateVault.selector);
        governor.addVault(eoa);
    }

    // ==================== G-M2/G-M6 — calls array cap ====================

    /// @dev Builds an oversized Call array of the requested length pointing at
    ///      `usdc.approve(...)` — benign calldata, cheap to construct.
    function _buildOversizedCalls(uint256 len) internal view returns (BatchExecutorLib.Call[] memory arr) {
        arr = new BatchExecutorLib.Call[](len);
        for (uint256 i = 0; i < len; i++) {
            arr[i] = BatchExecutorLib.Call({
                target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 1e6)), value: 0
            });
        }
    }

    /// @notice G-M2: propose reverts when executeCalls exceeds the cap.
    function test_propose_revertsIfExecuteCallsExceedCap() public {
        uint256 cap = governor.MAX_CALLS_PER_PROPOSAL();
        BatchExecutorLib.Call[] memory oversized = _buildOversizedCalls(cap + 1);

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.TooManyCalls.selector);
        governor.propose(
            address(vault),
            "ipfs://big",
            2000,
            7 days,
            oversized,
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
    }

    /// @notice G-M6: propose reverts when settlementCalls exceeds the cap.
    function test_propose_revertsIfSettlementCallsExceedCap() public {
        uint256 cap = governor.MAX_CALLS_PER_PROPOSAL();
        BatchExecutorLib.Call[] memory oversized = _buildOversizedCalls(cap + 1);

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.TooManyCalls.selector);
        governor.propose(
            address(vault), "ipfs://big", 2000, 7 days, _execCalls(), oversized, new ISyndicateGovernor.CoProposer[](0)
        );
    }

    // ==================== G-M11 — metadata URI length cap ====================

    /// @notice G-M11: `propose` must revert when `metadataURI.length`
    ///         exceeds MAX_METADATA_URI_LENGTH. Bounds a calldata-unbounded
    ///         string that would otherwise let a proposer grief gas / event
    ///         storage.
    function test_propose_revertsIfMetadataURITooLong() public {
        uint256 cap = governor.MAX_METADATA_URI_LENGTH();
        bytes memory tooLong = new bytes(cap + 1);
        for (uint256 i = 0; i < tooLong.length; i++) {
            tooLong[i] = "a";
        }

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.MetadataURITooLong.selector);
        governor.propose(
            address(vault),
            string(tooLong),
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
    }

    // ==================== G-M1 — propose blocks on open proposal ====================

    /// @notice G-M1: `propose` must revert when the vault already has a
    ///         non-terminal proposal bound to it (here: Pending). Prevents
    ///         duplicate lifecycles racing the same vault state.
    function test_propose_revertsIfVaultHasPending() public {
        _depositLps();
        // First proposal -> Pending, bumps openProposalCount[vault] to 1.
        _createSoloPending();

        // Second propose from a different agent must now revert.
        vm.prank(co1);
        vm.expectRevert(ISyndicateGovernor.VaultHasOpenProposal.selector);
        governor.propose(
            address(vault),
            "ipfs://dup",
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );
    }

    /// @notice G-M1: `approveCollaboration` must revert the Draft -> Pending
    ///         transition if the vault has another non-terminal proposal.
    ///         The Draft itself stays alive so it can re-transition later.
    function test_approveCollaboration_revertsIfVaultHasPending() public {
        _depositLps();

        // Stage a Draft (lead + 1 co-prop) BEFORE the blocking Pending exists.
        // Draft doesn't bump openProposalCount.
        ISyndicateGovernor.CoProposer[] memory cps = new ISyndicateGovernor.CoProposer[](1);
        cps[0] = ISyndicateGovernor.CoProposer({agent: co1, splitBps: 3000});
        vm.prank(leadAgent);
        uint256 draftId =
            governor.propose(address(vault), "ipfs://draft", 2000, 7 days, _execCalls(), _settleCalls(), cps);

        // Create a separate solo Pending that bumps the counter to 1.
        // Use a fresh agent — the lead is already attached to draftId.
        vm.prank(co2);
        governor.propose(
            address(vault),
            "ipfs://pending",
            2000,
            7 days,
            _execCalls(),
            _settleCalls(),
            new ISyndicateGovernor.CoProposer[](0)
        );

        // The final co-prop approve would flip draftId to Pending, but the
        // G-M1 guard blocks it.
        vm.prank(co1);
        vm.expectRevert(ISyndicateGovernor.VaultHasOpenProposal.selector);
        governor.approveCollaboration(draftId);
    }
}
