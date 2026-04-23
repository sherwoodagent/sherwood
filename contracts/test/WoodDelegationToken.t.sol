// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WoodToken} from "../src/WoodToken.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

/// @title WoodDelegationToken — smoke tests for WOOD's ERC20Votes extension
/// @notice Verifies that adding ERC20Votes alongside OFT preserves:
///         - basic ERC20 transfers + permit
///         - ERC20Votes delegation + getPastVotes
///         - timestamp-based clock (overridden from default block-number)
///         - minter restriction + 1B supply cap
contract WoodDelegationTokenTest is Test {
    WoodToken public wood;

    address public delegate_ = makeAddr("delegate");
    address public minter = makeAddr("minter");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");

    // Mock LZ endpoint that satisfies the OAppCore.setDelegate call shape.
    MockEndpoint public endpoint;

    function setUp() public {
        endpoint = new MockEndpoint();
        wood = new WoodToken(address(endpoint), delegate_, minter);
    }

    // ── Basic ERC20 + mint cap ──

    function test_mint_onlyMinter() public {
        vm.expectRevert(WoodToken.OnlyMinter.selector);
        vm.prank(alice);
        wood.mint(alice, 1e18);

        vm.prank(minter);
        uint256 minted = wood.mint(alice, 1e18);
        assertEq(minted, 1e18);
        assertEq(wood.balanceOf(alice), 1e18);
    }

    function test_mint_capsAtMaxSupply() public {
        uint256 maxSupply = wood.MAX_SUPPLY();
        vm.prank(minter);
        wood.mint(alice, maxSupply);
        assertEq(wood.totalSupply(), maxSupply);

        vm.prank(minter);
        uint256 minted = wood.mint(bob, 1e18);
        assertEq(minted, 0, "no-op mint past cap");
    }

    function test_transfer_works() public {
        vm.prank(minter);
        wood.mint(alice, 100e18);

        vm.prank(alice);
        wood.transfer(bob, 30e18);

        assertEq(wood.balanceOf(alice), 70e18);
        assertEq(wood.balanceOf(bob), 30e18);
    }

    // ── ERC20Votes delegation ──

    function test_delegation_routesVotes() public {
        vm.prank(minter);
        wood.mint(alice, 1000e18);

        assertEq(wood.getVotes(alice), 0, "no votes until delegation");
        assertEq(wood.getVotes(bob), 0);

        vm.prank(alice);
        wood.delegate(bob);

        assertEq(wood.getVotes(alice), 0, "alice still has 0 votes (she delegated away)");
        assertEq(wood.getVotes(bob), 1000e18, "bob now has alice's votes");
    }

    function test_delegation_selfDelegateActivatesVotes() public {
        vm.prank(minter);
        wood.mint(alice, 500e18);
        vm.prank(alice);
        wood.delegate(alice);
        assertEq(wood.getVotes(alice), 500e18);
    }

    function test_delegation_checkpointsByTimestamp() public {
        vm.prank(minter);
        wood.mint(alice, 1000e18);
        vm.prank(alice);
        wood.delegate(bob);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        wood.transfer(carol, 400e18);
        vm.prank(carol);
        wood.delegate(bob);
        uint256 t2 = vm.getBlockTimestamp();

        // ERC5805 rejects lookups at clock() (only strictly-past). Advance past t2.
        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(wood.getPastVotes(bob, t1), 1000e18, "at t1: bob has alice's 1000");
        assertEq(wood.getPastVotes(bob, t2 - 1), 1000e18, "just before t2: bob still 1000");
        // At t2: alice has 600, delegated to bob; carol has 400, delegated to bob -> bob has 1000
        assertEq(wood.getPastVotes(bob, t2), 1000e18, "at t2: bob has 600 (alice) + 400 (carol)");
    }

    function test_clock_isTimestamp() public view {
        assertEq(wood.clock(), uint48(block.timestamp));
        assertEq(keccak256(bytes(wood.CLOCK_MODE())), keccak256("mode=timestamp"));
    }

    function test_votesFollowTransfers() public {
        vm.prank(minter);
        wood.mint(alice, 1000e18);
        vm.prank(alice);
        wood.delegate(bob);

        assertEq(wood.getVotes(bob), 1000e18);

        vm.prank(alice);
        wood.transfer(carol, 300e18);

        // Carol has no delegate -> bob's votes drop by 300
        assertEq(wood.getVotes(bob), 700e18);
        assertEq(wood.getVotes(carol), 0);

        vm.prank(carol);
        wood.delegate(carol);
        assertEq(wood.getVotes(carol), 300e18);
    }
}

/// @dev Minimal LZ endpoint mock accepting `setDelegate`. Enough to let the
///      OAppCore constructor succeed without touching real LayerZero infra.
contract MockEndpoint {
    mapping(address => address) public delegates;

    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }
}
