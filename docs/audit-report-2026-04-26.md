# Sherwood Protocol — Smart Contract Audit Report

**Date:** 2026-04-26
**Branch:** `main` (V1.5 — guardian delegation + commission live)
**Scope:** core contracts (Vault / Governor / Registry / Factory / Token / BatchExecutor) + 8 strategy templates + 4 swap adapters + Hyperliquid precompiles + ve-stack tokenomics
**Methodology:** 7 parallel domain audits using Trail of Bits skill catalog (`entry-point-analyzer`, `audit-context-building`, `building-secure-contracts:guidelines-advisor` / `code-maturity-assessor` / `token-integration-analyzer`, `dimensional-analysis`, `spec-to-code-compliance`, `insecure-defaults`, `sharp-edges`, `variant-analysis`, `property-based-testing`, `fp-check`)
**Source reports:** `/tmp/sherwood-audit-{vault,governor,registry,tokenomics,strategies,spec,maturity}.md` (4,051 lines / ~300 KB combined)
**Reviewer model:** read-only static review; no fuzzing or fork tests run

---

## 1. Executive Summary

**Total findings: 222 (newly identified).** Plus ~50 pre-existing punch-list rows verified-still-open or verified-now-closed.

| Severity | Count |
|---|---:|
| **Critical** | **20** |
| **High** | **66** |
| **Medium** | **80** |
| **Low / Info** | **56** |

**Code-maturity score: Moderate (20/36 ≈ 56%)** by ToB 9-category framework. Bottleneck: **Decentralization (Weak)** — V1.5 removed every on-chain timelock; the protocol now relies entirely on multisig+Zodiac-Delay for power separation, and code-only auditors cannot verify that delay applies. Strong: Solidity 0.8.28 pinned exactly across all 50 source files; OZ 5.6.1; UUPS layout discipline (`__gap` + `__paramsGap` + `__emergencyGap`).

### 1.1 Headline risks (mainnet blockers)

1. **Strategy templates are front-runnable on init (S-C1)** — `BaseStrategy.initialize` is `external`/public; no template overrides `_disableInitializers()` in its constructor; the CLI deploys ERC-1167 in tx N then calls `initialize` in tx N+1. **An attacker on chain mempool sees the clone deploy, races the init in the next block, and becomes the strategy proposer for that clone.** All 7 concrete strategies are exposed.
2. **`SynthraDirectAdapter.synthraV3SwapCallback` is unauthenticated AND `amountOutMin` is never read AND state slots are not transient (S-C2 + A2 + B42)** — three independent flaws compound into a deterministic mid-swap drain available to any caller.
3. **Governor `finalizeEmergencySettle` does not verify proposal state (Governor C1)** — when used in combination with standard `settleProposal`, the same proposal id can be settled twice. Counter underflows via `_decOpen unchecked`, fees are re-distributed on phantom PnL, vault is permanently bricked from new proposals, and owner cannot reclaim their bond.
4. **`PortfolioStrategy` swaps with `amountOutMin = 0` at six call sites (S-C4)** while computing trade sizes off Chainlink prices — classic oracle-vs-AMM mismatch that drains the basket on every rebalance.
5. **WOOD `MAX_SUPPLY` is breachable via OFT cross-chain round-trips (Tokenomics WOOD-1)** — `Minter.totalMintable()` reads local-chain `totalSupply()` which decreases when WOOD bridges out via OFT. Round-trip bridging silently re-enables minting beyond the 1B cap.
6. **`balanceOfNFTAt(timestamp)` reads CURRENT lock state, not historical (T-C3)** — `_pointHistory` is written by `_updateLockCheckpoint` but **never read by any function**. Every consumer (`Voter.vote`, bribe attribution, rebase math) is wrong, and weaponizes into an underflow DoS via lock-amount inflation + veNFT transfer.
7. **`SyndicateGauge.claimLPRewards` always reverts and there is no rescue path (T-C1)** — the LP slice (10/7/3% of gauge allocation in epochs 1-4 / 5-8 / 9-12) is permanently stuck on-chain. ~80% of one epoch's emission per gauge × number of syndicates is dead WOOD.
8. **Spec ↔ code drift on the timelock (X1/X2/X73/X86)** — every public docs page still describes the V1 6h-7d queue/finalize timelock as live; V1.5 deleted it entirely. Users may plan around a delay that doesn't exist.
9. **Documentation surface still claims removed/aspirational features**: `setGovernor`, `executeBatch`, `emergencySettle` fallback try/catch, `fundEpoch`/`claimEpochReward`, `maxPerTx`/`maxDailyTotal` per-agent caps, EAS `STRATEGY_PNL` attestation, WOOD/SHARES early-exit pool — all missing from code.
10. **Guardian-fee parameter (`MAX_GUARDIAN_FEE_BPS = 500`, 5%) is invisible to depositors** — does not appear in `economics.mdx` fee waterfall.

### 1.2 What works well

- Pull-claim escrow keys correctly include `vault`/`proposalId` to prevent cross-instance drain (W-1 closure verified).
- `SyndicateVault.executeGovernorBatch` codehash-pins `BatchExecutorLib` (V-C2 closure verified).
- Optimistic-vote snapshot at `block.timestamp - 1` closes the same-block flash-delegate (G-C1 closure verified at both `propose` and `approveCollaboration` Draft→Pending sites).
- `cancelProposal` and `emergencyCancel` narrowed to non-terminal states; `_activeProposal[vault]` only mutated in `executeProposal` and `_finishSettlement` (G-C2/G-C3 closure verified).
- Storage layout has documented per-abstract `__gap` discipline.
- All 50 source files pin Solidity exactly to `0.8.28` (no `^` floats).
- Initializer race closed on every UUPS proxy: `_disableInitializers()` confirmed in 4/4 (Vault, Governor, Factory, Registry). Strategy templates are the gap — see §3.1.

---

## 2. Severity Summary by Domain

| Domain | C | H | M | L/I | Total | Source |
|---|---:|---:|---:|---:|---:|---|
| Vault + Factory + BatchExecutor + Create3 | 1 | 6 | 8 | 5 | 25 | `audit-vault.md` |
| Governor (3 contracts) | 5 | 8 | 10 | 9 | 32 | `audit-governor.md` |
| GuardianRegistry | 1 | 6 | 12 | 8 | 29 | `audit-registry.md` |
| Token + Distributors + ve-stack | 3 | 13 | 14 | 7 | 37 | `audit-tokenomics.md` |
| Strategies + Adapters + Hyperliquid | 8 | 15 | 24 | 13 | 60 | `audit-strategies.md` |
| Spec ↔ Code mismatches | 5 | 18 | 18 | 6 | 47 | `audit-spec.md` |
| Cross-cutting (maturity / entry-points) | — | — | — | — | scorecard | `audit-maturity.md` |
| **Combined unique findings** | **20** | **66** | **80** | **56** | **222** | |

Multi-domain duplicates (e.g., S-C1 surfaced in strategies + maturity, T-C3 in tokenomics + strategies) are counted once in the totals above and listed once in §3.

---

## 3. Critical Findings (20)

Each row: title, files, root cause, suggested action.

### C-01 · Strategy template `initialize` is front-runnable on every clone (S-C1)
- **Files:** `src/strategies/BaseStrategy.sol:61-71`; all 7 concrete strategies (`MoonwellSupplyStrategy`, `AerodromeLPStrategy`, `WstETHMoonwellStrategy`, `HyperliquidPerpStrategy`, `MamoYieldStrategy`, `PortfolioStrategy`, `VeniceInferenceStrategy`); CLI `cli/src/lib/clone.ts` + `cli/src/commands/strategy-template.ts:819 / 920 / 1081`
- **Root cause:** `initialize` is public; no `_disableInitializers()` on any template constructor; CLI deploys clone in tx N then initializes in tx N+1. Mempool watcher races and calls `initialize(attackerVault, attackerProposer, attackerData)` first.
- **Action:** add `constructor() { _disableInitializers(); }` to every concrete strategy template, OR migrate to a `StrategyFactory.cloneAndInit()` wrapper that does both in one tx.

### C-02 · `SynthraDirectAdapter.synthraV3SwapCallback` unauthenticated (S-C2)
- **File:** `src/adapters/SynthraDirectAdapter.sol:98`
- **Root cause:** zero `msg.sender` check. Any caller can spoof the callback while a real swap is in flight (or post-state with non-zero `_callbackToken`/`_callbackAmount`) and pull `amountOwed` of `_callbackToken` to themselves via `safeTransfer(msg.sender, ...)` at line 101.
- **Action:** `require(msg.sender == ISynthraV3Factory(factory).getPool(token0, token1, fee))`.

### C-03 · `SynthraDirectAdapter.swap` ignores `amountOutMin` (A2)
- **File:** `src/adapters/SynthraDirectAdapter.sol:58-95`
- **Root cause:** `amountOutMin` is in the function signature but **never referenced** inside the body. Pool swap is called with `MIN_SQRT_RATIO + 1` / `MAX_SQRT_RATIO - 1` price limits — i.e. unbounded. No protection regardless of caller intent.
- **Action:** `if (amountOut < amountOutMin) revert SlippageExceeded();` after the swap completes.

### C-04 · `SynthraDirectAdapter` callback `safeTransfer(msg.sender, ...)` cross-pool drain (B45)
- **File:** `src/adapters/SynthraDirectAdapter.sol:101`
- **Root cause:** the callback transfers `amountOwed` of `_callbackToken` to `msg.sender`. Combined with C-02 (no auth) and B42 (non-transient slots), any contract address can call `synthraV3SwapCallback(amount0, amount1, "")` while a swap is mid-flight, claim itself as the pool, and pull `_callbackAmount` of `_callbackToken`.
- **Action:** authenticate the callback (C-02 fix); also move `_callbackToken` / `_callbackAmount` to transient storage (EIP-1153) so cross-call corruption is impossible.

### C-05 · `PortfolioStrategy.rebalanceDelta` oracle-vs-AMM mismatch + 0 slippage (S-C4)
- **File:** `src/strategies/PortfolioStrategy.sol:319-365`; six swap call sites at `:167, 188, 261, 274, 342, 360` all pass literal `amountOutMin = 0`. `maxSlippageBps` storage at `:86` is never read.
- **Root cause:** flow reads Chainlink price → computes `targetValue` from Chainlink → swaps via `swapAdapter` with no slippage. The Chainlink price and the AMM spot are independent; sandwich attack drains the strategy by `(fair − manipulated) × tokensToSell`.
- **Action:** wire `maxSlippageBps` into every swap site: `amountOutMin = expectedOut * (10000 - maxSlippageBps) / 10000`. Also require `maxSlippageBps > 0` and `< 10000` at init.

### C-06 · `MamoYieldStrategy` trusts arbitrary bytecode from Mamo factory (B21, supply-chain)
- **File:** `src/strategies/MamoYieldStrategy.sol:65-72`
- **Root cause:** `mamoFactory.createStrategyForUser(address(this))` returns whatever bytecode Mamo's factory chooses. The strategy verifies `extcodesize > 0` but not the bytecode itself. A compromised Mamo factory returns an arbitrary contract that accepts the deposit then funnels to attacker.
- **Action:** allowlist Mamo factory versions / bytecode hashes; verify via `keccak256(<address>.code)`.

### C-07 · `MockSwapAdapter` is in `src/` and `setRate` is permissionless (B46)
- **File:** `src/adapters/MockSwapAdapter.sol:29-31`
- **Root cause:** anyone can call `setRate`. For a "test-only" contract this is intentional, but the file lives in `src/`. If accidentally deployed and wired into a strategy (an operator does this for "stage testing"), an attacker rate-flips it to 0 (or 1e36) at any moment.
- **Action:** move `MockSwapAdapter.sol` and `CoreWriter.sol` from `src/` to `test/mocks/` (#226 §11 item 4).

### C-08 · Governor `finalizeEmergencySettle` lacks `proposal.state` guard — replay double-settle
- **File:** `src/GovernorEmergency.sol:120-136`; interacts with `src/SyndicateGovernor.sol:911-940` (`_finishSettlement`)
- **Root cause:** `finalizeEmergencySettle` validates owner / hash / registry-resolved-unblocked but NOT `p.state == Executed`. The hash mapping `_emergencyCallsHashes[pid]` is not cleared by `settleProposal` or `unstick`. Sequence: `emergencySettleWithCalls(pid)` → `settleProposal(pid)` → `finalizeEmergencySettle(pid)`. Second `_finishSettlement` runs: re-distributes fees on phantom PnL (capital snapshot not cleared), `_decOpen unchecked` underflows from 0 → `2^256 - 1`, vault is permanently bricked from `requestUnstakeOwner` and new proposals.
- **Action:** add `if (p.state != ProposalState.Executed) revert ProposalNotExecuted();` at the top of `finalizeEmergencySettle`. As defense-in-depth: `delete _capitalSnapshots[pid]; _clearEmergencyCalls(pid);` at the end of `_finishSettlement`. Drop `unchecked` from `_decOpen` (C-10).

### C-09 · `vetoThresholdBps == 100%` upper bound makes proposals un-vetoable
- **File:** `src/GovernorParameters.sol:33,217-219` (`MAX_VETO_THRESHOLD_BPS = 10000`)
- **Root cause:** at 100%, `votesAgainst >= pastTotalSupply` is required, but ERC20Votes-delegated supply is usually a fraction of total — so the threshold is unreachable. Proposals always proceed regardless of opposition. Combined with G-H4 closure (skip veto check if `pastTotalSupply == 0`), a vault with no delegated shares has zero on-chain veto.
- **Action:** cap `MAX_VETO_THRESHOLD_BPS` at e.g. 5000; document that the threshold is against `pastTotalSupply` not delegated voting power.

### C-10 · `_decOpen` is `unchecked` — single-mistake catastrophic underflow
- **File:** `src/SyndicateGovernor.sol:450-454`
- **Root cause:** `unchecked { --openProposalCount[vault]; }` rolls 0 → `2^256 - 1`. Triggers from C-08 replay. Multiple downstream gates (`requestUnstakeOwner`, `propose`, `approveCollaboration`) check `openProposalCount != 0`; underflow makes them all pass even when no proposal is open, and the vault is permanently locked from owner unstake.
- **Action:** drop the `unchecked` block. Solidity 0.8 will revert on underflow loudly.

### C-11 · Co-proposer `share == 0` revert bricks settlement on tiny PnL (G-C7 residual)
- **File:** `src/SyndicateGovernor.sol:1023-1051`
- **Root cause:** `_distributeAgentFee` reverts `CoProposerShareUnderflow` when `share = (agentFee * splitBps) / 10000 == 0`. With `MIN_SPLIT_BPS = 100` (1%), this fires for every USDC fee under 100 wei. Strategies with legitimate small PnL revert the entire settlement. Vault stuck in `Executed` until owner deregisters a co-proposer.
- **Action:** round-up share for active co-proposers, OR distribute remainder to lead, OR floor share at 1 wei rather than reverting.

### C-12 · Emergency-review re-open without rate limit — guardian quorum gas-bleed (Governor C5)
- **File:** `src/GovernorEmergency.sol:80-96` + `src/GuardianRegistry.sol:1034-1054`
- **Root cause:** `emergencySettleWithCalls` does not check whether an emergency review for `proposalId` is already open. Each call overwrites `_emergencyCallsHashes[pid]` and bumps `er.nonce`, invalidating all prior block votes (`_emergencyBlockVotes[pid][nonce]` is keyed on nonce). Owner re-opens to erase guardian votes near quorum.
- **Action:** rate-limit re-opens (one per `reviewPeriod / 2`), or charge a slashable owner stake delta on each open, or require an explicit `cancelEmergencySettle` between opens.

### C-13 · Registry `pause()` re-pause resets the deadman timer indefinitely (Registry C-01)
- **File:** `src/GuardianRegistry.sol:1393-1397`
- **Root cause:** `pause()` has no `if (paused) revert` precondition. A compromised owner re-pauses every 6 days, resetting `pausedAt`, defeating the 7-day public deadman-unpause.
- **Action:** `if (paused) revert AlreadyPaused();` at the top of `pause()`.

### C-14 · WOOD `MAX_SUPPLY` breachable via OFT cross-chain round-trips
- **File:** `src/WoodToken.sol:44-50, 53-55`
- **Root cause:** `Minter.totalMintable()` reads local-chain `totalSupply()` which decreases when WOOD bridges out via OFT (LayerZero `_debit` calls `_burn`). Bridge 500M from chain A to B → chain A `totalSupply` drops → `Minter.flipEpoch` mints 500M more → bridged chain has 1.5B total cross-chain.
- **Action:** track a global high-water mark `_totalEverMinted` updated on every local `mint`; gate `mint` on that not on `totalSupply()`. Or designate a single mintable chain via OFTAdapter pattern.

### C-15 · `Minter.triggerCircuitBreaker` is owner-only manual; price-trigger documented but unimplemented
- **File:** `src/Minter.sol:258-267`
- **Root cause:** the function body has a `TODO: Implement price/lock rate checks` comment and gates on `msg.sender == owner`. `mintlify-docs/economics.mdx` documents an automated trigger that does not exist. Owner can also `setEmissionReduction(10000)` to halt emissions arbitrarily.
- **Action:** either ship the price-based trigger (Chainlink read + threshold) or strip the function and document the manual-only trust assumption.

### C-16 · `VotingEscrow.balanceOfNFTAt(timestamp)` reads CURRENT lock state, never historical (T-C3)
- **File:** `src/VotingEscrow.sol:333-357`
- **Root cause:** function reads `_locks[tokenId]` at call time, ignoring `timestamp`. The `_pointHistory[tokenId][epoch]` and `_supplyPointHistory[epoch]` are written by `_updateLockCheckpoint` / `_updateSupplyCheckpoint` but **never read by any function**. Every consumer (`Voter.vote`, `Voter._removeExistingVotes`, `Voter._isQuorumMet`, `Minter.voteWoodFed`, `VoteIncentive._calculateIncentiveAmount`, `VoteIncentive._claimSingleIncentive`, `RewardsDistributor.claimRebase`) gets the wrong answer.
- **Weaponization:** Alice votes with veNFT 42 (power 90), increases lock amount mid-epoch (decay-adjusted reading now 990), transfers NFT to Bob (T-C4 — no transfer block). Bob calls `vote()` for syndicate B; `_removeExistingVotes` reads new (inflated) power 990, tries `_syndicateVotes[A][epoch] -= 990` (only 90 there) → underflow revert → epoch's vote-tracking permanently bricked.
- **Action:** implement Curve-style point-history binary search using existing `_pointHistory` scaffolding. Or read from `_lockAmountHistory` (already correctly historical for `getLockAmountAt`) plus per-token end checkpoints.

### C-17 · Spec drift: every public doc page claims V1 timelock is live (X1, X2, X73, X86)
- **Files:** `mintlify-docs/protocol/governance/economics.mdx:48`, `mintlify-docs/protocol/architecture.mdx:131-150`, `mintlify-docs/learn/concepts.mdx:49`, `mintlify-docs/protocol/governance/guardian-review.mdx:131`
- **Root cause:** V1.5 (CLAUDE.md §"V1.5 — Guardian Delegation") removed `_parameterChangeDelay`, `_pendingChanges`, `finalizeParameterChange`, `cancelParameterChange`. Every setter is now `onlyOwner`-instant. Public docs still describe the 6h-7d queue/finalize pattern as load-bearing.
- **Action:** doc-side rewrite. Replace timelock claims with "owner is a Gnosis Safe + Zodiac Delay multisig that enforces the delay externally". Update bound tables to drop the timelock framing.

### C-18 · Spec drift: `fundEpoch`/`claimEpochReward`/`sweepUnclaimed` removed but docs reference (X27, X56)
- **Files:** `mintlify-docs/protocol/governance/guardian-review.mdx:80-89, :131, :160-164`; `mintlify-docs/protocol/governance/economics.mdx:27`
- **Root cause:** V1.5 deleted V1's on-chain WOOD epoch reward machinery in favor of off-chain Merkl distribution (`GuardianRegistry.sol:1346-1357` removal commit). Docs still list the removed functions as live entry points and describe a "weekly `fundEpoch(currentEpoch, X)` from the multisig".
- **Action:** doc-side. Replace with description of off-chain Merkl distributor + on-chain `BlockerAttributed(proposalId, epochId, blocker, weight)` event.

### C-19 · Spec drift: V1.5 guardian fee parameter invisible in fee waterfall (X29, X79)
- **File:** `mintlify-docs/protocol/governance/economics.mdx:54-65`
- **Root cause:** `GovernorParameters.MAX_GUARDIAN_FEE_BPS = 500` (5%) is enforced; `setGuardianFeeBps` is bounded; on settle, `_distributeFees` transfers a slice to `GuardianRegistry.fundProposalGuardianPool`. Public fee waterfall in `economics.mdx` shows only protocol → agent → management. Depositors see less than they expect.
- **Action:** add `Guardian fee` to the bound table (`architecture.mdx:135-147`) and to the fee waterfall in `economics.mdx`.

### C-20 · `BatchExecutorLib.executeBatch` is `external` not internal — sharp edge for future contributors
- **File:** `src/BatchExecutorLib.sol:36-45`
- **Root cause:** `external` visibility makes the deployed lib a permissionless arbitrary-call dispatcher when called *not* via delegatecall. Today it is safe because the lib has no balance and no token approvals. **But** any future contributor who adds state — for fees, for analytics, for anything — silently makes it attacker-controllable. The "no state, no auth" comment is load-bearing.
- **Action:** rename to `BatchExecutor` to drop the misleading "Lib" suffix; add a sentinel like `require(address(this).codehash != _LIB_CODEHASH)` so direct calls revert with a clear error.

---

## 4. High Findings (66) — by Domain

### 4.1 Vault / Factory / BatchExecutor (6)

| # | Title | File:line |
|---|---|---|
| H-V-01 | `Governor.setFactory` undermines vault → governor lookup chain (asymmetric trust) | `GovernorParameters.sol:185-189`; `SyndicateVault.sol:326-328` |
| H-V-02 | Factory `setFactory` is owner-instant despite `setGovernor` removal — symmetric bug | `GovernorParameters.sol:185-189` |
| H-V-03 | `Create3Factory.deploy` permissionless (A-C1, still open) | `Create3Factory.sol:14` |
| H-V-04 | `Create3.deploy` collapses two failure modes into one revert | `Create3.sol:35-37` |
| H-V-05 | `transferPerformanceFee(asset, to, amount)` no caps — compromised governor drains any ERC-20 from any vault | `SyndicateVault.sol:357-359` |
| H-V-06 | `_decimalsOffset()` silently returns 0 for assets where `decimals() == 0` — disables ERC-4626 inflation defense | `SyndicateVault.sol:132, 433-435` |

### 4.2 Governor (8)

| # | Title | File:line |
|---|---|---|
| H-G-01 | `cancelEmergencySettle` does not check proposal state — terminal-state spoof + registry state reset | `GovernorEmergency.sol:107-114` |
| H-G-02 | `_capitalSnapshots[pid]` survives across replay — phantom PnL on re-finalize | `SyndicateGovernor.sol:911-940` |
| H-G-03 | `removeVault` doesn't check for in-flight proposals — orphans active strategies | `SyndicateGovernor.sol:551-554` |
| H-G-04 | `setVetoThresholdBps` is retroactive for in-flight Pending of collaborative proposals | `SyndicateGovernor.sol:309, 508`; `GovernorParameters.sol:106-111` |
| H-G-05 | `_lastSettledAt` overwrite via replay shifts cooldown — extra delay for next strategy | `SyndicateGovernor.sol:925` |
| H-G-06 | Emergency calls have no array-length cap — owner posts 10k-call payload, guardians can't review | `GovernorEmergency.sol:80-96` |
| H-G-07 | Lead remainder paid to deregistered/dead address — no "lead must be active at settle" check | `SyndicateGovernor.sol:1042-1050` |
| H-G-08 | Co-proposer `isAgent` snapshot at settle, not propose — owner front-runs `removeAgent` to redirect share | `SyndicateGovernor.sol:1035` |

### 4.3 GuardianRegistry (6)

| # | Title | File:line |
|---|---|---|
| H-R-01 | Quorum **denominator** captured live; voter weights at `t-1` — same-block flash-stake inflates denominator without contributing votes | `GuardianRegistry.sol:1094-1103, 1039-1049` |
| H-R-02 | `blockQuorumBps` read live at resolve; no setter timelock — owner mid-review change flips block→pass | `GuardianRegistry.sol:1144, 1267` |
| H-R-03 | Emergency review has no cohort-too-small fallback — bootstrap-period 1-WOOD guardian blocks emergency settles | `GuardianRegistry.sol:1034-1054, 1255-1280` |
| H-R-04 | Emergency review blockers receive no `BlockerAttributed` event → no Merkl reward | `GuardianRegistry.sol:1234-1244, 1273-1276` |
| H-R-05 | Vote-change cap-ordering fragility (M-03 invariant) — future refactor could silently corrupt stake-weight | `GuardianRegistry.sol:826-832, 860` |
| H-R-06 | `requestUnstakeDelegation` does not decrement delegate's vote weight — delegator has no kill-switch during cooldown | `GuardianRegistry.sol:449-454` |

### 4.4 Tokenomics (13)

| # | Title | File:line |
|---|---|---|
| H-T-01 | `Minter` ignores `wood.mint()` graceful-cap return value — bricks `flipEpoch` near supply cap | `Minter.sol:206-219` |
| H-T-02 | `calculateRebase` denominator uses `votingEscrow.totalSupply()` (decay-adjusted) — D-1 over-issues as locks decay | `Minter.sol:291-309` |
| H-T-03 | Genesis `flipEpoch` off-by-one — T-C2; first epoch's emissions are lost or wrong | `Minter.sol:175-230`, `Voter.sol:281-289` |
| H-T-04 | veNFT freely transferable while votes/bribes attached — T-C4; transfers vote+bribe rights | `VotingEscrow.sol:434-444` |
| H-T-05 | `VoteIncentive.claimIncentives` checks current owner not vote-time owner — T-C5; sell veNFT after epoch ends | `VoteIncentive.sol:166, 180` |
| H-T-06 | `_pointHistory` / `_supplyPointHistory` are dead storage — gas waste + misleads future devs | `VotingEscrow.sol:60-66, 68-73, 370-398` |
| H-T-07 | `toggleAutoMaxLock` bypasses `MAX_LOCK_DURATION` — toggle on then off extends lock for free | `VotingEscrow.sol:270-286` |
| H-T-08 | `Voter._removeExistingVotes` underflow DoS via T-C3 + T-C4 chain | `Voter.sol:444-461` |
| H-T-09 | `getVoteDistribution` quorum-fallback re-uses stale `_lastQuorumEpoch` indefinitely | `Voter.sol:340-431` |
| H-T-10 | `vote()` O(N²) duplicate-id check — DoS at large N | `Voter.sol:174-181` |
| H-T-11 | `VaultRewardsDistributor.claimRewards` snapshots at `epochStart` — T-C7 flash-deposit captures full epoch | `VaultRewardsDistributor.sol:138-163` |
| H-T-12 | `VaultRewardsDistributor.claimRewards` requires self-delegation — silent rug for users who delegate to others | `VaultRewardsDistributor.sol:146-152` |
| H-T-13 | `SyndicateGauge.claimLPRewards` always reverts; no rescue — T-C1; ~80% of one epoch's emission per gauge dead | `SyndicateGauge.sol:243-248` |

### 4.5 Strategies + Adapters (15)

| # | Title | File:line |
|---|---|---|
| H-S-01 | `MoonwellSupplyStrategy._settle` `IWETH(underlying).deposit{}()` bricks settlement permanently if underlying isn't WETH but ETH was received | `MoonwellSupplyStrategy.sol:87, 99` |
| H-S-02 | `AerodromeLPStrategy` execute-side `amountAMin`/`amountBMin` default 0 (sandwich during execute) | `AerodromeLPStrategy.sol:104-105, 118, 158-159` |
| H-S-03 | `HyperliquidPerpStrategy` `tradedAssets[]` unbounded → settle gas-grief DoS | `HyperliquidPerpStrategy.sol:86, 318-325` |
| H-S-04 | `HyperliquidPerpStrategy.sweepToVault` first-sweep min-return permanently disarmed (S-C6) | `HyperliquidPerpStrategy.sol:346-363` |
| H-S-05 | Hyperliquid `/1e6` divisor hardcoded; `szDecimals` varies per asset (D-2) — BTC 10⁵× off, ETH 10⁴× off | `HyperliquidPerpStrategy.sol:181, 233, 268` |
| H-S-06 | `PortfolioStrategy._verifyPrice` requires native+LINK to pay verifier fees but strategy has no `receive()` and no LINK balance — call always reverts | `PortfolioStrategy.sol:381-391` |
| H-S-07 | `PortfolioStrategy.rebalance()` lacks `nonReentrant` — `_settle` mid-rebalance via Synthra unauth callback (compounds with C-02) | `PortfolioStrategy.sol:235-289, 88` |
| H-S-08 | Chainlink `1e18` scale assumed (D-3) — 8-decimal feeds (tokenized stocks) are 10¹⁰× off | `PortfolioStrategy.sol:65-67, 321, 337, 387-390` |
| H-S-09 | Mixed `1e18`-scaled prices with raw token decimals (D-4) | `PortfolioStrategy.sol:321-337` |
| H-S-10 | `chainlinkVerifier == 0` accepted at init (I-2) | `PortfolioStrategy.sol:132` |
| H-S-11 | Chainlink staleness gate (S-C3) — `MAX_PRICE_AGE` declared but unused | `PortfolioStrategy.sol:67, 386` |
| H-S-12 | `VeniceInferenceStrategy` agent revoke → vault permanently unable to settle | `VeniceInferenceStrategy.sol:172-175, 186-189` |
| H-S-13 | `SynthraDirectAdapter._callbackToken` / `_callbackAmount` are regular storage not transient — re-entry corrupts outer swap accounting | `SynthraDirectAdapter.sol:45-46` |
| H-S-14 | `MamoYieldStrategy._initialize` no allowlist of Mamo factory versions | `MamoYieldStrategy.sol:64-67` |
| H-S-15 | Hyperliquid CLOID risk if HyperCore introduces shared CLOID space (S-C5 documented assumption) | `HyperliquidPerpStrategy.sol:66-67` |

### 4.6 Spec ↔ Code (18)

(All doc-side fixes unless noted.)

| # | Title | File |
|---|---|---|
| H-X-01 | `BatchExecutorLib.sol:14` NatSpec claims "vault enforces allowlists and caps before delegatecalling" — no such enforcement exists | code |
| H-X-02 | `settlement.mdx:203-205` references `executeBatch` (removed in V-C3 closure) | doc |
| H-X-03 | `settlement.mdx:205` references `emergencySettle` try/catch fallback — fully replaced by 4-way split in PR #229 | doc |
| H-X-04 | `architecture.mdx:230` Trust Assumption #2 still flags V-C2 as open — closed at `SyndicateVault.sol:343` | doc |
| H-X-05 | `architecture.mdx:174-186` factory setter list still includes `setGovernor` (removed) | doc |
| H-X-06 | `architecture.mdx:131-147` "10 timelocked parameters" — V1.5 removed timelock (X3) | doc |
| H-X-07 | `governance/overview.mdx:60` Step 5 asserts EAS `STRATEGY_PNL` mint as fact — not implemented | doc |
| H-X-08 | `governance/overview.mdx:117-127` "every change is timelocked" Note block | doc |
| H-X-09 | `concepts.mdx:14` says "fund operator who sets initial governance parameters" — they don't, params are global | doc |
| H-X-10 | `architecture.mdx:120-122` storage table has stale `_parameterChangeDelay` / `_pendingChanges` rows | doc |
| H-X-11 | `architecture.mdx:170` says `minter` is owner-settable — `setMinter` removed in ToB P1-5 | doc |
| H-X-12 | `architecture.mdx:163` says `fundEpoch`/`claimEpochReward`/`sweepUnclaimed` live on registry — all removed | doc |
| H-X-13 | `guardian-review.mdx:107` says blockers are uncapped — capped at 100 in ToB I-2 | doc |
| H-X-14 | `guardian-review.mdx:50` says "weighted by stake at first vote" — actually at review-open via checkpoint | doc |
| H-X-15 | `guardian-review.mdx:163` references `fundEpoch` for bootstrap commitment — function does not exist | doc |
| H-X-16 | `deployments.mdx` does not list `WoodToken` or `GuardianRegistry` for any chain (X64, X65) | both: doc + `chains/{chainId}.json` |
| H-X-17 | `hyperliquid-perp.mdx:134` template address disagrees with `chains/999.json` | doc |
| H-X-18 | V1.5 stake-pool delegation, DPoS commission, on-chain guardian-fee pool entirely undocumented publicly (X76, X77, X78) | doc — ship public V1.5 page |

---

## 5. Medium Findings (80)

Compressed table — full root-cause + fix in source reports.

### 5.1 Vault / Factory / BatchExecutor (8)

- M-V-01 · `rescueERC20` blocks `asset` but not vault's own share token — owner can rescue mis-sent shares to drain LP claims. `SyndicateVault.sol:477-483`.
- M-V-02 · `approveDepositors` no per-call cap, noisy events on duplicates. `SyndicateVault.sol:151-157`.
- M-V-03 · Auto-self-delegate runs only when `delegates(receiver) == address(0)`; pre-delegated receivers redirect voting power. `SyndicateVault.sol:439-452`.
- M-V-04 · Vault has no `rotateFactory` recovery path; factory contract compromise bricks all vaults. `SyndicateVault.sol:93, 131`.
- M-V-05 · Factory UUPS upgrade can rewrite `_authorizeUpgrade` for every vault — bypasses `upgradesEnabled`. `SyndicateVault.sol:495-498`.
- M-V-06 · `setVaultImpl` accepts EOA — newly-created vaults are bricked proxies. `SyndicateFactory.sol:321-326`.
- M-V-07 · `pause`-during-emergency-review can permanently strand a proposal. `SyndicateVault.sol:298-305`.
- M-V-08 · `redemptionsLocked()` reverts on `governor() == 0`; factory-side accident bricks every vault. `SyndicateVault.sol:367-374`.

### 5.2 Governor (10)

- M-G-01 · `claimUnclaimedFees` doesn't validate `vault ∈ _registeredVaults` — typo silently no-ops. `SyndicateGovernor.sol:1073-1080`.
- M-G-02 · Stuck `unstick` can leave dangling `_emergencyCalls` array. `GovernorEmergency.sol:107-114`.
- M-G-03 · `getCooldownEnd` returns `cooldownPeriod` for never-settled vaults (1970 timestamp UI bug). `SyndicateGovernor.sol:648-650`.
- M-G-04 · `setMinStrategyDuration` / `setMaxStrategyDuration` retroactive for in-flight proposals' cooldown gate. `GovernorParameters.sol:122-139`.
- M-G-05 · `propose` doesn't check `target == address(0)` per call (gas-grief no-op). `SyndicateGovernor.sol:266-270`.
- M-G-06 · `addVault` extcodesize check survives SELFDESTRUCT pre-Cancun (Base is Cancun-OK; doc note). `SyndicateGovernor.sol:541-547`.
- M-G-07 · `cancelProposal` Draft doesn't notify co-proposers on-chain (event-only). `SyndicateGovernor.sol:418-427`.
- M-G-08 · `resolveProposalState` permissionless gas spike — slashing 100 approvers fits but ballooned cost. `SyndicateGovernor.sol:815-823`.
- M-G-09 · Spec drift: `setMinter` doesn't exist (G-X-11 above) — confirmed in code.
- M-G-10 · `MAX_PARAM_STALENESS` referenced in CLAUDE.md but does not exist in V1.5 code (CLAUDE.md update needed).

### 5.3 GuardianRegistry (12)

- M-R-01 · Slash hits OWN stake only — delegated weight earns vote power without skin in the game. `GuardianRegistry.sol:1173-1208`.
- M-R-02 · `_voteStake` not cleared for slashed approvers — defense-in-depth latent. `GuardianRegistry.sol:1173-1208 ↔ 601-645`.
- M-R-03 · Approver vote-change leaves stale `_voteStake` outside its current "side". `GuardianRegistry.sol:609-614`.
- M-R-04 · `fundProposalGuardianPool` casts `uint256 → uint128` without bounds check (truncation on exotic assets). `GuardianRegistry.sol:564-575, 239`.
- M-R-05 · No on-chain assertion that `wood.balanceOf(this) >= sum(internal accounting)` (WOOD-asset vault would mix). conceptual.
- M-R-06 · Mid-flight `coolDownPeriod` change shifts in-flight unstake exits. `GuardianRegistry.sol` (param table).
- M-R-07 · `setCommission` first-set semantics: epoch-0 first-set → unbounded; second raise capped at firstSet+500. Mild surprise. `GuardianRegistry.sol:520-534`.
- M-R-08 · `epochGenesis = block.timestamp` at init — chain-fork induces epoch desync (off-chain integrators). `GuardianRegistry.sol:301`.
- M-R-09 · `claimUnstakeDelegation` allows zero-amount claim if `_delegations` cleared without zeroing `_unstakeDelegationRequestedAt` (defensive-only today). `GuardianRegistry.sol:467-484`.
- M-R-10 · `cancelPreparedStake` semantics on already-bound slot — defensive cleanup gap. `GuardianRegistry.sol:926-936`.
- M-R-11 · `setCommission` flap-and-recover within one epoch — high-frequency commission changes are unbounded (off-chain churn). `GuardianRegistry.sol:499-543`.
- M-R-12 · Slash attribution missing for vote-changed Block→Approve approvers — final-state semantics not history. `GuardianRegistry.sol:1234-1244, 833-840`.

### 5.4 Tokenomics (14)

- M-T-01 · ERC20Permit nonces not replicated cross-chain (defense-in-depth — domain separator includes chainid). `WoodToken.sol:66-68`.
- M-T-02 · `_distributeToGauges` empty-vote fallback to treasury siphons epoch revenue during quorum failure. `Minter.sol:457-499`.
- M-T-03 · `setRewardsDistributor` is owner-instant — swap to drain in-flight rebase. `Minter.sol:450-452`.
- M-T-04 · `RewardsDistributor.distributeRebase` no `nonReentrant` (gated by `msg.sender == minter` today). `RewardsDistributor.sol:108-131`.
- M-T-05 · `distributeRebase` reverts when `totalLocked == 0` — bricks `flipEpoch` if no users have locked. `RewardsDistributor.sol:271-274`.
- M-T-06 · `RewardsDistributor.claimRebase` uses current-owner check (T-C5 variant). `RewardsDistributor.sol:133`.
- M-T-07 · `getClaimableEpochs` capped at 100 epochs (UX issue, can hide claims). `VaultRewardsDistributor.sol:273-280`.
- M-T-08 · `_safeMint` before `_locks[tokenId]` initialization — onERC721Received sees phantom NFT. `VotingEscrow.sol:155-171`.
- M-T-09 · `_totalSupplyAt` iterates active tokens unbounded — gas DoS at >100k locks. `VotingEscrow.sol:359-367`.
- M-T-10 · `flipEpoch` `_isQuorumMet` totalSupply read uses CURRENT lock state (T-C3 chain). `Voter.sol:228-237, 324-330`.
- M-T-11 · `vote()` rounding: `sum(_syndicateVotes)` ≤ `_totalVotes`; quorum uses `_totalVotes` (correct), distribution uses sum (under). `Voter.sol:199-205`.
- M-T-12 · `claimLPRewards` uses misleading error name (`DistributionAlreadyExecuted` for "not distributed"). `SyndicateGauge.sol:180-200`.
- M-T-13 · `receiveEmission` overwrites `totalReceived` instead of adding — double-deposit silently loses first transfer. `SyndicateGauge.sol:134-156`.
- M-T-14 · No `Pausable` across the entire ve-stack except Minter — no kill switch outside the vault. cross-cutting.

### 5.5 Strategies + Adapters + Hyperliquid (24)

(Selected; full list in `audit-strategies.md` §B.)

- M-S-01 · `BaseStrategy._pullFromVault` no balance-delta check (W-3 variant for FOT future-proofing). `BaseStrategy.sol:124-126`.
- M-S-02 · `MoonwellSupplyStrategy.receive()` accepts ETH from any sender during Pending — donation channel inflates V-C1 PnL. `MoonwellSupplyStrategy.sol:99`.
- M-S-03 · `AerodromeLPStrategy._execute` `deadline = block.timestamp` — reorder-safe but not user-expressed timeout. `AerodromeLPStrategy.sol:161, 206`.
- M-S-04 · `AerodromeLPStrategy._settle` partial `addLiquidity` → enters `Settled` with no LP. `AerodromeLPStrategy.sol:165-172`.
- M-S-05 · `WstETHMoonwellStrategy` `supplyAmount == 0` reads `vault.balanceOf(weth)` — sweeps mid-flight deposits. `WstETHMoonwellStrategy.sol:111`.
- M-S-06 · `HyperliquidPerpStrategy._settle` force-closes BOTH directions per asset — gas grows 2× per traded asset. `:319-325`.
- M-S-07 · `HyperliquidPerpStrategy` daily reset straddles UTC day — burst trade limit doubles at midnight. `:159-162`.
- M-S-08 · `MamoYieldStrategy.deposit` no balance-delta check on Mamo's strategy. `:79-81`.
- M-S-09 · `MamoYieldStrategy.mamoStrategy_` slot is both write-target and trust-anchor — Mamo admin can rotate impl. `:64-67`.
- M-S-10 · `PortfolioStrategy.updateParams` updates `targetWeightBps` but not `_swapExtraData` — inconsistent route. `:204-228`.
- M-S-11 · `PortfolioStrategy._swapExtraData` is opaque bytes — no length/structural validation. `:144, 223-228`.
- M-S-12 · `UniswapSwapAdapter._chainedSingleHops` leaves intermediate-token approval to router. `:144-147`.
- M-S-13 · `UniswapSwapAdapter` adapter-stateful (intermediate tokens held between hops); no `nonReentrant`. `:152-160`.
- M-S-14 · `SynthraSwapAdapter` single-hop / multi-hop disambiguation by `extraData.length == 32` is fragile. `:78-100`.
- M-S-15 · `Voter.createGauge` doesn't validate `vaultRewardsDistributor` is real (no probe). `Voter.sol:239-259`.
- M-S-16 · `L1Read` dynamic-output precompiles uncapped gas. `:421, 555, 577, 599, 621`.
- M-S-17 · `L1Write._sendAction` reverts hard if `CoreWriter` not deployed — bad fork-test fail mode. `:364-366`.
- M-S-18 · `VeniceInferenceStrategy` `repaymentAmount = assetAmount` default = 0 profit, no minimum check. `:139`.
- M-S-19 · `VeniceInferenceStrategy` no check `agent != proposer_` — self-loan path. `:131-132`.
- M-S-20 · `SyndicateGauge.distributeEmission` permissionless — analyzed safe today, document. `:158-178`.
- M-S-21 · `SynthraSwapAdapter.quote()` reverts if `extraData` isn't `abi.encode(uint24)` — multi-hop unsupported. `:104-111`.
- M-S-22 · `PortfolioStrategy._allocations` length never decreased — old slot lingers. `:141-145`.
- M-S-23 · `PortfolioStrategy.MAX_BASKET_SIZE = 20` enforced once at init, never on `updateParams`. `:133-145`.
- M-S-24 · Approval hygiene: 6 of 7 strategies set approval but never reset to 0 — fragile across reuses. cross-cutting.

### 5.6 Spec ↔ Code (18)

(See `audit-spec.md` §1-§9; selected.)

- M-X-01 · `architecture.mdx:62-70` storage table missing `_agentSet`, `_approvedDepositors`, `_openDeposits`, `_agentRegistry`, `_managementFeeBps`, `_factory`, `_expectedExecutorCodehash`, `_cachedDecimalsOffset`. doc.
- M-X-02 · `economics.mdx:85` and `settlement.mdx:108` show `unclaimedFees(recipient, token)` 2-arg — actual signature is 3-arg `unclaimedFees(vault, recipient, token)`. doc.
- M-X-03 · `architecture.mdx:107-126` storage table missing `openProposalCount`, `_emergencyCallsHashes`, `_emergencyCalls`, `_unclaimedFees`, `_approvedCount`. doc.
- M-X-04 · `architecture.mdx:148-150` says `Each function is reentrancy-guarded` — confirmed (no fix needed but documented).
- M-X-05 · Architecture `Bound` table missing `Guardian fee` row (also called out as Critical X79 above).
- M-X-06 · `setBlockQuorumBps` not bounded in code; doc claims 1000-10000. either side.
- M-X-07 · `setReviewPeriod` not bounded; doc claims 6h-7d. either side.
- M-X-08 · `MAX_BLOCKERS_PER_PROPOSAL = 100` constant added in ToB I-2 not listed in `guardian-review.mdx:142-151` table. doc.
- M-X-09 · `MIN_COHORT_STAKE_AT_OPEN` doc says "below this … unconditionally"; code compares `combinedAtOpen` (own + delegated). doc clarification.
- M-X-10 · `economics.mdx:11`: WOOD/SHARES early-exit pool aspirational + `settlement.mdx:24` still says "sell shares on the WOOD/SHARES pool" (X14).
- M-X-11 · `governance/overview.mdx:117-122` table mentions `vetoThresholdBps` but doesn't document the 10% lower bound. doc.
- M-X-12 · `architecture.mdx:84` `executeProposal` permissionless after Approved — confirmed (no fix needed).
- M-X-13 · `architecture.mdx:88` "24h" emergency review — should reference configurable `reviewPeriod`. doc.
- M-X-14 · `architecture.mdx:122` `_protocolFeeRecipient` storage row claims "(timelocked post G-C5)" — V1.5 removed timelock. doc.
- M-X-15 · `deployments.mdx:107-110` HyperEVM templates — only HyperliquidPerpStrategy listed (correct), but `chains/999.json:8-13` still has 5 zeroed entries. ops hygiene.
- M-X-16 · `venice-inference.mdx:33` lists `emergencySettle()` as strategy-level — actually governor-level. doc.
- M-X-17 · `concepts.mdx:25` "One share equals one vote" — true at snapshot, misleading post-V1.5. doc.
- M-X-18 · `concepts.mdx:39` "veto votes proportional to share balance" — terminology blurs `Against` votes vs. owner `vetoProposal()`. doc.

### 5.7 Cross-cutting (omitted — 8 items in `audit-maturity.md` §3; key ones)

- Storage-layout snapshot test missing for upgradeable contracts.
- Three separate `__gap` surfaces on Governor (concrete + 2 abstracts) — auditing must hold all three.
- `BPS_DENOMINATOR` and `EPOCH_DURATION` constants duplicated across 5+ contracts.
- Asymmetric setter event semantics (Factory has 4 distinct events; Governor + Registry use uniform `ParameterChangeFinalized`).

---

## 6. Low / Info Findings (56)

(Selected. Full lists in source reports.)

- L-V-01 · `deactivate(syndicateId)` is one-way; no `reactivate`. `SyndicateFactory.sol:299-306`.
- L-V-02 · `getAllActiveSyndicates` recursive `this.getActiveSyndicates` adds ~700 gas per call. `SyndicateFactory.sol:438-441`.
- L-V-03 · `BatchExecutorLib` named "Lib" but is a contract — misleading.
- L-V-04 · Storage `__gap[38]` math undocumented; future contributor may miscount.
- L-G-01 · `propose` doesn't check `metadataURI` is well-formed (length-only check).
- L-G-02 · `cancelProposal` Draft `+1` overflow check is safe (info-only after fp-check).
- L-G-03 · `getProposalCalls` concatenates execute+settle for legacy callers (info, doc).
- L-G-04 · `vetoProposal` / `emergencyCancel` don't check `proposal.id != 0` early — opaque revert on bogus pid.
- L-G-05 · `_resolveState` for non-existent pid emits `CollaborationDeadlineExpired(0)` once — event spam.
- L-G-06 · Hand-rolled `nonReentrant` storage slot vs OZ `ReentrancyGuardTransient` — gas tradeoff for bytecode.
- L-R-01 · `BlockerAttributed.epochId` calculated from `block.timestamp` at resolve — keeper controls ±1 epoch.
- L-R-02 · `uint32` timestamp truncation — Year 2106 issue (industry standard, document).
- L-R-03 · `_isActiveGuardian` short-circuits on unstake-pending; delegations don't auto-revoke (UX).
- L-R-04 · `transferOwnerStakeSlot` over-writes correctly but path through slash leaves "ghost" timestamp briefly (defensive note).
- L-R-05 · `flushUnclaimedApproverFee` doesn't emit a flush event (UX/observability).
- L-R-06 · `cancelEmergencyReview` doesn't zero `er.totalStakeAtOpen` etc. — overwritten on next open (defensive).
- L-R-07 · `BURN_ADDRESS = 0xdEaD` not canonical burn (`address(0)`) — `getPastTotalSupply` includes dead-address balance.
- L-R-08 · `claimUnstakeGuardian` not pause-gated (intentional for guardian exit; document).
- L-T-01 · `WoodToken._lzEndpoint` zero-check missing (constructor-time, OAppCore likely catches).
- L-T-02 · `Minter.voteWoodFed` re-uses T-C3 inflated balance reading.
- L-T-03 · `EPOCH_START_REFERENCE` immutable — no reset path for misconfig.
- L-T-04 · Many "view" functions revert (e.g., `getLock` `TokenNotExists`) — UX-unfriendly.
- L-T-05 · `withdraw` doesn't burn `_lockAmountHistory[tokenId]` — stale history accumulates.
- L-S-01 · `BaseStrategy.executed()` returns `false` after settle (lifecycle one-shot).
- L-S-02 · `BaseStrategy.positionValue()` not gated by `_initialized`; pre-init returns `(0, false)`.
- L-S-03 · `WstETHMoonwellStrategy` no `_pushAllToVault(0)` self-clear.
- L-S-04 · `HyperliquidPerpStrategy.getPosition()` returns latest-traded-asset only, not union.
- L-S-05 · `HyperliquidPerpStrategy.STOP_LOSS_CLOID` is per-template constant (assumption documented).
- L-S-06 · `HyperliquidPerpStrategy.leverage` not changeable post-init (document re-clone).
- L-S-07 · `VeniceInferenceStrategy.repaymentAmount = 1` allowed (I-14).
- L-S-08 · `UniswapSwapAdapter._reversePath` no upper-bound on path length (validates modulo only).
- L-S-09 · `UniswapSwapAdapter._extractFirstAddress` trusts caller's path direction.
- L-S-10 · `SynthraDirectAdapter.quote()` returns 0 unconditionally (false signaling).
- L-S-11 · `Create3Factory.addressOf` no collision warning.
- L-S-12 · `L1Read.position` (uint16) and `position2` (uint32) coexist — legacy fn risk for future contributors.
- L-S-13 · `L1Write` action selectors mixed packed/abi-encoded — schema fragility.
- L-X-01 · `architecture.mdx:60-70` vault storage `__gap[40]` — actual is 38. doc.
- L-X-02 · `economics.mdx:24` correctly notes T-C1; `settlement.mdx:24` still references the WOOD/SHARES pool (X14).
- L-X-03 · `MAX_CALLS_PER_PROPOSAL = 64` not in public docs (X82).
- L-X-04 · `MAX_METADATA_URI_LENGTH = 512` not in public docs (X83).
- L-X-05 · `architecture.mdx:150` governor margin "~70 bytes" — actual is 765 bytes post-V1.5. doc.

---

## 7. Verified Closures (cross-checked against live code)

The following pre-mainnet punch-list rows were re-verified as closed in current code:

| Ref | File:line confirming closure |
|---|---|
| **V-C2** delegatecall codehash + nonReentrant | `SyndicateVault.sol:343, 340` |
| **V-C3** owner `executeBatch` removed | grep returns 0 hits in `SyndicateVault.sol` |
| **V-C4** paginated `getActiveSyndicates` w/ `MAX_PAGE_LIMIT = 100` | `SyndicateFactory.sol:410-434` |
| **V-H1** factory atomic init via `ERC1967Proxy(impl, encodedInitCall)` | `SyndicateFactory.sol:258` |
| **V-H2** `setGovernor` removed; `governor` set-once | `SyndicateFactory.sol:96-103` |
| **V-H3** `upgradeVault(vault, expectedImpl)` w/ `VaultImplMismatch` | `SyndicateFactory.sol:379-391` |
| **V-H5** `rescueEth` blocked when redemptionsLocked | `SyndicateVault.sol:469-473` |
| **V-H6** no `receive()` on vault | grep returns 0 hits |
| **V-M1** `_decimalsOffset` cached at init | `SyndicateVault.sol:105, 132, 433-435` |
| **V-M3** paginated views | `SyndicateVault.sol:187-194, 225-227` |
| **V-M5** `removeAgent` deletes struct | `SyndicateVault.sol:286` |
| **V-M7** config validation (5 checks) | `SyndicateFactory.sol:218-222` |
| **V-M9** `GovernorBatchExecuted` event | `SyndicateVault.sol:353` |
| **I-1** `redemptionsLocked` reverts on governor==0 | `SyndicateVault.sol:371-372` |
| **G-C1** `snapshotTimestamp = block.timestamp - 1` (2 sites) | `SyndicateGovernor.sol:302, 503` |
| **G-C2/G-C3** `_activeProposal` only set/cleared by execute/finishSettlement | `SyndicateGovernor.sol:373, 924` |
| **G-H2** `cancelProposal` Draft near-quorum revert | `SyndicateGovernor.sol:421-424` |
| **G-H3** `getVoteWeight` reverts `ProposalInDraft` | `SyndicateGovernor.sol:621` |
| **G-H4** veto check skipped on `pastTotalSupply == 0` | `SyndicateGovernor.sol:859` |
| **G-H5** `executeBy` boundary inclusive | `SyndicateGovernor.sol:875, 890` |
| **G-H6** `vetoThresholdBps` snapshotted Draft→Pending | `SyndicateGovernor.sol:309, 508` |
| **G-M1** `openProposalCount[vault] != 0` gate | `SyndicateGovernor.sol:262, 498` |
| **G-M2/G-M6** `MAX_CALLS_PER_PROPOSAL = 64` enforced | `SyndicateGovernor.sol:84, 269` (NOT enforced in `emergencySettleWithCalls` — see H-G-06) |
| **G-M7** `emergencyCancel` requires Draft/Pending | `SyndicateGovernor.sol:440-441` |
| **G-M9** `addVault` extcodesize check | `SyndicateGovernor.sol:541-545` |
| **G-M11** `MAX_METADATA_URI_LENGTH = 512` | `SyndicateGovernor.sol:80, 273` |
| **W-1** `_payFee` try/catch + escrow keyed by `(vault, recipient, token)` | `SyndicateGovernor.sol:1057-1066, 1087` |
| **I-3** `_distributeFees` re-asserts `_protocolFeeRecipient != 0` | `SyndicateGovernor.sol:961` |
| **A-C4** `Create3.deploy` checks `success && code.length > 0` | `Create3.sol:35-37` |
| **A18** shareholder vetoProposal claim removed from concepts.mdx | `mintlify-docs/learn/concepts.mdx:47` |
| **A19** per-syndicate governance claim removed | `concepts.mdx:49`, `governance/overview.mdx:126` |
| **A20** vault.lockRedemptions removed | `settlement.mdx:21` |
| **A21** vault.executeBatch removed (top of page) | `settlement.mdx:27` |
| **A22** fee try/catch documented | `economics.mdx:79-93` |
| **A24** capitalRequired field removed | `governance/overview.mdx:91-93` |
| **A25** block.number→timestamp snapshot | `governance/overview.mdx:95-97` |
| **A26** ≤ 9000 BPS co-prop split | `collaborative-proposals.mdx:48` |
| **A27** absolute max 10 co-proposers | `collaborative-proposals.mdx:52` |
| **A28** expireCollaboration removed | `collaborative-proposals.mdx:70` |
| **A29** execute/settle permissionless | `collaborative-proposals.mdx:104` |
| **A34** HyperEVM feature matrix fixed | `chains/999.json` |
| **ToB C-1** `openReview` snapshots at `block.timestamp - 1` | `GuardianRegistry.sol:1049, 1103` |
| **ToB I-2** approver cap = 100, blocker cap = 100 | `GuardianRegistry.sol:51, 57` |
| **ToB P1-3/P1-4/P1-5** registry simplification — `recordEpochBudget`, `minter`, `setMinter`, `activeGuardianCount`, `_emergencyVoteStake`, `setCoolDownPeriod`, `guardianFeeRecipient`, `setGuardianFeeRecipient` all removed | grep returns 0 hits in `GuardianRegistry.sol` |

---

## 8. Code-Maturity Scorecard (ToB 9-category framework)

Reproduced from `audit-maturity.md` §1.

| # | Category | Rating | Score |
|---|---|---|---:|
| 1 | Arithmetic | Satisfactory | 3/4 |
| 2 | Auditing (logging / monitoring) | Moderate | 2/4 |
| 3 | Access controls | Moderate | 2/4 |
| 4 | Complexity management | Moderate | 2/4 |
| 5 | Decentralization | **Weak** | 1/4 |
| 6 | Documentation | Satisfactory | 3/4 |
| 7 | Front-running / MEV resistance | Moderate | 2/4 |
| 8 | Low-level manipulation | Satisfactory | 3/4 |
| 9 | Testing & verification | Moderate | 2/4 |
| **Overall** | | **Moderate** | **20/36 ≈ 56%** |

**Headline drivers:**
- **Decentralization Weak** — V1.5 has zero on-chain timelock; "owner is a Gnosis Safe + Zodiac Delay" is operational not on-chain. Vault owner = single EOA in typical creator flow. Multisig holds every UUPS upgrade key + every parameter setter on every contract.
- **Arithmetic Satisfactory not Strong** — D-1 (Minter rebase denominator), D-2/D-3/D-4 (strategy decimals), G-C7 (co-proposer rounding) prevent Strong rating.
- **Testing Moderate not Satisfactory** — invariant harnesses INV-3/-9/-10 are structural scaffolding without lifecycle exercise (per punch-list 7.5); 26 Critical findings lack PoC tests; no fork tests for Synthra / Hyperliquid / Mamo / `WoodToken` LZ; no formal verification.

---

## 9. Cross-Cutting Themes

### 9.1 Owner-at-now vs. owner-at-action-time (single-fix family)
A single semantic fix — **snapshot owner address into the action record at vote time** — closes 3 findings:
- T-C5 / H-T-05 (`VoteIncentive.claimIncentives` current-owner check)
- M-T-06 (`RewardsDistributor.claimRebase` current-owner check)
- T-C4 / H-T-04 (veNFT transfer during votes)

### 9.2 Historical reads using current state (single-fix family)
A single semantic fix — **implement Curve point-history binary search using existing `_pointHistory`** — closes:
- T-C3 / C-16 (`VotingEscrow.balanceOfNFTAt`)
- H-T-08 (`Voter._removeExistingVotes` underflow)
- M-T-09 (`_totalSupplyAt` unbounded iteration)
- M-T-10 (`flipEpoch` `_isQuorumMet` totalSupply read)

### 9.3 Synthra adapter compounding
C-02 + C-03 + C-04 + H-S-13 are all in `SynthraDirectAdapter` and are mutually-amplifying. Either remove the direct adapter from V1 or land all four fixes atomically. Per punch-list §8: "Retire `SynthraDirectAdapter` or allowlist specific pools."

### 9.4 Spec timelock drift (single-doc-fix family)
C-17 / H-X-06 / H-X-08 / M-X-14 + scattered references all stem from one cause: V1.5 deleted the parameter timelock entirely. **A single mintlify PR** that does a code-wide find-and-replace on "timelock", "queue/finalize", "6h-7d delay", "`_parameterChangeDelay`", "`finalizeParameterChange`" closes ~12 doc rows.

### 9.5 V1.5 functionality entirely undocumented (single-doc-fix family)
H-X-18: stake-pool delegation, DPoS commission, on-chain guardian-fee pool, off-chain Merkl block-rewards. Mirror `docs/superpowers/specs/2026-04-21-guardian-delegation-v1.5-design.md` into `mintlify-docs/protocol/governance/`.

---

## 10. Top 25 Pre-Audit Action Items

Ranked by audit-blast-radius reduction per engineer-day. Code fixes first, then doc fixes.

### Code (15)

| # | Item | Severity | ETA |
|---|---|---|---|
| 1 | **C-01 / S-C1** — add `_disableInitializers()` to all 7 strategy template constructors (or atomic factory wrapper) | Critical | 2h |
| 2 | **C-02 / S-C2** — auth `synthraV3SwapCallback` with `require(msg.sender == factory.getPool(...))` | Critical | 1h |
| 3 | **C-03 / A2** — wire `amountOutMin` into `SynthraDirectAdapter.swap` body | Critical | 1h |
| 4 | **C-05 / S-C4** — wire `maxSlippageBps` into `amountOutMin` at all 6 PortfolioStrategy swap sites | Critical | 3h |
| 5 | **C-08 / Governor C1** — add `proposal.state` guard to `finalizeEmergencySettle`; clear `_capitalSnapshots` and `_emergencyCalls` in `_finishSettlement` | Critical | 2h |
| 6 | **C-10** — drop `unchecked` from `_decOpen` | Critical | 5min |
| 7 | **C-11 / G-C7** — round-up co-proposer share (or floor at 1 wei) | Critical | 1h |
| 8 | **C-12 / Governor C5** — rate-limit `emergencySettleWithCalls` re-opens | Critical | 2h |
| 9 | **C-13 / Registry C-01** — `if (paused) revert AlreadyPaused();` | Critical | 5min |
| 10 | **C-14 / WOOD-1** — add `_totalEverMinted` HWM in `WoodToken`; gate `mint` on it | Critical | 5h |
| 11 | **C-16 / T-C3** — implement Curve point-history binary search using existing `_pointHistory` | Critical | 3 days |
| 12 | **A-C1** — add `Ownable` to `Create3Factory.deploy` | High | 1h |
| 13 | **V-C1** — donation-immune PnL: `IStrategy.settle() returns (int256 realized)` or pre/post snapshot around settle batch only | High | 1-2 days |
| 14 | **D-1 / H-T-02** — switch `Minter.calculateRebase` denominator to `totalLockedAmount()` | High | 10min |
| 15 | **G-C6** — add `nonReentrant` to remaining governor externals (`addVault`, `removeVault`, `resolveProposalState`, `approveCollaboration`, `rejectCollaboration`, `claimUnclaimedFees`) — verify each with fp-check first | High | 2h |

### Code (additional) (5)

| # | Item | Severity | ETA |
|---|---|---|---|
| 16 | **T-C1** — strip `claimLPRewards` (set `getLPRewardPercentage` → 0) until UniV3 integration; add `emergencyRescue` | High | 2h |
| 17 | **T-C7 / H-T-11** — pro-rate `VaultRewardsDistributor.claimRewards` by deposit-time-within-epoch | High | 1 day |
| 18 | **T-C5 + T-C4** — snapshot vote-time owner in `VoteAllocation`; block veNFT transfer while votes attached | High | 4h |
| 19 | **MockSwapAdapter + CoreWriter** → move from `src/` to `test/mocks/` | Critical (operational) | 30min |
| 20 | **D-2 / H-S-05** — read `perpAssetInfo.szDecimals + pxDecimals` from HyperCore in HyperliquidPerpStrategy notional math | High | 4h |

### Documentation (5)

| # | Item | Severity | ETA |
|---|---|---|---|
| 21 | **C-17** — V1.5 timelock-removal pass on `mintlify-docs/`: drop every `_parameterChangeDelay` / `finalizeParameterChange` / "6h-7d delay" reference | Critical | 4h |
| 22 | **C-18** — replace `fundEpoch`/`claimEpochReward`/`sweepUnclaimed` references with off-chain Merkl + `BlockerAttributed` event | Critical | 2h |
| 23 | **C-19** — add Guardian Fee row to `architecture.mdx` bound table + `economics.mdx` fee waterfall | Critical | 1h |
| 24 | **H-X-18** — ship public V1.5 page covering delegation + commission + on-chain guardian-fee pool | High | 1 day |
| 25 | **H-X-16** — add `WoodToken` and `GuardianRegistry` to `chains/{8453,84532,999}.json` and `deployments.mdx`; fix Hyperliquid template address mismatch (X28) | High | 2h |

---

## 11. Suggested Engagement Handoff Package

For external auditors:

1. `docs/pre-mainnet-punchlist.md` — canonical ref-coded tracker
2. **This report** — synthesized findings with severity tiers
3. `/tmp/sherwood-audit-{vault,governor,registry,tokenomics,strategies,spec,maturity}.md` — domain-deep reports
4. `docs/superpowers/specs/2026-04-19-guardian-review-lifecycle-design.md`
5. `docs/superpowers/specs/2026-04-21-guardian-delegation-v1.5-design.md`
6. `CLAUDE.md` — project intent
7. `chains/{8453,84532,999}.json` — live addresses
8. `mintlify-docs/` clone with explicit caveat: drift items A18-A41 mean `src/` is authority

Freeze a commit + audit-branch tag at engagement start; pin `lib/` submodules to current versions.

---

## 12. Skills Used (per ToB skill catalog)

- `entry-point-analyzer:entry-point-analyzer` — full attack-surface enumeration across all contracts
- `audit-context-building:audit-context-building` — line-by-line architectural pass on stateful contracts
- `building-secure-contracts:guidelines-advisor` — best-practices review (upgradeability, access control, dependencies)
- `building-secure-contracts:code-maturity-assessor` — 9-category scorecard
- `building-secure-contracts:audit-prep-assistant` — pre-audit readiness gaps
- `building-secure-contracts:token-integration-analyzer` — WoodToken multi-inherit + ERC20 conformity
- `dimensional-analysis:dimensional-analysis` — USDC 6-dec, WOOD 18-dec, BPS 10000, lock-duration weight
- `spec-to-code-compliance:spec-to-code-compliance` — docs.sherwood.sh ↔ src/ verification
- `insecure-defaults:insecure-defaults` — fail-open defaults, hardcoded values, zero-checks
- `sharp-edges:sharp-edges` — footgun APIs, dangerous patterns, "Lib"-named contracts
- `variant-analysis:variant-analysis` — pattern matches across found bugs
- `property-based-testing:property-based-testing` — recommended invariants (8 for registry alone)
- `fp-check:fp-check` — false-positive verification on selected findings

---

**End of report.** 222 newly-identified findings. Source detail in `/tmp/sherwood-audit-*.md` (4,051 lines / ~300 KB combined). Synthesis covers core contracts and strategy templates per the audit scope.
