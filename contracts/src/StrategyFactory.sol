// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";

/// @notice Minimal view surface needed to gate clone calls on registered vaults.
interface ISyndicateRegistry {
    function vaultToSyndicate(address vault) external view returns (uint256);
}

/// @notice Minimal view surface for agent / owner check.
interface IVaultMembership {
    function isAgent(address agentAddress) external view returns (bool);
    function owner() external view returns (address);
}

/// @title StrategyFactory
/// @notice Atomic clone + initialize wrapper for strategy templates.
///
///         Strategy templates use a custom `_initialized` flag (not OZ
///         Initializable) and run `initialize` from an `external` function;
///         deploying a clone via `Clones.clone(template)` followed by a
///         separate `initialize` tx exposes a front-running window where an
///         attacker can race the init and bind the clone to their own vault.
///
///         This factory bundles both into a single tx.
///
///         MS-C2 hardening: strategies must always be pre-deployed by the
///         vault's creator or a registered agent BEFORE proposal execution.
///         The governor itself does not deploy strategies during execute —
///         proposals reference an already-cloned-and-initialized strategy
///         address. Authorized callers are:
///
///           - `vault.owner()` (creator pre-deploy);
///           - `vault.isAgent(msg.sender)` (registered agent pre-deploy).
///
///         The vault must additionally be registered on `syndicateFactory` so
///         a rogue contract cannot spoof the membership view.
contract StrategyFactory {
    /// @notice SyndicateFactory used to verify that `vault` is a registered vault.
    /// @dev Immutable: set once at construction. A clone-fn caller-vault gate is
    ///      meaningless if the registry it consults can be hot-swapped.
    address public immutable syndicateFactory;

    error Unauthorized();
    error VaultNotRegistered();
    error InvalidSyndicateFactory();

    event StrategyCloned(address indexed template, address indexed vault, address indexed clone);

    constructor(address syndicateFactory_) {
        if (syndicateFactory_ == address(0)) revert InvalidSyndicateFactory();
        syndicateFactory = syndicateFactory_;
    }

    /// @dev MS-C2: caller is the vault's owner or a registered agent of the
    ///      vault, and the vault is a registered Sherwood vault. Strategies
    ///      are always pre-deployed; the governor does not deploy at execute.
    function _authClone(address vault) internal view {
        if (ISyndicateRegistry(syndicateFactory).vaultToSyndicate(vault) == 0) {
            revert VaultNotRegistered();
        }
        IVaultMembership v = IVaultMembership(vault);
        if (msg.sender == v.owner()) return;
        if (v.isAgent(msg.sender)) return;
        revert Unauthorized();
    }

    /// @notice Clone `template` and run `initialize(vault, proposer, data)` atomically.
    /// @param template Strategy template address (e.g., a deployed concrete BaseStrategy).
    /// @param vault    Vault that will own the clone's lifecycle. MUST equal `msg.sender`.
    /// @param proposer Strategy proposer.
    /// @param data     Strategy-specific init bytes (decoded inside `_initialize`).
    /// @return clone   Address of the cloned + initialized strategy.
    function cloneAndInit(address template, address vault, address proposer, bytes calldata data)
        external
        returns (address clone)
    {
        _authClone(vault);
        clone = Clones.clone(template);
        IStrategy(clone).initialize(vault, proposer, data);
        emit StrategyCloned(template, vault, clone);
    }

    /// @notice Deterministic variant — caller can predict the clone address via
    ///         `Clones.predictDeterministicAddress`.
    function cloneAndInitDeterministic(
        address template,
        address vault,
        address proposer,
        bytes calldata data,
        bytes32 salt
    ) external returns (address clone) {
        _authClone(vault);
        clone = Clones.cloneDeterministic(template, salt);
        IStrategy(clone).initialize(vault, proposer, data);
        emit StrategyCloned(template, vault, clone);
    }
}
