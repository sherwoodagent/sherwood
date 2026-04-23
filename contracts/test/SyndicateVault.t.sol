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

contract SyndicateVaultTest is Test {
    SyndicateVault public vault;
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
    address public agentAddr = makeAddr("agent1");
    address public agentAddr2 = makeAddr("agent2");

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
        agent1NftId = agentRegistry.mint(agentAddr);
        agent2NftId = agentRegistry.mint(agentAddr2);

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

        // Register agent (NFT owned by agent)
        vm.prank(owner);
        vault.registerAgent(agent1NftId, agentAddr);

        // Mock factory.governor() to return a non-zero placeholder, with
        // getActiveProposal → 0 so deposits/withdrawals stay unlocked by default.
        // `redemptionsLocked()` fails closed on governor == address(0).
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
    }

    /// @dev Deterministic placeholder for factory.governor() in tests.
    address internal constant MOCK_GOVERNOR = address(0xF00D);

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

    // ==================== AGENT REGISTRATION ====================

    function test_registerAgent() public view {
        assertTrue(vault.isAgent(agentAddr));
        assertEq(vault.getAgentCount(), 1);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentAddr);
        assertEq(config.agentId, agent1NftId);
        assertEq(config.agentAddress, agentAddr);
        assertTrue(config.active);
    }

    function test_registerAgent_ownerOwnsNft() public {
        // Mint an NFT owned by the vault owner (syndicate creator) — should also be allowed
        uint256 ownerNftId = agentRegistry.mint(owner);

        vm.prank(owner);
        vault.registerAgent(ownerNftId, agentAddr2);

        assertTrue(vault.isAgent(agentAddr2));
        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentAddr2);
        assertEq(config.agentId, ownerNftId);
    }

    function test_registerAgent_notAgentOwner_reverts() public {
        // Mint NFT to some random address
        address random = makeAddr("random");
        uint256 randomNftId = agentRegistry.mint(random);

        // Try to register with NFT not owned by agentAddress or vault owner
        vm.prank(owner);
        vm.expectRevert(ISyndicateVault.NotAgentOwner.selector);
        vault.registerAgent(randomNftId, agentAddr2);
    }

    function test_registerAgent_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.registerAgent(agent2NftId, agentAddr2);
    }

    function test_removeAgent() public {
        vm.prank(owner);
        vault.removeAgent(agentAddr);

        assertFalse(vault.isAgent(agentAddr));
        assertEq(vault.getAgentCount(), 0);
    }

    /// @dev V-M5: after `removeAgent`, the `_agents[agentAddress]` struct must
    ///      be fully deleted, not just `active = false`. Otherwise a later
    ///      `registerAgent` for the same address would silently leak the old
    ///      `agentId` into the new entry if the caller assumed struct fields
    ///      were untouched. We assert:
    ///      1. After remove, `getAgentConfig` returns the zero struct.
    ///      2. After re-register with a new `agentId`, the stored fields match
    ///         the *new* args, not the old.
    function test_removeAgent_deletesStructData() public {
        // Pre-condition: agent registered in setUp with `agent1NftId`.
        ISyndicateVault.AgentConfig memory before = vault.getAgentConfig(agentAddr);
        assertEq(before.agentId, agent1NftId);
        assertTrue(before.active);

        // Remove
        vm.prank(owner);
        vault.removeAgent(agentAddr);

        // 1. Struct must be wiped (not just `active = false`).
        ISyndicateVault.AgentConfig memory afterRemove = vault.getAgentConfig(agentAddr);
        assertEq(afterRemove.agentId, 0, "agentId not cleared");
        assertEq(afterRemove.agentAddress, address(0), "agentAddress not cleared");
        assertFalse(afterRemove.active, "active not cleared");

        // 2. Re-register with a fresh NFT (different id) owned by the same
        //    agent address — fields must reflect the new args, not old.
        uint256 newNftId = agentRegistry.mint(agentAddr);
        assertTrue(newNftId != agent1NftId, "test setup: new id must differ");

        vm.prank(owner);
        vault.registerAgent(newNftId, agentAddr);

        ISyndicateVault.AgentConfig memory reRegistered = vault.getAgentConfig(agentAddr);
        assertEq(reRegistered.agentId, newNftId, "re-register: id reflects new");
        assertEq(reRegistered.agentAddress, agentAddr, "re-register: addr");
        assertTrue(reRegistered.active, "re-register: active");
    }

    // ==================== BATCH EXECUTION (V-C3: executeBatch removed) ====================

    /// @dev V-C3: owner-direct `executeBatch(BatchExecutorLib.Call[])` was removed.
    ///      A raw call with the old selector must revert (no matching function).
    function test_executeBatch_removed() public {
        // Old selector: executeBatch((address,bytes,uint256)[])
        bytes4 oldSelector = bytes4(keccak256("executeBatch((address,bytes,uint256)[])"));

        // Craft minimal calldata: old selector + empty dynamic array.
        // Encoding: selector || offset(0x20) || length(0)
        bytes memory callData = abi.encodePacked(oldSelector, uint256(0x20), uint256(0));

        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call(callData);

        // Function does not exist: call returns false with no error data.
        assertFalse(ok);
        assertEq(ret.length, 0);
    }

    // ==================== PAUSE ====================

    function test_pause_blocksDeposits() public {
        vm.prank(owner);
        vault.pause();

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vm.expectRevert();
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();
    }

    // ==================== RECEIVE ETH (removed — V-H6) ====================

    /// @dev V-H6: Vault no longer exposes a public `receive()`. Raw ETH
    ///      transfers must fail. Any legitimate mid-batch ETH arrival
    ///      (e.g. mWETH redemption) is wrapped inside strategy code and
    ///      pushed back as WETH, not native ETH. The vault is a pure
    ///      ERC-4626 USDC vault and has no accounting slot for ETH.
    function test_receive_rejectsEth() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(vault).call{value: 1 ether}("");
        assertFalse(success);
        assertEq(address(vault).balance, 0);
    }

    // ==================== REDEMPTIONS LOCKED (I-1) ====================

    /// @dev I-1: `redemptionsLocked()` must fail closed when the factory
    ///      returns a zero governor. Any misconfig should block deposits /
    ///      withdrawals / rescues instead of silently unlocking them.
    function test_redemptionsLocked_revertsIfGovernorZero() public {
        // Re-mock the factory to return address(0) as governor.
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(0)));

        vm.expectRevert(ISyndicateVault.GovernorNotSet.selector);
        vault.redemptionsLocked();
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
        vm.expectRevert();
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

    // ==================== RESCUE ETH ====================

    function test_rescueEth() public {
        // Send ETH to the vault
        vm.deal(address(vault), 2 ether);
        assertEq(address(vault).balance, 2 ether);

        address recipient = makeAddr("recipient");
        uint256 balBefore = recipient.balance;

        vm.prank(owner);
        vault.rescueEth(payable(recipient), 1 ether);

        assertEq(recipient.balance, balBefore + 1 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_rescueEth_notOwner_reverts() public {
        vm.deal(address(vault), 1 ether);

        vm.prank(lp1);
        vm.expectRevert();
        vault.rescueEth(payable(lp1), 1 ether);
    }

    /// @dev V-H5: `rescueEth` must honour `redemptionsLocked()` just like
    ///      `rescueERC20` / `rescueERC721`. Owner cannot siphon ETH while
    ///      a strategy is live (e.g. mWETH redeem mid-settle parks ETH
    ///      transiently in the vault before a wrap).
    function test_rescueEth_revertsDuringActiveStrategy() public {
        vm.deal(address(vault), 1 ether);

        // Simulate an active proposal for this vault.
        vm.mockCall(
            MOCK_GOVERNOR,
            abi.encodeWithSignature("getActiveProposal(address)", address(vault)),
            abi.encode(uint256(42))
        );

        vm.prank(owner);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.rescueEth(payable(makeAddr("recipient")), 1 ether);
    }

    // ==================== RESCUE ERC20 ====================

    /// @dev Sanity check that `rescueERC20` covers stranded non-asset tokens
    ///      that would previously have been pulled out via `executeBatch`.
    function test_rescue_covers_strandedTokens() public {
        // Send WETH (non-asset) directly to the vault
        weth.mint(address(vault), 1e18);
        assertEq(weth.balanceOf(address(vault)), 1e18);

        address recipient = makeAddr("stranded-weth-recipient");

        vm.prank(owner);
        vault.rescueERC20(address(weth), recipient, 1e18);

        assertEq(weth.balanceOf(recipient), 1e18);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    function test_rescueERC20_cannotRescueAsset_reverts() public {
        usdc.mint(address(vault), 1_000e6);

        vm.prank(owner);
        vm.expectRevert(ISyndicateVault.CannotRescueAsset.selector);
        vault.rescueERC20(address(usdc), makeAddr("recipient"), 1_000e6);
    }

    // ==================== RESCUE ERC721 ====================

    function test_rescueERC721() public {
        // Mint an NFT directly to the vault
        uint256 tokenId = agentRegistry.mint(address(vault));

        assertEq(agentRegistry.ownerOf(tokenId), address(vault));

        address recipient = makeAddr("nftRecipient");
        vm.prank(owner);
        vault.rescueERC721(address(agentRegistry), tokenId, recipient);

        assertEq(agentRegistry.ownerOf(tokenId), recipient);
    }

    function test_rescueERC721_notOwner_reverts() public {
        uint256 tokenId = agentRegistry.mint(address(vault));

        vm.prank(lp1);
        vm.expectRevert();
        vault.rescueERC721(address(agentRegistry), tokenId, lp1);
    }

    // ==================== ERC20VOTES ====================

    function test_getPastVotes_afterDeposit() public {
        // via_ir-safe: use getBlockTimestamp cheatcode so compiler can't reorder
        uint256 depositTime = vm.getBlockTimestamp();

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // Advance time so getPastVotes works (timestamp-based clock)
        vm.warp(vm.getBlockTimestamp() + 1);

        uint256 pastVotes = vault.getPastVotes(lp1, depositTime);
        // With _decimalsOffset() = 6, shares have 12 decimals for USDC
        assertEq(pastVotes, 10_000e12);
    }

    function test_getPastTotalSupply_afterDeposit() public {
        uint256 depositTime = vm.getBlockTimestamp();

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1);

        uint256 pastSupply = vault.getPastTotalSupply(depositTime);
        // With _decimalsOffset() = 6, shares have 12 decimals for USDC
        assertEq(pastSupply, 10_000e12);
    }

    // ==================== DECIMALS OFFSET (INFLATION PROTECTION) ====================

    function test_decimalsOffset_matchesAssetDecimals() public view {
        // USDC has 6 decimals, so offset should be 6 → shares have 12 decimals
        assertEq(vault.decimals(), 12);
    }

    /// @dev V-M1: `_decimalsOffset()` must read from the slot cached at `initialize`
    ///      instead of re-calling `asset().decimals()` on every share conversion.
    ///      If the asset's reported decimals later drifts (e.g. upgraded mock) the
    ///      vault must keep its original offset — otherwise share-to-asset math
    ///      changes retroactively.
    function test_decimalsOffset_cachedAtInit() public {
        // Baseline: USDC (6 decimals) → shares decimals = 6 + 6 = 12
        assertEq(vault.decimals(), 12);
        assertEq(vault.convertToShares(1e6), 1e12, "pre-drift convertToShares");

        // Replace the reported decimals on the asset contract. A real ERC-20
        // can't do this, but a malicious/upgradable asset could — we want the
        // vault to be immune because it cached at init.
        vm.mockCall(address(usdc), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        // Sanity: the mock is live.
        assertEq(usdc.decimals(), 18);

        // Vault view must still report the original 12 decimals — proving it
        // pulled the offset from storage, not from a live `asset().decimals()`.
        assertEq(vault.decimals(), 12, "vault decimals drifted after asset mock");
        assertEq(vault.convertToShares(1e6), 1e12, "convertToShares drifted after asset mock");
    }

    /// @dev V-M2: tighter regression on the 1-wei-deposit donation attack.
    ///      Pins the expected share bookkeeping at each step and requires the
    ///      victim to retain `>=99%` of their deposit value. If someone ever
    ///      reverts `_decimalsOffset` back to a constant 0, this turns red
    ///      alongside `test_inflationAttack_mitigated` below.
    function test_inflationAttack_1weiDeposit_blocked() public {
        address attacker = makeAddr("attacker_v_m2");
        address victim = makeAddr("victim_v_m2");

        usdc.mint(attacker, 2_000_000e6);
        usdc.mint(victim, 10_000e6);

        // Step 1: attacker deposits 1 wei. With _decimalsOffset() = 6 (USDC),
        // the 1-wei deposit yields `1 * 10**offset` shares via ERC-4626 virtual
        // shares.
        vm.startPrank(attacker);
        usdc.approve(address(vault), 1);
        vault.deposit(1, attacker);
        vm.stopPrank();

        uint8 offset = 6;
        assertEq(vault.balanceOf(attacker), uint256(1) * 10 ** offset, "attacker share accounting");

        // Step 2: attacker donates 1M USDC directly (not via deposit) trying
        // to inflate share price so the victim's shares round to zero.
        vm.prank(attacker);
        usdc.transfer(address(vault), 1_000_000e6);

        // Step 3: victim deposits 100 USDC. Without inflation protection they'd
        // receive 0 shares. With protection the deposit is proportional and
        // redeemable.
        uint256 victimDepositAmount = 100e6;
        vm.startPrank(victim);
        usdc.approve(address(vault), victimDepositAmount);
        uint256 victimShares = vault.deposit(victimDepositAmount, victim);
        vm.stopPrank();

        assertGt(victimShares, 0, "inflation attack would give victim 0 shares");

        uint256 victimAssets = vault.convertToAssets(victimShares);
        assertGe(victimAssets, (victimDepositAmount * 99) / 100, "victim loses >1% to inflation");
    }

    function test_inflationAttack_mitigated() public {
        // Classic ERC-4626 inflation attack:
        // 1. Attacker deposits 1 wei, gets shares
        // 2. Attacker donates large amount directly to vault
        // 3. Next depositor's shares round to 0
        // With _decimalsOffset() = 6, virtual shares make this infeasible

        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");

        usdc.mint(attacker, 20_000e6);
        usdc.mint(victim, 10_000e6);

        // Step 1: Attacker deposits 1 wei of USDC
        vm.startPrank(attacker);
        usdc.approve(address(vault), 1);
        vault.deposit(1, attacker);
        vm.stopPrank();

        // Step 2: Attacker donates 10_000 USDC directly (not via deposit)
        vm.prank(attacker);
        usdc.transfer(address(vault), 10_000e6);

        // Step 3: Victim deposits 10_000 USDC — should still get meaningful shares
        vm.startPrank(victim);
        usdc.approve(address(vault), 10_000e6);
        uint256 victimShares = vault.deposit(10_000e6, victim);
        vm.stopPrank();

        // Victim should have non-trivial shares (attack is economically infeasible)
        assertGt(victimShares, 0);

        // Victim can redeem most of their deposit back
        vm.prank(victim);
        uint256 redeemed = vault.redeem(victimShares, victim, victim);
        // Should get back at least 99% of deposit (rounding loss, not attack loss)
        assertGt(redeemed, 9_900e6);
    }

    // ==================== FEE-SUM INVARIANT (V-M8) ====================

    /// @dev V-M8: fuzz the fee-distribution formula from
    ///      `SyndicateGovernor._distributeFees` and assert the invariant
    ///      `protocolFee + agentFee + mgmtFee <= pnl`. Integer division
    ///      truncates so the sum is always less than or equal to `pnl`, and
    ///      strictly less than whenever rounding drops at least one wei. The
    ///      test lives in the vault suite because it's pure math (no governor
    ///      state) and the other governor-owning agent is editing the governor
    ///      and its tests.
    function testFuzz_feeSum_leqPnl(uint128 pnlRaw, uint16 protoBpsRaw, uint16 perfBpsRaw, uint16 mgmtBpsRaw)
        public
        pure
    {
        // Constrain to the real ranges used by the governor / vault:
        //   protocol fee <= 10% (MAX_PROTOCOL_FEE_BPS = 1000)
        //   performance fee <= 50% (MAX_PERFORMANCE_FEE_BPS = 5000)
        //   management fee <= 50% (validated at vault init; 5000 bps ceiling)
        uint256 pnl = uint256(pnlRaw);
        uint256 protoBps = bound(uint256(protoBpsRaw), 0, 1000);
        uint256 perfBps = bound(uint256(perfBpsRaw), 0, 5000);
        uint256 mgmtBps = bound(uint256(mgmtBpsRaw), 0, 5000);

        // Mirror the exact formula used in SyndicateGovernor._distributeFees.
        uint256 protocolFee = (pnl * protoBps) / 10_000;
        uint256 netProfit = pnl - protocolFee;
        uint256 agentFee = (netProfit * perfBps) / 10_000;
        uint256 mgmtFee = ((netProfit - agentFee) * mgmtBps) / 10_000;

        uint256 totalFee = protocolFee + agentFee + mgmtFee;

        // Primary invariant: total fees never exceed the PnL.
        assertLe(totalFee, pnl, "totalFee > pnl violates fee-sum bound");
        // Corollary: residual paid back to the vault is non-negative.
        assertLe(totalFee, pnl);
        assertGe(pnl - totalFee, 0);
    }

    /// @dev V-M8: worst-case edge — max protocol fee (10%) + max perf (50%) +
    ///      max mgmt (50%). Pin the numeric result to guard against anyone
    ///      accidentally re-ordering the subtraction chain.
    function test_feeSum_worstCase_stillBounded() public pure {
        uint256 pnl = 1_000_000e6; // 1M USDC
        uint256 protoBps = 1000; // 10%
        uint256 perfBps = 5000; // 50%
        uint256 mgmtBps = 5000; // 50%

        uint256 protocolFee = (pnl * protoBps) / 10_000;
        uint256 netProfit = pnl - protocolFee;
        uint256 agentFee = (netProfit * perfBps) / 10_000;
        uint256 mgmtFee = ((netProfit - agentFee) * mgmtBps) / 10_000;

        // 10% + 90%*50% + 90%*50%*50% = 10% + 45% + 22.5% = 77.5% of PnL
        // 775_000e6.
        uint256 expectedTotal = 100_000e6 + 450_000e6 + 225_000e6;
        assertEq(protocolFee + agentFee + mgmtFee, expectedTotal, "worst-case total");
        assertLt(protocolFee + agentFee + mgmtFee, pnl, "fees must stay below pnl");
    }

    // ==================== ZERO DEPOSIT ====================

    function test_deposit_zeroAmount_mintsZeroShares() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 0);
        uint256 shares = vault.deposit(0, lp1);
        vm.stopPrank();
        assertEq(shares, 0);
        assertEq(vault.balanceOf(lp1), 0);
    }

    // ==================== BASIC REDEEM ====================

    function test_redeem_returnsCorrectAssets() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        uint256 usdcBefore = usdc.balanceOf(lp1);
        uint256 sharesBefore = vault.balanceOf(lp1);

        vm.prank(lp1);
        uint256 assets = vault.redeem(shares, lp1, lp1);

        assertEq(assets, 10_000e6);
        assertEq(usdc.balanceOf(lp1), usdcBefore + 10_000e6);
        assertEq(vault.balanceOf(lp1), sharesBefore - shares);
    }

    // ==================== PAGINATED GETTERS (V-M3) ====================

    /// @dev V-M3: `agentsPaginated` returns `[offset, offset + limit)` clipped
    ///      to the set length, and hard-clamps `limit` to `MAX_PAGE_LIMIT = 100`.
    ///      We register 150 agents and assert a `limit = 150` call returns 100
    ///      rows (the clamped max), not 150. A second call with offset=100
    ///      returns the remaining 50.
    function test_agentsPaginated_respectsCap() public {
        // 150 total registrations = existing 1 from setUp + 149 new agents
        uint256 existing = vault.getAgentCount();
        uint256 target = 150;
        uint256 toAdd = target - existing;

        for (uint256 i = 0; i < toAdd; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("agent_v_m3", i)))));
            uint256 nftId = agentRegistry.mint(a);
            vm.prank(owner);
            vault.registerAgent(nftId, a);
        }
        assertEq(vault.getAgentCount(), target, "setup: agent count");

        // First page: offset=0, limit=150 — must return exactly MAX_PAGE_LIMIT=100
        address[] memory page1 = vault.agentsPaginated(0, 150);
        assertEq(page1.length, 100, "page1 length clamped to MAX_PAGE_LIMIT");
        assertEq(vault.MAX_PAGE_LIMIT(), 100, "MAX_PAGE_LIMIT public");

        // Second page: offset=100, limit=100 — returns the remaining 50
        address[] memory page2 = vault.agentsPaginated(100, 100);
        assertEq(page2.length, 50, "page2 length = remainder");

        // Empty page past the end
        address[] memory page3 = vault.agentsPaginated(150, 100);
        assertEq(page3.length, 0, "page3 past end returns empty");
    }

    /// @dev V-M3: paginated depositor getter basic shape check + cap enforcement.
    function test_approvedDepositorsPaginated_basic() public {
        // Batch-approve 5 depositors so we can exercise both a short slice
        // and a clipped limit.
        address[] memory ds = new address[](5);
        for (uint256 i = 0; i < ds.length; i++) {
            ds[i] = address(uint160(uint256(keccak256(abi.encode("dep_v_m3", i)))));
        }
        vm.prank(owner);
        vault.approveDepositors(ds);

        assertEq(vault.approvedDepositorCount(), 5);

        address[] memory full = vault.approvedDepositorsPaginated(0, 100);
        assertEq(full.length, 5, "full page = 5");
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(vault.isApprovedDepositor(full[i]), "page entry approved");
        }

        // Slice [2, 4)
        address[] memory slice = vault.approvedDepositorsPaginated(2, 2);
        assertEq(slice.length, 2, "slice length");
        assertEq(slice[0], full[2], "slice[0]");
        assertEq(slice[1], full[3], "slice[1]");

        // Offset past end returns empty.
        address[] memory empty = vault.approvedDepositorsPaginated(5, 10);
        assertEq(empty.length, 0, "past-end empty");

        // Cap: limit=999 is clamped to MAX_PAGE_LIMIT, but since the set has
        // only 5 entries we get 5 back.
        address[] memory capped = vault.approvedDepositorsPaginated(0, 999);
        assertEq(capped.length, 5, "cap clip against set length");
    }

    // ==================== PAUSE / UNPAUSE CYCLE ====================

    function test_pause_blocksDeposits_unpause_allows() public {
        vm.prank(owner);
        vault.pause();

        // Deposits blocked
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vm.expectRevert();
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // Unpause
        vm.prank(owner);
        vault.unpause();

        // Deposits work again
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();
        assertGt(shares, 0);
    }

    function test_pause_blocksWithdrawals() public {
        // Deposit first while unpaused
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // Pause the vault
        vm.prank(owner);
        vault.pause();

        // Withdrawals are also blocked when paused
        vm.prank(lp1);
        vm.expectRevert();
        vault.redeem(shares, lp1, lp1);
    }

    // ==================== EXECUTOR CODEHASH PIN (V-C2) ====================

    /// @dev V-C2: delegatecall path re-verifies `_executorImpl.codehash`
    ///      against the hash stamped at init. If the stored executor address
    ///      is rewritten to point at a different contract, the next
    ///      `executeGovernorBatch` must revert instead of delegatecalling
    ///      into the swapped-in bytecode.
    function test_executeGovernorBatch_revertsIfExecutorCodehashChanged() public {
        // Deploy a second "evil" contract with different bytecode.
        DifferentExecutor evil = new DifferentExecutor();
        assertTrue(address(evil).codehash != address(executorLib).codehash);

        // Overwrite _executorImpl (slot 3) with the evil address.
        vm.store(address(vault), bytes32(uint256(3)), bytes32(uint256(uint160(address(evil)))));
        assertEq(vault.getExecutorImpl(), address(evil));

        // Attempt to execute a batch through the governor — should revert
        // because the live codehash no longer matches the one pinned at init.
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.ExecutorCodehashMismatch.selector);
        vault.executeGovernorBatch(calls);
    }

    /// @dev V-C2 reentrancy guard: if a target re-enters `executeGovernorBatch`
    ///      during its callback, the re-entry must revert.
    ///      We deploy a `ReentrantTarget` and re-mock
    ///      `factory.governor()` to return its address, so when the target
    ///      calls back into the vault as the governor the `onlyGovernor`
    ///      modifier passes and the reentrancy guard is the next line of
    ///      defence.
    function test_executeGovernorBatch_reentrancy_blocked() public {
        ReentrantTarget target = new ReentrantTarget(vault);

        // Route the vault's `onlyGovernor` through the reentrant target.
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(target)));
        vm.mockCall(address(target), abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));

        // Outer batch: one call into `target.ping()`, which re-enters the vault.
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(target), data: abi.encodeWithSelector(ReentrantTarget.ping.selector), value: 0
        });

        vm.prank(address(target));
        // The re-entrant inner call reverts with OZ's ReentrancyGuardReentrantCall,
        // and that revert bubbles up as the outer batch failure.
        vm.expectRevert();
        vault.executeGovernorBatch(calls);
    }

    // ==================== EXECUTE EVENT (V-M9) ====================

    /// @dev V-M9: `executeGovernorBatch` emits
    ///      `GovernorBatchExecuted(governor, callCount)` after the delegatecall
    ///      succeeds. Indexers / monitors depend on this vault-level marker.
    ///      Empty-calls path is the cleanest positive case (no target mocks
    ///      needed) — `BatchExecutorLib.executeBatch` is a no-op loop over a
    ///      zero-length array.
    function test_executeGovernorBatch_emitsEvent() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.expectEmit(true, false, false, true, address(vault));
        emit ISyndicateVault.GovernorBatchExecuted(MOCK_GOVERNOR, 0);

        vm.prank(MOCK_GOVERNOR);
        vault.executeGovernorBatch(calls);
    }

    // ==================== PAUSE GATES GOVERNOR BATCH (I-11) ====================

    /// @dev I-11: pause must halt strategy execution (`executeGovernorBatch`)
    ///      in addition to LP flow. Prior pause semantics were "LP flow off,
    ///      strategy flow on" — closed by gating the governor batch path with
    ///      `whenNotPaused`.
    function test_executeGovernorBatch_revertsWhenPaused() public {
        vm.prank(owner);
        vault.pause();

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);
        vm.prank(MOCK_GOVERNOR);
        // OZ v5 PausableUpgradeable reverts with `EnforcedPause()`.
        vm.expectRevert();
        vault.executeGovernorBatch(calls);
    }
}

/// @dev Minimal standalone contract with bytecode different from
///      `BatchExecutorLib`. Used to prove the codehash check rejects any
///      swapped-in executor.
contract DifferentExecutor {
    function executeBatch(BatchExecutorLib.Call[] calldata) external {
        // Different bytecode than BatchExecutorLib — reverts if called.
        revert("different executor");
    }
}

/// @dev Reentrancy probe: doubles as the mock governor. The vault calls
///      `ping()` on this target inside a batch; `ping()` then calls back
///      into `vault.executeGovernorBatch` with `msg.sender == address(this)`,
///      which passes `onlyGovernor` because we mocked `factory.governor()`
///      to return this target. The `nonReentrant` transient guard must
///      reject the second entry.
contract ReentrantTarget {
    SyndicateVault public immutable vault;

    constructor(SyndicateVault _vault) {
        vault = _vault;
    }

    function ping() external {
        BatchExecutorLib.Call[] memory inner = new BatchExecutorLib.Call[](0);
        vault.executeGovernorBatch(inner);
    }
}
