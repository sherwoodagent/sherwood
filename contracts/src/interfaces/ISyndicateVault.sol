// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateVault {
    // ── Errors ──
    error InvalidOwner();
    error InvalidExecutorImpl();
    error NotActiveAgent();
    error SimulationFailed();
    error InvalidDepositor();
    error DepositorAlreadyApproved();
    error DepositorNotApproved();
    error NotApprovedDepositor();
    error AgentAlreadyRegistered();
    error AgentNotActive();
    error InvalidAgentRegistry();
    error NotAgentOwner();
    error NotGovernor();
    error RedemptionsLocked();
    error DepositsLocked();
    error InvalidAgentAddress();
    error TransferFailed();
    error ZeroAddress();
    error CannotRescueAsset();
    error NotFactory();
    error GovernorNotSet();
    error ExecutorCodehashMismatch();

    // ── Init Params ──
    struct InitParams {
        address asset;
        string name;
        string symbol;
        address owner;
        address executorImpl;
        bool openDeposits;
        address agentRegistry;
        uint256 managementFeeBps;
    }

    // ── Per-Agent Config ──
    struct AgentConfig {
        uint256 agentId; // ERC-8004 identity token ID
        address agentAddress; // Agent wallet address
        bool active;
    }

    // ── Depositor Whitelist ──
    function approveDepositor(address depositor) external;
    function removeDepositor(address depositor) external;
    function approveDepositors(address[] calldata depositors) external;
    function isApprovedDepositor(address depositor) external view returns (bool);
    function getApprovedDepositors() external view returns (address[] memory);
    function approvedDepositorsPaginated(uint256 offset, uint256 limit) external view returns (address[] memory);
    function approvedDepositorCount() external view returns (uint256);
    function setOpenDeposits(bool open) external;
    function openDeposits() external view returns (bool);

    // ── Views ──
    function getAgentConfig(address agentAddress) external view returns (AgentConfig memory);
    function getAgentCount() external view returns (uint256);
    function agentsPaginated(uint256 offset, uint256 limit) external view returns (address[] memory);
    function isAgent(address agentAddress) external view returns (bool);
    function getExecutorImpl() external view returns (address);

    // ── Factory ──
    function factory() external view returns (address);

    // ── Governor ──
    function executeGovernorBatch(BatchExecutorLib.Call[] calldata calls) external;
    function transferPerformanceFee(address asset, address to, uint256 amount) external;
    function governor() external view returns (address);
    function redemptionsLocked() external view returns (bool);
    function managementFeeBps() external view returns (uint256);

    // ── Rescue ──
    function rescueEth(address payable to, uint256 amount) external;
    function rescueERC20(address token, address to, uint256 amount) external;
    function rescueERC721(address token, uint256 tokenId, address to) external;

    // ── Admin (syndicate creator) ──
    function registerAgent(uint256 agentId, address agentAddress) external;
    function removeAgent(address agentAddress) external;
    function pause() external;
    function unpause() external;

    // ── Events ──
    event AgentRegistered(uint256 indexed agentId, address indexed agentAddress);
    event AgentRemoved(address indexed agentAddress);
    event DepositorApproved(address indexed depositor);
    event DepositorRemoved(address indexed depositor);
    event OpenDepositsUpdated(bool open);
    /// @notice Emitted whenever the governor drives a strategy batch into the
    ///         vault via `executeGovernorBatch`. `callCount` is the number of
    ///         sub-calls fanned out by `BatchExecutorLib.executeBatch`.
    /// @dev V-M9: subgraphs and monitors previously had to observe strategy
    ///      execution indirectly via downstream protocol events (Moonwell /
    ///      Aerodrome / Uniswap). Emitting here gives a first-class
    ///      vault-level execution marker.
    event GovernorBatchExecuted(address indexed governor, uint256 callCount);
}
