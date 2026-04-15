// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

interface IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
}

interface IWETH {
    function deposit() external payable;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @notice Create Synthra V3 pools for WETH<>stock tokens and seed with liquidity.
 *
 *   Uses a helper contract (PoolSeeder) that implements the Uniswap V3 mint callback,
 *   since pool.mint() pulls tokens via callback rather than transferFrom.
 *
 *   Usage:
 *     forge script script/robinhood-testnet/SeedPools.s.sol:SeedPools \
 *       --rpc-url robinhood_testnet \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract SeedPools is Script {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x911b4000D3422F482F4062a913885f7b035382Df);
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;

    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    uint24 constant FEE = 3000;

    // sqrtPriceX96 for 1:1 price = sqrt(1) * 2^96
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    // Wide tick range for fee 3000 (tickSpacing = 60)
    int24 constant TICK_LOWER = -887220;
    int24 constant TICK_UPPER = 887220;

    function run() external {
        address deployer = msg.sender;
        console.log("Deployer:", deployer);

        vm.startBroadcast();

        // Wrap 0.001 ETH → WETH
        IWETH(WETH).deposit{value: 0.001 ether}();
        console.log("Wrapped 0.001 ETH to WETH");

        // Deploy helper that implements the mint callback
        PoolSeeder seeder = new PoolSeeder();
        console.log("PoolSeeder deployed:", address(seeder));

        // Transfer tokens to the seeder so it can provide liquidity via callback
        // 0.0002 WETH + 1 stock token per pool (5 pools × 0.0002 = 0.001 WETH total)
        IERC20(WETH).transfer(address(seeder), 0.001 ether);

        address[5] memory tokens = [TSLA, AMZN, PLTR, NFLX, AMD];
        string[5] memory names = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).transfer(address(seeder), 1 ether); // 1 stock token per pool
            seeder.createAndSeed(tokens[i], names[i]);
        }

        vm.stopBroadcast();

        // Verify pools exist
        console.log("\n=== Pool Verification ===");
        for (uint256 i = 0; i < tokens.length; i++) {
            address pool = FACTORY.getPool(WETH, tokens[i], FEE);
            console.log("  WETH-%s pool: %s", names[i], pool);
        }
    }
}

/**
 * @notice Helper contract that implements uniswapV3MintCallback.
 *         Deployed inline, holds tokens, and provides liquidity.
 */
contract PoolSeeder {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x911b4000D3422F482F4062a913885f7b035382Df);
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    uint24 constant FEE = 3000;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int24 constant TICK_LOWER = -887220;
    int24 constant TICK_UPPER = 887220;

    function createAndSeed(address stockToken, string calldata tokenName) external {
        // 1. Create pool (or use existing)
        address pool = FACTORY.getPool(WETH, stockToken, FEE);
        if (pool == address(0)) {
            pool = FACTORY.createPool(WETH, stockToken, FEE);
            IUniswapV3Pool(pool).initialize(SQRT_PRICE_1_1);
        }

        // 2. Mint liquidity — callback will transfer tokens
        uint128 liquidity = 100000000000000; // modest liquidity
        IUniswapV3Pool(pool).mint(address(this), TICK_LOWER, TICK_UPPER, liquidity, "");
    }

    /// @notice Synthra V3 mint callback — pool calls this to pull tokens
    function synthraV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        // Transfer owed tokens to the pool
        if (amount0Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, amount1Owed);
        }
    }
}
