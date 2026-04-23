// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BlacklistingERC20Mock} from "../mocks/BlacklistingERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockRegistryMinimal} from "../mocks/MockRegistryMinimal.sol";

/// @title FeeBlacklistResilience
/// @notice Covers W-1: USDC blacklist on any fee recipient (lead / co-proposer
///         / protocol / vault owner) previously bricked `settleProposal` by
///         reverting inside `_distributeFees`. Governor now wraps each transfer
///         in try/catch, escrows the amount on failure, and still finishes
///         settlement. Escrowed amounts are claimable once the blacklist lifts.
contract FeeBlacklistResilienceTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    BlacklistingERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public coAgent = makeAddr("coAgent");
    address public protocolRecipient = makeAddr("protocolRecipient");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");

    uint256 public agentNftId;
    uint256 public coAgentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new BlacklistingERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();
        agentNftId = agentRegistry.mint(agent);
        coAgentNftId = agentRegistry.mint(coAgent);

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
                    protocolFeeBps: 200,
                    protocolFeeRecipient: protocolRecipient,
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

        vm.warp(block.timestamp + 1);
    }

    // ── Helpers ──

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _coProposers(address co, uint256 splitBps)
        internal
        pure
        returns (ISyndicateGovernor.CoProposer[] memory arr)
    {
        arr = new ISyndicateGovernor.CoProposer[](1);
        arr[0] = ISyndicateGovernor.CoProposer({agent: co, splitBps: splitBps});
    }

    function _noopCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(this), 0)), value: 0
        });
    }

    function _executeThroughSettle(uint256 perfFeeBps, uint256 duration, ISyndicateGovernor.CoProposer[] memory coProps)
        internal
        returns (uint256 proposalId)
    {
        vm.prank(agent);
        proposalId =
            governor.propose(address(vault), "ipfs://test", perfFeeBps, duration, _noopCalls(), _noopCalls(), coProps);
        vm.warp(block.timestamp + 1);

        if (coProps.length > 0) {
            vm.prank(coAgent);
            governor.approveCollaboration(proposalId);
        }

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor.executeProposal(proposalId);
    }

    // ── Tests ──

    /// @notice Settle must still succeed when the protocol-fee recipient is
    ///         blacklisted. The failed transfer is escrowed; everything else
    ///         flows; the strategy lands in Settled.
    function test_settleProposal_succeedsWhenProtocolFeeRecipientBlacklisted() public {
        uint256 proposalId = _executeThroughSettle(1500, 7 days, _emptyCoProposers());

        // Mint profit before blacklisting so the mint itself is allowed.
        usdc.mint(address(vault), 10_000e6);
        usdc.setBlacklisted(protocolRecipient, true);

        uint256 agentBalBefore = usdc.balanceOf(agent);
        uint256 ownerBalBefore = usdc.balanceOf(owner);

        // Expect the fee-failure event for the blacklisted protocol recipient.
        // We don't hard-match the reason bytes — just assert the topics.
        vm.expectEmit(true, true, false, true);
        emit ISyndicateGovernor.FeeTransferFailed(protocolRecipient, address(usdc), 200e6);

        vm.prank(agent);
        governor.settleProposal(proposalId);

        // Agent + owner mgmt fee still land; protocol recipient escrowed.
        // 2% protocol of 10k = 200; net = 9800; agent 15% = 1470; mgmt 0.5% of 8330 = 41.65
        assertEq(usdc.balanceOf(agent), agentBalBefore + 1_470e6, "agent fee paid");
        assertEq(usdc.balanceOf(owner), ownerBalBefore + 41_650000, "mgmt fee paid");
        assertEq(usdc.balanceOf(protocolRecipient), 0, "protocol recipient unpaid");
        assertEq(
            governor.unclaimedFees(address(vault), protocolRecipient, address(usdc)), 200e6, "escrowed amount"
        );

        // Strategy is Settled.
        assertEq(
            uint256(governor.getProposal(proposalId).state),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "Settled"
        );
    }

    /// @notice Once the blacklist is lifted, the recipient pulls their escrowed
    ///         fees via `claimUnclaimedFees`. The vault still holds the amount.
    function test_claimUnclaimedFees_retriesAfterUnblacklist() public {
        uint256 proposalId = _executeThroughSettle(1500, 7 days, _emptyCoProposers());

        usdc.mint(address(vault), 10_000e6);
        usdc.setBlacklisted(protocolRecipient, true);

        vm.prank(agent);
        governor.settleProposal(proposalId);
        assertEq(governor.unclaimedFees(address(vault), protocolRecipient, address(usdc)), 200e6);

        // Lift the blacklist + pull.
        usdc.setBlacklisted(protocolRecipient, false);

        vm.expectEmit(true, true, false, true);
        emit ISyndicateGovernor.FeeClaimed(protocolRecipient, address(usdc), 200e6);

        vm.prank(protocolRecipient);
        governor.claimUnclaimedFees(address(vault), address(usdc));

        assertEq(usdc.balanceOf(protocolRecipient), 200e6, "fee delivered");
        assertEq(governor.unclaimedFees(address(vault), protocolRecipient, address(usdc)), 0, "escrow cleared");
    }

    /// @notice Co-proposer share gets escrowed when the co-proposer is
    ///         blacklisted. Lead proposer still receives their share; settle
    ///         still completes.
    function test_agentFee_blacklisted_coProposerShare_escrowed() public {
        uint256 proposalId = _executeThroughSettle(1500, 7 days, _coProposers(coAgent, 3000));

        usdc.mint(address(vault), 10_000e6);
        // Blacklist the co-proposer.
        usdc.setBlacklisted(coAgent, true);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.prank(agent);
        governor.settleProposal(proposalId);

        // Agent fee math: perfFee = 15% of 9800 net = 1470.
        // Co split 3000 bps: 1470 * 0.3 = 441 -> escrowed.
        // Lead 70% = 1470 - 441 = 1029 -> paid.
        assertEq(usdc.balanceOf(agent), agentBalBefore + 1_029e6, "lead paid");
        assertEq(usdc.balanceOf(coAgent), 0, "coAgent unpaid");
        assertEq(governor.unclaimedFees(address(vault), coAgent, address(usdc)), 441e6, "coAgent escrowed");

        assertEq(
            uint256(governor.getProposal(proposalId).state),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "Settled"
        );
    }

    /// @notice Claim with nothing to pull is a no-op (no revert, no transfer).
    function test_claimUnclaimedFees_zeroAmount_noop() public {
        uint256 balBefore = usdc.balanceOf(protocolRecipient);
        vm.prank(protocolRecipient);
        governor.claimUnclaimedFees(address(vault), address(usdc));
        assertEq(usdc.balanceOf(protocolRecipient), balBefore);
    }

    /// @notice Regression: escrow is keyed by origin vault. A recipient with
    ///         escrow on vault A cannot redirect the pull to an unrelated
    ///         vault B that happens to hold the same token. Prior to the
    ///         `_unclaimedFees[vault][recipient][token]` keying, the caller-
    ///         supplied `vault` argument let anyone with ANY unclaimed credit
    ///         drain ANY vault.
    function test_claimUnclaimedFees_cannotDrainUnrelatedVault() public {
        // 1. Accrue escrow on vault A via blacklist.
        uint256 proposalId = _executeThroughSettle(1500, 7 days, _emptyCoProposers());
        usdc.mint(address(vault), 10_000e6);
        usdc.setBlacklisted(protocolRecipient, true);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        assertEq(governor.unclaimedFees(address(vault), protocolRecipient, address(usdc)), 200e6);

        // 2. Deploy and register an unrelated vault B that holds plenty of USDC.
        SyndicateVault vaultImplB = new SyndicateVault();
        bytes memory vaultInitB = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Sherwood Vault B",
                    symbol: "swUSDCB",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: 50
                }))
        );
        SyndicateVault vaultB = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImplB), vaultInitB))));
        vm.prank(owner);
        governor.addVault(address(vaultB));
        usdc.mint(address(vaultB), 50_000e6);
        uint256 vaultBBalBefore = usdc.balanceOf(address(vaultB));
        uint256 recipientBalBefore = usdc.balanceOf(protocolRecipient);

        // 3. Attempt cross-vault claim. Escrow slot for (vaultB, recipient, usdc)
        //    is zero, so the call returns a no-op — NOT a 200e6 drain of vault B.
        usdc.setBlacklisted(protocolRecipient, false);
        vm.prank(protocolRecipient);
        governor.claimUnclaimedFees(address(vaultB), address(usdc));

        assertEq(usdc.balanceOf(address(vaultB)), vaultBBalBefore, "vault B balance untouched");
        assertEq(usdc.balanceOf(protocolRecipient), recipientBalBefore, "recipient received nothing");
        // Escrow on vault A still intact — the attempted misroute did not clear it.
        assertEq(
            governor.unclaimedFees(address(vault), protocolRecipient, address(usdc)),
            200e6,
            "origin-vault escrow preserved"
        );
    }
}
