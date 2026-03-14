// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";

/**
 * @notice Deploy SyndicateVault (UUPS proxy) + BatchExecutor to Base.
 *
 *   Usage:
 *     forge script script/Deploy.s.sol:Deploy \
 *       --rpc-url $BASE_RPC_URL \
 *       --private-key $PRIVATE_KEY \
 *       --broadcast \
 *       --verify
 */
contract Deploy is Script {
    // Base mainnet USDC
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Moonwell (Base)
    address constant MOONWELL_COMPTROLLER = 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C;
    address constant MOONWELL_mUSDC = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;

    // Uniswap V3 SwapRouter02 (Base)
    address constant UNISWAP_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Tokens to allowlist (for swaps)
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant cbETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    address constant wstETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address constant cbBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy SyndicateVault implementation
        SyndicateVault impl = new SyndicateVault();
        console.log("Vault implementation:", address(impl));

        // 2. Deploy proxy with initialize calldata
        ISyndicateVault.SyndicateCaps memory caps = ISyndicateVault.SyndicateCaps({
            maxPerTx: 10_000e6, // 10k USDC
            maxDailyTotal: 50_000e6, // 50k USDC
            maxBorrowRatio: 7500 // 75% LTV
        });

        bytes memory initData =
            abi.encodeCall(SyndicateVault.initialize, (IERC20(USDC), "Sherwood Vault", "shUSDC", deployer, caps));

        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        address vaultProxy = address(proxy);
        console.log("Vault proxy:", vaultProxy);

        // 3. Deploy BatchExecutor
        BatchExecutor executor = new BatchExecutor(vaultProxy, deployer);
        console.log("BatchExecutor:", address(executor));

        // 4. Allowlist targets
        address[] memory targets = new address[](8);
        targets[0] = USDC;
        targets[1] = MOONWELL_mUSDC;
        targets[2] = MOONWELL_COMPTROLLER;
        targets[3] = UNISWAP_SWAP_ROUTER;
        targets[4] = WETH;
        targets[5] = cbETH;
        targets[6] = wstETH;
        targets[7] = cbBTC;
        executor.addTargets(targets);
        // AERO separately (addTargets already used)
        executor.addTarget(AERO);
        console.log("Allowlisted 9 targets");

        // 5. Register deployer as agent (dev mode — PKP and EOA are both deployer)
        SyndicateVault(vaultProxy)
            .registerAgent(
                deployer, // pkpAddress (in dev, deployer acts as agent)
                deployer, // operatorEOA
                10_000e6, // maxPerTx: 10k USDC
                50_000e6 // dailyLimit: 50k USDC
            );
        console.log("Registered deployer as agent");

        vm.stopBroadcast();

        // Summary
        console.log("\n=== Deployment Summary ===");
        console.log("VAULT_ADDRESS=%s", vaultProxy);
        console.log("BATCH_EXECUTOR_ADDRESS=%s", address(executor));
        console.log("\nCopy these to cli/.env");
    }
}
