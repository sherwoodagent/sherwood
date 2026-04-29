// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Interface for the HyperCore system contract at 0x3333...3333.
///         On real HyperEVM, the precompile at 0x3333...3333 processes
///         RawAction events natively. For testing, use
///         test/mocks/MockCoreWriter.sol with vm.etch.
interface ICoreWriter {
    event RawAction(address indexed user, bytes data);

    function sendRawAction(bytes calldata data) external;
}
