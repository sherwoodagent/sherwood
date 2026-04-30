// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultWithdrawalQueue} from "../../src/queue/VaultWithdrawalQueue.sol";
import {IVaultWithdrawalQueue} from "../../src/interfaces/IVaultWithdrawalQueue.sol";
import {MockVault} from "./mocks/MockVault.sol";

contract VaultWithdrawalQueueTest is Test {
    MockVault vault;
    VaultWithdrawalQueue queue;
    address alice = makeAddr("alice");

    function setUp() public {
        vault = new MockVault();
        queue = new VaultWithdrawalQueue(address(vault));
        vault.setQueue(address(queue));
        vault.mint(alice, 1_000e18);
        // Simulate the vault transferring escrow shares into the queue when a
        // request is queued. We do that by minting directly to the queue here
        // since these unit tests focus on queue logic, not the vault wiring.
    }

    function test_queueRequest_recordsRequestAndIncrementsPending() public {
        vm.prank(address(vault));
        uint256 id = queue.queueRequest(alice, 100e18);

        assertEq(id, 1);
        IVaultWithdrawalQueue.Request memory r = queue.getRequest(1);
        assertEq(r.owner, alice);
        assertEq(uint256(r.shares), 100e18);
        assertFalse(r.claimed);
        assertFalse(r.cancelled);
        assertEq(queue.pendingShares(), 100e18);
        assertEq(queue.nextRequestId(), 2);
    }

    function test_queueRequest_onlyVaultCanCall() public {
        vm.expectRevert(IVaultWithdrawalQueue.NotVault.selector);
        queue.queueRequest(alice, 100e18);
    }

    function test_claim_revertsWhileVaultLocked() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.setLocked(true);
        vm.expectRevert(IVaultWithdrawalQueue.VaultLocked.selector);
        queue.claim(1);
    }

    function test_claim_redeemsAtPostSettleNAVAndPaysOwner() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);

        // Simulate vault having transferred shares into the queue at request time
        vault.mint(address(queue), 100e18);

        vault.setLocked(false);
        vault.setRedeemRate(2e18); // 1 share -> 2 underlying

        uint256 assets = queue.claim(1);
        assertEq(assets, 200e18);
        assertEq(vault.lastRedeemReceiver(), alice);
        assertEq(vault.lastRedeemOwner(), address(queue));

        IVaultWithdrawalQueue.Request memory r = queue.getRequest(1);
        assertTrue(r.claimed);
        assertEq(queue.pendingShares(), 0);
    }

    function test_claim_anyoneCanCall() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.mint(address(queue), 100e18);
        vault.setLocked(false);

        address bob = makeAddr("bob");
        vm.prank(bob);
        queue.claim(1);
        // Alice still receives proceeds
        assertEq(vault.lastRedeemReceiver(), alice);
    }

    function test_getRequestsByOwner_listsAllForUser() public {
        vm.startPrank(address(vault));
        queue.queueRequest(alice, 10e18);
        queue.queueRequest(alice, 20e18);
        vm.stopPrank();
        uint256[] memory ids = queue.getRequestsByOwner(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    function test_queueRequest_zeroSharesReverts() public {
        vm.prank(address(vault));
        vm.expectRevert(IVaultWithdrawalQueue.ZeroShares.selector);
        queue.queueRequest(alice, 0);
    }

    function test_claim_twiceReverts() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.mint(address(queue), 100e18);
        vault.setLocked(false);
        queue.claim(1);
        vm.expectRevert(IVaultWithdrawalQueue.AlreadyClaimed.selector);
        queue.claim(1);
    }

    function test_cancel_returnsSharesToOwner() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        // simulate vault transfer of shares into queue
        vault.mint(address(queue), 100e18);
        uint256 aliceBalBefore = vault.balanceOf(alice);
        vm.prank(alice);
        queue.cancel(1);
        assertEq(vault.balanceOf(alice), aliceBalBefore + 100e18);
        assertEq(queue.pendingShares(), 0);
        IVaultWithdrawalQueue.Request memory r = queue.getRequest(1);
        assertTrue(r.cancelled);
        assertFalse(r.claimed);
    }

    function test_cancel_nonOwnerReverts() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        address bob = makeAddr("bob");
        vm.prank(bob);
        vm.expectRevert(IVaultWithdrawalQueue.NotQueueOwner.selector);
        queue.cancel(1);
    }

    function test_claim_unknownRequestReverts() public {
        vm.expectRevert(IVaultWithdrawalQueue.RequestNotFound.selector);
        queue.claim(99);
    }

    function test_cancel_afterClaimReverts() public {
        vm.prank(address(vault));
        queue.queueRequest(alice, 100e18);
        vault.mint(address(queue), 100e18);
        vault.setLocked(false);
        queue.claim(1);
        vm.prank(alice);
        vm.expectRevert(IVaultWithdrawalQueue.AlreadyClaimed.selector);
        queue.cancel(1);
    }
}
