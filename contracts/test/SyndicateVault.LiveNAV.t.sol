// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";

contract VaultLiveNAVTest is Test {
    SyndicateVault vault;
    BatchExecutorLib executorLib;
    ERC20Mock usdc;
    MockAgentRegistry agentRegistry;

    address owner = makeAddr("owner");
    address constant MOCK_GOVERNOR = address(0xF00D);
    address constant MOCK_ADAPTER = address(0xADA9);

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();

        SyndicateVault impl = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Sherwood Vault",
                    symbol: "swUSDC",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: 0
                }))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vault = SyndicateVault(payable(address(proxy)));

        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
    }

    function test_activeStrategyAdapter_initiallyZero() public view {
        assertEq(vault.activeStrategyAdapter(), address(0));
    }

    function test_setActiveStrategyAdapter_governorOnly() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(ISyndicateVault.NotGovernor.selector);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);
    }

    function test_setActiveStrategyAdapter_zeroAddressReverts() public {
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.ZeroAddress.selector);
        vault.setActiveStrategyAdapter(address(0));
    }

    function test_setActiveStrategyAdapter_setsAndEmits() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit ISyndicateVault.ActiveStrategyAdapterSet(MOCK_ADAPTER);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);

        assertEq(vault.activeStrategyAdapter(), MOCK_ADAPTER);
    }

    function test_setActiveStrategyAdapter_alreadyBoundReverts() public {
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);
        address other = address(0xBEEF);
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AdapterAlreadyBound.selector);
        vault.setActiveStrategyAdapter(other);
    }

    function test_clearActiveStrategyAdapter_governorOnly() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(ISyndicateVault.NotGovernor.selector);
        vault.clearActiveStrategyAdapter();
    }

    function test_clearActiveStrategyAdapter_clearsAndEmits() public {
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);

        vm.expectEmit(false, false, false, false, address(vault));
        emit ISyndicateVault.ActiveStrategyAdapterCleared();
        vm.prank(MOCK_GOVERNOR);
        vault.clearActiveStrategyAdapter();

        assertEq(vault.activeStrategyAdapter(), address(0));
    }

    function test_setActiveStrategyAdapter_canRebindAfterClear() public {
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);
        vm.prank(MOCK_GOVERNOR);
        vault.clearActiveStrategyAdapter();
        address next = address(0xBEEF);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(next);
        assertEq(vault.activeStrategyAdapter(), next);
    }
}
