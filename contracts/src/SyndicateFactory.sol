// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SyndicateVault} from "./SyndicateVault.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {IL2Registrar} from "./interfaces/IL2Registrar.sol";

/**
 * @title SyndicateFactory
 * @notice Deploys new syndicate vaults as immutable ERC-1967 proxies. One tx = one syndicate.
 *
 *   All syndicates share the same executor lib (stateless, called via delegatecall)
 *   and vault implementation. Each vault proxy has its own storage: positions,
 *   agent registry, and depositor whitelist.
 *
 *   ENS subnames are registered atomically via Durin L2 Registrar, so each
 *   syndicate gets a <subdomain>.sherwoodagent.eth name resolving to its vault.
 *
 *   UUPS upgradeable — owner can update config (creation fee, governor, etc.)
 *   but deployed vaults are immutable (no upgradeTo on vaults).
 */
contract SyndicateFactory is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidExecutorImpl();
    error InvalidVaultImpl();
    error InvalidENSRegistrar();
    error InvalidAgentRegistry();
    error NotAgentOwner();
    error SubdomainTooShort();
    error SubdomainTaken();
    error NotCreator();
    error InvalidGovernor();
    error InsufficientCreationFee();
    error InvalidFeeToken();
    error ManagementFeeTooHigh();
    error UpgradesDisabled();
    error VaultNotDeployed();
    error StrategyActive();

    struct SyndicateConfig {
        string metadataURI; // ipfs://Qm... (name, description, strategies)
        IERC20 asset; // Deposit asset (e.g., USDC)
        string name; // Vault token name
        string symbol; // Vault token symbol
        bool openDeposits; // If true, anyone can deposit. If false, depositor whitelist enforced.
        string subdomain; // ENS subdomain label (e.g. "alpha-seekers")
    }

    struct Syndicate {
        uint256 id;
        address vault; // ERC-4626 vault (proxy)
        address creator;
        string metadataURI; // ipfs://... via Pinata
        uint256 createdAt;
        bool active;
        string subdomain; // ENS subdomain registered
    }

    // ── Storage ──

    /// @notice Shared executor lib (deployed once, stateless)
    address public executorImpl;

    /// @notice Shared vault implementation (proxies are non-upgradeable)
    address public vaultImpl;

    /// @notice Durin L2 Registrar for ENS subnames
    IL2Registrar public ensRegistrar;

    /// @notice ERC-8004 agent identity registry (ERC-721)
    IERC721 public agentRegistry;

    /// @notice Shared governor contract
    address public governor;

    /// @notice Management fee for vault owners (bps of strategy profits)
    uint256 public managementFeeBps;

    /// @notice All syndicates
    mapping(uint256 => Syndicate) public syndicates;
    uint256 public syndicateCount;

    /// @notice Vault address → syndicate ID
    mapping(address => uint256) public vaultToSyndicate;

    /// @notice ENS subdomain → syndicate ID
    mapping(string => uint256) public subdomainToSyndicate;

    /// @notice ERC-20 token required for creation fee (e.g., USDC)
    IERC20 public creationFeeToken;

    /// @notice Amount of creationFeeToken required to create a syndicate (0 = free)
    uint256 public creationFee;

    /// @notice Recipient of creation fees
    address public creationFeeRecipient;

    /// @notice Whether vault upgrades are enabled (default: false)
    bool public upgradesEnabled;

    // ── Events ──

    event SyndicateCreated(
        uint256 indexed id, address indexed vault, address indexed creator, string metadataURI, string subdomain
    );
    event MetadataUpdated(uint256 indexed id, string metadataURI);
    event SyndicateDeactivated(uint256 indexed id);
    event CreationFeeUpdated(address token, uint256 amount, address recipient);
    event GovernorUpdated(address oldGovernor, address newGovernor);
    event VaultImplUpdated(address oldImpl, address newImpl);
    event ManagementFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event VaultUpgraded(address indexed vault, address indexed newImpl);
    event UpgradesEnabledUpdated(bool enabled);

    struct InitParams {
        address owner;
        address executorImpl;
        address vaultImpl;
        address ensRegistrar;
        address agentRegistry;
        address governor;
        uint256 managementFeeBps;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external initializer {
        if (p.executorImpl == address(0)) revert InvalidExecutorImpl();
        if (p.vaultImpl == address(0)) revert InvalidVaultImpl();
        if (p.ensRegistrar == address(0)) revert InvalidENSRegistrar();
        if (p.agentRegistry == address(0)) revert InvalidAgentRegistry();
        if (p.governor == address(0)) revert InvalidGovernor();

        __Ownable_init(p.owner);

        executorImpl = p.executorImpl;
        vaultImpl = p.vaultImpl;
        ensRegistrar = IL2Registrar(p.ensRegistrar);
        agentRegistry = IERC721(p.agentRegistry);
        governor = p.governor;
        if (p.managementFeeBps > 1000) revert ManagementFeeTooHigh();
        managementFeeBps = p.managementFeeBps;
    }

    // ==================== SYNDICATE CREATION ====================

    /// @notice Create a new syndicate — deploys vault proxy, registers ENS subname, stores everything
    /// @param creatorAgentId ERC-8004 agent ID of the creator (must be owned by msg.sender)
    /// @param config Syndicate configuration
    /// @return syndicateId The new syndicate's ID
    /// @return vault The deployed vault proxy address
    function createSyndicate(uint256 creatorAgentId, SyndicateConfig calldata config)
        external
        returns (uint256 syndicateId, address vault)
    {
        // Collect creation fee (if set)
        if (creationFee > 0) {
            if (address(creationFeeToken) == address(0)) revert InvalidFeeToken();
            creationFeeToken.safeTransferFrom(msg.sender, creationFeeRecipient, creationFee);
        }

        // Verify ERC-8004 identity
        if (agentRegistry.ownerOf(creatorAgentId) != msg.sender) revert NotAgentOwner();

        // Validate subdomain
        if (bytes(config.subdomain).length < 3) revert SubdomainTooShort();
        if (subdomainToSyndicate[config.subdomain] != 0) revert SubdomainTaken();

        syndicateId = ++syndicateCount;

        // Deploy vault as immutable proxy (no upgradeTo — locked to vaultImpl)
        ISyndicateVault.InitParams memory initParams = ISyndicateVault.InitParams({
            asset: address(config.asset),
            name: config.name,
            symbol: config.symbol,
            owner: msg.sender,
            executorImpl: executorImpl,
            openDeposits: config.openDeposits,
            agentRegistry: address(agentRegistry),
            managementFeeBps: managementFeeBps
        });
        bytes memory initData = abi.encodeCall(SyndicateVault.initialize, (initParams));

        vault = address(new ERC1967Proxy(vaultImpl, initData));

        // Register ENS subname — vault is both address record + NFT owner
        ensRegistrar.register(config.subdomain, vault);

        syndicates[syndicateId] = Syndicate({
            id: syndicateId,
            vault: vault,
            creator: msg.sender,
            metadataURI: config.metadataURI,
            createdAt: block.timestamp,
            active: true,
            subdomain: config.subdomain
        });

        vaultToSyndicate[vault] = syndicateId;
        subdomainToSyndicate[config.subdomain] = syndicateId;

        emit SyndicateCreated(syndicateId, vault, msg.sender, config.metadataURI, config.subdomain);
    }

    // ==================== CREATOR FUNCTIONS ====================

    /// @notice Update syndicate metadata (creator only)
    function updateMetadata(uint256 syndicateId, string calldata metadataURI) external {
        Syndicate storage s = syndicates[syndicateId];
        if (s.creator != msg.sender) revert NotCreator();
        s.metadataURI = metadataURI;
        emit MetadataUpdated(syndicateId, metadataURI);
    }

    /// @notice Deactivate a syndicate (creator only)
    function deactivate(uint256 syndicateId) external {
        Syndicate storage s = syndicates[syndicateId];
        if (s.creator != msg.sender) revert NotCreator();
        s.active = false;
        emit SyndicateDeactivated(syndicateId);
    }

    // ==================== ADMIN (OWNER) ====================

    /// @notice Set creation fee parameters (0 amount = free creation)
    function setCreationFee(address token, uint256 amount, address recipient) external onlyOwner {
        if (amount > 0 && token == address(0)) revert InvalidFeeToken();
        if (amount > 0 && recipient == address(0)) revert InvalidFeeToken();
        creationFeeToken = IERC20(token);
        creationFee = amount;
        creationFeeRecipient = recipient;
        emit CreationFeeUpdated(token, amount, recipient);
    }

    /// @notice Update the governor contract for new vaults
    function setGovernor(address newGovernor) external onlyOwner {
        if (newGovernor == address(0)) revert InvalidGovernor();
        address old = governor;
        governor = newGovernor;
        emit GovernorUpdated(old, newGovernor);
    }

    /// @notice Update the vault implementation for new vaults (existing vaults unaffected)
    function setVaultImpl(address newVaultImpl) external onlyOwner {
        if (newVaultImpl == address(0)) revert InvalidVaultImpl();
        address old = vaultImpl;
        vaultImpl = newVaultImpl;
        emit VaultImplUpdated(old, newVaultImpl);
    }

    /// @notice Update management fee for new vaults (existing vaults unaffected)
    function setManagementFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > 1000) revert ManagementFeeTooHigh(); // max 10%
        uint256 old = managementFeeBps;
        managementFeeBps = newBps;
        emit ManagementFeeBpsUpdated(old, newBps);
    }

    /// @notice Enable or disable vault upgrades (owner only)
    function setUpgradesEnabled(bool enabled) external onlyOwner {
        upgradesEnabled = enabled;
        emit UpgradesEnabledUpdated(enabled);
    }

    /// @notice Upgrade a vault to a new implementation. Callable by the syndicate owner (vault owner).
    /// @dev Factory must have upgrades enabled, and newImpl must be the current factory vaultImpl.
    /// @param vault The vault proxy to upgrade
    function upgradeVault(address vault) external {
        if (!upgradesEnabled) revert UpgradesDisabled();
        uint256 syndicateId = vaultToSyndicate[vault];
        if (syndicateId == 0) revert VaultNotDeployed();
        if (syndicates[syndicateId].creator != msg.sender) revert NotCreator();
        // Cannot upgrade while a strategy is active
        if (governor != address(0) && ISyndicateGovernor(governor).getActiveProposal(vault) != 0) {
            revert StrategyActive();
        }
        UUPSUpgradeable(vault).upgradeToAndCall(vaultImpl, "");
        emit VaultUpgraded(vault, vaultImpl);
    }

    // ==================== VIEWS ====================

    /// @notice Check if a subdomain is available for registration
    function isSubdomainAvailable(string calldata subdomain) external view returns (bool) {
        return subdomainToSyndicate[subdomain] == 0 && ensRegistrar.available(subdomain);
    }

    /// @notice Get active syndicates with pagination (for dashboard)
    /// @param offset Starting index (0-based)
    /// @param limit Maximum number of results to return
    /// @return result Array of active syndicates
    /// @return total Total count of active syndicates
    function getActiveSyndicates(uint256 offset, uint256 limit)
        external
        view
        returns (Syndicate[] memory result, uint256 total)
    {
        // First pass: count active syndicates
        uint256 count = 0;
        for (uint256 i = 1; i <= syndicateCount; i++) {
            if (syndicates[i].active) count++;
        }
        total = count;

        if (offset >= count || limit == 0) {
            return (new Syndicate[](0), total);
        }

        // Calculate actual return size
        uint256 remaining = count - offset;
        uint256 size = remaining < limit ? remaining : limit;
        result = new Syndicate[](size);

        // Second pass: fill results starting from offset
        uint256 activeIdx = 0;
        uint256 resultIdx = 0;
        for (uint256 i = 1; i <= syndicateCount && resultIdx < size; i++) {
            if (syndicates[i].active) {
                if (activeIdx >= offset) {
                    result[resultIdx++] = syndicates[i];
                }
                activeIdx++;
            }
        }
    }

    /// @notice Get ALL active syndicates (may exceed gas at scale — prefer paginated version)
    function getAllActiveSyndicates() external view returns (Syndicate[] memory) {
        (Syndicate[] memory result,) = this.getActiveSyndicates(0, syndicateCount);
        return result;
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
