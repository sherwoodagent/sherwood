// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SynthraDirectAdapter, ISynthraFactory, ISynthraPool} from "../src/adapters/SynthraDirectAdapter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract MockSynthraPool {
    address public token0;
    address public token1;
    int256 public outAmount;

    constructor(address _token0, address _token1, int256 _outAmount) {
        token0 = _token0;
        token1 = _token1;
        outAmount = _outAmount;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        // Pay the recipient first (the negative delta is what they receive).
        if (zeroForOne) {
            amount0 = amountSpecified;
            amount1 = -outAmount;
            ERC20Mock(token1).mint(recipient, uint256(outAmount));
        } else {
            amount0 = -outAmount;
            amount1 = amountSpecified;
            ERC20Mock(token0).mint(recipient, uint256(outAmount));
        }
        // Then call back to pull input.
        SynthraDirectAdapter(msg.sender).synthraV3SwapCallback(amount0, amount1, "");
    }
}

contract MockSynthraFactory is ISynthraFactory {
    mapping(bytes32 => address) public pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
        pools[_key(tokenB, tokenA, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address tokenA, address tokenB, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encode(tokenA, tokenB, fee));
    }
}

contract SynthraDirectAdapterTest is Test {
    SynthraDirectAdapter adapter;
    MockSynthraFactory factory;
    MockSynthraPool pool;
    ERC20Mock tokenA;
    ERC20Mock tokenB;
    address user = makeAddr("user");

    function setUp() public {
        tokenA = new ERC20Mock("A", "A", 18);
        tokenB = new ERC20Mock("B", "B", 18);
        // token0 must be the lower address for V3 pool order.
        (address t0, address t1) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        pool = new MockSynthraPool(t0, t1, 100e18);
        factory = new MockSynthraFactory();
        factory.setPool(address(tokenA), address(tokenB), 3000, address(pool));
        adapter = new SynthraDirectAdapter(address(factory));

        tokenA.mint(user, 1000e18);
        vm.prank(user);
        tokenA.approve(address(adapter), type(uint256).max);
    }

    function test_callback_unauthenticated_reverts() public {
        vm.expectRevert(SynthraDirectAdapter.UnauthorizedCallback.selector);
        adapter.synthraV3SwapCallback(int256(1e18), int256(0), "");
    }

    function test_swap_belowAmountOutMin_reverts() public {
        // Pool returns 100e18 → demand 200e18 → revert.
        vm.prank(user);
        vm.expectRevert(SynthraDirectAdapter.SlippageExceeded.selector);
        adapter.swap(address(tokenA), address(tokenB), 50e18, 200e18, abi.encode(uint24(3000)));
    }

    function test_swap_meetingAmountOutMin_succeeds() public {
        vm.prank(user);
        uint256 out = adapter.swap(address(tokenA), address(tokenB), 50e18, 100e18, abi.encode(uint24(3000)));
        assertEq(out, 100e18);
        assertEq(tokenB.balanceOf(user), 100e18);
    }

    function test_callback_transientStorage_clearedAfterCall() public {
        vm.prank(user);
        adapter.swap(address(tokenA), address(tokenB), 50e18, 100e18, abi.encode(uint24(3000)));

        // After the swap returns, transient slots should be cleared. A direct
        // callback call must therefore revert with UnauthorizedCallback (slots
        // read as zero, expectedPool == 0).
        vm.expectRevert(SynthraDirectAdapter.UnauthorizedCallback.selector);
        adapter.synthraV3SwapCallback(int256(1e18), int256(0), "");
    }
}
