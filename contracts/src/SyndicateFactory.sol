// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SyndicateVault} from "./SyndicateVault.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
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
    using EnumerableSet for EnumerableSet.UintSet;

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
    error VaultImplMismatch();
    // ── Task 26: owner-stake binding + rotation errors ──
    error InvalidGuardianRegistry();
    error PreparedStakeNotFound();
    error VaultStillStaked();
    error RegistryMismatch();
    error ZeroAddress();
    // ── V-M7: reject zero/empty SyndicateConfig fields ──
    error InvalidSyndicateConfig();

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

    /// @notice Shared governor contract.
    /// @dev Set once at `initialize` and never rewired. There is no setter —
    ///      `setGovernor` was removed to close V-H2, a factory-owner instant
    ///      global retroactive switch that would have orphaned in-flight
    ///      proposals across every registered vault (vaults read the governor
    ///      live via `_getGovernor()`, so a rewire would leave the old
    ///      governor unable to call `onlyGovernor` fns and the new governor
    ///      with no knowledge of the proposal). Governor upgrades must go
    ///      through a UUPS upgrade of the governor itself.
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

    /// @notice Guardian registry used to gate vault creation on prepared owner stake
    ///         and to coordinate owner-stake slot transfers on `rotateOwner`.
    /// @dev Set once at `initialize` and never rewired. The governor and factory
    ///      MUST share the same registry — `rotateOwner` asserts this invariant.
    address public guardianRegistry;

    /// @dev Active-syndicate IDs for O(1) paginated enumeration (V-C4).
    ///      Added on `createSyndicate`, removed on `deactivate`. The legacy
    ///      `syndicates[id].active` flag remains the source of truth for
    ///      individual rows; this set is kept in lock-step.
    EnumerableSet.UintSet private _activeSyndicateIds;

    /// @notice Hard cap on the per-call page size for `getActiveSyndicates`.
    ///         Paginated reads above this cap silently clamp to `MAX_PAGE_LIMIT`.
    uint256 public constant MAX_PAGE_LIMIT = 100;

    /// @dev Reserved for future storage — reduced by 1 for `guardianRegistry`,
    ///      reduced by 1 for `_activeSyndicateIds` (EnumerableSet.UintSet uses
    ///      a single storage slot for the Set struct).
    uint256[48] private __gap;

    // ── Events ──

    event SyndicateCreated(
        uint256 indexed id, address indexed vault, address indexed creator, string metadataURI, string subdomain
    );
    event MetadataUpdated(uint256 indexed id, string metadataURI);
    event SyndicateDeactivated(uint256 indexed id);
    event CreationFeeUpdated(address token, uint256 amount, address recipient);
    event VaultImplUpdated(address oldImpl, address newImpl);
    event ManagementFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event VaultUpgraded(address indexed vault, address indexed newImpl);
    event UpgradesEnabledUpdated(bool enabled);
    event OwnerRotated(address indexed vault, address indexed newOwner);

    struct InitParams {
        address owner;
        address executorImpl;
        address vaultImpl;
        address ensRegistrar;
        address agentRegistry;
        address governor;
        uint256 managementFeeBps;
        address guardianRegistry;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external initializer {
        if (p.executorImpl == address(0)) revert InvalidExecutorImpl();
        if (p.vaultImpl == address(0)) revert InvalidVaultImpl();
        // NOTE: ensRegistrar and agentRegistry can be address(0) on chains without ENS/ERC-8004
        if (p.governor == address(0)) revert InvalidGovernor();
        if (p.guardianRegistry == address(0)) revert InvalidGuardianRegistry();

        __Ownable_init(p.owner);

        executorImpl = p.executorImpl;
        vaultImpl = p.vaultImpl;
        ensRegistrar = IL2Registrar(p.ensRegistrar);
        agentRegistry = IERC721(p.agentRegistry);
        governor = p.governor;
        guardianRegistry = p.guardianRegistry;
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
        // V-M7: reject zero/empty config fields before any side effects. Without
        // these checks, `cfg.asset == 0` would only trip in `SyndicateVault.initialize`
        // (after ENS subdomain registration + registry stake bind), leaving stranded
        // state. Empty name / symbol / metadataURI would deploy a vault with blank
        // ERC-4626 metadata + no IPFS pointer. `subdomain.length < 3` is already
        // checked below (`SubdomainTooShort`) so we only assert non-empty here.
        if (address(config.asset) == address(0)) revert InvalidSyndicateConfig();
        if (bytes(config.name).length == 0) revert InvalidSyndicateConfig();
        if (bytes(config.symbol).length == 0) revert InvalidSyndicateConfig();
        if (bytes(config.subdomain).length == 0) revert InvalidSyndicateConfig();
        if (bytes(config.metadataURI).length == 0) revert InvalidSyndicateConfig();

        // Gate on prepared owner stake BEFORE any side effects (Task 26).
        IGuardianRegistry reg = IGuardianRegistry(guardianRegistry);
        if (!reg.canCreateVault(msg.sender)) revert PreparedStakeNotFound();

        // Collect creation fee (if set)
        if (creationFee > 0) {
            if (address(creationFeeToken) == address(0)) revert InvalidFeeToken();
            creationFeeToken.safeTransferFrom(msg.sender, creationFeeRecipient, creationFee);
        }

        // Verify ERC-8004 identity (skipped on chains without agent registry)
        if (address(agentRegistry) != address(0)) {
            if (agentRegistry.ownerOf(creatorAgentId) != msg.sender) revert NotAgentOwner();
        }

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

        // Register vault with the governor so it can receive proposals
        ISyndicateGovernor(governor).addVault(vault);

        // Bind the prepared owner stake to the newly deployed vault (Task 26).
        // Reverts roll back the whole creation tx — atomic.
        reg.bindOwnerStake(msg.sender, vault);

        // Register ENS subname — vault is both address record + NFT owner
        if (address(ensRegistrar) != address(0)) {
            ensRegistrar.register(config.subdomain, vault);
        }

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
        _activeSyndicateIds.add(syndicateId);

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
        _activeSyndicateIds.remove(syndicateId);
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

    /// @notice Transfer a vault's ownership to `newOwner` and rebind the owner-stake
    ///         slot in the guardian registry.
    /// @dev Owner-only. Requires the old owner to have already unstaked
    ///      (`hasOwnerStake(vault) == false`) — otherwise rotating would strand
    ///      the old stake. Asserts the factory + governor point at the same
    ///      registry to catch misconfiguration. `newOwner` must have a prepared
    ///      stake sized ≥ `requiredOwnerBond(vault)`; the registry's
    ///      `transferOwnerStakeSlot` enforces this.
    function rotateOwner(address vault, address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (vaultToSyndicate[vault] == 0) revert VaultNotDeployed();

        IGuardianRegistry reg = IGuardianRegistry(guardianRegistry);
        if (reg.hasOwnerStake(vault)) revert VaultStillStaked();
        // Registry-consistency invariant: governor and factory must share one registry.
        if (ISyndicateGovernor(governor).guardianRegistry() != guardianRegistry) revert RegistryMismatch();

        SyndicateVault(payable(vault)).rotateOwnership(newOwner);
        reg.transferOwnerStakeSlot(vault, newOwner);

        // Keep creator record in sync so downstream invariants (e.g. NotCreator
        // gates on updateMetadata / deactivate) follow the active owner.
        syndicates[vaultToSyndicate[vault]].creator = newOwner;

        emit OwnerRotated(vault, newOwner);
    }

    /// @notice Upgrade a vault to a new implementation. Callable by the syndicate owner (vault owner).
    /// @dev Factory must have upgrades enabled, and `vaultImpl` must equal `expectedImpl`.
    ///      The `expectedImpl` parameter closes V-H3: otherwise a factory owner
    ///      could call `setVaultImpl(newImpl)` between when the creator decides
    ///      to upgrade and when the upgrade tx lands, landing the vault on an
    ///      impl the creator did not opt into.
    /// @param vault The vault proxy to upgrade
    /// @param expectedImpl The vault implementation address the creator expects
    ///                     to be applied. Reverts with `VaultImplMismatch` if
    ///                     `vaultImpl` has changed since the caller observed it.
    function upgradeVault(address vault, address expectedImpl) external {
        if (!upgradesEnabled) revert UpgradesDisabled();
        uint256 syndicateId = vaultToSyndicate[vault];
        if (syndicateId == 0) revert VaultNotDeployed();
        if (syndicates[syndicateId].creator != msg.sender) revert NotCreator();
        if (vaultImpl != expectedImpl) revert VaultImplMismatch();
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
        return subdomainToSyndicate[subdomain] == 0
            && (address(ensRegistrar) == address(0) || ensRegistrar.available(subdomain));
    }

    /// @notice Get active syndicates with pagination (for dashboard).
    /// @dev    Backed by `_activeSyndicateIds` (EnumerableSet) so reads are
    ///         O(limit) instead of O(syndicateCount). `limit` is hard-capped at
    ///         `MAX_PAGE_LIMIT` to guarantee the call stays well below block
    ///         gas even as the set grows. Closes V-C4.
    /// @param offset Starting index (0-based) into the active-set
    /// @param limit  Maximum number of results to return; clamped to `MAX_PAGE_LIMIT`
    /// @return result Array of active syndicates (in insertion order with swap-pop gaps filled)
    /// @return total  Total count of active syndicates
    function getActiveSyndicates(uint256 offset, uint256 limit)
        external
        view
        returns (Syndicate[] memory result, uint256 total)
    {
        total = _activeSyndicateIds.length();

        if (offset >= total || limit == 0) {
            return (new Syndicate[](0), total);
        }
        if (limit > MAX_PAGE_LIMIT) {
            limit = MAX_PAGE_LIMIT;
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        result = new Syndicate[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            uint256 id = _activeSyndicateIds.at(i);
            result[i - offset] = syndicates[id];
        }
    }

    /// @notice Get ALL active syndicates. Clamped at `MAX_PAGE_LIMIT` per call;
    ///         callers that need every row must paginate via `getActiveSyndicates`.
    function getAllActiveSyndicates() external view returns (Syndicate[] memory) {
        (Syndicate[] memory result,) = this.getActiveSyndicates(0, MAX_PAGE_LIMIT);
        return result;
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
