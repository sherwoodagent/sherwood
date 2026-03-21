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
    uint256 public constant MIN_VETO_THRESHOLD_BPS = 1000; // 10%
    uint256 public constant MAX_VETO_THRESHOLD_BPS = 10000; // 100%
    uint256 public constant MAX_PERFORMANCE_FEE_CAP = 5000; // 50%
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% cap on protocol fee
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

    /// @notice Protocol fee in basis points (taken from profit before agent/management fees)
    uint256 private _protocolFeeBps;

    /// @notice Recipient of protocol fees
    address private _protocolFeeRecipient;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        uint256 votingPeriod_,
        uint256 executionWindow_,
        uint256 vetoThresholdBps_,
        uint256 maxPerformanceFeeBps_,
        uint256 maxStrategyDuration_,
        uint256 cooldownPeriod_,
        uint256 protocolFeeBps_,
        address protocolFeeRecipient_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);

        _validateVotingPeriod(votingPeriod_);
        _validateExecutionWindow(executionWindow_);
        _validateVetoThresholdBps(vetoThresholdBps_);
        _validateMaxPerformanceFeeBps(maxPerformanceFeeBps_);
        _validateMaxStrategyDuration(maxStrategyDuration_);
        _validateCooldownPeriod(cooldownPeriod_);

        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
        if (protocolFeeBps_ > 0 && protocolFeeRecipient_ == address(0)) revert InvalidProtocolFeeRecipient();

        _protocolFeeBps = protocolFeeBps_;
        _protocolFeeRecipient = protocolFeeRecipient_;

        _params = GovernorParams({
            votingPeriod: votingPeriod_,
            executionWindow: executionWindow_,
            vetoThresholdBps: vetoThresholdBps_,
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
            votesAbstain: 0,
            snapshotTimestamp: block.timestamp,
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
    function vote(uint256 proposalId, VoteType support) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) revert ProposalNotApproved(); // proposal doesn't exist
        if (block.timestamp > proposal.voteEnd) revert NotWithinVotingPeriod();
        if (proposal.state != ProposalState.Pending) revert NotWithinVotingPeriod();
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
    /// @notice Settle a strategy. Proposer can settle at any time; anyone else must wait for duration.
    function settleProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.state != ProposalState.Executed) revert ProposalNotExecuted();

        // Proposer can settle anytime; everyone else waits for duration
        if (msg.sender != proposal.proposer) {
            if (block.timestamp < proposal.executedAt + proposal.strategyDuration) {
                revert StrategyDurationNotElapsed();
            }
        }

        // Run the pre-committed unwind calls
        BatchExecutorLib.Call[] storage calls = _proposalCalls[proposalId];
        uint256 splitIndex = proposal.splitIndex;
        uint256 totalCalls = calls.length;

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](totalCalls - splitIndex);
        for (uint256 i = splitIndex; i < totalCalls; i++) {
            settleCalls[i - splitIndex] = calls[i];
        }
        ISyndicateVault(proposal.vault).executeGovernorBatch(settleCalls);

        _finishSettlement(proposalId, proposal);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Path 3: Vault owner settles. Tries pre-committed calls first, falls back to custom. After duration.
    function emergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        if (proposal.state != ProposalState.Executed) revert ProposalNotExecuted();
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

    /// @inheritdoc ISyndicateGovernor
    function vetoProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();

        ProposalState currentState = _resolveStateView(proposal);
        if (currentState != ProposalState.Pending && currentState != ProposalState.Approved) {
            revert ProposalNotCancellable();
        }

        proposal.state = ProposalState.Rejected;
        emit ProposalVetoed(proposalId, msg.sender);
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
    function setVetoThresholdBps(uint256 newVetoThresholdBps) external onlyOwner {
        _validateVetoThresholdBps(newVetoThresholdBps);
        uint256 old = _params.vetoThresholdBps;
        _params.vetoThresholdBps = newVetoThresholdBps;
        emit VetoThresholdBpsUpdated(old, newVetoThresholdBps);
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

    /// @inheritdoc ISyndicateGovernor
    function setProtocolFeeBps(uint256 newProtocolFeeBps) external onlyOwner {
        if (newProtocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
        uint256 old = _protocolFeeBps;
        _protocolFeeBps = newProtocolFeeBps;
        emit ProtocolFeeBpsUpdated(old, newProtocolFeeBps);
    }

    /// @inheritdoc ISyndicateGovernor
    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert InvalidProtocolFeeRecipient();
        address old = _protocolFeeRecipient;
        _protocolFeeRecipient = newRecipient;
        emit ProtocolFeeRecipientUpdated(old, newRecipient);
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

    /// @notice Protocol fee in basis points (taken from profit before agent/management fees)
    function protocolFeeBps() external view returns (uint256) {
        return _protocolFeeBps;
    }

    /// @notice Address that receives protocol fees
    function protocolFeeRecipient() external view returns (address) {
        return _protocolFeeRecipient;
    }

    // ==================== INTERNAL ====================

    /// @dev Try pre-committed unwind calls first. If they revert, run the fallback calls.
    function _tryPrecommittedThenFallback(
        uint256 proposalId,
        StrategyProposal storage proposal,
        BatchExecutorLib.Call[] calldata fallbackCalls
    ) internal {
        // Build pre-committed settle calls
        BatchExecutorLib.Call[] storage storedCalls = _proposalCalls[proposalId];
        uint256 splitIndex = proposal.splitIndex;
        uint256 totalCalls = storedCalls.length;

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](totalCalls - splitIndex);
        for (uint256 i = splitIndex; i < totalCalls; i++) {
            settleCalls[i - splitIndex] = storedCalls[i];
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
        if (proposal.state != ProposalState.Pending) return proposal.state;
        if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

        // Voting ended — optimistic: approved unless AGAINST votes reach veto threshold
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
        uint256 vetoThreshold = (pastTotalSupply * _params.vetoThresholdBps) / 10000;

        if (proposal.votesAgainst >= vetoThreshold) {
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

        // Optimistic: approved unless AGAINST votes reach veto threshold
        uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
        uint256 vetoThreshold = (pastTotalSupply * _params.vetoThresholdBps) / 10000;

        if (proposal.votesAgainst >= vetoThreshold) {
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

        // Finalize state before external transfers to prevent reentrancy on stale state
        _activeProposal[vault] = 0;
        _lastSettledAt[vault] = block.timestamp;
        proposal.state = ProposalState.Settled;

        // Distribute fees on profit: protocol → agent → management (from remainder)
        agentFee = 0;
        uint256 mgmtFee = 0;
        uint256 protocolFee = 0;
        if (pnl > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 profit = uint256(pnl);

            // Protocol fee taken first from gross profit
            if (_protocolFeeBps > 0 && _protocolFeeRecipient != address(0)) {
                protocolFee = (profit * _protocolFeeBps) / 10000;
                if (protocolFee > 0) {
                    try ISyndicateVault(vault).transferPerformanceFee(asset, _protocolFeeRecipient, protocolFee) {}
                    catch {
                        emit FeeTransferFailed(proposalId, _protocolFeeRecipient, protocolFee);
                    }
                }
            }

            uint256 netProfit = profit - protocolFee;

            // Agent performance fee from net profit
            agentFee = (netProfit * proposal.performanceFeeBps) / 10000;

            // Management fee from remainder after agent fee
            mgmtFee = ((netProfit - agentFee) * ISyndicateVault(vault).managementFeeBps()) / 10000;

            if (agentFee > 0) {
                try ISyndicateVault(vault).transferPerformanceFee(asset, proposal.proposer, agentFee) {}
                catch {
                    emit FeeTransferFailed(proposalId, proposal.proposer, agentFee);
                }
            }
            if (mgmtFee > 0) {
                address vaultOwner = OwnableUpgradeable(vault).owner();
                try ISyndicateVault(vault).transferPerformanceFee(asset, vaultOwner, mgmtFee) {}
                catch {
                    emit FeeTransferFailed(proposalId, vaultOwner, mgmtFee);
                }
            }
        }

        uint256 duration = block.timestamp - proposal.executedAt;
        emit ProposalSettled(proposalId, vault, pnl, protocolFee + agentFee + mgmtFee, duration);
    }

    // ── Validation helpers ──

    function _validateVotingPeriod(uint256 value) internal pure {
        if (value < MIN_VOTING_PERIOD || value > MAX_VOTING_PERIOD) revert InvalidVotingPeriod();
    }

    function _validateExecutionWindow(uint256 value) internal pure {
        if (value < MIN_EXECUTION_WINDOW || value > MAX_EXECUTION_WINDOW) revert InvalidExecutionWindow();
    }

    function _validateVetoThresholdBps(uint256 value) internal pure {
        if (value < MIN_VETO_THRESHOLD_BPS || value > MAX_VETO_THRESHOLD_BPS) revert InvalidVetoThresholdBps();
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
