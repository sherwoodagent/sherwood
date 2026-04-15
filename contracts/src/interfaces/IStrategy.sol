// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IStrategy
 * @notice Interface for strategy contracts called by the vault via batch calls.
 *
 *   The vault executes strategy actions as part of its batch:
 *     Execute batch: [token.approve(strategy, amount), strategy.execute()]
 *     Settle batch:  [strategy.settle()]
 *
 *   The strategy pulls tokens from the vault, deploys into DeFi protocols,
 *   and returns tokens on settlement. It holds custody of position tokens
 *   (e.g., mUSDC, LP tokens) during the strategy period.
 *
 *   Lifecycle:
 *     1. Agent deploys strategy (cloned from template) with initial params
 *     2. Agent includes strategy calls in the proposal batch
 *     3. Vault calls execute() — strategy pulls tokens and deploys
 *     4. Proposer can updateParams() to tune slippage/amounts before settlement
 *     5. Vault calls settle() — strategy unwinds and returns tokens
 */
interface IStrategy {
    /// @notice Initialize the strategy (called once, typically after cloning)
    /// @param vault The vault this strategy operates on
    /// @param proposer The agent who created this strategy
    /// @param data ABI-encoded strategy-specific initialization parameters
    function initialize(address vault, address proposer, bytes calldata data) external;

    /// @notice Execute the strategy — pull tokens from vault, deploy into DeFi
    /// @dev Only callable by the vault (via batch call)
    function execute() external;

    /// @notice Settle the strategy — unwind positions, return tokens to vault
    /// @dev Only callable by the vault (via batch call)
    function settle() external;

    /// @notice Update tunable parameters (only proposer, only while executed)
    /// @param data ABI-encoded parameter updates (strategy-specific)
    function updateParams(bytes calldata data) external;

    /// @notice The vault this strategy operates on
    function vault() external view returns (address);

    /// @notice The agent who proposed this strategy
    function proposer() external view returns (address);

    /// @notice Whether the strategy has been executed
    function executed() external view returns (bool);

    /// @notice Human-readable name of the strategy template
    function name() external view returns (string memory);

    /// @notice Best-estimate current value of the strategy's position,
    ///         denominated in the vault's asset() token.
    /// @dev    The frontend reads this to display mid-strategy unrealized
    ///         P&L without hardcoding a detector per strategy type.
    ///
    ///         Called as a `view` only — never trust this number as a
    ///         fee or settlement basis. Pool spot prices (AMM quotes)
    ///         are sandwichable; the return value may swing across
    ///         blocks on thin liquidity.
    ///
    /// @return value Position value in the vault asset's units
    ///               (e.g. USDC has 6 decimals, WETH has 18).
    /// @return valid Whether `value` is computable for this strategy on
    ///               this chain right now. `false` signals the frontend
    ///               should hide the live P&L readout rather than
    ///               render a misleading $0. Returned false before
    ///               execute, after settle, and for strategies whose
    ///               current position isn't queryable from this contract
    ///               (external loans, offchain perps, etc.).
    function positionValue() external view returns (uint256 value, bool valid);
}
