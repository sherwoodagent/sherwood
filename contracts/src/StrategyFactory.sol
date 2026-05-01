// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";

/// @notice Minimal view surface needed to gate clone calls on registered vaults.
interface ISyndicateRegistry {
    function vaultToSyndicate(address vault) external view returns (uint256);
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
///         MS-C2 hardening: the clone fns are gated so only a vault registered
///         on `syndicateFactory` may clone-and-init a strategy bound to itself.
///         The legitimate caller path is:
///
///             SyndicateGovernor.executeProposal
///               -> Vault.executeGovernorBatch (delegatecall BatchExecutorLib)
///                 -> StrategyFactory.cloneAndInit(template, address(this), ...)
///
///         Inside the delegatecall the outer `msg.sender` arriving at this
///         factory is the vault address itself. We require:
///
///           1. `msg.sender == vault` — caller proves it IS the vault being
///              bound (no third-party can bind a clone to a victim).
///           2. `syndicateFactory.vaultToSyndicate(vault) != 0` — the vault is
///              a real, registered SyndicateFactory vault (no rogue contract
///              spoofing the (1) check by self-binding to a fake address).
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

    /// @dev MS-C2: only a registered vault binding to itself may clone.
    function _authClone(address vault) internal view {
        if (msg.sender != vault) revert Unauthorized();
        if (ISyndicateRegistry(syndicateFactory).vaultToSyndicate(vault) == 0) {
            revert VaultNotRegistered();
        }
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
