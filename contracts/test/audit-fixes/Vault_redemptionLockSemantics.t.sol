// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockStrategyAdapter} from "../mocks/MockStrategyAdapter.sol";

/// @title Vault_redemptionLockSemantics — MS-H4 regression
/// @notice Verifies the deposit-side lock now covers the full
///         Pending → GuardianReview → Approved → Executed window via
///         `openProposalCount`, while withdrawals retain the legacy
///         Executed-only lock (`getActiveProposal != 0`). The audit's
///         late-deposit window — depositor enters during Pending, gets
///         executed by the next `executeProposal` into a strategy they
///         never voted on — is closed for all four pre-execute states.
/// @dev Drives the vault directly with mocked governor reads. The two
///      governor selectors that matter:
///        - `getActiveProposal(address)` = 0 outside Executed,
///                                       != 0 during Executed.
///        - `openProposalCount(address)` = 0 outside Pending..Executed,
///                                        != 0 from Pending through Executed
///                                        (incremented on Draft→Pending,
///                                         decremented on terminal edges).
contract VaultRedemptionLockSemanticsTest is Test {
    SyndicateVault vault;
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

        // factory.governor() returns the mock governor address.
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        // Default: no active proposal anywhere — deposits/withdraws unlocked.
        _mockState({active: false, openCount: 0});

        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Mocks the two governor view selectors used by the vault locks.
    ///      `active` drives `redemptionsLocked()` (Executed); `openCount`
    ///      drives the MS-H4 deposit lock (Pending..Executed).
    function _mockState(bool active, uint256 openCount) internal {
        vm.mockCall(
            MOCK_GOVERNOR,
            abi.encodeWithSignature("getActiveProposal(address)"),
            abi.encode(active ? uint256(1) : uint256(0))
        );
        vm.mockCall(
            MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)", address(vault)), abi.encode(openCount)
        );
    }

    // ──────────────────────── MS-H4: deposit lock during Pending ────────────────────────

    /// @notice Pending state: `openProposalCount > 0` but no active proposal yet.
    ///         Deposits MUST revert (closes the late-deposit window).
    function test_deposit_revertsDuringPending() public {
        _mockState({active: false, openCount: 1});
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    /// @notice GuardianReview state: same `openProposalCount > 0`, no active
    ///         proposal yet. Deposits MUST revert.
    function test_deposit_revertsDuringGuardianReview() public {
        _mockState({active: false, openCount: 1});
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    /// @notice Approved state: same `openProposalCount > 0`, no active
    ///         proposal yet. Deposits MUST revert (this is the audit's
    ///         worst-case late-deposit window: the very next block can
    ///         `executeProposal` and pull the fresh USDC into a strategy).
    function test_deposit_revertsDuringApproved() public {
        _mockState({active: false, openCount: 1});
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    /// @notice Executed state without a live-NAV adapter: deposits revert
    ///         (legacy behaviour preserved by `_lpFlowGate`).
    function test_deposit_revertsDuringExecutedWithoutAdapter() public {
        _mockState({active: true, openCount: 1});
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    /// @notice Executed state WITH a valid live-NAV adapter: deposits succeed
    ///         and forward to the adapter (preserves the live-NAV unlock from
    ///         the `feat/live-nav-async-withdrawals` branch — MS-H4 must NOT
    ///         regress this).
    function test_deposit_allowedDuringExecutedWithLiveNAV() public {
        // Bind a valid adapter via governor.
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        _mockState({active: true, openCount: 1});

        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        assertGt(shares, 0, "live-NAV deposit should succeed");
        assertEq(adapter.lastLiveDeposit(), 1_000e6, "assets forwarded to adapter");
    }

    /// @notice Settled (terminal) — `openProposalCount` decrements to 0,
    ///         `getActiveProposal` clears. Deposits MUST succeed.
    function test_deposit_allowedAfterSettle() public {
        // Simulate Pending→Approved blocked, then settled (counter drops).
        _mockState({active: false, openCount: 1});
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);

        // Settled: counter back to 0, adapter cleared.
        _mockState({active: false, openCount: 0});
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        assertGt(shares, 0, "deposit unlocked post-settle");
    }

    // ──────────────────────── MS-H4: withdraw lock asymmetry ────────────────────────

    /// @notice Withdrawals during Pending..Approved (no active proposal yet)
    ///         MUST be allowed — the strategy hasn't started, the vault is
    ///         float-only, and forcing LPs through async-redeem during voting
    ///         would degrade UX without any safety benefit. Asymmetric with
    ///         the deposit lock by design.
    function test_withdraw_allowedDuringPending() public {
        // Seed alice with shares while unlocked.
        _mockState({active: false, openCount: 0});
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        uint256 shares = vault.balanceOf(alice);

        // Open proposal goes Pending — withdrawals stay open.
        _mockState({active: false, openCount: 1});
        uint256 maxW = vault.maxWithdraw(alice);
        assertGt(maxW, 0, "withdraw not blocked during Pending");

        vm.prank(alice);
        uint256 redeemed = vault.redeem(shares, alice, alice);
        assertGt(redeemed, 0, "redeem succeeds during Pending");
    }

    /// @notice Withdrawals during Executed without a live-NAV adapter MUST
    ///         revert (legacy lock preserved).
    function test_withdraw_revertsDuringExecutedWithoutAdapter() public {
        _mockState({active: false, openCount: 0});
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        _mockState({active: true, openCount: 1});
        // OZ ERC4626's maxRedeem-zero path causes ERC4626ExceededMaxRedeem.
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(1, alice, alice);
    }

    // ──────────────────────── Sanity: rescue lock unchanged ────────────────────────

    /// @notice Rescue paths still gate on `redemptionsLocked()` (Executed
    ///         only) — unchanged by MS-H4. During Pending they remain open.
    ///         During Executed they revert.
    function test_rescueERC20_unaffectedByPending() public {
        ERC20Mock other = new ERC20Mock("Other", "OTH", 18);
        other.mint(address(vault), 100e18);

        _mockState({active: false, openCount: 1}); // Pending
        vm.prank(owner);
        vault.rescueERC20(address(other), owner, 100e18);
        assertEq(other.balanceOf(owner), 100e18);
    }

    function test_rescueERC20_blockedDuringExecuted() public {
        ERC20Mock other = new ERC20Mock("Other", "OTH", 18);
        other.mint(address(vault), 100e18);

        _mockState({active: true, openCount: 1}); // Executed
        vm.prank(owner);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.rescueERC20(address(other), owner, 100e18);
    }
}
