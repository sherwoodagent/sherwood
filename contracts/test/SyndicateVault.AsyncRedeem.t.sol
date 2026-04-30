// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {VaultWithdrawalQueue} from "../src/queue/VaultWithdrawalQueue.sol";
import {IVaultWithdrawalQueue} from "../src/interfaces/IVaultWithdrawalQueue.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
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
}
