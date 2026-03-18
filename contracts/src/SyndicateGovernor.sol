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
    uint256 public constant MIN_STRATEGY_DURATION = 1 hours;
    uint256 public constant MAX_STRATEGY_DURATION_CAP = 365 days;
    uint256 public constant MIN_COOLDOWN_PERIOD = 1 hours;
    uint256 public constant MAX_COOLDOWN_PERIOD = 30 days;

    // ── Storage ──

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
        uint256 maxStrategyDuration_,
        uint256 cooldownPeriod_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);

        _validateVotingPeriod(votingPeriod_);
        _validateExecutionWindow(executionWindow_);
        _validateQuorumBps(quorumBps_);
        _validateMaxPerformanceFeeBps(maxPerformanceFeeBps_);
        _validateMaxStrategyDuration(maxStrategyDuration_);
        _validateCooldownPeriod(cooldownPeriod_);

        _params = GovernorParams({
            votingPeriod: votingPeriod_,
            executionWindow: executionWindow_,
            quorumBps: quorumBps_,
            maxPerformanceFeeBps: maxPerformanceFeeBps_,
            maxStrategyDuration: maxStrategyDuration_,
            cooldownPeriod: cooldownPeriod_
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
        uint256 splitIndex
    ) external returns (uint256 proposalId) {
        if (!_registeredVaults.contains(vault)) revert VaultNotRegistered();
        if (!ISyndicateVault(vault).isAgent(msg.sender)) revert NotRegisteredAgent();
        if (performanceFeeBps > _params.maxPerformanceFeeBps) revert PerformanceFeeTooHigh();
        if (strategyDuration > _params.maxStrategyDuration) revert StrategyDurationTooLong();
        if (strategyDuration < MIN_STRATEGY_DURATION) revert StrategyDurationTooShort();
        if (calls.length == 0) revert EmptyCalls();
        if (splitIndex == 0 || splitIndex >= calls.length) revert InvalidSplitIndex();

        proposalId = ++_proposalCount;

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
            snapshotBlock: block.number,
            voteEnd: block.timestamp + _params.votingPeriod,
            executeBy: block.timestamp + _params.votingPeriod + _params.executionWindow,
            executedAt: 0,
            state: ProposalState.Pending
        });

        // Store calls separately
        for (uint256 i = 0; i < calls.length; i++) {
            _proposalCalls[proposalId].push(calls[i]);
        }

        emit ProposalCreated(
            proposalId, msg.sender, vault, performanceFeeBps, strategyDuration, splitIndex, calls.length, metadataURI
        );
    }

    /// @inheritdoc ISyndicateGovernor
    function vote(uint256 proposalId, bool support) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) revert ProposalNotApproved(); // proposal doesn't exist
        if (block.timestamp > proposal.voteEnd) revert NotWithinVotingPeriod();
        if (proposal.state != ProposalState.Pending) revert NotWithinVotingPeriod();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Get vote weight from ERC20Votes checkpoint at proposal creation block
        uint256 weight = IVotes(proposal.vault).getPastVotes(msg.sender, proposal.snapshotBlock);
        if (weight == 0) revert NoVotingPower();

        _hasVoted[proposalId][msg.sender] = true;

        if (support) {
            proposal.votesFor += weight;
        } else {
            proposal.votesAgainst += weight;
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

        // Lock redemptions
        ISyndicateVault(vault).lockRedemptions();

        // Snapshot vault balance before execution
        address asset = IERC4626(vault).asset();
        uint256 balanceBefore = IERC20(asset).balanceOf(vault);
        _capitalSnapshots[proposalId] = balanceBefore;

        // Execute the opening calls via the vault
        BatchExecutorLib.Call[] storage calls = _proposalCalls[proposalId];
        uint256 splitIndex = proposal.splitIndex;

        BatchExecutorLib.Call[] memory executeCalls = new BatchExecutorLib.Call[](splitIndex);
        for (uint256 i = 0; i < splitIndex; i++) {
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
    /// @notice Path 1: Agent settles with custom calls. Enforces no loss.
    function settleByAgent(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (msg.sender != proposal.proposer) revert NotProposer();

        // Run agent-provided unwind calls
        if (calls.length > 0) {
            ISyndicateVault(proposal.vault).executeGovernorBatch(calls);
        }

        // Enforce no loss — agent can only settle if vault balance >= snapshot
        address asset = IERC4626(proposal.vault).asset();
        uint256 balanceAfter = IERC20(asset).balanceOf(proposal.vault);
        if (balanceAfter < _capitalSnapshots[proposalId]) revert SettlementCausedLoss();

        (int256 pnl, uint256 agentFee) = _finishSettlement(proposalId, proposal, balanceAfter);

        emit AgentSettled(proposalId, proposal.vault, pnl, agentFee);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 2: Permissionless settle using pre-committed calls. After duration.
    function settleProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < proposal.executedAt + proposal.strategyDuration) revert StrategyDurationNotElapsed();

        // Run the pre-committed unwind calls
        BatchExecutorLib.Call[] storage calls = _proposalCalls[proposalId];
        uint256 splitIndex = proposal.splitIndex;
        uint256 totalCalls = calls.length;

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](totalCalls - splitIndex);
        for (uint256 i = splitIndex; i < totalCalls; i++) {
            settleCalls[i - splitIndex] = calls[i];
        }
        ISyndicateVault(proposal.vault).executeGovernorBatch(settleCalls);

        _finishSettlement(proposalId, proposal, 0);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 3: Vault owner settles with custom calls. After duration. Backstop.
    function emergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        if (proposal.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < proposal.executedAt + proposal.strategyDuration) revert StrategyDurationNotElapsed();

        // Run vault-owner-provided unwind calls
        if (calls.length > 0) {
            ISyndicateVault(proposal.vault).executeGovernorBatch(calls);
        }

        (int256 pnl,) = _finishSettlement(proposalId, proposal, 0);

        emit EmergencySettled(proposalId, proposal.vault, pnl, calls.length);
    }

    /// @inheritdoc ISyndicateGovernor
    function cancelProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != proposal.proposer) revert NotProposer();
        if (proposal.state != ProposalState.Pending) revert ProposalNotCancellable();
        // Can only cancel during voting period
        if (block.timestamp > proposal.voteEnd) revert ProposalNotCancellable();

        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @inheritdoc ISyndicateGovernor
    function emergencyCancel(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        // Can cancel anything that isn't already settled or cancelled
        if (
            proposal.state == ProposalState.Settled || proposal.state == ProposalState.Cancelled
                || proposal.state == ProposalState.Executed
        ) {
            revert ProposalNotCancellable();
        }

        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
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
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external onlyOwner {
        _validateMaxStrategyDuration(newMaxStrategyDuration);
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
        return IVotes(proposal.vault).getPastVotes(voter, proposal.snapshotBlock);
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

    // ==================== INTERNAL ====================

    function _resolveState(StrategyProposal storage proposal) internal returns (ProposalState) {
        if (proposal.state != ProposalState.Pending) return proposal.state;
        if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

        // Voting ended — determine outcome
        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotBlock);
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
        if (proposal.state != ProposalState.Pending) return proposal.state;
        if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotBlock);
        uint256 quorumRequired = (pastTotalSupply * _params.quorumBps) / 10000;

        if (totalVotes < quorumRequired || proposal.votesFor <= proposal.votesAgainst) {
            return ProposalState.Rejected;
        }

        if (block.timestamp > proposal.executeBy) {
            return ProposalState.Expired;
        }

        return ProposalState.Approved;
    }

    /// @param balanceAfterOverride If non-zero, use this value instead of reading from chain.
    function _finishSettlement(uint256 proposalId, StrategyProposal storage proposal, uint256 balanceAfterOverride)
        internal
        returns (int256 pnl, uint256 agentFee)
    {
        address vault = proposal.vault;
        address asset = IERC4626(vault).asset();
        uint256 balanceAfter = balanceAfterOverride > 0 ? balanceAfterOverride : IERC20(asset).balanceOf(vault);
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
                ISyndicateVault(vault).transferPerformanceFee(asset, proposal.proposer, agentFee);
            }
            if (mgmtFee > 0) {
                address vaultOwner = OwnableUpgradeable(vault).owner();
                ISyndicateVault(vault).transferPerformanceFee(asset, vaultOwner, mgmtFee);
            }
        }

        // Unlock redemptions
        ISyndicateVault(vault).unlockRedemptions();

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

    function _validateMaxStrategyDuration(uint256 value) internal pure {
        if (value < MIN_STRATEGY_DURATION || value > MAX_STRATEGY_DURATION_CAP) revert InvalidMaxStrategyDuration();
    }

    function _validateCooldownPeriod(uint256 value) internal pure {
        if (value < MIN_COOLDOWN_PERIOD || value > MAX_COOLDOWN_PERIOD) revert InvalidCooldownPeriod();
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
