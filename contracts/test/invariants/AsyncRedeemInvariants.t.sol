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

import {AsyncRedeemHandler} from "./handlers/AsyncRedeemHandler.sol";

/// @title AsyncRedeemInvariantsTest
/// @notice INV-Q1..Q3 fuzz harness — the queue + vault must remain accounting-
///         consistent across any random sequence of deposit/requestRedeem/
///         claim/cancel/lock-toggle calls.
contract AsyncRedeemInvariantsTest is StdInvariant, Test {
    SyndicateVault vault;
    VaultWithdrawalQueue queue;
    ERC20Mock usdc;
    BatchExecutorLib executorLib;
    MockAgentRegistry agentRegistry;
    AsyncRedeemHandler handler;

    address constant MOCK_GOVERNOR = address(0xF00D);
    address owner = makeAddr("owner");

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

        // The test contract is the factory.
        queue = new VaultWithdrawalQueue(address(vault));
        vault.setWithdrawalQueue(address(queue));

        // governor mock — start unlocked
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(MOCK_GOVERNOR));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("getActiveProposal(address)"), abi.encode(uint256(0)));
        vm.mockCall(MOCK_GOVERNOR, abi.encodeWithSignature("openProposalCount(address)"), abi.encode(uint256(0)));

        handler = new AsyncRedeemHandler(vault, queue, IERC20(address(usdc)), MOCK_GOVERNOR);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = AsyncRedeemHandler.deposit.selector;
        selectors[1] = AsyncRedeemHandler.requestRedeem.selector;
        selectors[2] = AsyncRedeemHandler.claimRandom.selector;
        selectors[3] = AsyncRedeemHandler.cancelRandom.selector;
        selectors[4] = AsyncRedeemHandler.setLocked.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice INV-Q1 — queue's _pendingShares must equal the handler's tracked sum
    function invariant_pendingSharesMatchesHandlerLedger() public view {
        assertEq(queue.pendingShares(), handler.expectedPending(), "INV-Q1: pending shares mismatch");
    }

    /// @notice INV-Q2 — when not locked, reservedQueueAssets cannot exceed float
    function invariant_reservedAssetsLeFloatWhenUnlocked() public view {
        if (!vault.redemptionsLocked()) {
            uint256 reserve = vault.reservedQueueAssets();
            uint256 float = IERC20(vault.asset()).balanceOf(address(vault));
            assertLe(reserve, float, "INV-Q2: reserve exceeds float when unlocked");
        }
    }

    /// @notice INV-Q3 — totalSupply must equal the sum of all known holders' balances
    function invariant_totalSupplyConserved() public view {
        uint256 sum = vault.balanceOf(address(queue));
        uint256 n = handler.actorsLength();
        for (uint256 i; i < n; i++) {
            sum += vault.balanceOf(handler.actorAt(i));
        }
        assertEq(vault.totalSupply(), sum, "INV-Q3: totalSupply diverged from holder ledger");
    }

    /// @notice INV-Q4 (Q-H1) — queue's vault-share balance must be >= its claimed `pendingShares`.
    ///         If this ever inverts, non-queue users could withdraw float that the queue's
    ///         reserve says is reserved, draining LP claims.
    function invariant_queueShareBalanceCoversPendingShares() public view {
        assertGe(
            vault.balanceOf(address(queue)), queue.pendingShares(), "INV-Q4: queue share balance below pendingShares"
        );
    }

    /// @notice afterInvariant — sanity gate ensuring the fuzzer actually drove some flow
    function afterInvariant() external view {
        assertGt(handler.depositCalls() + handler.requestCalls(), 0, "fuzz vacuous: no deposits or requests");
    }
}
