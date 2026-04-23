// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
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
    address public guardianRegistryAddr = makeAddr("guardianRegistry");

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
                    managementFeeBps: 50,
                    guardianRegistry: guardianRegistryAddr
                }))
        );
        factory = SyndicateFactory(address(new ERC1967Proxy(address(factoryImpl), factoryInit)));

        // Mint ERC-8004 identity NFTs for creators
        creator1AgentId = agentRegistry.mint(creator1);
        creator2AgentId = agentRegistry.mint(creator2);

        // Mock governor.getActiveProposal() so vault deposits work (no active proposals)
        vm.mockCall(governorAddr, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        // Task 26: mock registry to pass the prepared-stake gate + bind path during create.
        vm.mockCall(
            guardianRegistryAddr, abi.encodeWithSelector(IGuardianRegistry.canCreateVault.selector), abi.encode(true)
        );
        vm.mockCall(guardianRegistryAddr, abi.encodeWithSelector(IGuardianRegistry.bindOwnerStake.selector), "");
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

        // Governor executes batch (strategy-style approve — onlyGovernor after V-C3)
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (makeAddr("protocol"), 1_000e6)), value: 0
        });

        vm.prank(governorAddr);
        vault.executeGovernorBatch(calls);

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

    // ==================== V-H1: ATOMIC PROXY INITIALIZE ====================

    /// @notice V-H1 regression: deploying the factory proxy with atomic init data
    ///         (ERC1967Proxy(impl, encodedInitCall)) is the ONLY path our deploy
    ///         scripts use. This test asserts that once the proxy is deployed
    ///         atomically, `initialize` can never be called a second time — so
    ///         no attacker can front-run the owner slot even if they watch the
    ///         proxy creation tx.
    /// @dev    Under a non-atomic deploy (empty init data), any caller could
    ///         initialize the proxy first. Our scripts never do this; see
    ///         `contracts/script/Deploy.s.sol`, `script/testnet/Deploy.s.sol`,
    ///         `script/robinhood-testnet/Deploy.s.sol` — each encodes the init
    ///         call into the proxy constructor as a single tx.
    function test_factoryInitialize_atomicProxy_cannotBeReinitialized() public {
        // The `factory` in setUp was deployed via atomic init. Attempt to
        // re-initialize as an attacker — must revert with OZ's InvalidInitialization.
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(); // Initializable: contract is already initialized
        factory.initialize(
            SyndicateFactory.InitParams({
                owner: attacker,
                executorImpl: address(executorLib),
                vaultImpl: address(vaultImpl),
                ensRegistrar: address(ensRegistrar),
                agentRegistry: address(agentRegistry),
                governor: governorAddr,
                managementFeeBps: 50,
                guardianRegistry: guardianRegistryAddr
            })
        );

        // Owner slot untouched by the reinit attempt.
        assertEq(factory.owner(), owner);
    }

    /// @notice V-H1 regression: the implementation contract itself has
    ///         `_disableInitializers()` in its constructor, so `initialize`
    ///         on the raw impl reverts regardless of who calls it.
    function test_factoryInitialize_implementation_initializersDisabled() public {
        SyndicateFactory rawImpl = new SyndicateFactory();

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(); // InvalidInitialization
        rawImpl.initialize(
            SyndicateFactory.InitParams({
                owner: attacker,
                executorImpl: address(executorLib),
                vaultImpl: address(vaultImpl),
                ensRegistrar: address(ensRegistrar),
                agentRegistry: address(agentRegistry),
                governor: governorAddr,
                managementFeeBps: 50,
                guardianRegistry: guardianRegistryAddr
            })
        );
    }

    // ==================== V-H3: upgradeVault expectedImpl ====================

    /// @notice V-H3 regression: if the factory owner calls `setVaultImpl`
    ///         between the creator observing `vaultImpl` and calling
    ///         `upgradeVault`, the creator must not end up on a different
    ///         impl than they expected.
    function test_upgradeVault_revertsIfImplChanged() public {
        // Create syndicate
        vm.prank(creator1);
        (, address vaultAddr) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        // Owner enables upgrades and snapshots the current impl.
        vm.prank(owner);
        factory.setUpgradesEnabled(true);
        address expected = factory.vaultImpl();

        // Owner rotates the vault impl (front-run scenario).
        SyndicateVault newImpl = new SyndicateVault();
        vm.prank(owner);
        factory.setVaultImpl(address(newImpl));

        // Creator calls upgradeVault with the previously-observed impl -> revert.
        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.VaultImplMismatch.selector);
        factory.upgradeVault(vaultAddr, expected);
    }

    /// @notice V-H3 positive path: upgradeVault succeeds when expectedImpl
    ///         matches the factory's current vaultImpl.
    function test_upgradeVault_succeedsWithCurrentImpl() public {
        // Create syndicate
        vm.prank(creator1);
        (, address vaultAddr) = factory.createSyndicate(creator1AgentId, _defaultConfig());

        // Enable upgrades, rotate to a new impl
        vm.prank(owner);
        factory.setUpgradesEnabled(true);
        SyndicateVault newImpl = new SyndicateVault();
        vm.prank(owner);
        factory.setVaultImpl(address(newImpl));

        // Creator passes the now-current impl -> succeeds.
        vm.prank(creator1);
        factory.upgradeVault(vaultAddr, address(newImpl));
    }

    // ==================== V-H2: GOVERNOR IS SET-ONCE ====================

    /// @notice V-H2 regression: `setGovernor` was removed. The selector must
    ///         not exist on the factory — any low-level call reverts with
    ///         empty return data. This guarantees the factory owner can
    ///         never instantly rewire every registered vault's governor.
    function test_setGovernor_removed() public {
        // setGovernor(address) selector: keccak256("setGovernor(address)")[:4]
        bytes4 sel = bytes4(keccak256("setGovernor(address)"));

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        (bool okAttacker, bytes memory retAttacker) =
            address(factory).call(abi.encodeWithSelector(sel, makeAddr("newGovernor")));
        assertFalse(okAttacker, "setGovernor must not exist (attacker)");
        assertEq(retAttacker.length, 0, "expected empty revert data (fn does not exist)");

        // Even the owner cannot call it.
        vm.prank(owner);
        (bool okOwner, bytes memory retOwner) =
            address(factory).call(abi.encodeWithSelector(sel, makeAddr("newGovernor")));
        assertFalse(okOwner, "setGovernor must not exist (owner)");
        assertEq(retOwner.length, 0, "expected empty revert data (fn does not exist)");

        // Governor slot is set-once at initialize and unchanged.
        assertEq(factory.governor(), governorAddr);
    }

    // ==================== V-M7: SyndicateConfig validation ====================

    /// @notice V-M7 regression: `createSyndicate` must reject a config whose
    ///         `asset` is zero before any side effects (stake bind, ENS
    ///         register, vault deploy). Consolidated under
    ///         `InvalidSyndicateConfig`.
    function test_createSyndicate_revertsIfAssetZero() public {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.asset = ERC20Mock(address(0));

        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.InvalidSyndicateConfig.selector);
        factory.createSyndicate(creator1AgentId, cfg);
    }

    /// @notice V-M7: empty vault token name is rejected.
    function test_createSyndicate_revertsIfNameEmpty() public {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.name = "";

        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.InvalidSyndicateConfig.selector);
        factory.createSyndicate(creator1AgentId, cfg);
    }

    /// @notice V-M7: empty vault token symbol is rejected.
    function test_createSyndicate_revertsIfSymbolEmpty() public {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.symbol = "";

        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.InvalidSyndicateConfig.selector);
        factory.createSyndicate(creator1AgentId, cfg);
    }

    /// @notice V-M7: empty subdomain is rejected with `InvalidSyndicateConfig`
    ///         (the existing `SubdomainTooShort` guard is checked later; the
    ///         zero-length case is caught first by the consolidated V-M7
    ///         check, which is what we want to assert here).
    function test_createSyndicate_revertsIfSubdomainEmpty() public {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.subdomain = "";

        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.InvalidSyndicateConfig.selector);
        factory.createSyndicate(creator1AgentId, cfg);
    }

    /// @notice V-M7: empty metadataURI is rejected — a deployed vault with
    ///         no IPFS pointer is not a real syndicate.
    function test_createSyndicate_revertsIfMetadataUriEmpty() public {
        SyndicateFactory.SyndicateConfig memory cfg = _defaultConfig();
        cfg.metadataURI = "";

        vm.prank(creator1);
        vm.expectRevert(SyndicateFactory.InvalidSyndicateConfig.selector);
        factory.createSyndicate(creator1AgentId, cfg);
    }

    // ==================== V-C4: EnumerableSet pagination ====================

    /// @notice V-C4 regression: getActiveSyndicates is backed by an
    ///         EnumerableSet so reads are O(limit) instead of O(syndicateCount),
    ///         the per-call limit is hard-capped at MAX_PAGE_LIMIT, and
    ///         deactivated syndicates do not appear in the active set.
    function test_getActiveSyndicates_paginated() public {
        // Create 150 syndicates with unique subdomains
        vm.startPrank(creator1);
        for (uint256 i = 0; i < 150; i++) {
            factory.createSyndicate(creator1AgentId, _configWithSubdomain(string.concat("fund-", vm.toString(i))));
        }

        // Deactivate a handful (ids 10, 50, 100 — 1-indexed).
        factory.deactivate(10);
        factory.deactivate(50);
        factory.deactivate(100);
        vm.stopPrank();

        // 147 active total.
        (, uint256 total) = factory.getActiveSyndicates(0, 1);
        assertEq(total, 147, "total should reflect deactivations");

        // Hard cap: request 200, get at most MAX_PAGE_LIMIT (100).
        (SyndicateFactory.Syndicate[] memory firstPage, uint256 total2) = factory.getActiveSyndicates(0, 200);
        assertEq(firstPage.length, 100, "limit clamped to MAX_PAGE_LIMIT");
        assertEq(total2, 147);

        // No deactivated syndicate appears in the page.
        for (uint256 i = 0; i < firstPage.length; i++) {
            assertTrue(firstPage[i].active, "only active syndicates should be returned");
            assertTrue(
                firstPage[i].id != 10 && firstPage[i].id != 50 && firstPage[i].id != 100,
                "deactivated id leaked into results"
            );
        }

        // Second page (offset 100). 47 remaining.
        (SyndicateFactory.Syndicate[] memory secondPage,) = factory.getActiveSyndicates(100, 100);
        assertEq(secondPage.length, 47, "remaining rows after offset");

        // Offset beyond total returns empty.
        (SyndicateFactory.Syndicate[] memory empty,) = factory.getActiveSyndicates(200, 10);
        assertEq(empty.length, 0);

        // getAllActiveSyndicates also clamps to MAX_PAGE_LIMIT.
        SyndicateFactory.Syndicate[] memory all = factory.getAllActiveSyndicates();
        assertEq(all.length, 100, "getAllActiveSyndicates clamped to MAX_PAGE_LIMIT");
    }
}
