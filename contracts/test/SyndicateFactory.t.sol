// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockL2Registrar} from "./mocks/MockL2Registrar.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";

contract SyndicateFactoryTest is Test {
    SyndicateFactory public factory;
    BatchExecutorLib public executorLib;
    SyndicateVault public vaultImpl;
    ERC20Mock public usdc;
    MockL2Registrar public ensRegistrar;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public creator1 = makeAddr("creator1");
    address public creator2 = makeAddr("creator2");
    address public governorAddr = makeAddr("governor");

    uint256 public creator1AgentId;
    uint256 public creator2AgentId;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        vaultImpl = new SyndicateVault();
        ensRegistrar = new MockL2Registrar();
        agentRegistry = new MockAgentRegistry();

        // Deploy factory as UUPS proxy
        SyndicateFactory factoryImpl = new SyndicateFactory();
        bytes memory factoryInit = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: owner,
                    executorImpl: address(executorLib),
                    vaultImpl: address(vaultImpl),
                    ensRegistrar: address(ensRegistrar),
                    agentRegistry: address(agentRegistry),
                    governor: governorAddr,
                    managementFeeBps: 50
                }))
        );
        factory = SyndicateFactory(address(new ERC1967Proxy(address(factoryImpl), factoryInit)));

        // Mint ERC-8004 identity NFTs for creators
        creator1AgentId = agentRegistry.mint(creator1);
        creator2AgentId = agentRegistry.mint(creator2);

        // Mock governor.getActiveProposal() so vault deposits work (no active proposals)
        vm.mockCall(governorAddr, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
    }

    function _defaultConfig() internal view returns (SyndicateFactory.SyndicateConfig memory) {
        return SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://QmTest",
            asset: usdc,
            name: "Test Vault",
            symbol: "tVault",
            openDeposits: false,
            subdomain: "test-syndicate"
        });
    }

    function _configWithSubdomain(string memory subdomain_)
        internal
        view
        returns (SyndicateFactory.SyndicateConfig memory)
    {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.subdomain = subdomain_;
        return cfg;
    }

    // ==================== CREATION ====================

    function test_createSyndicate() public {
        vm.prank(creator1);
        (uint256 id, address vaultAddr) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        assertEq(id, 1);
        assertTrue(vaultAddr != address(0));

        // Verify vault is initialized
        SyndicateVault vault = SyndicateVault(payable(vaultAddr));
        assertEq(vault.name(), "Test Vault");
        assertEq(vault.symbol(), "tVault");
        assertEq(vault.owner(), creator1);
        assertEq(address(vault.asset()), address(usdc));
        assertEq(vault.getExecutorImpl(), address(executorLib));
    }

    function test_createSyndicate_notAgentOwner_reverts() public {
        // creator2 tries to use creator1's agent ID
        vm.prank(creator2);
        vm.expectRevert(SyndicateFactory.NotAgentOwner.selector);
        factory.createSyndicate(creator1AgentId, _defaultConfig());
    }

    function test_createSyndicate_registryTracking() public {
        vm.prank(creator1);
        (uint256 id1, address vault1) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        assertEq(factory.syndicateCount(), 1);
        assertEq(factory.vaultToSyndicate(vault1), id1);

        (uint256 storedId, address storedVault, address storedCreator,,,, string memory storedSubdomain) =
            factory.syndicates(id1);
        assertEq(storedId, id1);
        assertEq(storedVault, vault1);
        assertEq(storedCreator, creator1);
        assertEq(storedSubdomain, "test-syndicate");
    }

    function test_createMultipleSyndicates() public {
        vm.prank(creator1);
        (uint256 id1, address vault1) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("syndicate-one"));

        vm.prank(creator2);
        (uint256 id2, address vault2) = factory.createSyndicate(creator2AgentId, _configWithSubdomain("syndicate-two"));

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
        (, address vaultAddr) = factory.createSyndicate(creator1AgentId, _defaultConfig());
        SyndicateVault vault = SyndicateVault(payable(vaultAddr));

        // Register agent (mint agent NFT for the agent address)
        address agent = makeAddr("agent");
        uint256 agentNftId = agentRegistry.mint(agent);
        vm.prank(creator1);
        vault.registerAgent(agentNftId, agent);

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

        // Owner executes batch (simple approve call — owner-only in governor model)
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (makeAddr("protocol"), 1_000e6)), value: 0
        });

        vm.prank(creator1); // vault owner
        vault.executeBatch(calls);

        // Verify: vault set the approval (delegatecall)
        assertEq(usdc.allowance(vaultAddr, makeAddr("protocol")), 1_000e6);
    }

    function test_storageIsolation() public {
        // Create two syndicates
        vm.prank(creator1);
        (, address vault1Addr) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("vault-alpha"));
        vm.prank(creator2);
        (, address vault2Addr) = factory.createSyndicate(creator2AgentId, _configWithSubdomain("vault-beta"));

        SyndicateVault vault1 = SyndicateVault(payable(vault1Addr));
        SyndicateVault vault2 = SyndicateVault(payable(vault2Addr));

        // Register different agents on each (mint NFTs for agents)
        address agent1 = makeAddr("agent1");
        address agent2 = makeAddr("agent2");
        uint256 agent1NftId = agentRegistry.mint(agent1);
        uint256 agent2NftId = agentRegistry.mint(agent2);

        vm.prank(creator1);
        vault1.registerAgent(agent1NftId, agent1);
        vm.prank(creator2);
        vault2.registerAgent(agent2NftId, agent2);

        // Agent1 is only on vault1
        assertTrue(vault1.isAgent(agent1));
        assertFalse(vault2.isAgent(agent1));

        // Agent2 is only on vault2
        assertFalse(vault1.isAgent(agent2));
        assertTrue(vault2.isAgent(agent2));
    }

    // ==================== ENS SUBDOMAINS ====================

    function test_createSyndicate_registersENS() public {
        vm.prank(creator1);
        (, address vaultAddr) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("alpha-seekers"));

        // Verify the registrar received the correct label + vault address
        assertTrue(ensRegistrar.isRegistered("alpha-seekers"));
        assertEq(ensRegistrar.getOwner("alpha-seekers"), vaultAddr);
    }

    function test_createSyndicate_duplicateName_reverts() public {
        vm.prank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("taken-name"));

        vm.prank(creator2);
        vm.expectRevert(SyndicateFactory.SubdomainTaken.selector);
        factory.createSyndicate(creator2AgentId, _configWithSubdomain("taken-name"));
    }

    function test_createSyndicate_nameTooShort_reverts() public {
        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.SubdomainTooShort.selector);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("ab"));
    }

    function test_subdomainToSyndicate() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("my-fund"));

        assertEq(factory.subdomainToSyndicate("my-fund"), id);
        assertEq(factory.subdomainToSyndicate("nonexistent"), 0);
    }

    function test_isSubdomainAvailable() public {
        assertTrue(factory.isSubdomainAvailable("new-fund"));

        vm.prank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("new-fund"));

        assertFalse(factory.isSubdomainAvailable("new-fund"));
    }

    function test_isSubdomainAvailable_tooShort() public view {
        assertFalse(factory.isSubdomainAvailable("ab"));
    }

    // ==================== METADATA ====================

    function test_updateMetadata() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        vm.prank(creator1);
        factory.updateMetadata(id, "ipfs://QmUpdated");

        (,,, string memory uri,,,) = factory.syndicates(id);
        assertEq(uri, "ipfs://QmUpdated");
    }

    function test_updateMetadata_notCreator_reverts() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        vm.prank(creator2);
        vm.expectRevert(SyndicateFactory.NotCreator.selector);
        factory.updateMetadata(id, "ipfs://QmHack");
    }

    // ==================== DEACTIVATION ====================

    function test_deactivate() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        vm.prank(creator1);
        factory.deactivate(id);

        (,,,,, bool active,) = factory.syndicates(id);
        assertFalse(active);
    }

    function test_deactivate_notCreator_reverts() public {
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        vm.prank(creator2);
        vm.expectRevert(SyndicateFactory.NotCreator.selector);
        factory.deactivate(id);
    }

    function test_getActiveSyndicates() public {
        vm.startPrank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-aaa"));
        (uint256 id2,) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-bbb"));
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-ccc"));

        // Deactivate #2
        factory.deactivate(id2);
        vm.stopPrank();

        (SyndicateFactory.Syndicate[] memory active, uint256 total) = factory.getActiveSyndicates(0, 100);
        assertEq(active.length, 2);
        assertEq(total, 2);
    }

    function test_getActiveSyndicates_pagination() public {
        // Create 5 syndicates, deactivate #3
        vm.startPrank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-001"));
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-002"));
        (uint256 id3,) = factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-003"));
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-004"));
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-005"));
        factory.deactivate(id3);
        vm.stopPrank();

        // 4 active syndicates total

        // Page 1: offset=0, limit=2
        (SyndicateFactory.Syndicate[] memory page1, uint256 total1) = factory.getActiveSyndicates(0, 2);
        assertEq(page1.length, 2);
        assertEq(total1, 4);

        // Page 2: offset=2, limit=2
        (SyndicateFactory.Syndicate[] memory page2, uint256 total2) = factory.getActiveSyndicates(2, 2);
        assertEq(page2.length, 2);
        assertEq(total2, 4);

        // Page 3: offset=4, limit=2 — beyond total
        (SyndicateFactory.Syndicate[] memory page3, uint256 total3) = factory.getActiveSyndicates(4, 2);
        assertEq(page3.length, 0);
        assertEq(total3, 4);

        // Limit larger than remaining
        (SyndicateFactory.Syndicate[] memory big, uint256 totalBig) = factory.getActiveSyndicates(1, 100);
        assertEq(big.length, 3);
        assertEq(totalBig, 4);
    }

    function test_getActiveSyndicates_offsetBeyondTotal() public {
        vm.startPrank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-only"));
        vm.stopPrank();

        (SyndicateFactory.Syndicate[] memory result, uint256 total) = factory.getActiveSyndicates(5, 10);
        assertEq(result.length, 0);
        assertEq(total, 1);
    }

    function test_getAllActiveSyndicates() public {
        vm.startPrank(creator1);
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-aaa"));
        factory.createSyndicate(creator1AgentId, _configWithSubdomain("fund-bbb"));
        vm.stopPrank();

        SyndicateFactory.Syndicate[] memory all = factory.getAllActiveSyndicates();
        assertEq(all.length, 2);
    }

    // ==================== CREATION FEE ====================

    function test_creationFee_blocksWithoutPayment() public {
        // Owner sets creation fee
        vm.prank(owner);
        factory.setCreationFee(address(usdc), 100e6, owner);

        // Creator tries without approval → reverts
        vm.prank(creator1);
        vm.expectRevert();
        factory.createSyndicate(creator1AgentId, _defaultConfig());
    }

    function test_creationFee_collectsPayment() public {
        vm.prank(owner);
        factory.setCreationFee(address(usdc), 100e6, owner);

        // Fund creator and approve
        usdc.mint(creator1, 100e6);
        vm.startPrank(creator1);
        usdc.approve(address(factory), 100e6);
        (uint256 id, address vaultAddr) = factory.createSyndicate(creator1AgentId, _defaultConfig());
        vm.stopPrank();

        assertEq(id, 1);
        assertTrue(vaultAddr != address(0));
        assertEq(usdc.balanceOf(owner), 100e6); // fee recipient got paid
        assertEq(usdc.balanceOf(creator1), 0); // creator paid
    }

    function test_creationFee_freeWhenZero() public {
        // Default: no fee set, creation works
        vm.prank(creator1);
        (uint256 id,) = factory.createSyndicate(creator1AgentId, _defaultConfig());
        assertEq(id, 1);
    }

    function test_creationFee_onlyOwner() public {
        vm.prank(creator1);
        vm.expectRevert();
        factory.setCreationFee(address(usdc), 100e6, owner);
    }
}
