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

    function test_setActiveStrategyAdapter_setsAndEmits() public {
        // I-3: must be a real IStrategy contract — the smoke-test rejects
        // EOAs / non-IStrategy targets at bind time.
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.expectEmit(true, false, false, true, address(vault));
        emit ISyndicateVault.ActiveStrategyAdapterSet(address(adapter));
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        assertEq(vault.activeStrategyAdapter(), address(adapter));
    }

    function test_setActiveStrategyAdapter_zeroAddressUnbindsAndEmits() public {
        // Bind first — smoke-test passes for the real adapter.
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        vm.expectEmit(false, false, false, false, address(vault));
        emit ISyndicateVault.ActiveStrategyAdapterCleared();
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(0));

        assertEq(vault.activeStrategyAdapter(), address(0));
    }

    function test_setActiveStrategyAdapter_overwritesExisting() public {
        MockStrategyAdapter a1 = new MockStrategyAdapter();
        MockStrategyAdapter a2 = new MockStrategyAdapter();
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(a1));
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(a2));
        assertEq(vault.activeStrategyAdapter(), address(a2));
    }

    /// @notice I-3: EOA / non-IStrategy adapters are rejected at bind time
    ///         by `setActiveStrategyAdapter`. Catches obvious mistakes
    ///         before the runtime backstops kick in.
    function test_setActiveStrategyAdapter_rejectsEOA() public {
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AdapterNotIStrategy.selector);
        vault.setActiveStrategyAdapter(MOCK_ADAPTER);
    }

    /// @notice I-3: contracts whose `positionValue()` reverts are rejected
    ///         at bind time by `setActiveStrategyAdapter`.
    function test_setActiveStrategyAdapter_rejectsRevertingContract() public {
        RevertingAdapter ra = new RevertingAdapter();
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AdapterNotIStrategy.selector);
        vault.setActiveStrategyAdapter(address(ra));
    }

    /// @dev Make `redemptionsLocked()` return true so the adapter NAV is read.
    function _mockActiveProposal() internal {
        _mockActiveProposal(true);
    }

    /// @dev Toggle the mocked active proposal — `true` locks the vault.
    function _mockActiveProposal(bool active) internal {
        vm.mockCall(
            MOCK_GOVERNOR,
            abi.encodeWithSignature("getActiveProposal(address)"),
            abi.encode(active ? uint256(1) : uint256(0))
        );
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

        // Adapter NAV is only included while a proposal is active.
        _mockActiveProposal();

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
        _mockActiveProposal();

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
        _mockActiveProposal();

        assertEq(vault.totalAssets(), 1_000e6); // 500 float + 500 adapter
    }

    // ──────────────────────── Task 12: live-NAV LP-flow gating ────────────────────────

    function test_deposit_allowedWhenAdapterValidDuringLock() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true); // value=0 + valid=true
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        assertGt(shares, 0);
    }

    function test_deposit_blockedWhenAdapterInvalidDuringLock() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, false);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    function test_deposit_blockedWhenAdapterUnboundDuringLock() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        _mockActiveProposal(true); // no adapter set
        vm.prank(alice);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(1_000e6, alice);
    }

    function test_withdraw_allowedWhenAdapterValidDuringLock() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);

        // Bind adapter, lock, valid=true
        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        // Should be able to withdraw via standard path
        vm.prank(alice);
        uint256 redeemed = vault.redeem(shares, alice, alice);
        assertGt(redeemed, 0);
    }

    function test_withdraw_blockedWhenAdapterInvalidDuringLock() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, false); // invalid
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        // OZ ERC4626 hits maxRedeem == 0 → ERC4626ExceededMaxRedeem before _withdraw runs.
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(1, alice, alice);
    }

    function test_maxWithdraw_returnsNonZeroWhenAdapterValid() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        assertGt(vault.maxWithdraw(alice), 0);
    }

    // ──────────────────────── Task 13: live-deposit forwarding ────────────────────────

    /// @notice On a live deposit (proposal active, adapter valid), the vault
    ///         pushes the new capital into the adapter via `onLiveDeposit`
    ///         so it starts earning yield immediately.
    function test_deposit_forwardsAssetsToLiveAdapter() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        _mockActiveProposal(true);

        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        // Vault pushed the assets to the adapter and called the hook.
        assertEq(adapter.lastLiveDeposit(), 1_000e6, "adapter received forwarded assets");
        assertEq(adapter.liveDepositCount(), 1, "hook called exactly once");
        assertEq(usdc.balanceOf(address(adapter)), 1_000e6, "assets pushed to adapter");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault float drained");
    }

    /// @notice Outside the lock window the forwarding hook must not fire,
    ///         even if a stale adapter pointer is still set.
    function test_deposit_doesNotForwardWhenUnlocked() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
        // No active proposal mocked — `redemptionsLocked()` is false.

        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        assertEq(adapter.liveDepositCount(), 0, "hook not called when unlocked");
        assertEq(usdc.balanceOf(address(vault)), 1_000e6, "vault keeps float");
    }

    /// @notice With no adapter bound the vault must not attempt to forward.
    function test_deposit_doesNotForwardWhenAdapterUnbound() public {
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        // No active proposal, no adapter — plain deposit path.
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        assertEq(usdc.balanceOf(address(vault)), 1_000e6, "vault keeps float");
    }

    function test_totalAssets_ignoresStaleAdapterWhenUnlocked() public {
        // Implicit-clear behaviour: with no active proposal the adapter
        // pointer is silently ignored even if non-zero.
        address alice = makeAddr("alice");
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        MockStrategyAdapter adapter = new MockStrategyAdapter();
        adapter.setValue(9_999e6, true);
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));

        // No active proposal mock => `redemptionsLocked()` is false.
        // Stale adapter pointer must be ignored — float-only NAV.
        assertEq(vault.activeStrategyAdapter(), address(adapter));
        assertEq(vault.totalAssets(), 1_000e6);
    }

    // ──────────────────────── I-3: try/catch backstop on totalAssets ────────────────────────

    /// @notice I-3 regression: a reverting adapter must NOT brick `totalAssets`
    ///         even if it slips past the bind-time smoke-test (e.g. adapter
    ///         self-destructs or upgrades to a reverting impl after binding).
    ///         Vault falls back to float-only so every ERC-4626 conversion path
    ///         (`previewDeposit` / `convertTo*` / `maxWithdraw`) keeps working.
    /// @dev    Bypasses `setActiveStrategyAdapter` (which would reject a
    ///         reverting adapter at bind time) by writing slot 11 —
    ///         `_activeStrategyAdapter` — directly via `vm.store`. This is
    ///         the only way to simulate "passed smoke-test then degraded".
    function test_totalAssets_revertingAdapterFallsBackToFloat() public {
        RevertingAdapter ra = new RevertingAdapter();

        // Slot 11 — see `forge inspect SyndicateVault storage`.
        vm.store(address(vault), bytes32(uint256(11)), bytes32(uint256(uint160(address(ra)))));
        assertEq(vault.activeStrategyAdapter(), address(ra), "adapter pointer wired via vm.store");

        _mockActiveProposal(true);

        // Synthetic float — bypass `_deposit` (which would also call into the
        // reverting adapter via `_lpFlowGate`) by funding the vault directly.
        deal(address(usdc), address(vault), 1_000e6);

        // Should not revert; should report float-only.
        uint256 ta = vault.totalAssets();
        assertEq(ta, 1_000e6);
    }
}

/// @dev Adapter whose `positionValue()` reverts. Used to verify the
///      try/catch backstop in `totalAssets` and `_lpFlowGate` (I-3).
contract RevertingAdapter {
    function positionValue() external pure returns (uint256, bool) {
        revert("nope");
    }
}
