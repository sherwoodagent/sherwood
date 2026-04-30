// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../../src/SyndicateGovernor.sol";
import {SyndicateVault} from "../../../src/SyndicateVault.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";

import {ERC20Mock} from "../../mocks/ERC20Mock.sol";

/// @title VaultSolvencyHandler
/// @notice Bounded fuzz-action driver for INV-15 (vault solvency).
///
///         Invariant under test (asserted by `VaultSolvencyInvariantTest`):
///         `vault.convertToAssets(vault.totalSupply()) <= vault.totalAssets()`
///
///         Property holds across any sequence of:
///         - deposits at random sizes by 3 LP actors
///         - redeem requests at random fractions of share balance
///         - full proposal lifecycles with random PnL (profit OR loss).
///
///         Why this matters: the vault is ERC-4626 with `_decimalsOffset() =
///         asset.decimals()` for first-depositor inflation protection, plus
///         per-proposal fee waterfall + capital snapshots. Any rounding
///         drift that lets share-implied assets exceed actual assets means
///         late redeemers can drain late depositors. The first-depositor
///         attack class is the canonical example; this fuzzer exercises a
///         broader space.
///
///         Handler exposes 4 random-action functions:
///         - `depositRandom(seed)` — pick 1 of 3 LPs, deposit a bounded amount.
///         - `redeemRandom(seed)` — pick 1 of 3 LPs, redeem a bounded fraction.
///         - `runProfitableLifecycle(seed)` — full propose → vote → execute →
///           settle with positive minted PnL.
///         - `runLossyLifecycle(seed)` — full lifecycle with NEGATIVE PnL
///           (vault loses asset balance during execution; settle records
///           realized loss).
contract VaultSolvencyHandler is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    ERC20Mock public usdc;

    address public leadAgent;
    address public coAgent;
    address public vaultOwner;
    address public protocolRecipient;

    address public lp1;
    address public lp2;
    address public lp3;

    uint256 public maxPerformanceFeeBps;
    uint256 public votingPeriod;

    // Action counters (visible for `afterInvariant` vacuity guards).
    uint256 public depositCount;
    uint256 public redeemCount;
    uint256 public profitableLifecycleCount;
    uint256 public lossyLifecycleCount;

    constructor(
        SyndicateGovernor _governor,
        SyndicateVault _vault,
        ERC20Mock _usdc,
        address _leadAgent,
        address _coAgent,
        address _vaultOwner,
        address _protocolRecipient,
        address _lp1,
        address _lp2,
        address _lp3,
        uint256 _maxPerformanceFeeBps,
        uint256 _votingPeriod
    ) {
        governor = _governor;
        vault = _vault;
        usdc = _usdc;
        leadAgent = _leadAgent;
        coAgent = _coAgent;
        vaultOwner = _vaultOwner;
        protocolRecipient = _protocolRecipient;
        lp1 = _lp1;
        lp2 = _lp2;
        lp3 = _lp3;
        maxPerformanceFeeBps = _maxPerformanceFeeBps;
        votingPeriod = _votingPeriod;
    }

    // ──────────────────────────────────────────────────────────────
    // Action 1 — deposit
    // ──────────────────────────────────────────────────────────────

    function depositRandom(uint256 seed) external {
        // Skip when any proposal is open: covers `redemptionsLocked()`
        // (active proposal at vote/execute) AND the broader `Pending`
        // window where deposits are still blocked. `openProposalCount` is
        // a strict superset of `getActiveProposal != 0`.
        if (governor.openProposalCount(address(vault)) != 0) return;

        address[3] memory lps = [lp1, lp2, lp3];
        address depositor = lps[seed % 3];

        uint256 amount = bound(uint256(keccak256(abi.encode(seed, "amt"))), 1e6, 50_000e6);

        usdc.mint(depositor, amount);
        vm.prank(depositor);
        usdc.approve(address(vault), amount);
        // No try/catch — vault is unpaused, openDeposits=true, and the
        // openProposalCount gate covers `redemptionsLocked()`. Any revert
        // here is a real regression and should surface in the fuzz output.
        vm.prank(depositor);
        vault.deposit(amount, depositor);
        depositCount += 1;
    }

    // ──────────────────────────────────────────────────────────────
    // Action 2 — redeem
    // ──────────────────────────────────────────────────────────────

    function redeemRandom(uint256 seed) external {
        // Same gate semantics as `depositRandom` — `openProposalCount`
        // is a strict superset of the vault's `redemptionsLocked()`.
        if (governor.openProposalCount(address(vault)) != 0) return;

        address[3] memory lps = [lp1, lp2, lp3];
        address redeemer = lps[seed % 3];

        uint256 shares = vault.balanceOf(redeemer);
        if (shares == 0) return;

        // Redeem a random fraction (1 / 2^k) of holdings, k in [0, 4].
        // Bias toward partials so we exercise the rounding regime, not
        // just full exits.
        uint256 divisor = 1 << bound(uint256(keccak256(abi.encode(seed, "div"))), 0, 4);
        uint256 toRedeem = shares / divisor;
        if (toRedeem == 0) toRedeem = 1;

        // No try/catch — gate above covers redemptionsLocked, redeemer
        // has shares > 0, and vault is unpaused. Any revert surfaces as
        // a real regression.
        vm.prank(redeemer);
        vault.redeem(toRedeem, redeemer, redeemer);
        redeemCount += 1;
    }

    // ──────────────────────────────────────────────────────────────
    // Action 3 — profitable lifecycle
    // ──────────────────────────────────────────────────────────────

    function runProfitableLifecycle(uint256 seed) external {
        uint256 profit = bound(uint256(keccak256(abi.encode(seed, "profit"))), 1_000e6, 50_000e6);
        if (_runLifecycle(seed, int256(profit))) {
            profitableLifecycleCount += 1;
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Action 4 — lossy lifecycle
    // ──────────────────────────────────────────────────────────────

    function runLossyLifecycle(uint256 seed) external {
        // Bound loss conservatively — capital snapshot is taken at execute
        // (before the burn), so we can only "lose" up to whatever was in
        // the vault at execute time. Use a small fixed cap and let the
        // helper clamp.
        uint256 loss = bound(uint256(keccak256(abi.encode(seed, "loss"))), 100e6, 5_000e6);
        if (_runLifecycle(seed, -int256(loss))) {
            lossyLifecycleCount += 1;
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Lifecycle helper — shared between profitable + lossy paths.
    //
    //   pnlSigned > 0: mint `pnlSigned` to vault between execute + settle
    //                  (looks like a profitable strategy outcome)
    //   pnlSigned < 0: burn `-pnlSigned` from vault (clamped to vault
    //                  balance) — looks like a realized strategy loss.
    //
    //   Returns false if the lifecycle was skipped (e.g. cooldown gate).
    // ──────────────────────────────────────────────────────────────

    function _runLifecycle(uint256 seed, int256 pnlSigned) private returns (bool) {
        // Cooldown / one-active-proposal gate.
        if (governor.openProposalCount(address(vault)) != 0) return false;

        uint256 nowTs = vm.getBlockTimestamp();
        uint256 readyAt = governor.getCooldownEnd(address(vault));
        if (nowTs < readyAt) {
            vm.warp(readyAt + 1);
        }

        // No depositors? skip — propose() needs a non-zero pastTotalSupply
        // for the vote to be meaningful, and there's nothing to be insolvent
        // ABOUT yet.
        if (vault.totalSupply() == 0) return false;

        uint256 perfFeeBps = bound(uint256(keccak256(abi.encode(seed, "pfb"))), 0, maxPerformanceFeeBps);
        uint256 strategyDuration = bound(uint256(keccak256(abi.encode(seed, "sd"))), 1 hours, 6 hours);

        BatchExecutorLib.Call[] memory calls = _noopCalls();

        // No try/catch on propose: openProposalCount + cooldown gates
        // above cover the only failure modes (`VaultHasOpenProposal`,
        // `CooldownNotElapsed`). Any other revert is a real regression.
        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://test",
            perfFeeBps,
            strategyDuration,
            calls,
            calls,
            new ISyndicateGovernor.CoProposer[](0)
        );

        vm.warp(vm.getBlockTimestamp() + 1);

        // LPs vote For. The `balanceOf > 0` guard ensures the voter has
        // checkpointed delegation weight at the snapshot timestamp; no
        // legitimate revert reason remains, so we let any revert surface.
        if (vault.balanceOf(lp1) > 0) {
            vm.prank(lp1);
            governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        }
        if (vault.balanceOf(lp2) > 0) {
            vm.prank(lp2);
            governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        }

        vm.warp(vm.getBlockTimestamp() + votingPeriod + 1);

        // No try/catch: warp past voteEnd + no veto/Against votes → state
        // is Approved. Any other state is a real regression.
        governor.executeProposal(proposalId);

        // Inject the configured PnL.
        if (pnlSigned > 0) {
            usdc.mint(address(vault), uint256(pnlSigned));
        } else if (pnlSigned < 0) {
            uint256 vaultBal = usdc.balanceOf(address(vault));
            uint256 toBurn = uint256(-pnlSigned);
            if (toBurn > vaultBal) toBurn = vaultBal;
            // Move tokens out to a sink address so the vault sees a
            // negative delta vs the capital snapshot taken at execute.
            address sink = address(0xDEAD);
            vm.prank(address(vault));
            usdc.transfer(sink, toBurn);
        }

        // Settle as proposer (anytime). MUST NOT revert — a settle revert
        // is exactly the bug class INV-15 hunts (fee-distribution math
        // exploding on a realized loss, share-accounting drift, etc.).
        // Reraise with the underlying selector so the fuzzer surfaces a
        // concrete counterexample (mirrors `FeeBlacklistHandler::runProposalLifecycle`).
        vm.prank(leadAgent);
        try governor.settleProposal(proposalId) {}
        catch (bytes memory err) {
            revert(string.concat("INV-15 violation: settleProposal reverted: ", _bytesToHex(err)));
        }

        return true;
    }

    // ──────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────

    function _noopCalls() private view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(this), uint256(0))
        });
    }

    /// @dev Hex-encode a bytes blob for inclusion in a revert string. Used
    ///      so a `settleProposal` revert reraised by the lifecycle helper
    ///      surfaces the underlying selector + payload to the fuzzer.
    function _bytesToHex(bytes memory data) internal pure returns (string memory) {
        bytes memory hexAlphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            out[2 + i * 2] = hexAlphabet[uint8(data[i]) >> 4];
            out[3 + i * 2] = hexAlphabet[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }
}
