// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../../../src/SyndicateVault.sol";
import {VaultWithdrawalQueue} from "../../../src/queue/VaultWithdrawalQueue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Adapter mock for the live-NAV invariant harness. Supports independent
///         toggles of return-validity, return-value, and a hard revert mode so
///         the fuzzer can drive the vault's `_lpFlowGate` / `totalAssets`
///         try/catch backstops through every state.
contract MaliciousAdapter {
    uint256 public mockValue;
    bool public mockValid;
    bool public shouldRevert;
    address public configuredVault;

    function setValue(uint256 v) external {
        mockValue = v;
    }

    function setValid(bool x) external {
        mockValid = x;
    }

    function setShouldRevert(bool x) external {
        shouldRevert = x;
    }

    function setConfiguredVault(address v) external {
        configuredVault = v;
    }

    function positionValue() external view returns (uint256, bool) {
        if (shouldRevert) revert("malicious adapter revert");
        return (mockValue, mockValid);
    }

    // Stubs to satisfy IStrategy ABI surface — the vault never calls these via
    // the live-NAV path, but a complete IStrategy contract is what the bind-time
    // smoke-test expects.
    function name() external pure returns (string memory) {
        return "Malicious";
    }

    function initialize(address, address, bytes calldata) external pure {}

    function execute() external pure {}

    function settle() external pure {}

    function updateParams(bytes calldata) external pure {}

    function vault() external view returns (address) {
        return configuredVault;
    }

    function proposer() external pure returns (address) {
        return address(0);
    }

    function executed() external pure returns (bool) {
        return true;
    }

    function onLiveDeposit(uint256) external { /* no-op for fuzz */ }
}

/// @notice Drives random adapter / lock / LP-flow sequences for the live-NAV
///         invariants (INV-LN1/LN2). Bound to `LiveNAVInvariantsTest` via
///         `targetContract`.
contract LiveNAVHandler is Test {
    SyndicateVault public vault;
    VaultWithdrawalQueue public queue;
    IERC20 public asset;
    address public mockGovernor;
    MaliciousAdapter public adapter;

    address[] public actors;
    uint256 public depositCalls;
    uint256 public requestCalls;
    uint256 public redeemCalls;
    uint256 public lockToggleCalls;
    uint256 public adapterToggleCalls;

    constructor(SyndicateVault v, VaultWithdrawalQueue q, IERC20 a, address mg) {
        vault = v;
        queue = q;
        asset = a;
        mockGovernor = mg;
        adapter = new MaliciousAdapter();

        // Bind-time smoke-test: `setActiveStrategyAdapter` staticcalls
        // `positionValue()` and requires non-reverting return data >= 64 bytes.
        // Configure adapter to return a valid (uint256, bool) before binding.
        adapter.setValid(true);
        adapter.setValue(0);
        adapter.setShouldRevert(false);

        // Bind via mocked governor authority — vault checks msg.sender == _getGovernor().
        vm.prank(mockGovernor);
        vault.setActiveStrategyAdapter(address(adapter));

        actors.push(makeAddr("actor0LN"));
        actors.push(makeAddr("actor1LN"));
        actors.push(makeAddr("actor2LN"));
        actors.push(makeAddr("actor3LN"));
        for (uint256 i; i < actors.length; i++) {
            deal(address(asset), actors[i], 1_000_000e6);
            vm.prank(actors[i]);
            asset.approve(address(vault), type(uint256).max);
        }
    }

    // ------------ State togglers ------------

    function toggleLock(bool locked) external {
        lockToggleCalls++;
        vm.mockCall(
            mockGovernor,
            abi.encodeWithSignature("getActiveProposal(address)"),
            abi.encode(locked ? uint256(1) : uint256(0))
        );
        // MS-H4: deposits are also gated by `openProposalCount` — mirror lock state.
        vm.mockCall(
            mockGovernor,
            abi.encodeWithSignature("openProposalCount(address)"),
            abi.encode(locked ? uint256(1) : uint256(0))
        );
    }

    function toggleAdapterValid(bool v) external {
        adapterToggleCalls++;
        adapter.setValid(v);
    }

    function toggleAdapterRevert(bool x) external {
        adapterToggleCalls++;
        adapter.setShouldRevert(x);
    }

    // ------------ LP flow drivers ------------

    function deposit(uint256 actorSeed, uint256 amount) external {
        depositCalls++;
        if (vault.paused()) return;
        // `_lpFlowGate` may block when locked — let the vault decide and catch.
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 100_000e6);
        if (asset.balanceOf(a) < amount) return;
        vm.prank(a);
        try vault.deposit(amount, a) {} catch {}
    }

    function requestRedeem(uint256 actorSeed, uint256 sharesSeed) external {
        requestCalls++;
        if (!vault.redemptionsLocked()) return; // queue path only valid while locked
        address a = actors[actorSeed % actors.length];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        uint256 s = bound(sharesSeed, 1, bal);
        vm.prank(a);
        try vault.requestRedeem(s, a) {} catch {}
    }

    function redeem(uint256 actorSeed, uint256 sharesSeed) external {
        redeemCalls++;
        address a = actors[actorSeed % actors.length];
        uint256 max = vault.maxRedeem(a);
        if (max == 0) return;
        uint256 s = bound(sharesSeed, 1, max);
        vm.prank(a);
        try vault.redeem(s, a, a) {} catch {}
    }
}
