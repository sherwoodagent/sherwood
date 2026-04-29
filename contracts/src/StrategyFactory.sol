// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";

/// @title StrategyFactory
/// @notice Atomic clone + initialize wrapper for strategy templates.
///
///         Strategy templates use a custom `_initialized` flag (not OZ
///         Initializable) and run `initialize` from an `external` function;
///         deploying a clone via `Clones.clone(template)` followed by a
///         separate `initialize` tx exposes a front-running window where an
///         attacker can race the init and bind the clone to their own vault.
///
///         This factory bundles both into a single tx. Strategy templates
///         that wish to be exclusively cloned through this path can
///         optionally restrict `initialize` to `msg.sender == factory`,
///         though `Clones.clone` already deterministically prevents reuse
///         of an initialized clone.
contract StrategyFactory {
    event StrategyCloned(address indexed template, address indexed vault, address indexed clone);

    /// @notice Clone `template` and run `initialize(vault, proposer, data)` atomically.
    /// @param template Strategy template address (e.g., a deployed concrete BaseStrategy).
    /// @param vault    Vault that will own the clone's lifecycle.
    /// @param proposer Strategy proposer.
    /// @param data     Strategy-specific init bytes (decoded inside `_initialize`).
    /// @return clone   Address of the cloned + initialized strategy.
    function cloneAndInit(address template, address vault, address proposer, bytes calldata data)
        external
        returns (address clone)
    {
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
        clone = Clones.cloneDeterministic(template, salt);
        IStrategy(clone).initialize(vault, proposer, data);
        emit StrategyCloned(template, vault, clone);
    }
}
