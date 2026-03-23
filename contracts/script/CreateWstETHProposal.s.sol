// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {WstETHMoonwellStrategy} from "../src/strategies/WstETHMoonwellStrategy.sol";

/**
 * @notice Clone WstETHMoonwellStrategy template and initialize for Flagship Fund proposal.
 *
 *   Usage:
 *     forge script script/CreateWstETHProposal.s.sol:CreateWstETHProposal \
 *       --rpc-url https://rpc.moonwell.fi/main/evm/8453 \
 *       --private-key $SHERWOOD_PRIVATE_KEY \
 *       --broadcast
 */
contract CreateWstETHProposal is Script {
    // Addresses
    address constant VAULT = 0xa4aF960CAFDe8BF5dc93Fc3b62175968C107892f;
    address constant STRATEGY_TEMPLATE = 0x6d026e2f5Ff0C34A01690EC46Cb601B8fF391985;

    // Tokens
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address constant MWSTETH = 0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b;

    // Aerodrome
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    // Strategy params
    uint256 constant SUPPLY_AMOUNT = 0.0194 ether; // full vault balance
    uint256 constant MIN_WSTETH_OUT = 0.018 ether; // ~7% slippage tolerance on execute swap
    uint256 constant MIN_WETH_OUT = 0.018 ether; // ~7% slippage tolerance on settle swap
    uint256 constant DEADLINE_OFFSET = 300; // 5 min deadline

    function run() external {
        address deployer = msg.sender;
        console.log("Deployer:", deployer);

        vm.startBroadcast();

        // 1. Clone strategy template (ERC-1167 minimal proxy)
        address clone = Clones.clone(STRATEGY_TEMPLATE);
        console.log("Strategy clone:", clone);

        // 2. Initialize clone
        WstETHMoonwellStrategy.InitParams memory params = WstETHMoonwellStrategy.InitParams({
            weth: WETH,
            wsteth: WSTETH,
            mwsteth: MWSTETH,
            aeroRouter: AERO_ROUTER,
            aeroFactory: AERO_FACTORY,
            supplyAmount: SUPPLY_AMOUNT,
            minWstethOut: MIN_WSTETH_OUT,
            minWethOut: MIN_WETH_OUT,
            deadlineOffset: DEADLINE_OFFSET
        });

        WstETHMoonwellStrategy(clone).initialize(VAULT, deployer, abi.encode(params));
        console.log("Strategy initialized");

        vm.stopBroadcast();
    }
}
