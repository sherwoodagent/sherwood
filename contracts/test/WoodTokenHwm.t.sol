// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WoodToken} from "../src/WoodToken.sol";

/// @dev Test-only WOOD subclass that exposes `_burn` so we can simulate an
///      OFT bridge-out (which internally calls `_burn`) without standing up
///      a full LayerZero endpoint.
contract WoodTokenForTest is WoodToken {
    constructor(address _lzEndpoint, address _delegate, address _minter) WoodToken(_lzEndpoint, _delegate, _minter) {}

    function burnExternal(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice C-14 — OFT bridge-out decrements local `totalSupply()` via `_burn`.
///         Pre-fix, `totalMintable() = MAX_SUPPLY - totalSupply()` would re-open
///         mint capacity equal to the bridged-out amount, breaching the 1B cap
///         across chains. Post-fix, `_totalEverMinted` is the cap reference and
///         is never decremented.
contract WoodTokenHwmTest is Test {
    WoodTokenForTest public wood;
    MockEndpoint public endpoint;

    address minter = makeAddr("minter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        endpoint = new MockEndpoint();
        wood = new WoodTokenForTest(address(endpoint), address(this), minter);
    }

    function test_mint_afterBridgeOut_doesNotReissue() public {
        uint256 max = wood.MAX_SUPPLY();

        vm.prank(minter);
        wood.mint(alice, max);
        assertEq(wood.totalSupply(), max);
        assertEq(wood.totalEverMinted(), max);
        assertEq(wood.totalMintable(), 0);

        // Simulate bridge-out: 100M WOOD leaves this chain.
        wood.burnExternal(alice, 100_000_000e18);
        assertEq(wood.totalSupply(), max - 100_000_000e18);
        assertEq(wood.totalEverMinted(), max, "HWM unchanged on burn");

        // Pre-fix: totalMintable would now be 100M, allowing re-mint past the cap.
        // Post-fix: totalMintable stays 0.
        assertEq(wood.totalMintable(), 0, "HWM gates further mint after bridge-out");

        vm.prank(minter);
        uint256 minted = wood.mint(bob, 100_000_000e18);
        assertEq(minted, 0, "no-op mint after bridge-out");
        assertEq(wood.totalSupply(), max - 100_000_000e18, "supply unchanged");
    }

    function test_totalEverMinted_tracksAllMints() public {
        vm.startPrank(minter);
        wood.mint(alice, 1e18);
        wood.mint(bob, 2e18);
        vm.stopPrank();
        assertEq(wood.totalEverMinted(), 3e18);

        wood.burnExternal(alice, 1e18);
        assertEq(wood.totalEverMinted(), 3e18, "burn does not decrement HWM");
        assertEq(wood.totalSupply(), 2e18);
    }
}

contract MockEndpoint {
    mapping(address => address) public delegates;

    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }
}
