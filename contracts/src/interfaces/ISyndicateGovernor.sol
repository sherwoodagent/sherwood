// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateGovernor {
    // ── Enums ──

    enum ProposalState {
        Draft, // collaborative proposal awaiting co-proposer consent
        Pending, // voting active
        Approved, // voting ended, quorum met, majority FOR
        Rejected, // voting ended, failed quorum or majority
        Expired, // execution window passed without execution
        Executed, // strategy is live
        Settled, // P&L calculated, fee distributed
        Cancelled // proposer or owner cancelled
    }

    enum VoteType {
        For,
        Against,
        Abstain
    }

    // ── Structs ──

    struct InitParams {
        address owner;
        uint256 votingPeriod;
        uint256 executionWindow;
        uint256 quorumBps;
        uint256 maxPerformanceFeeBps;
        uint256 cooldownPeriod;
        uint256 collaborationWindow;
        uint256 maxCoProposers;
        uint256 minStrategyDuration;
        uint256 maxStrategyDuration;
    }

    struct GovernorParams {
        uint256 votingPeriod;
        uint256 executionWindow;
        uint256 quorumBps;
        uint256 maxPerformanceFeeBps;
        uint256 cooldownPeriod;
        uint256 collaborationWindow;
        uint256 maxCoProposers;
        uint256 minStrategyDuration;
        uint256 maxStrategyDuration;
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
        uint256 votesAbstain;
        uint256 snapshotTimestamp;
        uint256 voteEnd;
        uint256 executeBy;
        uint256 executedAt;
        ProposalState state;
    }

    struct CoProposer {
        address agent;
        uint256 splitBps;
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
    error InvalidStrategyDurationBounds();
    error InvalidCooldownPeriod();
    error InvalidVault();
    error ZeroAddress();
    error NotVaultOwner();
    error SettlementCausedLoss();
    error StrategyDurationNotElapsed();

    // ── Collaborative proposal errors ──
    error NotCoProposer();
    error CollaborationExpired();
    error AlreadyApproved();
    error InvalidSplits();
    error TooManyCoProposers();
    error SplitTooLow();
    error DuplicateCoProposer();
    error NotDraftState();
    error InvalidCollaborationWindow();
    error NotAuthorized();
    error InvalidMaxCoProposers();
    error Reentrancy();

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

    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);

    event ProposalExecuted(uint256 indexed proposalId, address indexed vault, uint256 capitalSnapshot);

    event ProposalSettled(
        uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee, uint256 duration
    );

    event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    event AgentSettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee);

    event EmergencySettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 customCallCount);

    event FactoryUpdated(address indexed factory);
    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);

    event VotingPeriodUpdated(uint256 oldValue, uint256 newValue);
    event ExecutionWindowUpdated(uint256 oldValue, uint256 newValue);
    event QuorumBpsUpdated(uint256 oldValue, uint256 newValue);
    event MaxPerformanceFeeBpsUpdated(uint256 oldValue, uint256 newValue);
    event MinStrategyDurationUpdated(uint256 oldValue, uint256 newValue);
    event MaxStrategyDurationUpdated(uint256 oldValue, uint256 newValue);
    event CooldownPeriodUpdated(uint256 oldValue, uint256 newValue);

    // ── Collaborative proposal events ──
    event CollaborativeProposalCreated(
        uint256 indexed proposalId, address indexed leadProposer, address[] coProposers, uint256[] splitsBps
    );
    event CollaborationApproved(uint256 indexed proposalId, address indexed agent);
    event CollaborationRejected(uint256 indexed proposalId, address indexed agent);
    event CollaborationTransitionedToPending(uint256 indexed proposalId);
    event CollaborationDeadlineExpired(uint256 indexed proposalId);
    event CollaborationWindowUpdated(uint256 oldValue, uint256 newValue);
    event MaxCoProposersUpdated(uint256 oldValue, uint256 newValue);

    // ── Functions ──

    function propose(
        address vault,
        string calldata metadataURI,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        BatchExecutorLib.Call[] calldata calls,
        uint256 splitIndex,
        CoProposer[] calldata coProposers
    ) external returns (uint256 proposalId);

    function vote(uint256 proposalId, VoteType support) external;

    function executeProposal(uint256 proposalId) external;

    function settleByAgent(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;

    function settleProposal(uint256 proposalId) external;

    function emergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;

    function cancelProposal(uint256 proposalId) external;

    function emergencyCancel(uint256 proposalId) external;

    // ── Collaborative proposal functions ──

    function approveCollaboration(uint256 proposalId) external;
    function rejectCollaboration(uint256 proposalId) external;

    // ── Setters ──

    function addVault(address vault) external;
    function removeVault(address vault) external;
    function setFactory(address factory_) external;
    function setVotingPeriod(uint256 newVotingPeriod) external;
    function setExecutionWindow(uint256 newExecutionWindow) external;
    function setQuorumBps(uint256 newQuorumBps) external;
    function setMaxPerformanceFeeBps(uint256 newMaxPerformanceFeeBps) external;
    function setMinStrategyDuration(uint256 newMinStrategyDuration) external;
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external;
    function setCooldownPeriod(uint256 newCooldownPeriod) external;
    function setCollaborationWindow(uint256 newCollaborationWindow) external;
    function setMaxCoProposers(uint256 newMaxCoProposers) external;

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
    function getCoProposers(uint256 proposalId) external view returns (CoProposer[] memory);
}
