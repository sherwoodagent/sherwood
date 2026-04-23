# Pre-mainnet punch list

Cross-reference catalog of everything that must land (or be explicitly deferred) before the first mainnet deposit. Sources:

- **[Issue #225](https://github.com/imthatcarlos/sherwood/issues/225)** — 30 Critical + 60 High bug findings across 5 domains.
- **[Issue #226](https://github.com/imthatcarlos/sherwood/issues/226)** — process gaps, risky design decisions, missing tests, doc↔code mismatches.
- **[PR #229](https://github.com/imthatcarlos/sherwood/pull/229)** — Guardian Review Lifecycle design spec (addresses a named subset).

Every row is tagged with status so reviewers can see at a glance what this branch closes vs. what's still outstanding.

Status key:
- ✅ **fixed-in-229** — shipped on `feat/guardian-review-lifecycle` (PR #229).
- 🟡 **partial-in-229** — partially addressed; remaining work needs a separate PR.
- 🔨 **separate-PR** — needs its own fix PR; PR #229 does not touch it.
- 📝 **doc-drift** — code is right, docs are wrong. Fix by updating the doc.
- 🧪 **test-only** — code is right, PoC / regression test missing.
- 🗓️ **deferred** — intentionally out of V1; tracked for V1.5 / audit.

---

## 1. Top 10 mainnet blockers (from #225 §1)

| # | Finding | Status | Notes |
|---|---|---|---|
| 1 | **V-C1** — Settlement PnL via `balanceOf` diff is inflatable by donation. Fees paid on donations. | 🔨 separate-PR | Fix: `IStrategy.settle() returns (int256 realized)`, or snapshot immediate pre/post around settlement batch. Independent of guardian design. |
| 2 | **V-C3** — Owner `executeBatch` bypasses `redemptionsLocked()`. Compromised owner drains mid-strategy. | ✅ closed | Removed `executeBatch` entirely. Strategy execution flows through `executeGovernorBatch`; stranded assets leave via `rescueERC20` / `rescueERC721` / `rescueEth`. |
| 3 | **G-C4** — `emergencySettle` fallback accepts arbitrary owner calls → vault drain. | ✅ fixed-in-229 | Split into `unstick` (no calldata) + `emergencySettleWithCalls` (guardian-reviewed) + `finalizeEmergencySettle` + `cancelEmergencySettle`. Owner posts slashable bond; guardian block-quorum slashes owner. See `5ba7939` (GovernorEmergency impl) + `f2e8224` (registry emergency review). |
| 4 | **G-C2/C3** — `cancelProposal` / `vetoProposal` / `emergencyCancel` blindly `delete _activeProposal[vault]`. | ✅ closed | Narrowed cancel paths to Draft/Pending only (commits `ef5cf55` + `770a929`); unrelated `delete` removed. Only `executeProposal` writes to `_activeProposal`; only `_finishSettlement` clears it. Regression tests in `test/governor/ActiveProposalPreservation.t.sol`. |
| 5 | **G-C1** — `snapshotTimestamp = block.timestamp` enables same-block flash-delegate on 2s L2 blocks. | ✅ closed | Fixed: `snapshotTimestamp = block.timestamp - 1` in both `propose()` and `approveCollaboration()` Draft→Pending transition. See `9608cd7`. |
| 6 | **T-C3/T-C4/T-C5** — veNFT transferable while vote/bribe state is attached. | 🔨 separate-PR | Fix: block transfers while `_lastVotedEpoch == currentEpoch`, OR snapshot owner into vote/bribe state. |
| 7 | **T-C1** — LP rewards permanently stuck (`_calculateLPReward` reverts unconditionally). | 🗓️ deferred | Documented in `CLAUDE.md` as aspirational. Either ship LP rewards or strip the entry point. |
| 8 | **S-C4 + A2** — `PortfolioStrategy` passes `amountOutMin=0` + `SynthraDirectAdapter` ignores its `amountOutMin`. | 🔨 separate-PR | Fix: wire `maxSlippageBps` into `amountOutMin`; require `amountOutMin > 0` at adapter entry. |
| 9 | **S-C2** — `SynthraDirectAdapter.synthraV3SwapCallback` is unauthenticated. Any caller drains in-flight swap. | 🔨 separate-PR | Fix: `require(msg.sender == pool)` with pool computed from (factory, token0, token1, fee). |
| 10 | **S-C1** — Strategy clone `initialize` is a separate tx; public init is front-runnable. | 🔨 separate-PR | Fix: `_disableInitializers()` in template constructors; factory wrapper that clones + inits atomically. |

---

## 2. What PR #229 closes

PR #229 directly addresses a specific subset. All other items remain open.

### Closed by #229 implementation

| Ref | Original finding | How #229 addresses it | Commit(s) |
|---|---|---|---|
| #225 G-C4 | `emergencySettle` arbitrary-fallback drain path | Split into `unstick` / `emergencySettleWithCalls` / `finalizeEmergencySettle` / `cancelEmergencySettle`. `emergencySettleWithCalls` commits hash + opens guardian review; owner stake slashed on guardian block. | `5ba7939`, `f2e8224` |
| #226 §2.6 | "Three overlapping 'no' buttons" (optimistic / `vetoProposal` / `emergencyCancel` / `emergencySettle`) | `vetoProposal` narrowed to `Pending`; `emergencyCancel` narrowed to `Draft`/`Pending`; emergency settle replaced by guardian-gated four-function split. Single coherent escape surface. | `ef5cf55` |
| #226 §2.10 | `emergencySettle` fallback = owner-signed "execute arbitrary batch" | Arbitrary calldata now goes through 24h guardian review with slashable owner bond. Cold-start fallback preserves owner veto during bootstrap. | `5ba7939`, `f2e8224` |
| #226 §2.1 (partial) | Single-EOA owner controls every privileged surface | Owners now post slashable WOOD bond; `emergencySettleWithCalls` is guardian-gated; `rotateOwner` provides slot-transfer recovery against a burned-key owner. Does NOT eliminate owner power — §2.1 proper (multisig/timelock rotation) is still separate. | `cf796b7`, `a83fac4` |
| #226 §4 A12 | `SyndicateGovernor` at 24,523 / 24,576 bytes (53-byte margin) | Extracted `GovernorEmergency` abstract (Option B) + enabled `via_ir`. Governor now at 24,327 / 24,576 (73-byte margin). CI size gate enforces `≤ 24,400`. | `32c26b9`, `2d0ae99`, `607386e` |
| #226 §3.1 | `forge coverage` fails on `SyndicateGovernor.propose()` struct literal | Split struct literal into sequential field assignments. `forge coverage` now runs. | `78257c3` |

### Partially closed by #229

| Ref | Original finding | What #229 did | What's still open |
|---|---|---|---|
| #225 G-C6 | `nonReentrant` missing from `vote` / `vetoProposal` / `emergencyCancel` | All new registry state-mutating externals use `nonReentrant` (e.g. `stakeAsGuardian`, `resolveReview`, `claimEpochReward`). New governor emergency path is reentrancy-safe via CEI + registry's own guard. | Legacy governor `vote`, `vetoProposal`, `cancelProposal` are untouched by #229. Still need modifiers in a separate PR. |
| #226 §3.5 | Zero invariant tests, 48 listed, priority INV-2/-3/-11/-15/-23 | Shipped guardian-specific harness (3 invariants), then `ProtocolInvariants.t.sol` closing **INV-2** (fee-sum bound), **INV-3** (single-active-proposal), **INV-9** (active-proposal pointer consistency), **INV-10** (capital-snapshot lifecycle), **INV-30** (protocol-fee recipient non-zero when bps > 0), **INV-33** (registry-address immutability factory == governor), **INV-46** (pause semantics) in `bf0e4cd` + `e5192b4`; **INV-11** (co-proposer split math sum equals agentFee) added as a property test in `12deb4d`. **Caveat:** `ProtocolHandler` does not drive the full proposal lifecycle (propose → vote → execute → settle), so **INV-3 / INV-9 / INV-10 are structural scaffolding** — they assert against the real governor's public views but iterate empty sets under the current handler. They guard against future drift if the governor mutates `_activeProposal` or `_capitalSnapshots` outside the audited paths; fuzz-exercised coverage is a V2 harness task. | **INV-15** (veWOOD conservation) and **INV-23** (strategy asset conservation) are deferred to their respective branches — tokenomics and strategies are out-of-scope for this protocol-only branch per #236's boundary. Full-lifecycle proposal harness is tracked separately. |

### Not addressed by #229

Everything in §3 below is orthogonal to guardian review.

---

## 3. Critical bug findings still open (from #225)

Grouped by domain. All require separate PRs.

### 3.1 Vault / Factory / BatchExecutor (Domain 1)

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| V-C1 | Donation-inflated PnL | 92 | Strategy-reported realized return, OR snapshot pre/post settlement batch only |
| V-C2 | `_executorImpl` delegatecall without codehash check; no `nonReentrant` | 90 | Assert `_executorImpl.codehash == EXPECTED`; add `nonReentrant` on `executeGovernorBatch` (owner `executeBatch` was deleted in V-C3 fix) |
| V-C3 ✅ | Owner `executeBatch` bypasses `redemptionsLocked()` | 90 | Closed — `executeBatch` removed entirely (`f616ec4`) |
| V-C4 ✅ | Unbounded `getActiveSyndicates` loop | 90 | Closed — backed by `EnumerableSet _activeSyndicateIds`; `limit` hard-clamped to `MAX_PAGE_LIMIT = 100` (`ea4ae6d`) |
| V-H1 ✅ | Factory proxy `initialize` front-runnable | 85 | Confirmed atomic `ERC1967Proxy(impl, encodedInitCall)`; regression test added (`9121ae6`) |
| V-H2 ✅ | `setGovernor` orphans live proposals | 82 | Closed — `setGovernor` deleted; `governor` is set-once at factory init (`ee581a6`) |
| V-H3 ✅ | `upgradeVault` race on current `vaultImpl` | 78 | Closed — `upgradeVault(vault, expectedImpl)` with `VaultImplMismatch` revert (`9a43e1d`) |
| V-H5 ✅ | `rescueEth` missing `redemptionsLocked()` check | 75 | Closed — `rescueEth` now respects `redemptionsLocked()` (`df5e1e8`) |
| V-H6 ✅ | Open `receive()` — stranded ETH | 75 | Closed — `receive()` removed; vault rejects raw ETH (`2a3abe4`) |
| V-M1 ✅ | `_decimalsOffset()` re-calls `asset().decimals()` on hot path | MED | Closed — cached at init, slot appended with `__gap` reduced by 1 (`0347367`) |
| V-M2 ✅ | Inflation-attack coverage asserts-greater-than-0 only | MED | Closed — tighter regression pins share accounting + victim keeps ≥99% (`516cc17`) |
| V-M3 ✅ | Unbounded `getApprovedDepositors` / no paginated agent listing | MED | Closed — `agentsPaginated` / `approvedDepositorsPaginated` / `approvedDepositorCount` + `MAX_PAGE_LIMIT = 100` (`ccd589e`) |
| V-M4 ✅ | `isApprovedDepositor(receiver)` receiver-only check undocumented | LOW | Closed — NatSpec documents the KYC intent + override recipe (`ebe3036`) |
| V-M5 ✅ | `removeAgent` leaves stale `AgentConfig` struct data | MED | Closed — `delete _agents[agentAddress]` fully wipes slot (`78c5afb`) |
| V-M6 ✅ | Agent NFT ownership not re-checked post-registration | LOW | Closed — documented snapshot-at-registration semantics (`5660331`) |
| V-M7 ✅ | `createSyndicate` accepts zero/empty `SyndicateConfig` fields | MED | Closed — consolidated entrypoint check reverts `InvalidSyndicateConfig` for zero `asset`, empty `name` / `symbol` / `subdomain` / `metadataURI` (`03c9390`). Regression tests: `test/SyndicateFactory.t.sol` (5 cases). |
| V-M8 ✅ | No regression test on fee-sum ≤ pnl invariant | MED | Closed — fuzz + pinned worst-case pure-math tests (`f04e9f6`) |
| V-M9 ✅ | `executeGovernorBatch` emits no event — no vault-level execution marker | LOW | Closed — `GovernorBatchExecuted(governor, callCount)` event (`f606811`) |
| I-1 ✅ | `redemptionsLocked()` fails open on `gov == 0` | — | Closed — reverts `GovernorNotSet` (`d8bdf00`) |
| W-1 ✅ | USDC-blacklist bricks settlement via `_distributeFees` | — | Closed — try/catch + escrow + `claimUnclaimedFees(vault, token)` retry (`134e768`) |

### 3.2 Governor / GovernorParameters (Domain 2)

| Ref | Finding | Severity | Fix | Guardian-adjacent? |
|---|---|---|---|---|
| G-C1 ✅ | `snapshotTimestamp = block.timestamp` flash-delegate | 95 | `snapshotTimestamp = block.timestamp - 1` (closed in `9608cd7`) | no |
| G-C2/C3 ✅ | Unrelated `_activeProposal[vault]` delete | 92 / 91 | Narrowed cancel paths to Draft/Pending; blanket `delete` removed (closed in `ef5cf55` + `770a929`). Regression tests: `test/governor/ActiveProposalPreservation.t.sol`. | no |
| G-C5 ✅ | `setProtocolFeeRecipient` not timelocked | 90 | Routed through `GovernorParameters._applyChange` dispatcher with address-as-uint160 encoding; shares the same queue/finalize path as `protocolFeeBps` (bytecode reclaim in `daab171`; G-C5 fix follows on `feat/guardian-review-lifecycle`). Regression tests: `test/governor/ProtocolFeeRecipientTimelock.t.sol`. | no |
| G-C6 | `nonReentrant` missing from `vote` / `vetoProposal` / `emergencyCancel` | 90 | Add `nonReentrant` on every state-mutating external fn | no |
| G-C7 | Co-proposer fee rounding silently benefits lead | 88 | Revert if any active co-prop share rounds to 0, or distribute remainder proportionally | no |
| G-H1 | `_capitalSnapshots` only measures asset balance; non-asset positions count as lost | 85 | Post-settle `require(nonAssetTokens == 0)` or document full-unwind requirement | no |
| G-H2 ✅ | `cancelProposal` during Draft front-runs last co-proposer approve | 82 | Closed — `CancelNotAllowedNearQuorum` revert when `approvedCount + 1 >= total` (`fe2fd72`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-H3 ✅ | `getVoteWeight` returns 0 for Draft proposals (snapshotTimestamp unset) | 80 | Closed — reverts `ProposalInDraft` instead of silent zero (`09dabed`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-H4 ✅ | Veto threshold divides by 0 on empty `pastTotalSupply` | 78 | Closed — veto check skipped when `pastTotalSupply == 0`; proposal falls through to GuardianReview/Approved (`f4a9f26`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-H5 ✅ | `executeBy` boundary behavior unpinned — callers unsure whether `executeProposal` succeeds at exactly `executeBy`. | 65 | Closed — test-only. `executeBy` is inclusive: executing at `executeBy` succeeds, `executeBy + 1` resolves to `Expired` and reverts `ProposalNotApproved`. Regression tests: `test/governor/ExecuteByBoundary.t.sol`. | no |
| G-H6 ✅ | `vetoThresholdBps` read at state-resolution, not creation | 77 | Closed — snapshotted into `StrategyProposal.vetoThresholdBps` at Draft -> Pending (propose + approveCollaboration) (`ce07179`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-M1 ✅ | Duplicate proposals on a vault — `propose` / `approveCollaboration` did not check for another non-terminal proposal | 70 | Closed — gated on `openProposalCount[vault] == 0`; reverts `VaultHasOpenProposal` (`f86db71`). Regression tests: `test/governor/GovernorHardening.t.sol`. Preceded by bytecode reclaim (`1ade487`: merged `_validateForFinalize` into `_applyChange`, 321 bytes). | no |
| G-M2/M6 ✅ | `executeCalls` / `settlementCalls` unbounded — gas-grief vector on `executeGovernorBatch` | 65 | Closed — `MAX_CALLS_PER_PROPOSAL = 64`; `propose` reverts `TooManyCalls` when either array exceeds the cap (`c64a0a4`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-M4 ✅ | `setFactory` was owner-instant — pairs with timelocked rotations to defeat governance UX (same class as G-C5 on `setProtocolFeeRecipient`). | 60 | Closed — routed through `GovernorParameters._applyChange` dispatcher with address-as-uint160 encoding; shares the same queue/finalize lifecycle as `protocolFeeRecipient`. `_applyAddressParam(paramKey, newAddr)` virtual consolidates both address-keyed params to keep the governor under EIP-170. Preceded by bytecode reclaim (dropped queue-time validation; cross-param invariants re-checked at finalize). Regression tests: `test/governor/SetFactoryTimelock.t.sol`. | no |
| G-M5 ✅ | Queued parameter changes never expire — stale queues could re-fire months later | 60 | Closed — `MAX_PARAM_STALENESS = 30 days`; `finalizeParameterChange` reverts `ChangeStale` if more than that has elapsed since `effectiveAt` (`7294bc2`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-M7 ✅ | `emergencyCancel` could theoretically re-cancel terminal-state proposals (Rejected / Expired / Settled / Cancelled) | 60 | Closed — test-only. `emergencyCancel`'s narrowing guard (`s != Draft ⇒ revert`) already rejects all terminal states; regression tests pin the behavior for Rejected / Cancelled / Expired. Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-M9 ✅ | `addVault` accepts any address — operator typo could wire governance at an EOA | 55 | Closed — `extcodesize > 0` probe; reverts `NotASyndicateVault` for EOAs (`8dc3442`). Weaker than a full `ISyndicateVault` interface probe (budget-constrained — see commit msg), but catches the most common mistake. Regression tests: `test/governor/GovernorHardening.t.sol`. | no |
| G-M10 ✅ | `_distributeAgentFee` silently double-counts FOT burns (lead rounding remainder computed against requested amount, not received amount) | 55 | Closed — doc-only. NatSpec on `_distributeAgentFee` explicitly pins the non-FOT asset assumption. USDC (V1 asset) is non-FOT. | no |
| G-M11 ✅ | `metadataURI` unbounded — calldata / event-storage grief | 55 | Closed — `MAX_METADATA_URI_LENGTH = 512`; `propose` reverts `MetadataURITooLong` when exceeded (`da8119b`). Regression tests: `test/governor/GovernorHardening.t.sol`. | no |

### 3.3 Strategies (Domain 3)

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| S-C1 | Clone + init in two txs → front-run `_proposer` | 90+ | `_disableInitializers()` + atomic factory wrapper |
| S-C2 | `SynthraDirectAdapter.synthraV3SwapCallback` unauth | 95 | `require(msg.sender == pool)` |
| S-C3 | Chainlink stale-report acceptance | 80+ | Use the declared-but-unused `MAX_PRICE_AGE` constant |
| S-C4 | `PortfolioStrategy` `amountOutMin=0` on every swap | 85 | Wire `maxSlippageBps` (stored, never read) into `amountOutMin` |
| S-C5 | Hyperliquid CLOID collision across clones | 75+ | Namespace CLOID by clone address / nonce |
| S-C6 | Cumulative sweep min-return | partial | Convert existing test that asserts the bug into a fix PoC |

### 3.4 Tokenomics (Domain 4) — ve(3,3) stack

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| T-C1 | LP rewards stuck (`_calculateLPReward` reverts) | 90 | Ship or strip — current state is user-visible revert on an "active" claim function |
| T-C2 | `flipEpoch` off-by-one at genesis | 80+ | Verify against `epochStart`; add boundary test |
| T-C3 | `balanceOfNFTAt` uses current lock state, not historical | 95 | Implement proper point-history read (scaffolding exists but `_pointHistory` is never read) |
| T-C4 | veNFT transferable while votes are attached → double-count | 90 | Block transfer during active epoch OR snapshot vote owner |
| T-C5 | Bribe claimant check uses current owner, not vote-time owner | 88 | Snapshot owner into `Bribe` struct at vote cast |
| T-C6 | Rebase computed by `amount`, not `amount × lockDuration` | 80 | Weight by lock duration |
| T-C7 | Flash-deposit captures full epoch on `VaultRewardsDistributor` | 80 | Pro-rate claims by deposit-block within epoch |

### 3.5 Adapters / Create3 (Domain 5)

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| A-C1 | `Create3Factory.deploy` permissionless despite doc claim | 85 | Add `Ownable`, or use Solady CREATE3 |
| A-C2/C3 | Synthra swap / callback paths unverified | 75+ | Fork tests; adapter refactor per S-C2 |
| A-C4 | CREATE3 silent-succeeds on failed CREATE (`deployed.code.length == 0`) | 70 | `require(deployed.code.length > 0)` after inner create |

---

## 4. Dimensional / decimals bugs (from #226 §5)

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| D-1 | `Minter` uses `votingEscrow.totalSupply()` (decay-adjusted voting power) as rebase denominator — over-issues as locks near expiry | HIGH | Use `totalLockedAmount()` (already used by `RewardsDistributor`) |
| D-2 | Hyperliquid `/1e6` divisor hardcoded; BTC szDecimals=5, ETH=4, others=0 | HIGH | Read `perpAssetInfo.szDecimals + pxDecimals` from HyperCore |
| D-3 | `PortfolioStrategy` assumes all Chainlink feeds `1e18`; tokenized-stock often `1e8` → 10¹⁰× mis-scaling | HIGH | Store `uint8 priceDecimals` per allocation; normalize to `1e18` |
| D-4 | PortfolioStrategy mixes `1e18`-scaled values with raw USDC (`1e6`) `assetHeld` | HIGH | Normalize price to asset decimals explicitly |
| D-5 | `MoonwellSupplyStrategy._positionValue` `1e18` divisor for USDC markets → 100× under-report on display | LOW | Use `1e(18 - cToken.decimals() + underlying.decimals())` |

---

## 4.5 Weird-token findings (from #226 §7.5)

| Ref | Finding | Severity | Fix |
|---|---|---|---|
| W-1 ✅ | USDC blacklist bricks settlement. If lead proposer / co-proposer / protocol-fee recipient / vault owner is USDC-blacklisted, `_distributeFees` reverts and `settleProposal` reverts with it — entire vault stuck. | MED | ✅ fixed — per-recipient transfers now wrapped in try/catch; failures escrow via `_unclaimedFees` and emit `FeeTransferFailed`; recipients pull via `claimUnclaimedFees`. Regression tests in `test/governor/FeeBlacklistResilience.t.sol`. Closes the A22 doc↔code mismatch. |
| W-3 | No FOT accounting on `_pullFromVault` (no snapshot balanceOf before/after). | LOW | Snapshot balance around pull; assert expected delta. Matters only if USDC ever adds FOT semantics. |
| W-4 | `PortfolioStrategy` accepts arbitrary tokens with no decimals check, no allowlist, no supply check. | LOW | Add minimum validation at allocation config; consider a protocol-level token allowlist. |

## 5. Fail-open defaults (from #226 §6)

| Ref | Severity | Location | Default | Fix |
|---|---|---|---|---|
| I-1 ✅ | HIGH | `SyndicateVault.redemptionsLocked()` | `if (gov == address(0)) return false` | Closed — reverts `GovernorNotSet` (`d8bdf00`) |
| I-2 | HIGH | `PortfolioStrategy` | `chainlinkVerifier == 0` accepted at init | Require non-zero |
| I-3 ✅ | HIGH | `SyndicateGovernor._distributeFees` | `recipient == 0` silently skips the protocol fee | Closed — `_applyProtocolFeeBpsChange` re-asserts the `bps > 0 ⇒ recipient != 0` invariant at finalize time; `_distributeFees` now reverts instead of silent-skip. Regression tests in `test/governor/ProtocolFeeRecipientTimelock.t.sol`. |
| I-6 | HIGH | `PortfolioStrategy` + `AerodromeLPStrategy` | `amountOutMin = 0` | S-C4 fix |
| I-13 | MED | `MoonwellSupplyStrategy`, `MamoYieldStrategy`, `HyperliquidPerpStrategy` | `minRedeemAmount = 0` | Require non-zero; document semantic |
| I-14 | LOW | `VeniceInferenceStrategy` | `repaymentAmount = 1` allowed via `updateParams` | Minimum bound |
| I-11 | LOW | `executeGovernorBatch` NOT `whenNotPaused` | documented behavior, non-issue | Document explicitly |

---

## 6. Doc ↔ code mismatches (from #226 §4)

Each row is a **doc update** (not a code change). `mintlify-docs/` changes route through the submodule PR.

| Ref | Doc claim | Reality | Fix location |
|---|---|---|---|
| A7 | "Protocol fee changes are timelocked" | `setProtocolFeeBps` timelocked, `setProtocolFeeRecipient` NOT | `mintlify-docs/economics.mdx` — update OR fix code (see G-C5) |
| A10 | CLAUDE.md: "two-layer permission model: `maxPerTx`, `maxDailyTotal`, `maxBorrowRatio`, per-agent caps, target allowlist" | None exist in code | Already flagged in CLAUDE.md "Aspirational" section; fix `mintlify-docs/protocol/architecture.mdx` to match |
| A12 | "near EIP-170 limit (~23.8k / 24.6k)" | Actually 24,523 / 24,576 = 53-byte margin | Already fixed in CLAUDE.md |
| A18 | `concepts.mdx`: "Shareholders can call `vetoProposal`" | `vetoProposal` is vault-owner only | `mintlify-docs/learn/concepts.mdx` — fix |
| A19 | `concepts.mdx`: "Governance parameters configurable per syndicate" | Single global `GovernorParams` | `mintlify-docs/learn/concepts.mdx` — fix |
| A20 | `settlement.mdx`: "Governor calls `vault.lockRedemptions()`" | No such function (pull-model `redemptionsLocked()`) | `mintlify-docs/protocol/settlement.mdx` — fix |
| A21 | `settlement.mdx`: `vault.executeBatch` | Governor uses `executeGovernorBatch` | `mintlify-docs/protocol/settlement.mdx` — fix |
| A22 | `settlement.mdx`: "Fee transfers wrapped in try/catch" | No try/catch; USDC blacklist bricks settlement | Either fix code (W-1) or remove doc claim |
| A23 | `settlement.mdx`: EAS `STRATEGY_PNL` attestation on settle | Not implemented | Either ship or remove doc claim |
| A24 | `overview.mdx` struct has `capitalRequired` | Field doesn't exist | `mintlify-docs/overview.mdx` — fix; also `docs/governor-architecture.md` |
| A25 | `overview.mdx`: "Snapshot at proposal creation (`block.number`)" | Timestamp-based | `mintlify-docs/overview.mdx` — fix |
| A26 | `collaborative-proposals.mdx`: "Splits must sum to 10000 BPS" | Code requires `totalCoSplitBps <= 9000` | `mintlify-docs/collaborative-proposals.mdx` — fix |
| A27 | `collaborative-proposals.mdx`: "Max co-proposers: 5" | Absolute ceiling 10; deployed 5 | Same |
| A28 | `collaborative-proposals.mdx`: `expireCollaboration(proposalId)` | Function doesn't exist (lazy resolution) | Same |
| A29 | `collaborative-proposals.mdx`: "Execute: lead only, Settle: lead only" | `executeProposal` permissionless; `settleProposal` proposer-anytime / anyone-after-duration | Same |
| A33 | `reference/deployments.mdx` Base addresses | All four stale vs `chains/8453.json` | Update after mainnet redeployment |
| A34 | `reference/deployments.mdx` Feature Matrix: HyperEVM "No" for Moonwell/Aerodrome/Venice | `chains/999.json` has those template keys (unusable on HyperEVM) | Fix the matrix or remove keys from chain config |
| A35 | `architecture.mdx`: "per-agent caps" | `AgentConfig` has no caps | Fix `mintlify-docs/protocol/architecture.mdx` |
| A38 | `architecture.mdx`: `transferPerformanceFee` as "governor-only fee distribution" | No amount/recipient/token caps — governor can move any ERC-20 | Document the trust assumption, or add caps |
| A41 | `economics.mdx`: "WOOD/SHARES early-exit pool" | Full ve(3,3) stack ships, mostly undocumented | Expand `mintlify-docs/` to cover ve(3,3) |

---

## 7. Process / test gaps (from #226 §3)

| Ref | Gap | Status | Fix |
|---|---|---|---|
| 3.1 | `forge coverage` fails on `SyndicateGovernor.propose()` struct literal (Yul stack-too-deep) | ✅ fixed-in-229 (`78257c3`) | Split struct literal into sequential field assignments. |
| 3.2 | Every Critical in #225 lacks a PoC test | 🧪 test-only | 26 items; red → fix → green per item |
| 3.3 | Missing fork tests: Synthra (none), Hyperliquid (mock only), Mamo (no real factory), Chainlink Data Streams, wstETH/ETH on Base, Create3 squat | 🧪 test-only | Add integration suites |
| 3.4 | No test file at all for: `Create3Factory`, `SynthraSwapAdapter`, `SynthraDirectAdapter`, `L1Write`, `L1Read`, `WoodToken` (LZ cross-chain), `VaultRewardsDistributor` flash-deposit, `MockSwapAdapter` | 🧪 test-only | Create suites |
| 3.5 | Zero invariant / property tests (`grep invariant_ test/` returns 0) | 🟡 partial-in-229 (`963e565`, `bf0e4cd`, `12deb4d`) | 3 guardian invariants (`963e565`) + 5 protocol invariants INV-2/-3/-30/-33/-46 (`bf0e4cd`) + INV-11 co-proposer split property test (`12deb4d`) shipped. INV-15 (veWOOD conservation) + INV-23 (strategy asset conservation) are deferred to tokenomics / strategies branches per #236's scope boundary. 48 invariants total in #226 §8; ship handler + echidna config for remaining. |

---

## 8. Supply-chain risk (from #226 §9)

T4 dependencies (experimental / single-maintainer / foreign VM) that need mitigations:

| Dep | Risk | V1 action |
|---|---|---|
| **Synthra** (Uniswap V3 fork on Robinhood L2) | Forked codebase, unclear audit, unauth callback (S-C2) | Retire `SynthraDirectAdapter` or allowlist specific pools |
| **Mamo** (factory → user strategies) | Compromised factory returns arbitrary "strategy" bytecode | Allowlist factory versions |
| **Venice** (sVVV non-transferable) | Strategy can't unwind if agent revokes approval | Require agent collateral / covenant |
| **Hyperliquid precompiles** | Foreign VM; upgrade could silently change ABI | Off-chain watchdog; version-pin HyperCore interactions |

---

## 9. Prioritized action list (from #226 §11)

Ranked by effort-to-impact. PR #229 doesn't touch items 1–5, 7, 8, 9; it lands on top of them.

1. ~~Refactor `SyndicateGovernor.propose()` struct literal — unblocks `forge coverage`.~~ ✅ **done in #229** (`78257c3`).
2. PoC tests for every Critical in #225 (26 items).
3. Delete dead code (14 items in #226 §10.1).
4. Move `MockSwapAdapter.sol` + `CoreWriter.sol` from `src/` to `test/mocks/`.
5. Fix `Create3Factory.deploy` — add `Ownable` OR use Solady CREATE3.
6. Fix doc↔code mismatches (§6 above).
7. Wire `maxSlippageBps` → `amountOutMin` in `PortfolioStrategy`.
8. Rotate all owners to `TimelockController` + Gnosis Safe.
9. Echidna harness for the 48 invariants (priority: INV-2, -3, -11, -15, -23). 🟡 **partial in #229** (`963e565` — 3 guardian-scope invariants; `bf0e4cd` — INV-2 / -3 / -30 / -33 / -46; `12deb4d` — INV-11 co-proposer split property test; `feat/guardian-review-lifecycle` HEAD — INV-9 active-proposal pointer consistency + INV-10 capital-snapshot lifecycle, closes #236). INV-15 / -23 deferred to tokenomics / strategies branches per #236 scope.
10. ~~CI size gate: `forge build --sizes` must fail if `SyndicateGovernor > 24,500` bytes.~~ ✅ **done in #229** (`607386e` — gate at 24,400).
11. Document invariants at call sites (#226 §10.3).
12. Add `Pausable` across tokenomics contracts. (Registry now has pause + 7d deadman — tokenomics still outstanding.)
13. Add `nonReentrant` on every state-mutating governor fn (G-C6). 🟡 **partial in #229** — registry externals covered; governor legacy fns still open.
14. Wrap fee transfers in try/catch (A22) + regression test.
15. Fix `maxDeposit` / `maxMint` / `maxWithdraw` / `maxRedeem` to return 0 when blocked.
16. Extract `BPS_DENOMINATOR = 10_000` to one shared library.
17. NatSpec on every non-`@inheritdoc` public fn.
18. Publish `executorImplCodehash()` view.

**External audit gate:** items 2–9 land (1 and 10 now closed), then external audit, then mainnet.

---

## 10. How to use this doc

- **Writing a fix PR**: link the ref codes in your PR description (e.g. "fixes V-C1, V-C3"). Close them in this table.
- **Reviewing a PR**: check whether it touches any open items here; if yes, require the ref in the PR description.
- **Planning the audit**: the external auditor gets this doc plus #225 and #226 as their starting corpus.
- **Updating mintlify docs**: every §6 row that says `mintlify-docs/...` routes through the submodule PR on `imthatcarlos/mintlify-docs`. Link both PRs (in-repo + submodule) when closing a row.

This doc is the **canonical pre-mainnet tracker**. Individual issue comments on #225 / #226 can update status; when a fix PR merges, mark the row ✅ with the PR link.
