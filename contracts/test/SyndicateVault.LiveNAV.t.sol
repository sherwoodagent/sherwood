// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";
import {MockStrategyAdapter} from "./mocks/MockStrategyAdapter.sol";

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

    function test_totalAssets_includesAdapterNAVWhenValid() public {
        // alice deposits 1000 USDC
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        // Bind a mock adapter that reports 2000e6 value with valid=true
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(2_000e6, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        // Simulate funds deployed: vault float drained
        vm.prank(address(vault));
        usdc.transfer(address(adapter), 1_000e6);

        // float = 0; adapter NAV = 2000; totalAssets = 2000
        assertEq(vault.totalAssets(), 2_000e6);
    }

    function test_totalAssets_ignoresAdapterWhenInvalid() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, false);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        // Adapter is invalid, totalAssets falls back to float-only
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_totalAssets_floatOnlyWhenAdapterUnbound() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        assertEq(vault.activeStrategyAdapter(), address(0));
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_totalAssets_floatPlusAdapterValue() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(500e6, true); // half deployed, half float
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        // Move only 500e6 to the adapter — vault keeps 500e6 float
        vm.prank(address(vault));
        usdc.transfer(address(adapter), 500e6);

        assertEq(vault.totalAssets(), 1_000e6); // 500 float + 500 adapter
    }
}
