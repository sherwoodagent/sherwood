// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Synthra V3 Factory
interface ISynthraFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @notice Synthra V3 Pool — swap interface
interface ISynthraPool {
    function token0() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @title SynthraDirectAdapter
 * @notice ISwapAdapter that swaps directly via Synthra V3 pools (bypassing the router).
 *
 *   The standard Synthra router computes pool addresses via CREATE2 which can
 *   be incompatible with proxy-based pool deployments. This adapter resolves
 *   pools from the factory and calls pool.swap() directly with a callback.
 *
 *   extraData encoding: abi.encode(uint24 fee)
 */
contract SynthraDirectAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    ISynthraFactory public immutable factory;

    error ZeroAddress();
    error PoolNotFound();
    error SwapFailed();
    error UnauthorizedCallback();
    error SlippageExceeded();

    // EIP-1153 transient storage slots — set during swap(), read in the callback.
    bytes32 private constant _TS_CALLBACK_TOKEN = keccak256("synthra.adapter.callback.token");
    bytes32 private constant _TS_CALLBACK_AMOUNT = keccak256("synthra.adapter.callback.amount");
    bytes32 private constant _TS_EXPECTED_POOL = keccak256("synthra.adapter.expected.pool");

    // Min/max sqrtPriceX96 limits (from Uniswap V3 TickMath)
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    constructor(address _factory) {
        if (_factory == address(0)) revert ZeroAddress();
        factory = ISynthraFactory(_factory);
    }

    /// @inheritdoc ISwapAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes calldata extraData)
        external
        override
        returns (uint256 amountOut)
    {
        uint24 fee = abi.decode(extraData, (uint24));

        address pool = factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert PoolNotFound();

        // Pull tokens from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Determine swap direction
        address token0 = ISynthraPool(pool).token0();
        bool zeroForOne = (tokenIn == token0);

        // Set callback transient state
        bytes32 tokenSlot = _TS_CALLBACK_TOKEN;
        bytes32 amountSlot = _TS_CALLBACK_AMOUNT;
        bytes32 poolSlot = _TS_EXPECTED_POOL;
        assembly {
            tstore(tokenSlot, tokenIn)
            tstore(amountSlot, amountIn)
            tstore(poolSlot, pool)
        }

        // Execute swap — positive amountSpecified = exact input
        (int256 amount0, int256 amount1) = ISynthraPool(pool)
            .swap(
                msg.sender, // recipient gets output tokens
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            );

        // Calculate output amount (the negative delta is the output)
        amountOut = zeroForOne ? uint256(-amount1) : uint256(-amount0);

        if (amountOut < amountOutMin) revert SlippageExceeded();

        // Clear callback transient state
        assembly {
            tstore(tokenSlot, 0)
            tstore(amountSlot, 0)
            tstore(poolSlot, 0)
        }
    }

    /// @notice Synthra V3 swap callback — pool calls this to pull input tokens
    function synthraV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        bytes32 tokenSlot = _TS_CALLBACK_TOKEN;
        bytes32 amountSlot = _TS_CALLBACK_AMOUNT;
        bytes32 poolSlot = _TS_EXPECTED_POOL;
        address expectedPool;
        address callbackToken;
        assembly {
            expectedPool := tload(poolSlot)
            callbackToken := tload(tokenSlot)
        }
        if (expectedPool == address(0) || msg.sender != expectedPool) revert UnauthorizedCallback();

        uint256 amountOwed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(callbackToken).safeTransfer(msg.sender, amountOwed);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev Direct-pool adapter does not implement an on-chain quoter — returns 0.
    ///      Callers that drive `amountOutMin` from `quote()` (e.g. PortfolioStrategy
    ///      execute/settle/rebalance) will revert with `QuoteUnavailable`. Use this
    ///      adapter only with strategies whose minOut is computed from an external
    ///      price source (e.g. Chainlink Data Streams, MoonwellSupplyStrategy).
    function quote(address, address, uint256, bytes calldata) external pure override returns (uint256) {
        return 0;
    }
}
