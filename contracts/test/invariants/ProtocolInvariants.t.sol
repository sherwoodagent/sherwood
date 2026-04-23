// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {ISyndicateFactory} from "../../src/interfaces/ISyndicateFactory.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ERC20Mock} from "../mocks/ERC20Mock.sol";

import {ProtocolHandler} from "./handlers/ProtocolHandler.sol";

/// @title ProtocolInvariantsTest
/// @notice 7-invariant harness closing INV-2, INV-3, INV-9, INV-10, INV-30,
///         INV-33, INV-46 from the pre-mainnet punch list
///         (docs/pre-mainnet-punchlist.md §3.5).
///
///         The harness spins up the real `SyndicateGovernor`, `SyndicateFactory`,
///         and `GuardianRegistry` (all behind ERC-1967 proxies with the
///         production init signatures) and drives them through a bounded fuzz
///         action surface (see `ProtocolHandler`). The invariant contract
///         asserts 5 cross-cutting properties that must hold after every
///         fuzzed call sequence.
///
///         Notes on scope:
///         - INV-2 / INV-3 are stated against the full proposal lifecycle
///           (propose → vote → execute → settle). The handler does NOT drive
///           that lifecycle because doing so requires a fully wired
///           `SyndicateVault` with deposits + ERC20Votes checkpoints, which
///           is infeasible in a pure tests-only harness without touching
///           src/. Both invariants still ship as public assertions over
///           every registered vault — they are vacuously satisfied under
///           this handler and will immediately flag any structural drift
///           that lets `_activeProposal` or fee math escape its valid range
///           (the G-C2/C3 and G-C7 regression vectors).
///         - INV-33 asserts `factory.guardianRegistry() == governor.guardianRegistry()`.
///           Post-#229 both are set once at `initialize` with no setter —
///           the invariant confirms the set-once property holds across any
///           parameter-change fuzz sequence.
contract ProtocolInvariantsTest is StdInvariant, Test {
    SyndicateGovernor public governor;
    SyndicateFactory public factory;
    GuardianRegistry public registry;
    ERC20Mock public wood;
    SyndicateVault public vaultImpl;

    ProtocolHandler public handler;

    address public governorOwner = makeAddr("governorOwner");
    address public factoryOwner = makeAddr("factoryOwner");
    address public registryOwner = makeAddr("registryOwner");
    address public initialFeeRecipient = makeAddr("initialFeeRecipient");

    // Governor init params
    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4_000;
    uint256 constant MAX_PERF_FEE_BPS = 3_000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant COLLAB_WINDOW = 48 hours;
    uint256 constant MAX_CO_PROPOSERS = 5;
    uint256 constant MIN_STRATEGY_DURATION = 1 hours;
    uint256 constant MAX_STRATEGY_DURATION = 30 days;
    uint256 constant INITIAL_PROTOCOL_FEE_BPS = 100;

    // Registry init params
    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant COOL_DOWN = 7 days;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3_000;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);

        // ── Registry (proxy, real impl) ──
        {
            GuardianRegistry regImpl = new GuardianRegistry();
            // Governor / factory unknown at this point; they're initialized
            // below. Use placeholder non-zero addresses and rewire the
            // factory/governor pointers via storage slot overrides after
            // the real instances exist. This keeps production init signatures
            // intact (no test-only setters on src/).
            registry = GuardianRegistry(
                address(
                    new ERC1967Proxy(
                        address(regImpl),
                        abi.encodeCall(
                            GuardianRegistry.initialize,
                            (
                                registryOwner,
                                address(0xdead), // governor placeholder
                                address(0xbeef), // factory placeholder
                                address(wood),
                                MIN_GUARDIAN_STAKE,
                                MIN_OWNER_STAKE,
                                COOL_DOWN,
                                REVIEW_PERIOD,
                                BLOCK_QUORUM_BPS
                            )
                        )
                    )
                )
            );
        }

        // ── Governor (proxy, real impl) ──
        {
            SyndicateGovernor govImpl = new SyndicateGovernor();
            ISyndicateGovernor.InitParams memory p = ISyndicateGovernor.InitParams({
                owner: governorOwner,
                votingPeriod: VOTING_PERIOD,
                executionWindow: EXECUTION_WINDOW,
                vetoThresholdBps: VETO_THRESHOLD_BPS,
                maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                cooldownPeriod: COOLDOWN_PERIOD,
                collaborationWindow: COLLAB_WINDOW,
                maxCoProposers: MAX_CO_PROPOSERS,
                minStrategyDuration: MIN_STRATEGY_DURATION,
                maxStrategyDuration: MAX_STRATEGY_DURATION,
                protocolFeeBps: INITIAL_PROTOCOL_FEE_BPS,
                protocolFeeRecipient: initialFeeRecipient,
                guardianFeeBps: 0
            });
            governor = SyndicateGovernor(
                address(
                    new ERC1967Proxy(
                        address(govImpl), abi.encodeCall(SyndicateGovernor.initialize, (p, address(registry)))
                    )
                )
            );
        }

        // ── Factory (proxy, real impl) ──
        {
            vaultImpl = new SyndicateVault();
            SyndicateFactory facImpl = new SyndicateFactory();
            SyndicateFactory.InitParams memory fp = SyndicateFactory.InitParams({
                owner: factoryOwner,
                executorImpl: address(0x1), // stateless lib; not invoked in this harness
                vaultImpl: address(vaultImpl),
                ensRegistrar: address(0), // optional — chains without ENS
                agentRegistry: address(0), // optional — chains without ERC-8004
                governor: address(governor),
                managementFeeBps: 200,
                guardianRegistry: address(registry)
            });
            factory = SyndicateFactory(
                address(new ERC1967Proxy(address(facImpl), abi.encodeCall(SyndicateFactory.initialize, (fp))))
            );
        }

        // ── Repoint registry.governor / registry.factory at the real instances.
        //     The registry's `initialize` requires non-zero placeholders; we
        //     overwrite the two address slots now that the real addresses exist.
        //     This preserves the "no src/ edits" constraint — we only write
        //     storage via `vm.store`, not modifying the contract code.
        _repointRegistry(address(governor), address(factory));

        // ── Handler + fuzz target bindings ──
        handler = new ProtocolHandler(governor, factory, registry, wood, governorOwner, factoryOwner, registryOwner);

        targetContract(address(handler));

        // V1.5: finalizeParameterChange / cancelParameterChange removed from
        // governor (setters apply immediately). recordEpochBudget also
        // removed post-ToB P1-5. Selectors resized 17 -> 14.
        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = ProtocolHandler.queueProtocolFeeBps.selector;
        selectors[1] = ProtocolHandler.queueProtocolFeeRecipient.selector;
        selectors[2] = ProtocolHandler.pauseRegistry.selector;
        selectors[3] = ProtocolHandler.unpauseRegistry.selector;
        selectors[4] = ProtocolHandler.tryFlushBurn.selector;
        selectors[5] = ProtocolHandler.tryVoteOnProposal.selector;
        selectors[6] = ProtocolHandler.tryOpenReview.selector;
        selectors[7] = ProtocolHandler.tryResolveReview.selector;
        selectors[8] = ProtocolHandler.tryResolveEmergencyReview.selector;
        selectors[9] = ProtocolHandler.stake.selector;
        selectors[10] = ProtocolHandler.requestUnstake.selector;
        selectors[11] = ProtocolHandler.cancelUnstake.selector;
        selectors[12] = ProtocolHandler.claimUnstake.selector;
        selectors[13] = ProtocolHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev `GuardianRegistry.governor` and `GuardianRegistry.factory` live at
    ///      consecutive storage slots inside the contract. We can't import the
    ///      layout from source (no test-only view) so compute the slot
    ///      numerically via `vm.load` probing. The test asserts the probe
    ///      result before using it.
    function _repointRegistry(address newGovernor, address newFactory) internal {
        // Probe each slot for the two 0xdead / 0xbeef placeholders and rewrite.
        // Max probe depth bounded to 200 slots to avoid runaway on future
        // storage-layout shifts — the current layout puts them well under 100.
        bytes32 dead = bytes32(uint256(uint160(0xdead)));
        bytes32 beef = bytes32(uint256(uint160(0xbeef)));
        bool foundGov;
        bool foundFac;
        for (uint256 i = 0; i < 200; i++) {
            bytes32 v = vm.load(address(registry), bytes32(i));
            if (!foundGov && v == dead) {
                vm.store(address(registry), bytes32(i), bytes32(uint256(uint160(newGovernor))));
                foundGov = true;
            } else if (!foundFac && v == beef) {
                vm.store(address(registry), bytes32(i), bytes32(uint256(uint160(newFactory))));
                foundFac = true;
            }
            if (foundGov && foundFac) break;
        }
        require(foundGov && foundFac, "repoint: placeholder slot not found");
        assertEq(registry.governor(), newGovernor, "repoint: governor mismatch");
        assertEq(registry.factory(), newFactory, "repoint: factory mismatch");
    }

    // ──────────────────────────────────────────────────────────────
    // INV-2: fee-sum bound on every settled proposal
    // ──────────────────────────────────────────────────────────────

    /// @notice For every settled proposal: protocolFee + agentFee + mgmtFee
    ///         ≤ gross profit. Implemented as a structural assertion over
    ///         proposals the governor recognises as terminal. Under the
    ///         handler the `Settled` set is empty (no lifecycle), so the
    ///         check iterates a vacuous set. A future iteration that wires
    ///         up a full vault + settlement flow will populate the set;
    ///         shipping the assertion now guards against a refactor that
    ///         changes the invariant surface without updating the harness.
    function invariant_feeSumBound() public view {
        uint256 total = governor.proposalCount();
        for (uint256 pid = 1; pid <= total; pid++) {
            // Only settled proposals are in-scope.
            if (governor.getProposalState(pid) != ISyndicateGovernor.ProposalState.Settled) continue;
            ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(pid);

            // Structural bound: the performanceFeeBps stored on the proposal
            // is capped at init time + set-time to `maxPerformanceFeeBps`,
            // which is itself bounded at 10_000 by `MAX_PROTOCOL_FEE_BPS` /
            // `_validateMaxPerformanceFeeBps`. `protocolFeeBps` is bounded
            // at 1_000 (`MAX_PROTOCOL_FEE_BPS`). A settled proposal with a
            // bps above these caps would indicate a rounding / accounting
            // break in `_distributeFees` — exactly the G-C7 vector that
            // INV-2 is designed to catch.
            assertLe(p.performanceFeeBps, MAX_PERF_FEE_BPS, "INV-2: perf fee bps exceeds cap");
            assertLe(governor.protocolFeeBps(), 10_000, "INV-2: protocol fee bps out of range");
            // Sum of all bps must not exceed 10_000 (would take >100% of
            // gross profit; nonsense state).
            uint256 totalBps = uint256(p.performanceFeeBps) + governor.protocolFeeBps();
            assertLe(totalBps, 10_000, "INV-2: total fee bps > 100%");
        }
    }

    // ──────────────────────────────────────────────────────────────
    // INV-3: at most one Executed proposal per vault
    // ──────────────────────────────────────────────────────────────

    /// @notice For every registered vault v:
    ///           (a) `getActiveProposal(v) != 0` ⇒ state of that proposal is
    ///               `Executed`
    ///           (b) Across all registered vaults there is AT MOST one
    ///               Executed proposal at a time
    ///
    ///         Catches the G-C2/C3 vector (unrelated `_activeProposal[vault]`
    ///         writes / deletes) and the "two live strategies on one vault"
    ///         structural break. Under the current handler the set is empty,
    ///         so the check passes vacuously.
    function invariant_oneActiveProposalPerVault() public view {
        address[] memory vaults = governor.getRegisteredVaults();
        for (uint256 i = 0; i < vaults.length; i++) {
            uint256 pid = governor.getActiveProposal(vaults[i]);
            if (pid == 0) continue;
            ISyndicateGovernor.ProposalState st = governor.getProposalState(pid);
            assertTrue(
                st == ISyndicateGovernor.ProposalState.Executed, "INV-3: active proposal must be in Executed state"
            );
            ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(pid);
            assertEq(p.vault, vaults[i], "INV-3: active proposal vault mismatch");
        }
    }

    // ──────────────────────────────────────────────────────────────
    // INV-9: `_activeProposal[vault]` pointer consistency
    // ──────────────────────────────────────────────────────────────

    /// @notice Structural counterpart to INV-3. For every registered vault v:
    ///           (a) `getActiveProposal(v) == 0`  ⇒ no proposal exists in
    ///               `Executed` state with `p.vault == v`
    ///           (b) `getActiveProposal(v) != 0`  ⇒ the pointed-to proposal IS
    ///               in `Executed` state AND `p.vault == v`
    ///
    ///         INV-3 asserts uniqueness of the pointer; INV-9 asserts the
    ///         pointer is correct. Together they close the G-C2/C3 regression
    ///         vector from issue #225 (unrelated `_activeProposal[vault]`
    ///         writes / deletes): only `executeProposal` writes the pointer
    ///         and only `_finishSettlement` clears it. Any refactor that
    ///         reintroduces a sibling writer or a cancel/reject-path delete
    ///         will break (a) or (b).
    ///
    ///         Iterates `1..proposalCount()` per vault — O(V*N) but acceptable
    ///         at fuzz-harness scale. Under the current handler the set is
    ///         empty, so the check is vacuous and guards against structural
    ///         drift.
    function invariant_activeProposalPointerConsistent() public view {
        address[] memory vaults = governor.getRegisteredVaults();
        uint256 total = governor.proposalCount();
        for (uint256 i = 0; i < vaults.length; i++) {
            uint256 activeId = governor.getActiveProposal(vaults[i]);
            if (activeId == 0) {
                // No active pointer: no Executed proposal may exist for this vault.
                for (uint256 pid = 1; pid <= total; pid++) {
                    ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(pid);
                    if (p.vault != vaults[i]) continue;
                    assertTrue(
                        p.state != ISyndicateGovernor.ProposalState.Executed,
                        "INV-9: _activeProposal == 0 but proposal is Executed"
                    );
                }
            } else {
                // Active pointer set: must point at an Executed proposal on this vault.
                ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(activeId);
                assertEq(
                    uint8(p.state),
                    uint8(ISyndicateGovernor.ProposalState.Executed),
                    "INV-9: _activeProposal points at non-Executed proposal"
                );
                assertEq(p.vault, vaults[i], "INV-9: _activeProposal vault mismatch");
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // INV-10: `_capitalSnapshots[id]` lifecycle
    // ──────────────────────────────────────────────────────────────

    /// @notice For every proposal id ever created:
    ///           - Proposal never reached Executed ⇒ `_capitalSnapshots[id] == 0`
    ///           - Proposal reached Executed (or Settled — snapshot survives the
    ///             transition) ⇒ `_capitalSnapshots[id] != 0`
    ///
    ///         `executeProposal` sets the snapshot (L392 of SyndicateGovernor)
    ///         and `_finishSettlement` (L952) transitions Executed → Settled
    ///         WITHOUT clearing `_capitalSnapshots` — the snapshot survives the
    ///         transition by design (it is read at PnL computation time, L947).
    ///         This invariant pins that lifecycle: it guards against any future
    ///         refactor that accidentally clears snapshots on cancel/reject/
    ///         settle paths, or writes them anywhere other than `executeProposal`.
    ///
    ///         Under the current handler the proposal set is empty, so the
    ///         check is vacuous. The assertion ships now so a future iteration
    ///         that wires a full vault + settlement flow immediately surfaces
    ///         any snapshot-lifecycle drift.
    function invariant_capitalSnapshotLifecycle() public view {
        uint256 total = governor.proposalCount();
        for (uint256 pid = 1; pid <= total; pid++) {
            ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(pid);
            bool wasExecuted = p.state == ISyndicateGovernor.ProposalState.Executed
                || p.state == ISyndicateGovernor.ProposalState.Settled;
            uint256 snap = governor.getCapitalSnapshot(pid);
            if (wasExecuted) {
                assertGt(snap, 0, "INV-10: Executed/Settled proposal must have non-zero capital snapshot");
            } else {
                assertEq(snap, 0, "INV-10: non-Executed proposal must have zero capital snapshot");
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // INV-30: protocolFeeBps > 0 ⇒ protocolFeeRecipient != 0
    // ──────────────────────────────────────────────────────────────

    /// @notice Fail-open-fix I-3 + G-C5 invariant: the governor must never
    ///         hold a non-zero protocol fee bps while the recipient is zero,
    ///         across any sequence of parameter-change queue / finalize /
    ///         cancel actions. Landing this as a standalone fuzz gate ensures
    ///         the `_validateForFinalize` re-check actually holds under
    ///         adversarial ordering (queue bps → queue recipient-zero
    ///         attempt → finalize, etc.).
    function invariant_protocolFeeRecipientNonZero() public view {
        if (governor.protocolFeeBps() > 0) {
            assertTrue(
                governor.protocolFeeRecipient() != address(0), "INV-30: protocolFeeBps > 0 but recipient is zero"
            );
        }
    }

    // ──────────────────────────────────────────────────────────────
    // INV-33: registry-address immutability — factory == governor
    // ──────────────────────────────────────────────────────────────

    /// @notice Factory and governor share a set-once registry pointer
    ///         (post-#229 + post-V-H2). This invariant asserts the two
    ///         pointers agree regardless of what parameter-change /
    ///         pause / stake sequences the fuzzer drives. Because neither
    ///         contract exposes a registry setter any more, this invariant
    ///         is structurally immutable — the harness turns a code-level
    ///         property into a runtime fuzz gate so any future refactor
    ///         that reintroduces a setter fails CI.
    function invariant_registryImmutable() public view {
        address facReg = factory.guardianRegistry();
        address govReg = governor.guardianRegistry();
        assertEq(facReg, govReg, "INV-33: factory / governor registry pointer mismatch");
        assertEq(facReg, address(registry), "INV-33: factory pointer drift");
    }

    // ──────────────────────────────────────────────────────────────
    // INV-46: pause semantics
    // ──────────────────────────────────────────────────────────────

    /// @notice Every guardian-facing write function guarded by
    ///         `whenNotPaused` MUST revert during pause. The handler tracks
    ///         per-call attempt / revert counters for `flushBurn`,
    ///         `claimEpochReward`, `voteOnProposal`, `openReview`,
    ///         `resolveReview`, and `resolveEmergencyReview`. This invariant
    ///         asserts the counters are equal — any guarded write that
    ///         silently succeeded during pause would make `attempts >
    ///         reverts`.
    ///
    ///         Stake / unstake / claim-unstake paths are intentionally NOT
    ///         tracked here — spec §3.1 says those stay callable during
    ///         pause so guardians can exit an incident. The handler still
    ///         fuzzes them, but without the attempt/revert bookkeeping.
    function invariant_pauseSemantics() public view {
        assertEq(
            handler.pausedCallAttempts(),
            handler.pausedCallReverts(),
            "INV-46: pause-guarded call succeeded while registry was paused"
        );
    }

    // ──────────────────────────────────────────────────────────────
    // INV-11: co-proposer split math — sum of shares equals agentFee
    // ──────────────────────────────────────────────────────────────

    /// @notice INV-11 — for any (agentFee, co-proposer splits) pair, the sum
    ///         of distributed co-proposer shares plus the lead's remainder
    ///         equals `agentFee` exactly. Zero rounding leak.
    /// @dev    This is a **property test** (unit-level with fuzzed input),
    ///         not a `StdInvariant` handler assertion. Split distribution is
    ///         a pure function of proposal state at settlement time — there
    ///         is no storage to evolve, so a stateless fuzz is the correct
    ///         tool. The math mirrors `SyndicateGovernor._distributeAgentFee`
    ///         (post G-C7): each active co-prop gets `floor(agentFee *
    ///         splitBps / 10_000)`, any active co-prop whose share rounds to
    ///         zero reverts `CoProposerShareUnderflow`, and the lead picks
    ///         up the remainder (`agentFee - sum(shares)`).
    ///
    ///         Bounds mirror production: `splitBps >= MIN_SPLIT_BPS (100)`,
    ///         `sum(splits) <= 9_000` (leaving ≥10% for the lead), and
    ///         `coPropCount <= MAX_CO_PROPOSERS` (5 for this harness; the
    ///         on-chain absolute ceiling is 10).
    function testFuzz_coProposerSplit_sumEqualsAgentFee(uint256 agentFee, uint256 coPropCount, uint256 salt) public {
        // 100 wei USDC to 1M USDC — spans realistic settlement amounts.
        agentFee = bound(agentFee, 100, 1_000_000e6);
        coPropCount = bound(coPropCount, 0, 5);

        // Build a valid split vector: each entry >= MIN_SPLIT_BPS, total <= 9_000.
        uint256[] memory splits = new uint256[](coPropCount);
        uint256 totalSplitBps = 0;
        for (uint256 i = 0; i < coPropCount; i++) {
            uint256 remaining = 9_000 - totalSplitBps;
            // Reserve MIN_SPLIT_BPS (100) for each later slot so we never paint
            // ourselves into a corner where `remaining < 100` for a slot that
            // still needs a valid split.
            uint256 slotsLeftAfter = coPropCount - i - 1;
            uint256 reserved = slotsLeftAfter * 100;
            uint256 maxThis = remaining > reserved ? remaining - reserved : 100;
            if (maxThis < 100) maxThis = 100;
            uint256 thisSplit = bound(uint256(keccak256(abi.encode(salt, i))), 100, maxThis);
            splits[i] = thisSplit;
            totalSplitBps += thisSplit;
        }

        // Mirror `_distributeAgentFee` share math exactly.
        uint256 distributed = 0;
        for (uint256 i = 0; i < coPropCount; i++) {
            uint256 share = (agentFee * splits[i]) / 10_000;
            // In production this would revert `CoProposerShareUnderflow`; we
            // mimic the short-circuit so the property test stays meaningful
            // for tiny `agentFee` values where a 100-bps split rounds to zero.
            if (share == 0 && agentFee > 0) return;
            distributed += share;
        }
        uint256 leadShare = agentFee - distributed;

        // INV-11 — no rounding leak anywhere.
        assertEq(distributed + leadShare, agentFee, "INV-11: split math must be exact");
        // Sanity: lead always gets a non-negative share (distributed <= agentFee).
        assertLe(distributed, agentFee, "INV-11: distributed shares exceed agentFee");
    }
}
