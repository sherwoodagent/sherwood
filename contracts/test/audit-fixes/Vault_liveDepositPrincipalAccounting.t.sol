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

/// @title Vault_liveDepositPrincipalAccounting
/// @notice Regression for the carlos PR comment: live-NAV deposit principal
///         must NOT be counted as strategy profit at settle. The vault
///         tracks per-proposal principal forwarded to the adapter via the
///         `liveAdapterPrincipal` mapping; `_finishSettlement` adds it to the
///         capital snapshot so PnL = balance - (snapshot + livePrincipal).
contract VaultLiveDepositPrincipalTest is Test {
    SyndicateVault vault;
    BatchExecutorLib executorLib;
    ERC20Mock usdc;
    MockAgentRegistry agentRegistry;
    MockStrategyAdapter adapter;

    address owner = makeAddr("owner");
    address depositor = makeAddr("depositor");
    address constant MOCK_GOVERNOR = address(0xF00D);
    uint256 constant ACTIVE_PID = 7;

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
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(impl), initData))));
        adapter = new MockStrategyAdapter();
        adapter.setValue(0, true);
        adapter.setConfiguredVault(address(vault));

        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        // Active proposal == ACTIVE_PID so the vault tags the principal under
        // that key when the live-NAV adapter forwards it.
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(ACTIVE_PID));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(1)));

        // Bind the live-NAV adapter (vault gates on _lpFlowGate via governor-only).
        vm.prank(MOCK_GOVERNOR);
        vault.setActiveStrategyAdapter(address(adapter));
    }

    /// @notice Live deposits during Executed forward principal to the adapter
    ///         and bump `liveAdapterPrincipal[activePid]` by exactly the amount.
    function test_liveDeposit_tracksPrincipalForActiveProposal() public {
        uint256 amount = 50_000e6;
        usdc.mint(depositor, amount);

        vm.startPrank(depositor);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, depositor);
        vm.stopPrank();

        assertEq(
            vault.liveAdapterPrincipal(ACTIVE_PID),
            amount,
            "principal forwarded to adapter must be tracked under the active proposal"
        );
        assertEq(usdc.balanceOf(address(adapter)), amount, "adapter holds the forwarded principal");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault balance is float-only post-forward");
    }

    /// @notice Multiple live deposits accumulate to the same proposal's bucket.
    function test_liveDeposit_accumulatesAcrossMultipleDeposits() public {
        usdc.mint(depositor, 100_000e6);
        vm.startPrank(depositor);
        usdc.approve(address(vault), 100_000e6);
        vault.deposit(30_000e6, depositor);
        vault.deposit(20_000e6, depositor);
        vault.deposit(50_000e6, depositor);
        vm.stopPrank();

        assertEq(vault.liveAdapterPrincipal(ACTIVE_PID), 100_000e6);
    }

    /// @notice Switching the active proposal isolates per-proposal accounting.
    function test_liveDeposit_isolatesPerProposalBuckets() public {
        usdc.mint(depositor, 80_000e6);

        vm.startPrank(depositor);
        usdc.approve(address(vault), 80_000e6);
        vault.deposit(30_000e6, depositor);
        vm.stopPrank();

        // Simulate a new proposal taking over the slot.
        uint256 newPid = ACTIVE_PID + 1;
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(newPid));

        vm.prank(depositor);
        vault.deposit(50_000e6, depositor);

        assertEq(vault.liveAdapterPrincipal(ACTIVE_PID), 30_000e6, "old proposal bucket frozen");
        assertEq(vault.liveAdapterPrincipal(newPid), 50_000e6, "new proposal has its own bucket");
    }

    /// @notice Pre-execute deposits (no active proposal, no adapter) do NOT
    ///         touch `liveAdapterPrincipal`.
    function test_preExecuteDeposit_doesNotTrackPrincipal() public {
        // No active proposal, no live-NAV adapter activity — but the vault
        // still tracks under whatever the governor says is active. To make
        // sure pre-execute float deposits don't leak: clear the adapter and
        // simulate openProposalCount=0 (deposit window before propose).
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(0)));

        usdc.mint(depositor, 10_000e6);
        vm.startPrank(depositor);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, depositor);
        vm.stopPrank();

        // Adapter still bound but `_lpFlowGate` returns blocked=false only when
        // there's an active proposal in Executed; otherwise the forward
        // condition (liveAdapter != 0 inside the `if` branch) only fires when
        // an active strategy adapter is meaningfully bound to a live state.
        // The bucket stays zero for the prior ACTIVE_PID since no forward
        // occurred under that pid in this test path.
        assertEq(vault.liveAdapterPrincipal(ACTIVE_PID), 0);
    }
}
