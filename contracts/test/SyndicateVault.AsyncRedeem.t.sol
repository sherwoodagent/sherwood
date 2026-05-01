// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {VaultWithdrawalQueue} from "../src/queue/VaultWithdrawalQueue.sol";
import {IVaultWithdrawalQueue} from "../src/interfaces/IVaultWithdrawalQueue.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";

contract VaultAsyncRedeemTest is Test {
    SyndicateVault vault;
    VaultWithdrawalQueue queue;
    BatchExecutorLib executorLib;
    ERC20Mock usdc;
    MockAgentRegistry agentRegistry;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address constant MOCK_GOVERNOR = address(0xF00D);

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

        // Test contract acts as factory; queue is deployed and bound by it.
        queue = new VaultWithdrawalQueue(address(vault));
        vault.setWithdrawalQueue(address(queue));

        // Mock governor + active proposal to false by default
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        // MS-H4: vault `_deposit` reads `openProposalCount(address)` — mock to 0.
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(0)));

        // Fund Alice
        usdc.mint(alice, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _setProposalActive(bool active) internal {
        vm.mockCall(
            MOCK_GOVERNOR,
            abi.encodeWithSignature("getActiveProposal(address)"),
            abi.encode(active ? uint256(1) : uint256(0))
        );
    }

    function test_setWithdrawalQueue_onlyFactory() public {
        // Already set by setUp via test contract (factory). A non-factory call must revert.
        VaultWithdrawalQueue q2 = new VaultWithdrawalQueue(address(vault));
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.NotFactory.selector);
        vault.setWithdrawalQueue(address(q2));
    }

    function test_setWithdrawalQueue_setOnce() public {
        VaultWithdrawalQueue q2 = new VaultWithdrawalQueue(address(vault));
        vm.expectRevert(ISyndicateVault.WithdrawalQueueAlreadySet.selector);
        vault.setWithdrawalQueue(address(q2));
    }

    function test_requestRedeem_revertsWhenUnlocked() public {
        // Alice deposits then tries to requestRedeem while not locked
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.RedemptionsNotLocked.selector);
        vault.requestRedeem(100e18, alice);
    }

    function test_requestRedeem_succeedsWhenLocked() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);

        _setProposalActive(true);

        vm.prank(alice);
        uint256 reqId = vault.requestRedeem(shares / 2, alice);

        assertEq(reqId, 1);
        // Half of alice's shares should now sit in the queue
        assertEq(vault.balanceOf(address(queue)), shares / 2);
        assertEq(vault.balanceOf(alice), shares - shares / 2);
        assertEq(vault.pendingQueueShares(), shares / 2);

        IVaultWithdrawalQueue.Request memory r = queue.getRequest(reqId);
        assertEq(r.owner, alice);
        assertEq(uint256(r.shares), shares / 2);
    }

    function test_requestRedeem_zeroSharesReverts() public {
        _setProposalActive(true);
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.InsufficientShares.selector);
        vault.requestRedeem(0, alice);
    }

    function test_requestRedeem_callerMustBeOwnerOrApproved() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        _setProposalActive(true);

        // Bob tries to request on alice's behalf without allowance
        address bob = makeAddr("bob");
        vm.prank(bob);
        vm.expectRevert(); // ERC20InsufficientAllowance from _spendAllowance
        vault.requestRedeem(shares / 2, alice);
    }

    function test_requestRedeem_emitsRedeemRequested() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        _setProposalActive(true);

        vm.expectEmit(true, true, false, true, address(vault));
        emit ISyndicateVault.RedeemRequested(1, alice, shares / 2);
        vm.prank(alice);
        vault.requestRedeem(shares / 2, alice);
    }

    function test_requestRedeem_revertsWhenQueueUnset() public {
        // Deploy a fresh vault (this test contract acts as factory) but do NOT
        // bind a queue. requestRedeem must revert with WithdrawalQueueNotSet
        // before it ever reaches the redemptionsLocked() check.
        SyndicateVault impl = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Bare",
                    symbol: "B",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: 0
                }))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        SyndicateVault bare = SyndicateVault(payable(address(proxy)));

        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.WithdrawalQueueNotSet.selector);
        bare.requestRedeem(1e18, alice);
    }

    function test_requestRedeem_thirdPartyWithAllowance() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        address bob = makeAddr("bob");

        // alice grants bob allowance for half her shares
        vm.prank(alice);
        vault.approve(bob, shares / 2);

        _setProposalActive(true);

        vm.prank(bob);
        uint256 reqId = vault.requestRedeem(shares / 2, alice);

        assertEq(reqId, 1);
        assertEq(vault.allowance(alice, bob), 0); // allowance consumed
        assertEq(vault.balanceOf(address(queue)), shares / 2);
        assertEq(vault.balanceOf(alice), shares - shares / 2);
    }

    function test_requestRedeem_byOwnerArrayGrows() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        _setProposalActive(true);

        vm.prank(alice);
        vault.requestRedeem(shares / 4, alice);
        vm.prank(alice);
        vault.requestRedeem(shares / 4, alice);

        uint256[] memory ids = queue.getRequestsByOwner(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    function test_maxWithdraw_capsAtFloatMinusReserve() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);

        address bob = makeAddr("bob");
        usdc.mint(bob, 100_000e6);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        vault.deposit(1_000e6, bob);

        // Activate proposal, alice queues half her shares
        _setProposalActive(true);
        vm.prank(alice);
        vault.requestRedeem(aliceShares / 2, alice);

        // Settle (lock cleared)
        _setProposalActive(false);

        uint256 reserve = vault.reservedQueueAssets();
        uint256 float = usdc.balanceOf(address(vault));

        uint256 cap = vault.maxWithdraw(bob);
        // Bob is capped by min(his entitled assets, float - reserve)
        assertLe(cap, float - reserve);
    }

    function test_withdraw_revertsWhenExceedsMaxWithdraw() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);

        address bob = makeAddr("bob");
        usdc.mint(bob, 100_000e6);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        vault.deposit(100e6, bob); // bob deposits much less than alice queued

        _setProposalActive(true);
        vm.prank(alice);
        vault.requestRedeem(aliceShares, alice); // queue ALL of alice
        _setProposalActive(false);

        // Bob tries to withdraw far more than `maxWithdraw(bob)` (which is
        // capped by `float - reserve`). EIP-4626 conformance requires the OZ
        // `ERC4626ExceededMaxWithdraw` revert here — `maxWithdraw` is the
        // visible cap and `withdraw` must honour it.
        uint256 cap = vault.maxWithdraw(bob);
        assertLt(cap, 1_000e6, "test invariant: request must exceed cap");
        vm.prank(bob);
        vm.expectPartialRevert(ERC4626Upgradeable.ERC4626ExceededMaxWithdraw.selector);
        vault.withdraw(1_000e6, bob, bob);
    }

    function test_queueClaim_bypassesReserveCheck() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);

        _setProposalActive(true);
        vm.prank(alice);
        uint256 reqId = vault.requestRedeem(aliceShares, alice);
        _setProposalActive(false);

        // Even though reservedQueueAssets > 0 and float == reserve,
        // the queue MUST be able to claim and drain the reserve to alice.
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        uint256 assets = queue.claim(reqId);
        assertGt(assets, 0);
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + assets);
    }

    function test_maxRedeem_capsAtPendingShares() public {
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);

        _setProposalActive(true);
        vm.prank(alice);
        vault.requestRedeem(aliceShares / 2, alice); // half escrowed
        _setProposalActive(false);

        uint256 cap = vault.maxRedeem(alice);
        // Alice has aliceShares/2 left; reserve cap shouldn't exceed her balance either
        assertLe(cap, vault.balanceOf(alice));
    }

    function test_redeem_revertsWhenExceedsMaxRedeem() public {
        // EIP-4626 conformance: `redeem` MUST revert with
        // `ERC4626ExceededMaxRedeem` when the requested shares exceed
        // `maxRedeem(owner)`. The reserve cap surfaces through `maxRedeem`
        // (queue-bypass aside), so the standard OZ gate fires first.
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000e6, alice);

        address bob = makeAddr("bob");
        usdc.mint(bob, 100_000e6);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        vault.deposit(100e6, bob);

        _setProposalActive(true);
        vm.prank(alice);
        vault.requestRedeem(aliceShares, alice);
        _setProposalActive(false);

        // Bob requests far more shares than `maxRedeem(bob)` permits.
        uint256 bigShares = aliceShares; // alice's worth of shares
        uint256 cap = vault.maxRedeem(bob);
        assertLt(cap, bigShares, "test invariant: request must exceed cap");
        vm.prank(bob);
        vm.expectPartialRevert(ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector);
        vault.redeem(bigShares, bob, bob);
    }
}
