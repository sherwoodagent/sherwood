// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {VaultWithdrawalQueue} from "../../src/queue/VaultWithdrawalQueue.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

import {LiveNAVHandler} from "./handlers/LiveNAVHandler.sol";

/// @title LiveNAVInvariantsTest
/// @notice INV-LN1/LN2 — vault `totalAssets` must remain non-reverting and
///         >= float under any random adapter behavior + lock toggles + LP flow.
contract LiveNAVInvariantsTest is StdInvariant, Test {
    SyndicateVault vault;
    VaultWithdrawalQueue queue;
    ERC20Mock usdc;
    BatchExecutorLib executorLib;
    MockAgentRegistry agentRegistry;
    LiveNAVHandler handler;

    address constant MOCK_GOVERNOR = address(0xF00D);
    address ownerLN = makeAddr("ownerLN");

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();

        SyndicateVault impl = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "LN Vault",
                    symbol: "lnUSDC",
                    owner: ownerLN,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    managementFeeBps: 0
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(impl), initData))));

        // The test contract is the factory — `setWithdrawalQueue` is factory-only.
        queue = new VaultWithdrawalQueue(address(vault));
        vault.setWithdrawalQueue(address(queue));

        // Mock the governor wiring — start unlocked.
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(0)));

        handler = new LiveNAVHandler(vault, queue, IERC20(address(usdc)), MOCK_GOVERNOR);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = LiveNAVHandler.deposit.selector;
        selectors[1] = LiveNAVHandler.requestRedeem.selector;
        selectors[2] = LiveNAVHandler.redeem.selector;
        selectors[3] = LiveNAVHandler.toggleLock.selector;
        selectors[4] = LiveNAVHandler.toggleAdapterValid.selector;
        selectors[5] = LiveNAVHandler.toggleAdapterRevert.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice INV-LN1: `totalAssets >= float` at all times — adapter contributes
    ///         non-negative NAV when valid, falls back to float-only otherwise.
    function invariant_totalAssetsGeFloat() public view {
        uint256 float = IERC20(vault.asset()).balanceOf(address(vault));
        assertGe(vault.totalAssets(), float, "INV-LN1: totalAssets < float");
    }

    /// @notice INV-LN2: `totalAssets()` must NOT revert under any adapter state.
    ///         A reverting `positionValue()` is caught by the vault's defensive
    ///         try/catch and falls back to float-only.
    function invariant_totalAssetsDoesNotRevert() public view {
        // If totalAssets reverts, this view-call propagates and the fuzzer marks failure.
        vault.totalAssets();
    }

    function afterInvariant() external view {
        assertGt(handler.depositCalls(), 0, "fuzz vacuous: no deposit attempts");
    }
}
