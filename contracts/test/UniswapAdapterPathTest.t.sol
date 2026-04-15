// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapSwapAdapter} from "../src/adapters/UniswapSwapAdapter.sol";

contract UniswapAdapterPathTest is Test {
    UniswapSwapAdapterHarness adapter;

    function setUp() public {
        adapter = new UniswapSwapAdapterHarness(address(1), address(2));
    }

    // ── extractFirstAddress ──

    function test_extractFirstAddress() public view {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address token = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;

        bytes memory path = abi.encodePacked(usdc, uint24(500), weth, uint24(10000), token);
        assertEq(adapter.extractFirstAddress(path), usdc);
    }

    // ── extractAddressAt / extractFeeAt ──

    function test_extractAddressAt() public view {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address token = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;
        uint24 fee1 = 500;
        uint24 fee2 = 10000;

        bytes memory path = abi.encodePacked(usdc, fee1, weth, fee2, token);

        // offset 0: USDC
        assertEq(adapter.extractAddressAt(path, 0), usdc);
        // offset 23: WETH (20 addr + 3 fee)
        assertEq(adapter.extractAddressAt(path, 23), weth);
        // offset 46: TOKEN
        assertEq(adapter.extractAddressAt(path, 46), token);
    }

    function test_extractFeeAt() public view {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address token = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;
        uint24 fee1 = 500;
        uint24 fee2 = 10000;

        bytes memory path = abi.encodePacked(usdc, fee1, weth, fee2, token);

        // fee1 at offset 20
        assertEq(adapter.extractFeeAt(path, 20), fee1);
        // fee2 at offset 43
        assertEq(adapter.extractFeeAt(path, 43), fee2);
    }

    function test_extractFeeAt_allTiers() public view {
        address a = address(0x1111111111111111111111111111111111111111);
        address b = address(0x2222222222222222222222222222222222222222);

        uint24[4] memory tiers = [uint24(100), uint24(500), uint24(3000), uint24(10000)];
        for (uint256 i; i < tiers.length; ++i) {
            bytes memory path = abi.encodePacked(a, tiers[i], b);
            assertEq(adapter.extractFeeAt(path, 20), tiers[i], "fee tier mismatch");
        }
    }

    // ── reversePath ──

    function test_reversePath_singleHop() public view {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address token = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;
        uint24 fee = 3000;

        bytes memory forward = abi.encodePacked(usdc, fee, token);
        bytes memory reversed = adapter.reversePath(forward);
        bytes memory expected = abi.encodePacked(token, fee, usdc);

        assertEq(keccak256(reversed), keccak256(expected));
    }

    function test_reversePath_twoHop() public view {
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address token = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;
        uint24 fee1 = 500;
        uint24 fee2 = 10000;

        bytes memory forward = abi.encodePacked(usdc, fee1, weth, fee2, token);
        bytes memory reversed = adapter.reversePath(forward);
        bytes memory expected = abi.encodePacked(token, fee2, weth, fee1, usdc);

        assertEq(keccak256(reversed), keccak256(expected), "reversed path should match expected");
        assertEq(adapter.extractFirstAddress(reversed), token, "reversed path starts with token");
    }

    function test_reversePath_threeHop() public view {
        address a = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address b = 0x4200000000000000000000000000000000000006;
        address c = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;
        address d = 0x6502EE0aB950Bdf5114C7e36c5F1da0429f73811;
        uint24 f1 = 500;
        uint24 f2 = 3000;
        uint24 f3 = 10000;

        bytes memory forward = abi.encodePacked(a, f1, b, f2, c, f3, d);
        bytes memory reversed = adapter.reversePath(forward);
        bytes memory expected = abi.encodePacked(d, f3, c, f2, b, f1, a);

        assertEq(keccak256(reversed), keccak256(expected), "3-hop reverse");
    }

    function test_reversePath_isInvolution() public view {
        address a = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address b = 0x4200000000000000000000000000000000000006;
        address c = 0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07;

        bytes memory path = abi.encodePacked(a, uint24(500), b, uint24(10000), c);
        bytes memory doubleReversed = adapter.reversePath(adapter.reversePath(path));

        assertEq(keccak256(doubleReversed), keccak256(path), "reverse(reverse(path)) == path");
    }

    // ── Edge cases ──

    function test_extractFirstAddress_reverts_tooShort() public {
        bytes memory path = new bytes(19);
        vm.expectRevert("path too short");
        adapter.extractFirstAddress(path);
    }

    function test_reversePath_reverts_invalidLength() public {
        bytes memory path = new bytes(25); // not 20 + 23*n
        vm.expectRevert("invalid path length");
        adapter.reversePath(path);
    }
}

contract UniswapSwapAdapterHarness is UniswapSwapAdapter {
    constructor(address r, address q) UniswapSwapAdapter(r, q) {}

    function extractFirstAddress(bytes memory path) external pure returns (address) {
        return _extractFirstAddress(path);
    }

    function extractAddressAt(bytes memory path, uint256 offset) external pure returns (address) {
        return _extractAddressAt(path, offset);
    }

    function extractFeeAt(bytes memory path, uint256 offset) external pure returns (uint24) {
        return _extractFeeAt(path, offset);
    }

    function reversePath(bytes memory path) external pure returns (bytes memory) {
        return _reversePath(path);
    }
}
