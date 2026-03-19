// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockMToken} from "./mocks/MockMToken.sol";
import {MockComptroller} from "./mocks/MockComptroller.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract SyndicateVaultTest is Test {
    SyndicateVault public vault;
    SyndicateGovernor public governor;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public weth;
    MockMToken public mUsdc;
    MockComptroller public comptroller;
    MockSwapRouter public swapRouter;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public agentWallet = makeAddr("agentWallet");
    address public agentWallet2 = makeAddr("agentWallet2");

    uint256 public agent1NftId;
    uint256 public agent2NftId;

    function setUp() public {
        // Deploy tokens
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);

        // Deploy DeFi mocks
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUsdc");
        comptroller = new MockComptroller();
        swapRouter = new MockSwapRouter();

        // Deploy shared executor lib
        executorLib = new BatchExecutorLib();

        // Deploy ERC-8004 agent registry
        agentRegistry = new MockAgentRegistry();

        // Mint ERC-8004 identity NFTs for agents
        agent1NftId = agentRegistry.mint(agentWallet);
        agent2NftId = agentRegistry.mint(agentWallet2);

        // Deploy governor first
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: 1 days,
                    executionWindow: 1 days,
                    quorumBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 days,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 days,
                    maxStrategyDuration: 7 days
                }))
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        // Deploy vault via proxy with executor lib
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
                    governor: address(governor),
                    managementFeeBps: 0
                }))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vault = SyndicateVault(payable(address(proxy)));

        // Mint USDC to LPs
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        // Fund mToken with underlying for borrow liquidity
        usdc.mint(address(mUsdc), 1_000_000e6);

        // Fund swap router
        weth.mint(address(swapRouter), 1_000e18);

        // Register agent
        vm.prank(owner);
        vault.registerAgent(agent1NftId, agentWallet);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(vault.name(), "Sherwood Vault");
        assertEq(vault.symbol(), "swUSDC");
        assertEq(vault.owner(), owner);
        assertEq(address(vault.asset()), address(usdc));
        assertEq(vault.getExecutorImpl(), address(executorLib));
    }

    // ==================== DEPOSITS & WITHDRAWALS ====================

    function test_deposit() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.balanceOf(lp1), shares);
    }

    function test_deposit_autoDelegates() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // After deposit, lp1 should be self-delegated
        assertEq(vault.delegates(lp1), lp1);
        // And should have voting power
        assertGt(vault.getVotes(lp1), 0);
    }

    function test_ragequit() public {
        // LP1 deposits
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // LP2 deposits
        vm.startPrank(lp2);
        usdc.approve(address(vault), 5_000e6);
        vault.deposit(5_000e6, lp2);
        vm.stopPrank();

        uint256 balBefore = usdc.balanceOf(lp1);

        // LP1 ragequits
        vm.prank(lp1);
        uint256 assets = vault.ragequit(lp1);

        assertEq(assets, 10_000e6);
        assertEq(usdc.balanceOf(lp1), balBefore + 10_000e6);
        assertEq(vault.balanceOf(lp1), 0);
        // LP2 still has their shares
        assertGt(vault.balanceOf(lp2), 0);
    }

    function test_ragequit_noShares_reverts() public {
        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.NoShares.selector);
        vault.ragequit(lp1);
    }

    // ==================== AGENT REGISTRATION ====================

    function test_registerAgent() public view {
        assertTrue(vault.isAgent(agentWallet));
        assertEq(vault.getAgentCount(), 1);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentWallet);
        assertEq(config.agentId, agent1NftId);
        assertEq(config.agentAddress, agentWallet);
        assertTrue(config.active);
    }

    function test_registerAgent_ownerOwnsNft() public {
        // Mint an NFT owned by the vault owner (syndicate creator) — should also be allowed
        uint256 ownerNftId = agentRegistry.mint(owner);

        vm.prank(owner);
        vault.registerAgent(ownerNftId, agentWallet2);

        assertTrue(vault.isAgent(agentWallet2));
        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentWallet2);
        assertEq(config.agentId, ownerNftId);
    }

    function test_registerAgent_notAgentOwner_reverts() public {
        // Mint NFT to some random address
        address random = makeAddr("random");
        uint256 randomNftId = agentRegistry.mint(random);

        // Try to register with NFT not owned by agentAddress or vault owner
        vm.prank(owner);
        vm.expectRevert(ISyndicateVault.NotAgentOwner.selector);
        vault.registerAgent(randomNftId, agentWallet2);
    }

    function test_registerAgent_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.registerAgent(agent2NftId, agentWallet2);
    }

    function test_removeAgent() public {
        vm.prank(owner);
        vault.removeAgent(agentWallet);

        assertFalse(vault.isAgent(agentWallet));
        assertEq(vault.getAgentCount(), 0);
    }

    // ==================== BATCH EXECUTION (owner-only, via delegatecall) ====================

    /// @dev Helper: fund the vault directly with USDC for batch tests
    function _fundVault(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }

    function test_executeBatch_ownerCanExecute() public {
        _fundVault(100_000e6);

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        vm.prank(owner);
        vault.executeBatch(calls);

        assertEq(usdc.allowance(address(vault), address(mUsdc)), 10_000e6);
    }

    function test_executeBatch_notOwner_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(agentWallet);
        vm.expectRevert();
        vault.executeBatch(calls);
    }

    function test_executeBatch_whenPaused_reverts() public {
        vm.prank(owner);
        vault.pause();

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(owner);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.executeBatch(calls);
    }

    // ==================== PAUSE ====================

    function test_pause_blocksDeposits() public {
        vm.prank(owner);
        vault.pause();

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();
    }

    // ==================== RECEIVE ETH ====================

    function test_vaultReceivesETH() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(vault).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(vault).balance, 1 ether);
    }

    // ==================== DEPOSITOR WHITELIST ====================

    function test_approveDepositor() public {
        address depositor = makeAddr("depositor");

        vm.prank(owner);
        vault.approveDepositor(depositor);

        assertTrue(vault.isApprovedDepositor(depositor));

        address[] memory depositors = vault.getApprovedDepositors();
        assertEq(depositors.length, 1);
        assertEq(depositors[0], depositor);
    }

    function test_approveDepositor_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, lp1));
        vault.approveDepositor(makeAddr("depositor"));
    }

    function test_removeDepositor() public {
        address depositor = makeAddr("depositor");
        vm.startPrank(owner);
        vault.approveDepositor(depositor);
        vault.removeDepositor(depositor);
        vm.stopPrank();

        assertFalse(vault.isApprovedDepositor(depositor));
    }

    function test_approveDepositors_batch() public {
        address[] memory depositors = new address[](3);
        depositors[0] = makeAddr("d1");
        depositors[1] = makeAddr("d2");
        depositors[2] = makeAddr("d3");

        vm.prank(owner);
        vault.approveDepositors(depositors);

        assertTrue(vault.isApprovedDepositor(depositors[0]));
        assertTrue(vault.isApprovedDepositor(depositors[1]));
        assertTrue(vault.isApprovedDepositor(depositors[2]));
        assertEq(vault.getApprovedDepositors().length, 3);
    }

    /// @dev Helper to deploy a closed-deposits vault for whitelist tests
    function _deployClosedVault() internal returns (SyndicateVault) {
        SyndicateVault impl2 = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Closed Vault",
                    symbol: "cVault",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: false,
                    agentRegistry: address(agentRegistry),
                    governor: address(governor),
                    managementFeeBps: 0
                }))
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData);
        return SyndicateVault(payable(address(proxy2)));
    }

    function test_deposit_closedDeposits_unapproved_reverts() public {
        SyndicateVault closedVault = _deployClosedVault();

        // Try to deposit without approval — should revert
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        vm.expectRevert(ISyndicateVault.NotApprovedDepositor.selector);
        closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();
    }

    function test_deposit_closedDeposits_approved_succeeds() public {
        SyndicateVault closedVault = _deployClosedVault();

        // Approve depositor
        vm.prank(owner);
        closedVault.approveDepositor(lp1);

        // Now deposit should succeed
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        uint256 shares = closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
    }

    function test_setOpenDeposits() public {
        SyndicateVault closedVault = _deployClosedVault();

        // Toggle to open
        vm.prank(owner);
        closedVault.setOpenDeposits(true);
        assertTrue(closedVault.openDeposits());

        // Now anyone can deposit
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        uint256 shares = closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
    }

    function test_openDeposits_initialized_true() public view {
        // The main vault in setUp was created with openDeposits=true
        assertTrue(vault.openDeposits());
    }

    // ==================== TOTAL DEPOSITED TRACKING ====================

    function test_totalDeposited_increments_on_deposit() public {
        assertEq(vault.totalDeposited(), 0);

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertEq(vault.totalDeposited(), 10_000e6);

        vm.startPrank(lp2);
        usdc.approve(address(vault), 5_000e6);
        vault.deposit(5_000e6, lp2);
        vm.stopPrank();

        assertEq(vault.totalDeposited(), 15_000e6);
    }

    function test_totalDeposited_decrements_on_withdraw() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vault.withdraw(3_000e6, lp1, lp1);
        vm.stopPrank();

        assertEq(vault.totalDeposited(), 7_000e6);
    }

    function test_totalDeposited_decrements_on_ragequit() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertEq(vault.totalDeposited(), 10_000e6);

        vm.prank(lp1);
        vault.ragequit(lp1);

        assertEq(vault.totalDeposited(), 0);
    }

    function test_totalDeposited_multiple_lps() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        usdc.approve(address(vault), 30_000e6);
        vault.deposit(30_000e6, lp2);
        vm.stopPrank();

        assertEq(vault.totalDeposited(), 80_000e6);

        // LP1 ragequits
        vm.prank(lp1);
        vault.ragequit(lp1);

        assertEq(vault.totalDeposited(), 30_000e6);
    }

    // ==================== GET AGENT ADDRESSES ====================

    function test_getAgentAddresses_single() public view {
        address[] memory agents = vault.getAgentAddresses();
        assertEq(agents.length, 1);
        assertEq(agents[0], agentWallet);
    }

    function test_getAgentAddresses_multiple() public {
        vm.prank(owner);
        vault.registerAgent(agent2NftId, agentWallet2);

        address[] memory agents = vault.getAgentAddresses();
        assertEq(agents.length, 2);
        // Order depends on EnumerableSet iteration order
        bool found1 = false;
        bool found2 = false;
        for (uint256 i = 0; i < agents.length; i++) {
            if (agents[i] == agentWallet) found1 = true;
            if (agents[i] == agentWallet2) found2 = true;
        }
        assertTrue(found1);
        assertTrue(found2);
    }

    function test_getAgentAddresses_afterRemoval() public {
        vm.startPrank(owner);
        vault.registerAgent(agent2NftId, agentWallet2);
        vault.removeAgent(agentWallet);
        vm.stopPrank();

        address[] memory agents = vault.getAgentAddresses();
        assertEq(agents.length, 1);
        assertEq(agents[0], agentWallet2);
    }

    function test_getAgentAddresses_empty() public {
        vm.prank(owner);
        vault.removeAgent(agentWallet);

        address[] memory agents = vault.getAgentAddresses();
        assertEq(agents.length, 0);
    }

    // ==================== ERC20VOTES ====================

    function test_getPastVotes_afterDeposit() public {
        uint256 depositTime = block.timestamp;

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // Advance time so getPastVotes works (timestamp-based clock)
        vm.warp(block.timestamp + 1);

        uint256 pastVotes = vault.getPastVotes(lp1, depositTime);
        assertEq(pastVotes, 10_000e6);
    }

    function test_getPastTotalSupply_afterDeposit() public {
        uint256 depositTime = block.timestamp;

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);

        uint256 pastSupply = vault.getPastTotalSupply(depositTime);
        assertEq(pastSupply, 10_000e6);
    }
}
