// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../../src/SyndicateGovernor.sol";
import {SyndicateVault} from "../../../src/SyndicateVault.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";

import {BlacklistingERC20Mock} from "../../mocks/BlacklistingERC20Mock.sol";

/// @title FeeBlacklistHandler
/// @notice Bounded fuzz-action driver for INV-47 (W-1 fee-blacklist resilience).
///
///         Invariant under test (asserted by `FeeBlacklistInvariantTest`):
///         `accrued = claimed + escrowed` for every reachable state.
///
///         The handler exposes 3 random-action functions the fuzzer calls in
///         random order:
///         - `blacklistRandomRecipient(seed)` — toggle blacklist on lead /
///           co-prop / vault owner / protocol-fee recipient.
///         - `runProposalLifecycle(seed)` — propose → vote → execute → settle
///           with a positive minted PnL. MUST NOT revert just because some
///           recipient was blacklisted; the W-1 try/catch in
///           `SyndicateGovernor._distributeFees` escrows on failure.
///         - `claimUnclaimedFees(seed)` — un-blacklist a recipient and pull
///           their escrow via `governor.claimUnclaimedFees`.
///
///         Ghost variables:
///         - `totalFeesAccrued` — sum of `totalFee` extracted from every
///           settled proposal (computed deterministically from the minted
///           PnL using the same waterfall the contract uses, so the
///           invariant assertion is independent of the contract's own
///           accounting).
///         - `totalFeesClaimed` — sum of USDC balance increases on the four
///           tracked recipients (independent measurement — does not read
///           any governor counter).
///         - `totalFeesEscrowed` — read at view-time from the governor's
///           `unclaimedFees` mapping across the four tracked recipients.
///
///         If `_distributeFees` ever bricks settlement on a blacklist (the
///         W-1 regression vector), `runProposalLifecycle` will revert and
///         the harness will surface a concrete counterexample trace.
contract FeeBlacklistHandler is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BlacklistingERC20Mock public usdc;

    // Fee-waterfall recipients tracked for ghost-variable accounting.
    // Order matters: `recipients[0..3]` must equal the four entries the
    // governor's `_distributeFees` may touch on the configured proposal
    // shape (1 lead, 1 co-prop, 1 vault owner, 1 protocol-fee recipient).
    address public leadAgent;
    address public coAgent;
    address public vaultOwner;
    address public protocolRecipient;

    // LP actors — voting power source. Kept disjoint from `recipients`
    // so balance-based claimed accounting isn't polluted by LP movements.
    address public lp1;
    address public lp2;

    // Governor parameters mirrored from setUp. Used to compute expected
    // accrued fee per settle so we have an INDEPENDENT measure (not
    // sourced from governor state itself).
    uint256 public protocolFeeBps;
    uint256 public managementFeeBps;
    uint256 public maxPerformanceFeeBps;

    // Proposal-lifecycle config
    uint256 public votingPeriod;
    uint256 public cooldownPeriod;

    // Ghost variables — exposed as state so the invariant contract reads
    // them via auto-generated getters.
    uint256 public totalFeesAccrued;
    uint256 public totalFeesClaimed;

    // Baselines for claimed accounting (USDC balance at constructor time).
    mapping(address => uint256) private _claimedBaseline;

    // Action counters (debug aids).
    uint256 public lifecycleAttempts;
    uint256 public lifecycleSuccesses;
    uint256 public blacklistToggles;
    uint256 public claimAttempts;
    uint256 public claimSuccesses;

    // Per-recipient blacklist toggle tracker — only used to decide
    // un-blacklist before claim. Mirrors `usdc.blacklisted(addr)` for
    // the four tracked recipients without re-reading the mock.
    mapping(address => bool) private _isBlacklisted;

    constructor(
        SyndicateGovernor _governor,
        SyndicateVault _vault,
        BlacklistingERC20Mock _usdc,
        address _leadAgent,
        address _coAgent,
        address _vaultOwner,
        address _protocolRecipient,
        address _lp1,
        address _lp2,
        uint256 _protocolFeeBps,
        uint256 _managementFeeBps,
        uint256 _maxPerformanceFeeBps,
        uint256 _votingPeriod,
        uint256 _cooldownPeriod
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
        protocolFeeBps = _protocolFeeBps;
        managementFeeBps = _managementFeeBps;
        maxPerformanceFeeBps = _maxPerformanceFeeBps;
        votingPeriod = _votingPeriod;
        cooldownPeriod = _cooldownPeriod;

        // Capture baselines so `totalFeesClaimed` only counts post-construction
        // recipient balance growth (the test contract pre-funds LPs and
        // they deposit into the vault; recipient balances should be 0 here
        // but we capture defensively for any future setUp tweak).
        _claimedBaseline[leadAgent] = usdc.balanceOf(leadAgent);
        _claimedBaseline[coAgent] = usdc.balanceOf(coAgent);
        _claimedBaseline[vaultOwner] = usdc.balanceOf(vaultOwner);
        _claimedBaseline[protocolRecipient] = usdc.balanceOf(protocolRecipient);
    }

    // ──────────────────────────────────────────────────────────────
    // Action 1 — toggle blacklist on a fee-waterfall recipient
    // ──────────────────────────────────────────────────────────────

    /// @dev Randomly select one of the four recipients and flip the mock's
    ///      blacklist bit. The fuzzer can stack toggles (multiple recipients
    ///      blacklisted simultaneously) — exactly the chaos we want.
    function blacklistRandomRecipient(uint256 seed) external {
        address[4] memory pool = [leadAgent, coAgent, vaultOwner, protocolRecipient];
        address target = pool[seed % 4];
        bool current = _isBlacklisted[target];
        _isBlacklisted[target] = !current;
        usdc.setBlacklisted(target, !current);
        blacklistToggles += 1;
    }

    // ──────────────────────────────────────────────────────────────
    // Action 2 — full proposal lifecycle (must NOT revert on blacklist)
    // ──────────────────────────────────────────────────────────────

    /// @dev Propose → vote → execute → settle a positive-PnL proposal.
    ///      The strategy duration is short and proposer settles immediately,
    ///      so cooldown is the only gate between successive lifecycles.
    ///      `seed` randomizes the perf-fee bps, profit size, and whether
    ///      the proposal carries a co-proposer.
    function runProposalLifecycle(uint256 seed) external {
        lifecycleAttempts += 1;

        // Cooldown gate — skip if the previous settle is too recent.
        if (governor.openProposalCount(address(vault)) != 0) return;
        // Read live block.timestamp at every site; via_ir reorders these
        // around vm.warp.
        uint256 nowTs = vm.getBlockTimestamp();
        uint256 readyAt = governor.getCooldownEnd(address(vault));
        if (nowTs < readyAt) {
            vm.warp(readyAt + 1);
        }

        // Fuzz-bound the perf fee, strategy duration, profit, and co-prop flag.
        uint256 perfFeeBps = bound(uint256(keccak256(abi.encode(seed, "pfb"))), 0, maxPerformanceFeeBps);
        uint256 strategyDuration = bound(uint256(keccak256(abi.encode(seed, "sd"))), 1 hours, 6 hours);
        uint256 profit = bound(uint256(keccak256(abi.encode(seed, "p"))), 1_000e6, 50_000e6);
        bool useCoProp = uint256(keccak256(abi.encode(seed, "co"))) % 2 == 0;

        ISyndicateGovernor.CoProposer[] memory coProps;
        if (useCoProp) {
            coProps = new ISyndicateGovernor.CoProposer[](1);
            coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent, splitBps: 3000});
        } else {
            coProps = new ISyndicateGovernor.CoProposer[](0);
        }

        // Propose. Use a stable noop call shape (USDC.approve(this, 0)) —
        // the governor doesn't care about the call's effect, only that the
        // batch exists.
        BatchExecutorLib.Call[] memory calls = _noopCalls();

        vm.prank(leadAgent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://test", perfFeeBps, strategyDuration, calls, calls, coProps);

        // Move past the snapshot block so checkpoints are readable.
        vm.warp(vm.getBlockTimestamp() + 1);

        // If collaborative, co-proposer must approve before voting opens.
        if (useCoProp) {
            vm.prank(coAgent);
            governor.approveCollaboration(proposalId);
        }

        // LPs vote For (deposit + delegate happens in test setUp).
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Warp past voting period to reach Approved.
        vm.warp(vm.getBlockTimestamp() + votingPeriod + 1);

        // Execute (anyone can call after the cooldown gate).
        governor.executeProposal(proposalId);

        // Inject profit. The capital snapshot was taken at execute; this
        // mint shows up as positive PnL at settle.
        usdc.mint(address(vault), profit);

        // Snapshot recipient balances + escrow before settle for delta math.
        uint256[4] memory balsBefore = _recipientBalances();
        uint256[4] memory escrowBefore = _recipientEscrow();

        // MS-H3: proposer self-settle requires MIN_STRATEGY_DURATION_BEFORE_SELF_SETTLE.
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);

        // Settle as proposer. MUST NOT revert on blacklist —
        // any revert here is a real INV-47 violation. Capture revert and
        // surface via assert so the harness produces a counterexample.
        vm.prank(leadAgent);
        try governor.settleProposal(proposalId) {
            // Compute the expected fee waterfall using the contract's own
            // formula. This is the INDEPENDENT accrued measure.
            //
            // protocolFee = profit * protocolFeeBps / 10_000
            // netProfit   = profit - protocolFee  (guardianFee = 0 in setUp)
            // agentFee    = netProfit * perfFeeBps / 10_000
            // mgmtFee     = (netProfit - agentFee) * mgmtFeeBps / 10_000
            // totalFee    = protocolFee + agentFee + mgmtFee
            uint256 protocolFee = (profit * protocolFeeBps) / 10_000;
            uint256 netProfit = profit - protocolFee;
            uint256 agentFee = (netProfit * perfFeeBps) / 10_000;
            uint256 mgmtFee = ((netProfit - agentFee) * managementFeeBps) / 10_000;
            uint256 totalFee = protocolFee + agentFee + mgmtFee;

            totalFeesAccrued += totalFee;

            // Direct claimed = sum of recipient balance deltas across the
            // four tracked addresses. Escrowed amounts stayed in the vault
            // (or are tracked via the governor's `_unclaimedFees`); they
            // are NOT counted here.
            uint256[4] memory balsAfter = _recipientBalances();
            uint256[4] memory escrowAfter = _recipientEscrow();
            uint256 directClaimed;
            for (uint256 i = 0; i < 4; i++) {
                directClaimed += balsAfter[i] - balsBefore[i];
                // Sanity: escrow can only grow during settle (never shrink).
                require(escrowAfter[i] >= escrowBefore[i], "settle decreased escrow");
            }
            totalFeesClaimed += directClaimed;
            lifecycleSuccesses += 1;
        } catch (bytes memory err) {
            // INV-47 violation: settle reverted because of a blacklist.
            // Surface the error so the fuzzer reports a real counterexample.
            // Use `revert` rather than `assert` so the failing test prints
            // the underlying selector for triage.
            revert(string.concat("INV-47 violation: settleProposal reverted: ", _bytesToHex(err)));
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Action 3 — un-blacklist + claim escrow
    // ──────────────────────────────────────────────────────────────

    /// @dev Pick a recipient, ensure they're un-blacklisted, then call
    ///      `governor.claimUnclaimedFees(vault, usdc)` from their address.
    ///      Updates `totalFeesClaimed` by the recipient's balance delta —
    ///      this is the same independent measure as `runProposalLifecycle`.
    function claimUnclaimedFees(uint256 seed) external {
        claimAttempts += 1;
        address[4] memory pool = [leadAgent, coAgent, vaultOwner, protocolRecipient];
        address target = pool[seed % 4];

        // Ensure recipient can receive — un-blacklist if needed.
        if (_isBlacklisted[target]) {
            _isBlacklisted[target] = false;
            usdc.setBlacklisted(target, false);
        }

        uint256 balBefore = usdc.balanceOf(target);
        vm.prank(target);
        try governor.claimUnclaimedFees(address(vault), address(usdc)) {
            uint256 delta = usdc.balanceOf(target) - balBefore;
            totalFeesClaimed += delta;
            claimSuccesses += 1;
        } catch {
            // Claim should never revert — `claimUnclaimedFees` returns early
            // on zero balance and otherwise transfers via SafeERC20. A
            // revert here would itself be a regression; we don't reraise
            // because the invariant assertion is the source of truth.
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Views consumed by the invariant contract
    // ──────────────────────────────────────────────────────────────

    /// @dev Sum of `_unclaimedFees[(vault, recipient, usdc)]` across the
    ///      four tracked recipients. Read at view-time so a successful
    ///      `claimUnclaimedFees` immediately decrements this.
    function totalFeesEscrowed() external view returns (uint256 sum) {
        sum += governor.unclaimedFees(address(vault), leadAgent, address(usdc));
        sum += governor.unclaimedFees(address(vault), coAgent, address(usdc));
        sum += governor.unclaimedFees(address(vault), vaultOwner, address(usdc));
        sum += governor.unclaimedFees(address(vault), protocolRecipient, address(usdc));
    }

    // ──────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────

    function _recipientBalances() internal view returns (uint256[4] memory bals) {
        bals[0] = usdc.balanceOf(leadAgent);
        bals[1] = usdc.balanceOf(coAgent);
        bals[2] = usdc.balanceOf(vaultOwner);
        bals[3] = usdc.balanceOf(protocolRecipient);
    }

    function _recipientEscrow() internal view returns (uint256[4] memory esc) {
        esc[0] = governor.unclaimedFees(address(vault), leadAgent, address(usdc));
        esc[1] = governor.unclaimedFees(address(vault), coAgent, address(usdc));
        esc[2] = governor.unclaimedFees(address(vault), vaultOwner, address(usdc));
        esc[3] = governor.unclaimedFees(address(vault), protocolRecipient, address(usdc));
    }

    function _noopCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(this), 0)), value: 0
        });
    }

    /// @dev Cheap hex encoder for revert-payload diagnostics.
    function _bytesToHex(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + 2 * data.length);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            out[2 + 2 * i] = alphabet[uint8(data[i] >> 4)];
            out[3 + 2 * i] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(out);
    }
}
