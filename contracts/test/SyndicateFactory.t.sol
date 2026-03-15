// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract SyndicateFactoryTest is Test {
    SyndicateFactory public factory;
    BatchExecutorLib public executorLib;
    SyndicateVault public vaultImpl;
    ERC20Mock public usdc;

    address public creator1 = makeAddr("creator1");
    address public creator2 = makeAddr("creator2");

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        vaultImpl = new SyndicateVault();
        factory = new SyndicateFactory(address(executorLib), address(vaultImpl));
    }

    function _defaultConfig() internal view returns (SyndicateFactory.SyndicateConfig memory) {
        address[] memory targets = new address[](1);
        targets[0] = address(usdc);

        return SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://QmTest",
            asset: usdc,
            name: "Test Vault",
            symbol: "tVault",
            caps: ISyndicateVault.SyndicateCaps({maxPerTx: 10_000e6, maxDailyTotal: 50_000e6, maxBorrowRatio: 7500}),
            initialTargets: targets,
            openDeposits: false
        });
    }

    // ==================== CREATION ====================

    function test_createSyndicate() public {
        vm.prank(creator1);
        (uint256 id, address vaultAddr) = factory.createSyndicate(_defaultConfig());

        assertEq(id, 1);
        assertTrue(vaultAddr != address(0));

        // Verify vault is initialized
        SyndicateVault vault = SyndicateVault(payable(vaultAddr));
        assertEq(vault.name(), "Test Vault");
        assertEq(vault.symbol(), "tVault");
        assertEq(vault.owner(), creator1);
        assertEq(address(vault.asset()), address(usdc));
        assertEq(vault.getExecutorImpl(), address(executorLib));

        // Verify targets
        assertTrue(vault.isAllowedTarget(address(usdc)));

        // Verify caps
        ISyndicateVault.SyndicateCaps memory caps = vault.getSyndicateCaps();
        assertEq(caps.maxPerTx, 10_000e6);
        assertEq(caps.maxDailyTotal, 50_000e6);
        assertEq(caps.maxBorrowRatio, 7500);
    }

    function test_createSyndicate_registryTracking() public {
        vm.prank(creator1);
        (uint256 id1, address vault1) = factory.createSyndicate(_defaultConfig());

        assertEq(factory.syndicateCount(), 1);
        assertEq(factory.vaultToSyndicate(vault1), id1);

        (uint256 storedId, address storedVault, address storedCreator,,, bool active) = factory.syndicates(id1);
        assertEq(storedId, id1);
        assertEq(storedVault, vault1);
        assertEq(storedCreator, creator1);
        assertTrue(active);
    }

    function test_createMultipleSyndicates() public {
        vm.prank(creator1);
        (uint256 id1, address vault1) = factory.createSyndicate(_defaultConfig());

        vm.prank(creator2);
        (uint256 id2, address vault2) = factory.createSyndicate(_defaultConfig());

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertTrue(vault1 != vault2);
        assertEq(factory.syndicateCount(), 2);

        // Both share same executor lib
        assertEq(SyndicateVault(payable(vault1)).getExecutorImpl(), address(executorLib));
        assertEq(SyndicateVault(payable(vault2)).getExecutorImpl(), address(executorLib));
    }

    function test_syndicateVaultIsFullyFunctional() public {
        // Create syndicate
        vm.prank(creator1);
        (, address vaultAddr) = factory.createSyndicate(_defaultConfig());
        SyndicateVault vault = SyndicateVault(payable(vaultAddr));

        // Register agent
        address agent = makeAddr("agent");
        vm.prank(creator1);
        vault.registerAgent(agent, agent, 5_000e6, 20_000e6);

        // Approve LP as depositor (vault has openDeposits=false)
        address lp = makeAddr("lp");
        vm.prank(creator1);
        vault.approveDepositor(lp);

        // LP deposits
        usdc.mint(lp, 50_000e6);
        vm.startPrank(lp);
        usdc.approve(vaultAddr, 50_000e6);
        vault.deposit(50_000e6, lp);
        vm.stopPrank();

        // Agent executes batch (simple approve call)
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (makeAddr("protocol"), 1_000e6)), value: 0
        });

        vm.prank(agent);
        vault.executeBatch(calls, 0);

        // Verify: vault set the approval (delegatecall)
        assertEq(usdc.allowance(vaultAddr, makeAddr("protocol")), 1_000e6);
    }

    function test_storageIsolation() public {
        // Create two syndicates
        vm.prank(creator1);
        (, address vault1Addr) = factory.createSyndicate(_defaultConfig());
        vm.prank(creator2);
        (, address vault2Addr) = factory.createSyndicate(_defaultConfig());

        SyndicateVault vault1 = SyndicateVault(payable(vault1Addr));
        SyndicateVault vault2 = SyndicateVault(payable(vault2Addr));

        // Register different agents on each
        address agent1 = makeAddr("agent1");
        address agent2 = makeAddr("agent2");

        vm.prank(creator1);
        vault1.registerAgent(agent1, agent1, 5_000e6, 20_000e6);
        vm.prank(creator2);
        vault2.registerAgent(agent2, agent2, 5_000e6, 20_000e6);

        // Agent1 is only on vault1
        assertTrue(vault1.isAgent(agent1));
        assertFalse(vault2.isAgent(agent1));

        // Agent2 is only on vault2
        assertFalse(vault1.isAgent(agent2));
        assertTrue(vault2.isAgent(agent2));
    }

    // ==================== METADATA ====================

    function test_updateMetadata() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(_defaultConfig());

        vm.prank(creator1);
        factory.updateMetadata(id, "ipfs://QmUpdated");

        (,,, string memory uri,,) = factory.syndicates(id);
        assertEq(uri, "ipfs://QmUpdated");
    }

    function test_updateMetadata_notCreator_reverts() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(_defaultConfig());

        vm.prank(creator2);
        vm.expectRevert("Not creator");
        factory.updateMetadata(id, "ipfs://QmHack");
    }

    // ==================== DEACTIVATION ====================

    function test_deactivate() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(_defaultConfig());

        vm.prank(creator1);
        factory.deactivate(id);

        (,,,,, bool active) = factory.syndicates(id);
        assertFalse(active);
    }

    function test_deactivate_notCreator_reverts() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(_defaultConfig());

        vm.prank(creator2);
        vm.expectRevert("Not creator");
        factory.deactivate(id);
    }

    function test_getActiveSyndicates() public {
        vm.startPrank(creator1);
        factory.createSyndicate(_defaultConfig());
        (uint256 id2,) = factory.createSyndicate(_defaultConfig());
        factory.createSyndicate(_defaultConfig());

        // Deactivate #2
        factory.deactivate(id2);
        vm.stopPrank();

        SyndicateFactory.Syndicate[] memory active = factory.getActiveSyndicates();
        assertEq(active.length, 2);
    }
}
