// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Interface stub for the HyperCore system contract at 0x3333...3333.
///         DO NOT deploy this contract — on real HyperEVM, the precompile at
///         0x3333...3333 processes RawAction events natively.
///         This exists only so L1Write.sol can reference the interface/ABI.
///         For testing, use test/mocks/MockCoreWriter.sol with vm.etch.
contract CoreWriter {
    event RawAction(address indexed user, bytes data);

    function sendRawAction(bytes calldata data) external {
        // Gas-burning loop simulates precompile cost in local testing
        for (uint256 i = 0; i < 400; i++) {}
        emit RawAction(msg.sender, data);
    }
}
