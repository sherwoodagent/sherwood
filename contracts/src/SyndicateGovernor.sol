// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/**
 * @title SyndicateGovernor
 * @notice Governance system for agent-managed vaults. Agents propose strategies,
 *         shareholders vote, and approved strategies execute via the vault.
 *
 *   - One strategy live per vault at a time
 *   - Redemptions locked during live strategy
 *   - Cooldown window between strategies for depositor exit
 *   - Permissionless settlement after strategy duration ends
 *   - P&L calculated via balance snapshot diffs
 *   - Vote weight from ERC20Votes checkpoints (block-number snapshots)
 *   - Collaborative proposals: multiple agents co-submit with fee splits
 */
contract SyndicateGovernor is ISyndicateGovernor, Initializable, OwnableUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Safety bounds (hardcoded) ──

    uint256 public constant MIN_VOTING_PERIOD = 1 hours;
    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MIN_EXECUTION_WINDOW = 1 hours;
    uint256 public constant MAX_EXECUTION_WINDOW = 7 days;
    uint256 public constant MIN_QUORUM_BPS = 1000; // 10%
    uint256 public constant MAX_QUORUM_BPS = 10000; // 100%
    uint256 public constant MAX_PERFORMANCE_FEE_CAP = 5000; // 50%
    uint256 public constant ABSOLUTE_MIN_STRATEGY_DURATION = 1 hours;
    uint256 public constant ABSOLUTE_MAX_STRATEGY_DURATION = 30 days;
    uint256 public constant MIN_COOLDOWN_PERIOD = 1 hours;
    uint256 public constant MAX_COOLDOWN_PERIOD = 30 days;

    // ── Collaborative proposal constants (safety bounds) ──

    uint256 public constant MIN_SPLIT_BPS = 100; // 1%
    uint256 public constant MIN_COLLABORATION_WINDOW = 1 hours;
    uint256 public constant MAX_COLLABORATION_WINDOW = 7 days;
    uint256 public constant ABSOLUTE_MAX_CO_PROPOSERS = 10;

    // ── Storage (existing — DO NOT reorder) ──

    /// @notice Governor parameters
    GovernorParams private _params;

    /// @notice Proposal ID counter (1-indexed)
    uint256 private _proposalCount;

    /// @notice Proposal ID → proposal data
    mapping(uint256 => StrategyProposal) private _proposals;

    /// @notice Proposal ID → calls array (stored separately for gas)
    mapping(uint256 => BatchExecutorLib.Call[]) private _proposalCalls;

    /// @notice Proposal ID → voter → bool
    mapping(uint256 => mapping(address => bool)) private _hasVoted;

    /// @notice Proposal ID → vault balance at execution time
    mapping(uint256 => uint256) private _capitalSnapshots;

    /// @notice Vault → currently executing proposal ID (0 if none)
    mapping(address => uint256) private _activeProposal;

    /// @notice Vault → timestamp of last settlement
    mapping(address => uint256) private _lastSettledAt;

    /// @notice Set of registered vault addresses
    EnumerableSet.AddressSet private _registeredVaults;

    // ── Collaborative proposal storage ──

    /// @notice Proposal ID → co-proposers array
    mapping(uint256 => CoProposer[]) private _coProposers;

    /// @notice Proposal ID → co-proposer address → approved
    mapping(uint256 => mapping(address => bool)) public coProposerApprovals;

    /// @notice Proposal ID → deadline for co-proposer consent
    mapping(uint256 => uint256) public collaborationDeadline;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        uint256 votingPeriod_,
        uint256 executionWindow_,
        uint256 quorumBps_,
        uint256 maxPerformanceFeeBps_,
        uint256 cooldownPeriod_,
        uint256 minStrategyDuration_,
        uint256 maxStrategyDuration_,
        uint256 collaborationWindow_,
        uint256 maxCoProposers_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (
            minStrategyDuration_ < ABSOLUTE_MIN_STRATEGY_DURATION
                || maxStrategyDuration_ > ABSOLUTE_MAX_STRATEGY_DURATION || minStrategyDuration_ > maxStrategyDuration_
        ) revert InvalidStrategyDurationBounds();
        if (collaborationWindow_ < MIN_COLLABORATION_WINDOW || collaborationWindow_ > MAX_COLLABORATION_WINDOW) {
            revert InvalidCollaborationWindow();
        }
        if (maxCoProposers_ == 0 || maxCoProposers_ > ABSOLUTE_MAX_CO_PROPOSERS) revert InvalidMaxCoProposers();

        __Ownable_init(owner_);

        _validateVotingPeriod(votingPeriod_);
        _validateExecutionWindow(executionWindow_);
        _validateQuorumBps(quorumBps_);
        _validateMaxPerformanceFeeBps(maxPerformanceFeeBps_);
        _validateCooldownPeriod(cooldownPeriod_);

        _params = GovernorParams({
            votingPeriod: votingPeriod_,
            executionWindow: executionWindow_,
            quorumBps: quorumBps_,
            maxPerformanceFeeBps: maxPerformanceFeeBps_,
            cooldownPeriod: cooldownPeriod_,
            collaborationWindow: collaborationWindow_,
            maxCoProposers: maxCoProposers_,
            minStrategyDuration: minStrategyDuration_,
            maxStrategyDuration: maxStrategyDuration_
        });
    }

    // ==================== PROPOSAL LIFECYCLE ====================

    /// @inheritdoc ISyndicateGovernor
    function propose(
        address vault,
        string calldata metadataURI,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        BatchExecutorLib.Call[] calldata calls,
        uint256 splitIndex,
        CoProposer[] calldata coProposers
    ) external returns (uint256 proposalId) {
        if (!_registeredVaults.contains(vault)) revert VaultNotRegistered();
        if (!ISyndicateVault(vault).isAgent(msg.sender)) revert NotRegisteredAgent();
        if (performanceFeeBps > _params.maxPerformanceFeeBps) revert PerformanceFeeTooHigh();
        if (strategyDuration > _params.maxStrategyDuration) revert StrategyDurationTooLong();
        if (strategyDuration < _params.minStrategyDuration) revert StrategyDurationTooShort();
        if (calls.length == 0) revert EmptyCalls();
        if (splitIndex == 0 || splitIndex >= calls.length) revert InvalidSplitIndex();

        // Validate co-proposers if present
        if (coProposers.length > 0) {
            _validateCoProposers(vault, coProposers);
        }

        proposalId = ++_proposalCount;

        bool isCollaborative = coProposers.length > 0;

        _proposals[proposalId] = StrategyProposal({
            id: proposalId,
            proposer: msg.sender,
            vault: vault,
            metadataURI: metadataURI,
            performanceFeeBps: performanceFeeBps,
            splitIndex: splitIndex,
            strategyDuration: strategyDuration,
            votesFor: 0,
            votesAgainst: 0,
            votesAbstain: 0,
            snapshotTimestamp: isCollaborative ? 0 : block.timestamp,
            voteEnd: isCollaborative ? 0 : block.timestamp + _params.votingPeriod,
            executeBy: isCollaborative ? 0 : block.timestamp + _params.votingPeriod + _params.executionWindow,
            executedAt: 0,
            state: isCollaborative ? ProposalState.Draft : ProposalState.Pending
        });

        // Store calls separately
        _storeCalls(proposalId, calls);

        // Store co-proposers and set collaboration deadline
        if (coProposers.length > 0) {
            _storeCoProposers(proposalId, coProposers);
        }

        _emitProposalCreated(proposalId, calls.length, metadataURI);
    }

    /// @inheritdoc ISyndicateGovernor
    function vote(uint256 proposalId, VoteType support) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) revert ProposalNotApproved(); // proposal doesn't exist
        if (_resolveState(proposal) != ProposalState.Pending) revert NotWithinVotingPeriod();
        if (block.timestamp > proposal.voteEnd) revert NotWithinVotingPeriod();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Get vote weight from ERC20Votes checkpoint at proposal creation block
        uint256 weight = IVotes(proposal.vault).getPastVotes(msg.sender, proposal.snapshotTimestamp);
        if (weight == 0) revert NoVotingPower();

        _hasVoted[proposalId][msg.sender] = true;

        if (support == VoteType.For) {
            proposal.votesFor += weight;
        } else if (support == VoteType.Against) {
            proposal.votesAgainst += weight;
        } else {
            proposal.votesAbstain += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @inheritdoc ISyndicateGovernor
    function executeProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];

        // Resolve state (may transition from Pending to Approved/Rejected/Expired)
        ProposalState currentState = _resolveState(proposal);
        if (currentState != ProposalState.Approved) revert ProposalNotApproved();
        if (block.timestamp > proposal.executeBy) revert ExecutionWindowExpired();

        address vault = proposal.vault;
        if (_activeProposal[vault] != 0) revert StrategyAlreadyActive();
        // Cooldown check (skip if no prior settlement)
        uint256 lastSettled = _lastSettledAt[vault];
        if (lastSettled != 0 && block.timestamp < lastSettled + _params.cooldownPeriod) {
            revert CooldownNotElapsed();
        }

        // Snapshot vault balance before execution
        address asset = IERC4626(vault).asset();
        uint256 balanceBefore = IERC20(asset).balanceOf(vault);
        _capitalSnapshots[proposalId] = balanceBefore;

        // Execute the opening calls via the vault
        BatchExecutorLib.Call[] storage calls = _proposalCalls[proposalId];
        uint256 splitIdx = proposal.splitIndex;

        BatchExecutorLib.Call[] memory executeCalls = new BatchExecutorLib.Call[](splitIdx);
        for (uint256 i = 0; i < splitIdx; i++) {
            executeCalls[i] = calls[i];
        }
        ISyndicateVault(vault).executeGovernorBatch(executeCalls);

        // Update state
        _activeProposal[vault] = proposalId;
        proposal.state = ProposalState.Executed;
        proposal.executedAt = block.timestamp;

        emit ProposalExecuted(proposalId, vault, balanceBefore);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 1: Agent settles. Tries pre-committed calls first, falls back to custom calls. Enforces no loss.
    function settleByAgent(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (_resolveState(proposal) != ProposalState.Executed) revert ProposalNotExecuted();
        if (msg.sender != proposal.proposer) revert NotProposer();

        // Try pre-committed unwind calls first, fall back to agent-provided calls
        _tryPrecommittedThenFallback(proposalId, proposal, calls);

        // Enforce no loss — agent can only settle if vault balance >= snapshot
        address asset = IERC4626(proposal.vault).asset();
        uint256 balanceAfter = IERC20(asset).balanceOf(proposal.vault);
        if (balanceAfter < _capitalSnapshots[proposalId]) revert SettlementCausedLoss();

        (int256 pnl, uint256 agentFee) = _finishSettlement(proposalId, proposal);

        emit AgentSettled(proposalId, proposal.vault, pnl, agentFee);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 2: Permissionless settle using pre-committed calls. After duration.
    function settleProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (_resolveState(proposal) != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < proposal.executedAt + proposal.strategyDuration) revert StrategyDurationNotElapsed();

        // Run the pre-committed unwind calls
        BatchExecutorLib.Call[] storage calls = _proposalCalls[proposalId];
        uint256 splitIdx = proposal.splitIndex;
        uint256 totalCalls = calls.length;

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](totalCalls - splitIdx);
        for (uint256 i = splitIdx; i < totalCalls; i++) {
            settleCalls[i - splitIdx] = calls[i];
        }
        ISyndicateVault(proposal.vault).executeGovernorBatch(settleCalls);

        _finishSettlement(proposalId, proposal);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 3: Vault owner settles. Tries pre-committed calls first, falls back to custom. After duration.
    function emergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        if (_resolveState(proposal) != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < proposal.executedAt + proposal.strategyDuration) revert StrategyDurationNotElapsed();

        // Try pre-committed unwind calls first, fall back to owner-provided calls
        _tryPrecommittedThenFallback(proposalId, proposal, calls);

        (int256 pnl,) = _finishSettlement(proposalId, proposal);

        emit EmergencySettled(proposalId, proposal.vault, pnl, calls.length);
    }

    /// @inheritdoc ISyndicateGovernor
    function cancelProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != proposal.proposer) revert NotProposer();
        ProposalState currentState = _resolveState(proposal);
        // Can cancel during Draft (collaborative) or Pending (voting) state
        if (currentState != ProposalState.Pending && currentState != ProposalState.Draft) {
            revert ProposalNotCancellable();
        }
        // For Pending proposals, can only cancel during voting period
        if (currentState == ProposalState.Pending && block.timestamp > proposal.voteEnd) {
            revert ProposalNotCancellable();
        }

        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @inheritdoc ISyndicateGovernor
    function emergencyCancel(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        ProposalState currentState = _resolveState(proposal);
        // Can cancel anything that isn't already settled, cancelled, or executed
        if (
            currentState == ProposalState.Settled || currentState == ProposalState.Cancelled
                || currentState == ProposalState.Executed
        ) {
            revert ProposalNotCancellable();
        }

        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    // ==================== COLLABORATIVE PROPOSALS ====================

    /// @inheritdoc ISyndicateGovernor
    function approveCollaboration(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (_resolveState(proposal) != ProposalState.Draft) revert NotDraftState();
        if (block.timestamp > collaborationDeadline[proposalId]) revert CollaborationExpired();

        _requireCoProposer(proposalId);
        if (coProposerApprovals[proposalId][msg.sender]) revert AlreadyApproved();

        coProposerApprovals[proposalId][msg.sender] = true;
        emit CollaborationApproved(proposalId, msg.sender);

        // Check if all co-proposers have approved
        CoProposer[] storage coProps = _coProposers[proposalId];
        bool allApproved = true;
        for (uint256 i = 0; i < coProps.length; i++) {
            if (!coProposerApprovals[proposalId][coProps[i].agent]) {
                allApproved = false;
                break;
            }
        }

        if (allApproved) {
            // Transition to Pending — voting begins
            proposal.state = ProposalState.Pending;
            proposal.snapshotTimestamp = block.timestamp;
            proposal.voteEnd = block.timestamp + _params.votingPeriod;
            proposal.executeBy = block.timestamp + _params.votingPeriod + _params.executionWindow;
            emit CollaborationTransitionedToPending(proposalId);
        }
    }

    /// @inheritdoc ISyndicateGovernor
    function rejectCollaboration(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (_resolveState(proposal) != ProposalState.Draft) revert NotDraftState();

        _requireCoProposer(proposalId);

        proposal.state = ProposalState.Cancelled;
        emit CollaborationRejected(proposalId, msg.sender);
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @inheritdoc ISyndicateGovernor
    function expireCollaboration(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        ProposalState currentState = _resolveState(proposal);
        // _resolveState auto-transitions Draft→Expired when deadline passes
        if (currentState == ProposalState.Expired) return;
        // Still in Draft — deadline hasn't passed yet
        if (currentState == ProposalState.Draft) revert CollaborationNotExpired();
        // Any other state
        revert NotDraftState();
    }

    // ==================== VAULT MANAGEMENT ====================

    /// @inheritdoc ISyndicateGovernor
    function addVault(address vault) external onlyOwner {
        if (vault == address(0)) revert InvalidVault();
        if (!_registeredVaults.add(vault)) revert VaultAlreadyRegistered();
        emit VaultAdded(vault);
    }

    /// @inheritdoc ISyndicateGovernor
    function removeVault(address vault) external onlyOwner {
        if (!_registeredVaults.remove(vault)) revert VaultNotRegistered();
        emit VaultRemoved(vault);
    }

    // ==================== PARAMETER SETTERS ====================

    /// @inheritdoc ISyndicateGovernor
    function setVotingPeriod(uint256 newVotingPeriod) external onlyOwner {
        _validateVotingPeriod(newVotingPeriod);
        uint256 old = _params.votingPeriod;
        _params.votingPeriod = newVotingPeriod;
        emit VotingPeriodUpdated(old, newVotingPeriod);
    }

    /// @inheritdoc ISyndicateGovernor
    function setExecutionWindow(uint256 newExecutionWindow) external onlyOwner {
        _validateExecutionWindow(newExecutionWindow);
        uint256 old = _params.executionWindow;
        _params.executionWindow = newExecutionWindow;
        emit ExecutionWindowUpdated(old, newExecutionWindow);
    }

    /// @inheritdoc ISyndicateGovernor
    function setQuorumBps(uint256 newQuorumBps) external onlyOwner {
        _validateQuorumBps(newQuorumBps);
        uint256 old = _params.quorumBps;
        _params.quorumBps = newQuorumBps;
        emit QuorumBpsUpdated(old, newQuorumBps);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxPerformanceFeeBps(uint256 newMaxPerformanceFeeBps) external onlyOwner {
        _validateMaxPerformanceFeeBps(newMaxPerformanceFeeBps);
        uint256 old = _params.maxPerformanceFeeBps;
        _params.maxPerformanceFeeBps = newMaxPerformanceFeeBps;
        emit MaxPerformanceFeeBpsUpdated(old, newMaxPerformanceFeeBps);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMinStrategyDuration(uint256 newMinStrategyDuration) external onlyOwner {
        if (
            newMinStrategyDuration < ABSOLUTE_MIN_STRATEGY_DURATION
                || newMinStrategyDuration > _params.maxStrategyDuration
        ) {
            revert InvalidStrategyDurationBounds();
        }
        uint256 old = _params.minStrategyDuration;
        _params.minStrategyDuration = newMinStrategyDuration;
        emit MinStrategyDurationUpdated(old, newMinStrategyDuration);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external onlyOwner {
        if (
            newMaxStrategyDuration > ABSOLUTE_MAX_STRATEGY_DURATION
                || newMaxStrategyDuration < _params.minStrategyDuration
        ) {
            revert InvalidStrategyDurationBounds();
        }
        uint256 old = _params.maxStrategyDuration;
        _params.maxStrategyDuration = newMaxStrategyDuration;
        emit MaxStrategyDurationUpdated(old, newMaxStrategyDuration);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCooldownPeriod(uint256 newCooldownPeriod) external onlyOwner {
        _validateCooldownPeriod(newCooldownPeriod);
        uint256 old = _params.cooldownPeriod;
        _params.cooldownPeriod = newCooldownPeriod;
        emit CooldownPeriodUpdated(old, newCooldownPeriod);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCollaborationWindow(uint256 newCollaborationWindow) external onlyOwner {
        if (newCollaborationWindow < MIN_COLLABORATION_WINDOW || newCollaborationWindow > MAX_COLLABORATION_WINDOW) {
            revert InvalidCollaborationWindow();
        }
        uint256 old = _params.collaborationWindow;
        _params.collaborationWindow = newCollaborationWindow;
        emit CollaborationWindowUpdated(old, newCollaborationWindow);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxCoProposers(uint256 newMaxCoProposers) external onlyOwner {
        if (newMaxCoProposers == 0 || newMaxCoProposers > ABSOLUTE_MAX_CO_PROPOSERS) {
            revert InvalidMaxCoProposers();
        }
        uint256 old = _params.maxCoProposers;
        _params.maxCoProposers = newMaxCoProposers;
        emit MaxCoProposersUpdated(old, newMaxCoProposers);
    }

    // ==================== VIEWS ====================

    /// @inheritdoc ISyndicateGovernor
    function getProposal(uint256 proposalId) external view returns (StrategyProposal memory) {
        return _proposals[proposalId];
    }

    /// @inheritdoc ISyndicateGovernor
    function getProposalState(uint256 proposalId) external view returns (ProposalState) {
        return _resolveStateView(_proposals[proposalId]);
    }

    /// @inheritdoc ISyndicateGovernor
    function getProposalCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory) {
        return _proposalCalls[proposalId];
    }

    /// @inheritdoc ISyndicateGovernor
    function getVoteWeight(uint256 proposalId, address voter) external view returns (uint256) {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) return 0;
        return IVotes(proposal.vault).getPastVotes(voter, proposal.snapshotTimestamp);
    }

    /// @inheritdoc ISyndicateGovernor
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    /// @inheritdoc ISyndicateGovernor
    function proposalCount() external view returns (uint256) {
        return _proposalCount;
    }

    /// @inheritdoc ISyndicateGovernor
    function getGovernorParams() external view returns (GovernorParams memory) {
        return _params;
    }

    /// @inheritdoc ISyndicateGovernor
    function getRegisteredVaults() external view returns (address[] memory) {
        return _registeredVaults.values();
    }

    /// @inheritdoc ISyndicateGovernor
    function getActiveProposal(address vault) external view returns (uint256) {
        return _activeProposal[vault];
    }

    /// @inheritdoc ISyndicateGovernor
    function getCooldownEnd(address vault) external view returns (uint256) {
        return _lastSettledAt[vault] + _params.cooldownPeriod;
    }

    /// @inheritdoc ISyndicateGovernor
    function getCapitalSnapshot(uint256 proposalId) external view returns (uint256) {
        return _capitalSnapshots[proposalId];
    }

    /// @inheritdoc ISyndicateGovernor
    function isRegisteredVault(address vault) external view returns (bool) {
        return _registeredVaults.contains(vault);
    }

    /// @inheritdoc ISyndicateGovernor
    function getCoProposers(uint256 proposalId) external view returns (CoProposer[] memory) {
        return _coProposers[proposalId];
    }

    // ==================== INTERNAL ====================

    /// @dev Store proposal calls separately for gas efficiency
    function _storeCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            _proposalCalls[proposalId].push(calls[i]);
        }
    }

    /// @dev Emit ProposalCreated event (reads from storage to avoid stack-too-deep in propose())
    function _emitProposalCreated(uint256 proposalId, uint256 callCount, string calldata metadataURI) internal {
        StrategyProposal storage p = _proposals[proposalId];
        emit ProposalCreated(
            proposalId,
            p.proposer,
            p.vault,
            p.performanceFeeBps,
            p.strategyDuration,
            p.splitIndex,
            callCount,
            metadataURI
        );
    }

    /// @dev Verify caller is a co-proposer on the given proposal
    function _requireCoProposer(uint256 proposalId) internal view {
        CoProposer[] storage coProps = _coProposers[proposalId];
        for (uint256 i = 0; i < coProps.length; i++) {
            if (coProps[i].agent == msg.sender) return;
        }
        revert NotCoProposer();
    }

    /// @dev Store co-proposers, set deadline, emit event
    function _storeCoProposers(uint256 proposalId, CoProposer[] calldata coProposers) internal {
        for (uint256 i = 0; i < coProposers.length; i++) {
            _coProposers[proposalId].push(coProposers[i]);
        }
        collaborationDeadline[proposalId] = block.timestamp + _params.collaborationWindow;

        address[] memory coAddrs = new address[](coProposers.length);
        uint256[] memory splits = new uint256[](coProposers.length);
        for (uint256 i = 0; i < coProposers.length; i++) {
            coAddrs[i] = coProposers[i].agent;
            splits[i] = coProposers[i].splitBps;
        }
        emit CollaborativeProposalCreated(proposalId, msg.sender, coAddrs, splits);
    }

    /// @dev Validate co-proposer array: registered agents, no duplicates, valid splits
    function _validateCoProposers(address vault, CoProposer[] calldata coProposers) internal view {
        if (coProposers.length > _params.maxCoProposers) revert TooManyCoProposers();

        uint256 totalCoSplitBps = 0;
        for (uint256 i = 0; i < coProposers.length; i++) {
            address coAgent = coProposers[i].agent;
            uint256 splitBps = coProposers[i].splitBps;

            // Must be registered agent
            if (!ISyndicateVault(vault).isAgent(coAgent)) revert NotRegisteredAgent();

            // Cannot be the lead proposer
            if (coAgent == msg.sender) revert DuplicateCoProposer();

            // Minimum split
            if (splitBps < MIN_SPLIT_BPS) revert SplitTooLow();

            // Check for duplicates within co-proposers array
            for (uint256 j = 0; j < i; j++) {
                if (coProposers[j].agent == coAgent) revert DuplicateCoProposer();
            }

            totalCoSplitBps += splitBps;
        }

        // Lead split = 10000 - totalCoSplitBps (must be > 0)
        if (totalCoSplitBps >= 10000) revert InvalidSplits();
    }

    /// @dev Try pre-committed unwind calls first. If they revert, run the fallback calls.
    function _tryPrecommittedThenFallback(
        uint256 proposalId,
        StrategyProposal storage proposal,
        BatchExecutorLib.Call[] calldata fallbackCalls
    ) internal {
        // Build pre-committed settle calls
        BatchExecutorLib.Call[] storage storedCalls = _proposalCalls[proposalId];
        uint256 splitIdx = proposal.splitIndex;
        uint256 totalCalls = storedCalls.length;

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](totalCalls - splitIdx);
        for (uint256 i = splitIdx; i < totalCalls; i++) {
            settleCalls[i - splitIdx] = storedCalls[i];
        }

        // Try pre-committed calls first
        try ISyndicateVault(proposal.vault).executeGovernorBatch(settleCalls) {
        // Pre-committed calls succeeded — done
        }
        catch {
            // Pre-committed calls failed — run fallback calls
            if (fallbackCalls.length > 0) {
                ISyndicateVault(proposal.vault).executeGovernorBatch(fallbackCalls);
            }
        }
    }

    function _resolveState(StrategyProposal storage proposal) internal returns (ProposalState) {
        // Auto-expire Draft proposals past collaboration deadline
        if (proposal.state == ProposalState.Draft) {
            if (block.timestamp > collaborationDeadline[proposal.id]) {
                proposal.state = ProposalState.Expired;
                emit CollaborationDeadlineExpired(proposal.id);
                return ProposalState.Expired;
            }
            return ProposalState.Draft;
        }

        if (proposal.state != ProposalState.Pending) return proposal.state;
        if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

        // Voting ended — determine outcome
        // Abstain votes count toward quorum but not for/against
        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
        uint256 quorumRequired = (pastTotalSupply * _params.quorumBps) / 10000;

        if (totalVotes < quorumRequired || proposal.votesFor <= proposal.votesAgainst) {
            proposal.state = ProposalState.Rejected;
            return ProposalState.Rejected;
        }

        if (block.timestamp > proposal.executeBy) {
            proposal.state = ProposalState.Expired;
            return ProposalState.Expired;
        }

        proposal.state = ProposalState.Approved;
        return ProposalState.Approved;
    }

    /// @dev View-only version of state resolution (doesn't modify storage)
    function _resolveStateView(StrategyProposal storage proposal) internal view returns (ProposalState) {
        // Auto-expire Draft proposals past collaboration deadline
        if (proposal.state == ProposalState.Draft) {
            if (block.timestamp > collaborationDeadline[proposal.id]) {
                return ProposalState.Expired;
            }
            return ProposalState.Draft;
        }

        if (proposal.state != ProposalState.Pending) return proposal.state;
        if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
        uint256 quorumRequired = (pastTotalSupply * _params.quorumBps) / 10000;

        if (totalVotes < quorumRequired || proposal.votesFor <= proposal.votesAgainst) {
            return ProposalState.Rejected;
        }

        if (block.timestamp > proposal.executeBy) {
            return ProposalState.Expired;
        }

        return ProposalState.Approved;
    }

    function _finishSettlement(uint256 proposalId, StrategyProposal storage proposal)
        internal
        returns (int256 pnl, uint256 agentFee)
    {
        address vault = proposal.vault;
        address asset = IERC4626(vault).asset();
        uint256 balanceAfter = IERC20(asset).balanceOf(vault);
        uint256 capitalSnapshot = _capitalSnapshots[proposalId];

        // casting to int256 is safe because vault balances won't exceed int256.max
        // forge-lint: disable-next-line(unsafe-typecast)
        pnl = int256(balanceAfter) - int256(capitalSnapshot);

        // Distribute fees on profit
        agentFee = 0;
        uint256 mgmtFee = 0;
        if (pnl > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 profit = uint256(pnl);
            agentFee = (profit * proposal.performanceFeeBps) / 10000;
            mgmtFee = ((profit - agentFee) * ISyndicateVault(vault).managementFeeBps()) / 10000;

            if (agentFee > 0) {
                CoProposer[] storage coProps = _coProposers[proposalId];
                if (coProps.length > 0) {
                    // Distribute to co-proposers first, lead gets remainder
                    uint256 distributed = 0;
                    for (uint256 i = 0; i < coProps.length; i++) {
                        uint256 share = (agentFee * coProps[i].splitBps) / 10000;
                        if (share > 0) {
                            ISyndicateVault(vault).transferPerformanceFee(asset, coProps[i].agent, share);
                            distributed += share;
                        }
                    }
                    // Lead proposer gets remainder (handles rounding)
                    uint256 leadShare = agentFee - distributed;
                    if (leadShare > 0) {
                        ISyndicateVault(vault).transferPerformanceFee(asset, proposal.proposer, leadShare);
                    }
                } else {
                    // Solo proposal — all to proposer
                    ISyndicateVault(vault).transferPerformanceFee(asset, proposal.proposer, agentFee);
                }
            }
            if (mgmtFee > 0) {
                address vaultOwner = OwnableUpgradeable(vault).owner();
                ISyndicateVault(vault).transferPerformanceFee(asset, vaultOwner, mgmtFee);
            }
        }

        // Clear active proposal
        _activeProposal[vault] = 0;
        _lastSettledAt[vault] = block.timestamp;

        // Update state
        proposal.state = ProposalState.Settled;

        uint256 duration = block.timestamp - proposal.executedAt;
        emit ProposalSettled(proposalId, vault, pnl, agentFee + mgmtFee, duration);
    }

    // ── Validation helpers ──

    function _validateVotingPeriod(uint256 value) internal pure {
        if (value < MIN_VOTING_PERIOD || value > MAX_VOTING_PERIOD) revert InvalidVotingPeriod();
    }

    function _validateExecutionWindow(uint256 value) internal pure {
        if (value < MIN_EXECUTION_WINDOW || value > MAX_EXECUTION_WINDOW) revert InvalidExecutionWindow();
    }

    function _validateQuorumBps(uint256 value) internal pure {
        if (value < MIN_QUORUM_BPS || value > MAX_QUORUM_BPS) revert InvalidQuorumBps();
    }

    function _validateMaxPerformanceFeeBps(uint256 value) internal pure {
        if (value > MAX_PERFORMANCE_FEE_CAP) revert InvalidMaxPerformanceFeeBps();
    }

    function _validateCooldownPeriod(uint256 value) internal pure {
        if (value < MIN_COOLDOWN_PERIOD || value > MAX_COOLDOWN_PERIOD) revert InvalidCooldownPeriod();
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
