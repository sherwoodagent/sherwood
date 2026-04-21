// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {GovernorParameters} from "./GovernorParameters.sol";
import {GovernorEmergency} from "./GovernorEmergency.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
 *   - Cooldown window between strategies for depositor exit
 *   - Permissionless settlement after strategy duration ends
 *   - P&L calculated via balance snapshot diffs
 *   - Vote weight from ERC20Votes checkpoints (timestamp-based snapshots)
 *   - Optimistic governance: proposals pass unless AGAINST votes reach veto threshold
 *   - Collaborative proposals: multiple agents co-submit with fee splits
 *   - Parameter changes require timelock delay
 *   - Protocol fee taken from profit before agent/management fees
 */
contract SyndicateGovernor is GovernorParameters, GovernorEmergency, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ── Storage (existing -- DO NOT reorder) ──

    /// @notice Governor parameters
    GovernorParams private _params;

    /// @notice Proposal ID counter (1-indexed)
    uint256 private _proposalCount;

    /// @notice Proposal ID -> proposal data
    mapping(uint256 => StrategyProposal) private _proposals;

    /// @notice Proposal ID -> voter -> bool
    mapping(uint256 => mapping(address => bool)) private _hasVoted;

    /// @notice Proposal ID -> vault balance at execution time
    mapping(uint256 => uint256) private _capitalSnapshots;

    /// @notice Vault -> currently executing proposal ID (0 if none)
    mapping(address => uint256) private _activeProposal;

    /// @notice Vault -> timestamp of last settlement
    mapping(address => uint256) private _lastSettledAt;

    /// @notice Set of registered vault addresses
    EnumerableSet.AddressSet private _registeredVaults;

    // ── Collaborative proposal storage ──

    /// @notice Proposal ID -> co-proposers array
    mapping(uint256 => CoProposer[]) private _coProposers;

    /// @notice Proposal ID -> co-proposer address -> approved
    mapping(uint256 => mapping(address => bool)) public coProposerApprovals;

    /// @notice Proposal ID -> deadline for co-proposer consent
    mapping(uint256 => uint256) public collaborationDeadline;

    /// @notice Authorized factory that can register vaults
    address public factory;

    /// @notice Simple reentrancy lock for execute/settle entrypoints
    uint256 private _reentrancyStatus;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // ── New storage (appended -- UUPS safe) ──

    /// @notice Proposal ID -> execute (opening) calls
    mapping(uint256 => BatchExecutorLib.Call[]) private _executeCalls;

    /// @notice Proposal ID -> settlement (closing) calls
    mapping(uint256 => BatchExecutorLib.Call[]) private _settlementCalls;

    /// @notice Delay (seconds) before queued parameter changes take effect
    uint256 private _parameterChangeDelay;

    /// @notice Parameter key -> pending change
    mapping(bytes32 => PendingChange) private _pendingChanges;

    /// @notice Protocol fee in basis points (taken from profit before agent/management fees)
    uint256 private _protocolFeeBps;

    /// @notice Recipient of protocol fees
    address private _protocolFeeRecipient;

    /// @notice Guardian registry. Set in `initialize`; required (non-zero).
    address internal _guardianRegistry;

    // ── Guardian-review storage (Task 24 / PR #229) ──
    /// @dev keccak256(abi.encode(calls)) pre-committed at `emergencySettleWithCalls`
    mapping(uint256 => bytes32) internal _emergencyCallsHashes;
    /// @dev Stored calls mirror so the owner (or a watcher) can recover them on-chain
    mapping(uint256 => BatchExecutorLib.Call[]) internal _emergencyCalls;

    /// @notice Per-vault count of non-terminal proposals — Pending,
    ///         GuardianReview, Approved, Executed. Used by
    ///         `GuardianRegistry.requestUnstakeOwner` alongside
    ///         `_activeProposal` to block owner rage-quit while any proposal
    ///         binds the vault. Incremented on Draft -> Pending. Decremented
    ///         on the terminal edge (Rejected / Expired / Cancelled / Settled).
    ///         Added in PR #229 Fix 2.
    mapping(address => uint256) public openProposalCount;

    /// @dev Reserved storage for future upgrades (shrunk by 1 for _guardianRegistry,
    ///      shrunk by 2 more for _emergencyCallsHashes + _emergencyCalls,
    ///      shrunk by 1 more for openProposalCount)
    uint256[29] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams memory p, address guardianRegistry_) external initializer {
        if (p.owner == address(0)) revert ZeroAddress();
        if (guardianRegistry_ == address(0)) revert ZeroAddress();
        if (
            p.minStrategyDuration < ABSOLUTE_MIN_STRATEGY_DURATION
                || p.maxStrategyDuration > ABSOLUTE_MAX_STRATEGY_DURATION
                || p.minStrategyDuration > p.maxStrategyDuration
        ) revert InvalidStrategyDurationBounds();
        if (p.collaborationWindow < MIN_COLLABORATION_WINDOW || p.collaborationWindow > MAX_COLLABORATION_WINDOW) {
            revert InvalidCollaborationWindow();
        }
        if (p.maxCoProposers == 0 || p.maxCoProposers > ABSOLUTE_MAX_CO_PROPOSERS) revert InvalidMaxCoProposers();
        if (p.parameterChangeDelay < MIN_PARAM_CHANGE_DELAY || p.parameterChangeDelay > MAX_PARAM_CHANGE_DELAY) {
            revert InvalidParameterChangeDelay();
        }
        if (p.protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
        if (p.protocolFeeBps > 0 && p.protocolFeeRecipient == address(0)) revert InvalidProtocolFeeRecipient();

        __Ownable_init(p.owner);

        _validateVotingPeriod(p.votingPeriod);
        _validateExecutionWindow(p.executionWindow);
        _validateVetoThresholdBps(p.vetoThresholdBps);
        _validateMaxPerformanceFeeBps(p.maxPerformanceFeeBps);
        _validateCooldownPeriod(p.cooldownPeriod);

        _params = GovernorParams({
            votingPeriod: p.votingPeriod,
            executionWindow: p.executionWindow,
            vetoThresholdBps: p.vetoThresholdBps,
            maxPerformanceFeeBps: p.maxPerformanceFeeBps,
            cooldownPeriod: p.cooldownPeriod,
            collaborationWindow: p.collaborationWindow,
            maxCoProposers: p.maxCoProposers,
            minStrategyDuration: p.minStrategyDuration,
            maxStrategyDuration: p.maxStrategyDuration
        });
        _parameterChangeDelay = p.parameterChangeDelay;
        _protocolFeeBps = p.protocolFeeBps;
        _protocolFeeRecipient = p.protocolFeeRecipient;
        _guardianRegistry = guardianRegistry_;
        _reentrancyStatus = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        _reentrancyEnter();
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    function _reentrancyEnter() private {
        if (_reentrancyStatus == _ENTERED) revert Reentrancy();
        _reentrancyStatus = _ENTERED;
    }

    // ── GovernorParameters virtual accessor overrides ──

    function _getParams() internal view override returns (GovernorParams storage) {
        return _params;
    }

    function _getParameterChangeDelay() internal view override returns (uint256) {
        return _parameterChangeDelay;
    }

    function _getPendingChanges() internal view override returns (mapping(bytes32 => PendingChange) storage) {
        return _pendingChanges;
    }

    function _getProtocolFeeRecipient() internal view override returns (address) {
        return _protocolFeeRecipient;
    }

    // ── GovernorEmergency virtual accessor overrides ──

    function _getProposal(uint256 id) internal view override returns (StrategyProposal storage) {
        return _proposals[id];
    }

    function _getSettlementCalls(uint256 id) internal view override returns (BatchExecutorLib.Call[] storage) {
        return _settlementCalls[id];
    }

    function _getRegistry() internal view override returns (IGuardianRegistry) {
        return IGuardianRegistry(_guardianRegistry);
    }

    function _emergencyReentrancyEnter() internal override {
        if (_reentrancyStatus == _ENTERED) revert Reentrancy();
        _reentrancyStatus = _ENTERED;
    }

    function _emergencyReentrancyLeave() internal override {
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ── Task 24: emergency-call storage overrides ──

    function _storeEmergencyCalls(uint256 id, BatchExecutorLib.Call[] calldata calls) internal override {
        _emergencyCallsHashes[id] = keccak256(abi.encode(calls));
        delete _emergencyCalls[id];
        for (uint256 i = 0; i < calls.length; i++) {
            _emergencyCalls[id].push(calls[i]);
        }
    }

    function _clearEmergencyCalls(uint256 id) internal override {
        delete _emergencyCallsHashes[id];
        delete _emergencyCalls[id];
    }

    function _getEmergencyCallsHash(uint256 id) internal view override returns (bytes32) {
        return _emergencyCallsHashes[id];
    }

    function _finishSettlementHook(uint256 id, StrategyProposal storage p) internal override returns (int256, uint256) {
        return _finishSettlement(id, p);
    }

    // ==================== PROPOSAL LIFECYCLE ====================

    /// @inheritdoc ISyndicateGovernor
    function propose(
        address vault,
        string calldata metadataURI,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        BatchExecutorLib.Call[] calldata executeCalls,
        BatchExecutorLib.Call[] calldata settlementCalls,
        CoProposer[] calldata coProposers
    ) external returns (uint256 proposalId) {
        if (!_registeredVaults.contains(vault)) revert VaultNotRegistered();
        if (!ISyndicateVault(vault).isAgent(msg.sender)) revert NotRegisteredAgent();
        if (performanceFeeBps > _params.maxPerformanceFeeBps) revert PerformanceFeeTooHigh();
        if (strategyDuration > _params.maxStrategyDuration) revert StrategyDurationTooLong();
        if (strategyDuration < _params.minStrategyDuration) revert StrategyDurationTooShort();
        if (executeCalls.length == 0) revert EmptyExecuteCalls();
        if (settlementCalls.length == 0) revert EmptySettlementCalls();

        // Validate co-proposers if present
        if (coProposers.length > 0) {
            _validateCoProposers(vault, coProposers);
        }

        proposalId = ++_proposalCount;

        bool isCollaborative = coProposers.length > 0;

        // Review period defaults to zero when registry isn't wired; state machine
        // still works (voteEnd == reviewEnd → immediate transition to Approved).
        uint256 reviewPeriod_ =
            _guardianRegistry != address(0) ? IGuardianRegistry(_guardianRegistry).reviewPeriod() : 0;

        // Sequential storage writes instead of struct literal to avoid Yul
        // stack-too-deep under the coverage config (optimizer/viaIR off).
        // votesFor / votesAgainst / votesAbstain / executedAt default to 0.
        StrategyProposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.vault = vault;
        p.metadataURI = metadataURI;
        p.performanceFeeBps = performanceFeeBps;
        p.strategyDuration = strategyDuration;
        if (isCollaborative) {
            p.state = ProposalState.Draft;
        } else {
            // -1 closes the same-block flash-delegate window (G-C1).
            p.snapshotTimestamp = block.timestamp - 1;
            p.voteEnd = block.timestamp + _params.votingPeriod;
            p.reviewEnd = p.voteEnd + reviewPeriod_;
            p.executeBy = p.reviewEnd + _params.executionWindow;
            p.state = ProposalState.Pending;
            // Draft doesn't count (not binding on the vault); Pending does.
            unchecked {
                ++openProposalCount[vault];
            }
        }

        // Store calls separately
        _storeCalls(_executeCalls, proposalId, executeCalls);
        _storeCalls(_settlementCalls, proposalId, settlementCalls);

        // Store co-proposers and set collaboration deadline
        if (coProposers.length > 0) {
            _storeCoProposers(proposalId, coProposers);
        }

        _emitProposalCreated(proposalId, executeCalls.length, settlementCalls.length);
    }

    /// @inheritdoc ISyndicateGovernor
    function vote(uint256 proposalId, VoteType support) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (proposal.id == 0) revert ProposalNotFound();
        if (_resolveState(proposal) != ProposalState.Pending) revert NotWithinVotingPeriod();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Get vote weight from ERC20Votes checkpoint at proposal creation
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
    function executeProposal(uint256 proposalId) external nonReentrant {
        StrategyProposal storage proposal = _proposals[proposalId];

        // Resolve state (may transition Pending->Approved/Rejected/Expired or Approved->Expired)
        if (_resolveState(proposal) != ProposalState.Approved) revert ProposalNotApproved();

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

        // Update state BEFORE external call (CEI pattern)
        _activeProposal[vault] = proposalId;
        proposal.state = ProposalState.Executed;
        proposal.executedAt = block.timestamp;
        // Counter stays incremented through Executed; decremented once on the
        // Executed -> Settled edge in `_finishSettlement`. `_activeProposal`
        // also guards the Executed window (see `requestUnstakeOwner`).

        // Execute the opening calls via the vault
        ISyndicateVault(vault).executeGovernorBatch(_loadCalls(_executeCalls, proposalId));

        emit ProposalExecuted(proposalId, vault, balanceBefore);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @notice Settle a strategy. Proposer can settle at any time; anyone else must wait for duration.
    function settleProposal(uint256 proposalId) external nonReentrant {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (_resolveState(proposal) != ProposalState.Executed) revert ProposalNotExecuted();

        // Proposer can settle anytime; everyone else waits for duration
        if (msg.sender != proposal.proposer) {
            if (block.timestamp < proposal.executedAt + proposal.strategyDuration) {
                revert StrategyDurationNotElapsed();
            }
        }

        // Run the pre-committed settlement calls
        ISyndicateVault(proposal.vault).executeGovernorBatch(_loadCalls(_settlementCalls, proposalId));

        _finishSettlement(proposalId, proposal);
    }

    // NOTE: emergencySettle removed in Task 2 — replaced by the full guardian
    // review lifecycle in GovernorEmergency (implemented in Task 24):
    // unstick / emergencySettleWithCalls / cancelEmergencySettle / finalizeEmergencySettle.

    /// @inheritdoc ISyndicateGovernor
    function cancelProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != proposal.proposer) revert NotProposer();
        ProposalState s = _resolveState(proposal);
        if (s == ProposalState.Pending) {
            // Pending: only during the voting period.
            if (block.timestamp > proposal.voteEnd) revert ProposalNotCancellable();
            _decOpen(proposal.vault);
        } else if (s != ProposalState.Draft) {
            revert ProposalNotCancellable();
        }
        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @dev Narrowed to Draft/Pending only (Task 25) — once a proposal reaches
    ///      GuardianReview or later, the guardian cohort and execution window
    ///      drive resolution and the owner loses unilateral cancel authority.
    function emergencyCancel(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        ProposalState s = _resolveState(proposal);
        if (s == ProposalState.Pending) _decOpen(proposal.vault);
        else if (s != ProposalState.Draft) revert ProposalNotCancellable();
        proposal.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @dev Single-site decrement for the open-proposal counter (PR #229 Fix 2).
    ///      Unchecked to save bytecode; the caller guarantees the counter is > 0
    ///      (each dec is matched by a prior inc on Draft -> Pending in
    ///      `propose` / `approveCollaboration`).
    function _decOpen(address vault) private {
        unchecked {
            --openProposalCount[vault];
        }
    }

    /// @inheritdoc ISyndicateGovernor
    /// @dev Narrowed to Pending only (Task 25) — post-vote veto flows through
    ///      the guardian-review path rather than unilateral owner action.
    function vetoProposal(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        if (msg.sender != OwnableUpgradeable(proposal.vault).owner()) revert NotVaultOwner();
        if (_resolveState(proposal) != ProposalState.Pending) revert ProposalNotCancellable();
        proposal.state = ProposalState.Rejected;
        // `_activeProposal` is unset during Pending (only set by execute).
        _decOpen(proposal.vault);
        emit ProposalVetoed(proposalId, msg.sender);
    }

    // ==================== COLLABORATIVE PROPOSALS ====================

    /// @inheritdoc ISyndicateGovernor
    function approveCollaboration(uint256 proposalId) external {
        StrategyProposal storage proposal = _proposals[proposalId];
        ProposalState storedState = proposal.state;
        ProposalState state = _resolveState(proposal);
        // Give a specific error for expired collaboration windows
        if (state != ProposalState.Draft) {
            if (storedState == ProposalState.Draft && block.timestamp > collaborationDeadline[proposalId]) {
                revert CollaborationExpired();
            }
            revert NotDraftState();
        }

        _requireCoProposer(proposalId);
        if (!ISyndicateVault(proposal.vault).isAgent(msg.sender)) revert NotRegisteredAgent();
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
            // Transition to Pending -- voting begins
            uint256 reviewPeriod_ =
                _guardianRegistry != address(0) ? IGuardianRegistry(_guardianRegistry).reviewPeriod() : 0;
            proposal.state = ProposalState.Pending;
            // -1: see propose() (G-C1).
            proposal.snapshotTimestamp = block.timestamp - 1;
            proposal.voteEnd = block.timestamp + _params.votingPeriod;
            proposal.reviewEnd = proposal.voteEnd + reviewPeriod_;
            proposal.executeBy = proposal.reviewEnd + _params.executionWindow;
            // Draft -> Pending: this is the first non-terminal state that binds
            // the vault, so start counting it now.
            unchecked {
                ++openProposalCount[proposal.vault];
            }
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

    // ==================== VAULT MANAGEMENT ====================

    /// @inheritdoc ISyndicateGovernor
    function addVault(address vault) external {
        if (msg.sender != owner() && msg.sender != factory) revert NotAuthorized();
        if (vault == address(0)) revert InvalidVault();
        if (!_registeredVaults.add(vault)) revert VaultAlreadyRegistered();
        emit VaultAdded(vault);
    }

    /// @inheritdoc ISyndicateGovernor
    function setFactory(address factory_) external onlyOwner {
        factory = factory_;
        emit FactoryUpdated(factory_);
    }

    /// @inheritdoc ISyndicateGovernor
    function removeVault(address vault) external onlyOwner {
        if (!_registeredVaults.remove(vault)) revert VaultNotRegistered();
        emit VaultRemoved(vault);
    }

    // ==================== VIEWS ====================

    /// @inheritdoc ISyndicateGovernor
    function getProposal(uint256 proposalId) external view returns (StrategyProposal memory p) {
        p = _proposals[proposalId];
        p.state = _resolveStateView(_proposals[proposalId]);
    }

    /// @inheritdoc ISyndicateGovernor
    function getProposalState(uint256 proposalId) external view returns (ProposalState) {
        return _resolveStateView(_proposals[proposalId]);
    }

    /// @inheritdoc ISyndicateGovernor
    /// @dev Returns concatenation of executeCalls + settlementCalls for backwards compatibility
    function getProposalCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory exec = _loadCalls(_executeCalls, proposalId);
        BatchExecutorLib.Call[] memory settle = _loadCalls(_settlementCalls, proposalId);
        BatchExecutorLib.Call[] memory result = new BatchExecutorLib.Call[](exec.length + settle.length);
        for (uint256 i = 0; i < exec.length; i++) {
            result[i] = exec[i];
        }
        for (uint256 i = 0; i < settle.length; i++) {
            result[exec.length + i] = settle[i];
        }
        return result;
    }

    /// @inheritdoc ISyndicateGovernor
    function getExecuteCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory) {
        return _loadCalls(_executeCalls, proposalId);
    }

    /// @inheritdoc ISyndicateGovernor
    function getSettlementCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory) {
        return _loadCalls(_settlementCalls, proposalId);
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
    function getRegisteredVaults() external view returns (address[] memory) {
        return _registeredVaults.values();
    }

    /// @inheritdoc ISyndicateGovernor
    function getActiveProposal(address vault) external view returns (uint256) {
        return _activeProposal[vault];
    }

    // `openProposalCount(address)` served by the public mapping auto-getter above.

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

    /// @inheritdoc ISyndicateGovernor
    function protocolFeeBps() external view returns (uint256) {
        return _protocolFeeBps;
    }

    /// @inheritdoc ISyndicateGovernor
    function protocolFeeRecipient() external view returns (address) {
        return _protocolFeeRecipient;
    }

    /// @inheritdoc ISyndicateGovernor
    function guardianRegistry() external view returns (address) {
        return _guardianRegistry;
    }

    /// @notice Narrow proposal view consumed by the guardian registry.
    /// @dev Returns a tuple (`voteEnd`, `reviewEnd`, `vault`) encoded to match
    ///      `GuardianRegistry.IGovernorMinimal.ProposalView`. Keeps the registry
    ///      decoupled from the full `StrategyProposal` ABI.
    function getProposalView(uint256 proposalId) external view returns (ProposalViewLite memory v) {
        StrategyProposal storage p = _proposals[proposalId];
        v.voteEnd = p.voteEnd;
        v.reviewEnd = p.reviewEnd;
        v.vault = p.vault;
    }

    /// @dev Mirrors `GuardianRegistry.IGovernorMinimal.ProposalView` for ABI parity.
    struct ProposalViewLite {
        uint256 voteEnd;
        uint256 reviewEnd;
        address vault;
    }

    function _applyProtocolFeeBpsChange(uint256 newValue) internal override returns (uint256 old) {
        old = _protocolFeeBps;
        _protocolFeeBps = newValue;
    }

    function _setProtocolFeeRecipient(address newRecipient) internal override {
        _protocolFeeRecipient = newRecipient;
    }

    // ==================== INTERNAL ====================

    /// @dev Push calldata calls into a storage mapping slot
    function _storeCalls(
        mapping(uint256 => BatchExecutorLib.Call[]) storage target,
        uint256 proposalId,
        BatchExecutorLib.Call[] calldata calls
    ) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            target[proposalId].push(calls[i]);
        }
    }

    /// @dev Copy calls from storage to memory
    function _loadCalls(mapping(uint256 => BatchExecutorLib.Call[]) storage source, uint256 proposalId)
        internal
        view
        returns (BatchExecutorLib.Call[] memory result)
    {
        BatchExecutorLib.Call[] storage stored = source[proposalId];
        result = new BatchExecutorLib.Call[](stored.length);
        for (uint256 i = 0; i < stored.length; i++) {
            result[i] = stored[i];
        }
    }

    /// @dev Emit ProposalCreated event (reads from storage to avoid stack-too-deep in propose())
    function _emitProposalCreated(uint256 proposalId, uint256 executeCallCount, uint256 settlementCallCount) internal {
        StrategyProposal storage p = _proposals[proposalId];
        emit ProposalCreated(
            proposalId,
            p.proposer,
            p.vault,
            p.performanceFeeBps,
            p.strategyDuration,
            executeCallCount,
            settlementCallCount,
            p.metadataURI
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

        // Lead split = 10000 - totalCoSplitBps (must be >= 10%)
        if (totalCoSplitBps > 9000) revert LeadSplitTooLow();
    }

    /// @dev Compute the resolved state and persist any transitions to storage.
    ///      Drives registry-side review resolution when the review window has
    ///      elapsed and no cached resolution exists yet (mutating path).
    function _resolveState(StrategyProposal storage proposal) internal returns (ProposalState) {
        ProposalState stored = proposal.state;
        ProposalState resolved = _resolveStateView(proposal);

        // If the review window ended and the registry hasn't cached a resolution
        // yet, call `resolveReview` once to finalize it. Mirrors the view-path
        // logic but commits the registry-side state.
        if (
            resolved == ProposalState.GuardianReview && block.timestamp > proposal.reviewEnd
                && _guardianRegistry != address(0)
        ) {
            bool blocked = IGuardianRegistry(_guardianRegistry).resolveReview(proposal.id);
            if (blocked) {
                resolved = ProposalState.Rejected;
            } else {
                resolved = block.timestamp > proposal.executeBy ? ProposalState.Expired : ProposalState.Approved;
            }
            emit GuardianReviewResolved(proposal.id, blocked);
        }

        if (resolved != stored) {
            proposal.state = resolved;
            // Terminal transitions from a counted state dec the counter; the
            // only uncounted source (Draft) emits its distinct event instead.
            if (resolved == ProposalState.Rejected || resolved == ProposalState.Expired) {
                if (stored != ProposalState.Draft) _decOpen(proposal.vault);
                else emit CollaborationDeadlineExpired(proposal.id);
            }
        }
        return resolved;
    }

    /// @dev Pure state resolution logic (view-only, no storage writes).
    ///      Optimistic governance: proposals pass the vote unless AGAINST votes
    ///      reach veto threshold, then transition to GuardianReview until the
    ///      review window ends. After review, they map to Approved or Rejected
    ///      based on the registry's cached resolution.
    function _resolveStateView(StrategyProposal storage proposal) internal view returns (ProposalState) {
        ProposalState stored = proposal.state;

        if (stored == ProposalState.Draft) {
            return block.timestamp > collaborationDeadline[proposal.id] ? ProposalState.Expired : ProposalState.Draft;
        }

        if (stored == ProposalState.Pending) {
            if (block.timestamp <= proposal.voteEnd) return ProposalState.Pending;

            // Voting ended -- optimistic: approved unless AGAINST votes reach veto threshold
            uint256 pastTotalSupply = IVotes(proposal.vault).getPastTotalSupply(proposal.snapshotTimestamp);
            uint256 vetoThreshold = (pastTotalSupply * _params.vetoThresholdBps) / 10000;

            if (proposal.votesAgainst >= vetoThreshold) {
                return ProposalState.Rejected;
            }

            // Voting passed — fall through to guardian-review handling below.
            return _resolveAfterVote(proposal);
        }

        if (stored == ProposalState.GuardianReview) {
            return _resolveAfterVote(proposal);
        }

        if (stored == ProposalState.Approved) {
            return block.timestamp > proposal.executeBy ? ProposalState.Expired : ProposalState.Approved;
        }

        return stored;
    }

    /// @dev Maps a vote-passed proposal to GuardianReview / Approved / Rejected / Expired
    ///      based on `reviewEnd` and the registry's cached review state.
    function _resolveAfterVote(StrategyProposal storage proposal) internal view returns (ProposalState) {
        if (block.timestamp <= proposal.reviewEnd) return ProposalState.GuardianReview;

        if (_guardianRegistry != address(0)) {
            (, bool resolved, bool blocked, bool cohortTooSmall) =
                IGuardianRegistry(_guardianRegistry).getReviewState(proposal.id);
            if (resolved) {
                if (blocked && !cohortTooSmall) return ProposalState.Rejected;
                return block.timestamp > proposal.executeBy ? ProposalState.Expired : ProposalState.Approved;
            }
            // Review window ended but registry hasn't resolved yet — remain in
            // GuardianReview. Mutating callers (`_resolveState`) will trigger
            // `resolveReview` which maps to Approved / Rejected.
            return ProposalState.GuardianReview;
        }

        // No registry wired: review window collapses to zero — treat as Approved.
        return block.timestamp > proposal.executeBy ? ProposalState.Expired : ProposalState.Approved;
    }

    function _finishSettlement(uint256 proposalId, StrategyProposal storage proposal)
        internal
        returns (int256 pnl, uint256 agentFee)
    {
        address vault = proposal.vault;
        address asset = IERC4626(vault).asset();

        // casting to int256 is safe because vault balances won't exceed int256.max
        // forge-lint: disable-next-line(unsafe-typecast)
        pnl = int256(IERC20(asset).balanceOf(vault)) - int256(_capitalSnapshots[proposalId]);

        // Finalize state before external transfers to prevent reentrancy on stale state
        _activeProposal[vault] = 0;
        _lastSettledAt[vault] = block.timestamp;
        proposal.state = ProposalState.Settled;
        // PR #229 Fix 2: single dec for the happy-path lifecycle
        // (Pending -> GuardianReview? -> Approved -> Executed -> Settled).
        // `_activeProposal` also covers Executed so `requestUnstakeOwner`'s
        // OR-check blocks rage-quit even before this dec fires.
        _decOpen(vault);

        uint256 totalFee = 0;
        if (pnl > 0) {
            (agentFee, totalFee) =
                _distributeFees(proposalId, vault, asset, proposal.proposer, proposal.performanceFeeBps, uint256(pnl));
        }

        emit ProposalSettled(proposalId, vault, pnl, totalFee, block.timestamp - proposal.executedAt);
    }

    /// @dev Distribute protocol, agent, and management fees. Extracted to avoid stack-too-deep.
    function _distributeFees(
        uint256 proposalId,
        address vault,
        address asset,
        address proposer,
        uint256 perfFeeBps,
        uint256 profit
    ) internal returns (uint256 agentFee, uint256 totalFee) {
        uint256 protocolFee = 0;

        // Protocol fee taken first from gross profit
        if (_protocolFeeBps > 0 && _protocolFeeRecipient != address(0)) {
            protocolFee = (profit * _protocolFeeBps) / 10000;
            if (protocolFee > 0) {
                ISyndicateVault(vault).transferPerformanceFee(asset, _protocolFeeRecipient, protocolFee);
            }
        }

        uint256 netProfit = profit - protocolFee;

        // Agent performance fee from net profit
        agentFee = (netProfit * perfFeeBps) / 10000;

        // Management fee from remainder after agent fee
        uint256 mgmtFee = ((netProfit - agentFee) * ISyndicateVault(vault).managementFeeBps()) / 10000;

        if (agentFee > 0) {
            _distributeAgentFee(proposalId, vault, asset, proposer, agentFee);
        }
        if (mgmtFee > 0) {
            ISyndicateVault(vault).transferPerformanceFee(asset, OwnableUpgradeable(vault).owner(), mgmtFee);
        }

        totalFee = protocolFee + agentFee + mgmtFee;
    }

    /// @dev Distribute agent fee to co-proposers (if any) and lead proposer. Extracted to avoid stack-too-deep.
    function _distributeAgentFee(uint256 proposalId, address vault, address asset, address proposer, uint256 agentFee)
        internal
    {
        CoProposer[] storage coProps = _coProposers[proposalId];
        if (coProps.length > 0) {
            // Distribute to co-proposers first, lead gets remainder
            // Deregistered co-proposers are skipped -- their share goes to the lead
            uint256 distributed = 0;
            for (uint256 i = 0; i < coProps.length; i++) {
                uint256 share = (agentFee * coProps[i].splitBps) / 10000;
                if (share > 0 && ISyndicateVault(vault).isAgent(coProps[i].agent)) {
                    ISyndicateVault(vault).transferPerformanceFee(asset, coProps[i].agent, share);
                    distributed += share;
                }
            }
            // Lead proposer gets remainder (handles rounding)
            uint256 leadShare = agentFee - distributed;
            if (leadShare > 0) {
                ISyndicateVault(vault).transferPerformanceFee(asset, proposer, leadShare);
            }
        } else {
            // Solo proposal -- all to proposer
            ISyndicateVault(vault).transferPerformanceFee(asset, proposer, agentFee);
        }
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
