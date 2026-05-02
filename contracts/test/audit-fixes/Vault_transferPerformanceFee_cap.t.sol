// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

/// @title Vault_transferPerformanceFee_cap — MS-H9 regression
/// @notice Confirms `transferPerformanceFee` reverts with
///         `AmountExceedsBalance` when the requested `amount` is greater than
///         the vault's current balance of `asset_`. Without the cap, a
///         compromised governor (or upgrade bug) could pass
///         `type(uint256).max` and rely solely on the underlying token's
///         revert path; the explicit bound surfaces the failure as a
///         vault-defined custom error before any token call.
contract VaultTransferPerformanceFeeCapTest is Test {
    SyndicateVault vault;
    BatchExecutorLib executorLib;
    ERC20Mock usdc;
    MockAgentRegistry agentRegistry;

    address owner = makeAddr("owner");
    address recipient = makeAddr("recipient");
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

        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(0)));
    }

    // ──────────────────────── MS-H9: amount cap ────────────────────────

    /// @notice Governor calling with `amount > balance` MUST revert with
    ///         `AmountExceedsBalance` — the vault never enters the
    ///         `safeTransfer` path.
    function test_revertsWhenAmountExceedsBalance() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AmountExceedsBalance.selector);
        vault.transferPerformanceFee(address(usdc), recipient, 100e6 + 1);
    }

    /// @notice The `type(uint256).max` worst-case (e.g. compromised governor
    ///         or upgrade bug) MUST revert with the explicit bound error,
    ///         not a generic SafeERC20 revert downstream.
    function test_revertsOnUintMax() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AmountExceedsBalance.selector);
        vault.transferPerformanceFee(address(usdc), recipient, type(uint256).max);
    }

    /// @notice On an empty vault, ANY non-zero amount must revert.
    function test_revertsOnEmptyVault() public {
        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.AmountExceedsBalance.selector);
        vault.transferPerformanceFee(address(usdc), recipient, 1);
    }

    /// @notice Transfer of exactly the full balance succeeds — the bound is
    ///         inclusive (`amount > balance` reverts; `amount == balance`
    ///         passes).
    function test_succeedsWhenAmountEqualsBalance() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vault.transferPerformanceFee(address(usdc), recipient, 100e6);

        assertEq(usdc.balanceOf(recipient), 100e6, "recipient receives full balance");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault drained");
    }

    /// @notice Sub-balance transfer succeeds and the vault retains the rest.
    function test_succeedsWhenAmountBelowBalance() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vault.transferPerformanceFee(address(usdc), recipient, 25e6);

        assertEq(usdc.balanceOf(recipient), 25e6, "recipient receives partial");
        assertEq(usdc.balanceOf(address(vault)), 75e6, "vault retains residual");
    }

    /// @notice Zero-amount transfer is a no-op but still must not revert
    ///         (legacy behaviour — the cap only kicks in on overage).
    function test_zeroAmountIsNoop() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vault.transferPerformanceFee(address(usdc), recipient, 0);

        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    // ──────────────────────── Existing guards still hold ────────────────────────

    /// @notice Non-governor callers still cannot reach the cap check; the
    ///         `onlyGovernor` modifier bites first.
    function test_onlyGovernor_revertBitesBeforeCapCheck() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(ISyndicateVault.NotGovernor.selector);
        vault.transferPerformanceFee(address(usdc), recipient, type(uint256).max);
    }

    /// @notice Wrong asset still reverts with `InvalidAsset` (not the new
    ///         `AmountExceedsBalance`) — the asset check runs first.
    function test_wrongAssetRevertsBeforeCapCheck() public {
        ERC20Mock other = new ERC20Mock("Other", "OTH", 18);
        other.mint(address(vault), 100e18);

        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.InvalidAsset.selector);
        vault.transferPerformanceFee(address(other), recipient, type(uint256).max);
    }

    /// @notice Zero-address recipient still reverts with `ZeroAddress`
    ///         (recipient check runs before the balance cap).
    function test_zeroRecipientRevertsBeforeCapCheck() public {
        usdc.mint(address(vault), 100e6);

        vm.prank(MOCK_GOVERNOR);
        vm.expectRevert(ISyndicateVault.ZeroAddress.selector);
        vault.transferPerformanceFee(address(usdc), address(0), type(uint256).max);
    }
}
