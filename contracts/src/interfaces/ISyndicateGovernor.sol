// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateGovernor {
    // ── Enums ──

    enum ProposalState {
        Pending, // voting active
        Approved, // voting ended, quorum met, majority FOR
        Rejected, // voting ended, failed quorum or majority
        Expired, // execution window passed without execution
        Executed, // strategy is live
        Settled, // P&L calculated, fee distributed
        Cancelled // proposer or owner cancelled
    }

    // ── Structs ──

    struct GovernorParams {
        uint256 votingPeriod;
        uint256 executionWindow;
        uint256 quorumBps;
        uint256 maxPerformanceFeeBps;
        uint256 maxStrategyDuration;
        uint256 cooldownPeriod;
    }

    struct StrategyProposal {
        uint256 id;
        address proposer;
        address vault;
        string metadataURI;
        uint256 performanceFeeBps;
        uint256 splitIndex;
        uint256 strategyDuration;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 snapshotTimestamp;
        uint256 voteEnd;
        uint256 executeBy;
        uint256 executedAt;
        ProposalState state;
    }

    // ── Errors ──

    error VaultNotRegistered();
    error VaultAlreadyRegistered();
    error NotRegisteredAgent();
    error PerformanceFeeTooHigh();
    error StrategyDurationTooLong();
    error StrategyDurationTooShort();
    error InvalidSplitIndex();
    error EmptyCalls();
    error NotWithinVotingPeriod();
    error NoVotingPower();
    error AlreadyVoted();
    error ProposalNotApproved();
    error ExecutionWindowExpired();
    error StrategyAlreadyActive();
    error CooldownNotElapsed();
    error ProposalNotExecuted();
    error ProposalNotCancellable();
    error NotProposer();
    error InvalidVotingPeriod();
    error InvalidExecutionWindow();
    error InvalidQuorumBps();
    error InvalidMaxPerformanceFeeBps();
    error InvalidMaxStrategyDuration();
    error InvalidCooldownPeriod();
    error InvalidVault();
    error ZeroAddress();
    error NotVaultOwner();
    error SettlementCausedLoss();
    error StrategyDurationNotElapsed();

    // ── Events ──

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed vault,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        uint256 splitIndex,
        uint256 callCount,
        string metadataURI
    );

    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);

    event ProposalExecuted(uint256 indexed proposalId, address indexed vault, uint256 capitalSnapshot);

    event ProposalSettled(
        uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee, uint256 duration
    );

    event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    event AgentSettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee);

    event EmergencySettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 customCallCount);

    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);

    event VotingPeriodUpdated(uint256 oldValue, uint256 newValue);
    event ExecutionWindowUpdated(uint256 oldValue, uint256 newValue);
    event QuorumBpsUpdated(uint256 oldValue, uint256 newValue);
    event MaxPerformanceFeeBpsUpdated(uint256 oldValue, uint256 newValue);
    event MaxStrategyDurationUpdated(uint256 oldValue, uint256 newValue);
    event CooldownPeriodUpdated(uint256 oldValue, uint256 newValue);

    // ── Functions ──

    function propose(
        address vault,
        string calldata metadataURI,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        BatchExecutorLib.Call[] calldata calls,
        uint256 splitIndex
    ) external returns (uint256 proposalId);

    function vote(uint256 proposalId, bool support) external;

    function executeProposal(uint256 proposalId) external;

    function settleByAgent(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;

    function settleProposal(uint256 proposalId) external;

    function emergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;

    function cancelProposal(uint256 proposalId) external;

    function emergencyCancel(uint256 proposalId) external;

    // ── Setters ──

    function addVault(address vault) external;
    function removeVault(address vault) external;
    function setVotingPeriod(uint256 newVotingPeriod) external;
    function setExecutionWindow(uint256 newExecutionWindow) external;
    function setQuorumBps(uint256 newQuorumBps) external;
    function setMaxPerformanceFeeBps(uint256 newMaxPerformanceFeeBps) external;
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external;
    function setCooldownPeriod(uint256 newCooldownPeriod) external;

    // ── Views ──

    function getProposal(uint256 proposalId) external view returns (StrategyProposal memory);
    function getProposalState(uint256 proposalId) external view returns (ProposalState);
    function getProposalCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory);
    function getVoteWeight(uint256 proposalId, address voter) external view returns (uint256);
    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    function proposalCount() external view returns (uint256);
    function getGovernorParams() external view returns (GovernorParams memory);
    function getRegisteredVaults() external view returns (address[] memory);
    function getActiveProposal(address vault) external view returns (uint256);
    function getCooldownEnd(address vault) external view returns (uint256);
    function getCapitalSnapshot(uint256 proposalId) external view returns (uint256);
    function isRegisteredVault(address vault) external view returns (bool);
}
