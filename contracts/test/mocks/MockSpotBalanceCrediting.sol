// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock for HyperCore spot balance precompile (0x...0801) that mirrors
///         the caller's USDC balance into HC spot, scaled 6→8 decimals.
///         Lets tests exercise the success path of the spot-credit gate without
///         needing a real precompile or sequential mockCalls.
contract MockSpotBalanceCrediting {
    address public usdc; // slot 0 — settable via vm.store

    fallback(bytes calldata data) external returns (bytes memory) {
        (address user,) = abi.decode(data, (address, uint64));
        // HC reports in 8 decimals, USDC EVM is 6 decimals → multiply by 100.
        uint64 spot = uint64(IERC20(usdc).balanceOf(user) * 100);
        return abi.encode(spot, uint64(0), uint64(0));
    }
}
