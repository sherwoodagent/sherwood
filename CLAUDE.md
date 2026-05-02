# CLAUDE.md — Sherwood Development Guide

## Git Workflow

**NEVER commit directly to `main`.** Always:

1. Create a feature branch: `git checkout -b <type>/<short-description>`
   - Types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`
   - Examples: `feat/vault-agent-registry`, `fix/usdc-decimals`, `test/vault-redeem`

2. Make atomic commits with conventional commit messages:
   - `feat: add syndicate-level caps to vault contract`
   - `fix: account for USDC 6 decimals in deposit math`
   - `test: vault redeem returns pro-rata shares`
   - `docs: update README with vault architecture`

3. Push the branch and create a PR with the template (auto-loaded from `.github/`)

4. PR description must include:
   - Which package is touched (`contracts`, `cli`, `app`)
   - What changed (adds / fixes / refactors)
   - How it was tested (forge test output, manual steps, etc.)

5. Never force push, never delete branches, never rewrite history.

6. **Before `git checkout -b` for a new feature, `git stash` any pre-staged work** — the staged index carries into the new branch and you'll silently commit prior work on the wrong branch.

## Code-review workflow

For multi-domain audits/reviews, dispatch parallel subagents by domain (vault / governor / strategies / tokenomics / adapters) rather than sequential whole-codebase passes. Cross-cutting patterns surface better when each agent can go deep. For ToB-style maturity + process reviews, use the `building-secure-contracts`, `entry-point-analyzer`, `dimensional-analysis`, and `spec-to-code-compliance` skills.

- **ToB skill catalog** at `~/.claude/plugins/cache/trailofbits/` — `guidelines-advisor`, `insecure-defaults`, `entry-point-analyzer`, `code-maturity-assessor`, `spec-to-code-compliance`, `second-opinion`, `property-based-testing`, `dimensional-analysis`, `audit-prep-assistant`, etc. For spec review, dispatch parallel subagents each loading one `SKILL.md` + the target spec — avoids main-context bloat.
- **Full-PR ToB review**: dispatch 4 parallel read-only agents in a single message — `entry-point-analyzer`, `differential-review`, `spec-to-code-compliance`, `audit-context-building` (for state machines). Each writes to a distinct `/tmp/tob-review-*.md` file. Synthesize into C/I/P priority tiers. Verify each P1 finding with a grep before acting — agents occasionally self-correct after second reads.
- **Parallel subagents must write to disjoint files.** If two agents both edit `SyndicateGovernor.sol` / `GovernorParameters.sol` / same test suites, they stall silently (observed: two 25-minute stalls). Before dispatch, map each agent's write set and confirm no overlap. `TaskStop` terminates a stalled agent; revert its dirty tree with `git stash` (NOT `git checkout --`) so its partial work can be inspected later.
- **Spec authoring**: design specs live at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Do NOT accumulate review changelogs inside the spec — git log + PR comment thread hold that history, the spec should read as a final design. If you catch yourself writing a 4th "Changelog — review N" section, stop and trim.
- **Fetch a specific PR comment by permalink**: `gh api repos/<owner>/<repo>/issues/comments/<comment_id> --jq '.body'` (the URL suffix `#issuecomment-<id>` gives you the comment_id).

## Project Structure

```
contracts/      Foundry — Solidity smart contracts
cli/            TypeScript CLI (viem, Commander)
app/            Next.js dashboard
cron/           Hermes Agent skills + jobs template for paper-trading + monitoring
mintlify-docs/  Mintlify documentation site (git submodule → docs.sherwood.sh)
```

For background paper-trading + vault/proposal/chat monitoring via cron, see
`cron/README.md`. The four shipped skills are agent-runtime-agnostic
(SKILL.md format) and `cron/install.sh` registers them with Hermes.

## Documentation

Full protocol and CLI documentation: **https://docs.sherwood.sh/**

Source lives in `mintlify-docs/` (git submodule pointing to `imthatcarlos/mintlify-docs`).

**Authority order when docs and code disagree:** `contracts/chains/{chainId}.json` (addresses) → `contracts/src/` (behavior) → this CLAUDE.md (intent) → `mintlify-docs/` last. Known drift areas: `reference/deployments.mdx` (stale Base addresses), `settlement.mdx` (references removed `lockRedemptions` and the removed owner-direct `executeBatch` — only `executeGovernorBatch` exists on the vault now, V-C3), `concepts.mdx` (says shareholders can `vetoProposal` — they can't), `collaborative-proposals.mdx` (incorrect auth claims). See issue #226 §4.

**Pre-mainnet tracking:** `docs/pre-mainnet-punchlist.md` + GitHub issue #236 are mirrors. Every fix PR must update BOTH with the ref code (V-C1, G-C5, etc.) and the commit SHA closing the row. #225 and #226 are closed as superseded by #236.

LLM-friendly versions:
- `https://docs.sherwood.sh/llms.txt` — structured index
- `https://docs.sherwood.sh/llms-full.txt` — complete docs in a single file

Key sections: [Learn](https://docs.sherwood.sh/learn/quickstart) | [Protocol](https://docs.sherwood.sh/protocol/architecture) | [CLI](https://docs.sherwood.sh/cli/commands) | [Reference](https://docs.sherwood.sh/reference/deployments)

**Keep docs in sync.** When changes touch contracts, CLI, or app, update the corresponding pages in `mintlify-docs/`:
- Contract changes → `protocol/architecture.mdx`, `protocol/governance/*.mdx`
- CLI command changes → `cli/commands.mdx`, `cli/governance-commands.mdx`
- Address/deployment changes → `contracts/chains/{chainId}.json` (auto-written by deploy scripts), `cli/src/lib/addresses.ts`, `reference/deployments.mdx`, `skill/ADDRESSES.md`
- Integration changes → `reference/integrations/*.mdx`
- New features → `learn/concepts.mdx` if it introduces a new primitive

## Contracts

- Solidity 0.8.28, Foundry, OpenZeppelin upgradeable (UUPS)
- USDC on Base has **6 decimals** not 18 — always account for this
- Use SafeERC20 for all token transfers
- Run `forge build` and `forge test` before every PR
- Run `forge fmt` before committing. CI runs `forge fmt --check` — always run `forge fmt` locally before pushing contract changes.
- SyndicateGovernor runtime is **24,255 / 24,576 bytes (321-byte EIP-170 margin)** as of 2026-04-30 post-PR #256 (`_initPendingProposal` extraction for `forge coverage`). Run `forge build --sizes` before any governor edit.
- GuardianRegistry runtime is **24,306 / 24,576 bytes (270-byte EIP-170 margin)** as of 2026-04-30 post-PR #252 review fix. **Any addition requires bytecode reduction levers.** Levers already used: dropped `nonReentrant` where CEI is respected, dropped external `pending*` views, dropped `getPastVoteWeight`/`getPastDelegationTo` convenience views, dropped `activeGuardianCount` + `minter` + `_emergencyVoteStake` + `recordEpochBudget`, dropped the entire `getPast*` view family (PR #252 — see #254 for off-chain reconstruction guidance).
- **`via_ir` is on** in `foundry.toml`. Compile is ~2× slower than the legacy pipeline. Required to fit `GovernorEmergency` under the bytecode limit — do not disable without re-measuring the governor.
- Under `via_ir = true`, the IR optimizer reorders `block.timestamp` reads across `vm.warp` cheatcodes. In tests, use `vm.getBlockTimestamp()` at each read site — never cache it in a local before a warp.
- `openReview` / `openEmergencyReview` snapshot votable stake at `block.timestamp - 1` (ToB C-1). Tests that stake guardians and open a review in the same block fail with `NotActiveGuardian` because the checkpoint at `t-1` is 0. Fix: `vm.warp(vm.getBlockTimestamp() + 1)` between staking and `openReview`.
- `forge test --no-match-path "test/integration/**"` skips fork tests that need RPC — use this for local iteration.
- Reentrancy guard: use `@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol` (EIP-1153; Cancun-required but Base supports it). OZ v5 upgradeable doesn't ship `ReentrancyGuardUpgradeable`; transient is cheaper and storage-slot-free.
- Bytecode reduction levers for `SyndicateGovernor`: (a) hoist shared event emits out of the `_applyChange` `else if` chain in `GovernorParameters` (saves ~20-50 bytes/branch), (b) drop per-parameter typed `*Updated` events in favor of the uniform `ParameterChangeFinalized(key, old, new)` (saved 482 bytes in one pass), (c) enable/bump `via_ir` (already on). (d) Drop `bytes` / dynamic-length event params — memory encoding for dynamic fields costs ~70 bytes/event (biggest single-shot lever; used on `FeeTransferFailed` in the W-1 rekey). (e) Factor repeated `keccak256(abi.encode(...))` sites into a `private pure` helper — ~15 bytes. (f) Drop `nonReentrant` when CEI is verifiably respected (state write before external call + same-key reentry hits zero slot) — ~20 bytes. Counterintuitive under via_ir: `abi.encode` is cheaper than `abi.encodePacked` for fixed-width inputs (+9 bytes with packed); dropping `indexed` on an address topic *increases* bytecode (memory encoding > topic push). `optimizer_runs` bumps didn't help meaningfully at runs=50.
- via_ir inlines trivial virtual pass-throughs. Collapsing a 9-function `_getX`/`_setX` override chain (P2-1) saves ~1 byte, not ~50. Reach for this for clarity, not size.
- CI size gate filter: `forge build --sizes --json | jq -r '.SyndicateGovernor.runtime_size // empty'` — `// empty` makes an unknown contract fail the check loudly instead of silently passing.

### Address Management

- Deploy scripts auto-write to `contracts/chains/{chainId}.json` (CAPS_SNAKE_CASE keys: `SYNDICATE_FACTORY`, `SYNDICATE_GOVERNOR`, etc.)
- Admin scripts (QueueParams, FinalizeParams) read from the same JSON — no env vars needed
- All scripts inherit `script/ScriptBase.sol` for shared helpers (`_writeAddresses`, `_readAddress`, `_checkAddr`, `_checkUint`)
- After redeployment, also update: `cli/src/lib/addresses.ts`, `mintlify-docs/reference/deployments.mdx`

### Architecture

Live contract sizes from `forge build --sizes` (2026-04):

| Contract | Runtime | Notes |
|---|---|---|
| SyndicateGovernor | 24,524 | **52-byte EIP-170 margin** (post Phase 2 adapter binding; tight — re-measure before any edit) |
| SyndicateFactory | 14,600 | grew with `VaultWithdrawalQueue` deploy at `createSyndicate` (Phase 1 async-redeem) |
| GuardianRegistry | 24,306 | **270-byte EIP-170 margin** (post-PR #252 review fix) |
| SyndicateVault | 22,399 | CI gate bumped to 22,500; live-NAV adapter slot + lock-aware deposit/withdraw + `onLiveDeposit` forwarding (Phase 2) |
| VaultWithdrawalQueue | 2,502 | per-vault async redemption escrow (Phase 1 live-NAV / async-withdrawals) |
| MoonwellSupplyStrategy | 3,659 | absorbs mid-strategy LP deposits via `onLiveDeposit` override (Phase 2) |
| WoodToken | 15,850 | ERC20Votes + OFT multi-inherit (Phase 1 V1.5) |

- **SyndicateVault** — ERC-4626 vault with ERC20Votes for governance. Standard `redeem()`/`withdraw()` for LP exits (no custom ragequit). `_decimalsOffset()` = `asset.decimals()` for first-depositor inflation protection (shares have 12 decimals for USDC). Deposits and `rescueERC20` are blocked during active proposals (`redemptionsLocked()`).
- **SyndicateGovernor** — Proposal lifecycle, optimistic voting, execution, settlement, collaborative proposals. Inherits `GovernorParameters` (abstract) for parameter setters/timelock and `GovernorEmergency` (abstract) for `unstick` / `emergencySettleWithCalls` / `cancelEmergencySettle` / `finalizeEmergencySettle`. The `GovernorEmergency` extraction plus `via_ir` keep the runtime under 24,550 bytes with the guardian-review changes.
- **GovernorEmergency** — Abstract extracted from `SyndicateGovernor` (PR #229). Holds the four emergency-settle entrypoints and the calldata-commit / hash-check helpers. `emergencySettleWithCalls` opens a guardian review in the registry; `finalizeEmergencySettle` executes if not blocked, reverts if blocked.
- **GovernorParameters** — Abstract contract with constants, bounds, and parameter setters. **V1.5: timelock removed.** Setters apply immediately on owner call; owner is a multisig that enforces its own delay (Gnosis Safe + Zodiac Delay). Each setter validates bounds + writes via per-param `_setX` virtual + emits a uniform `ParameterChangeFinalized(key, old, new)` event.
- **GuardianRegistry** — UUPS upgradeable single contract for guardian staking + owner staking + review vote accounting (approve/block + vote-change) + slashing (approver stake burned on block quorum) + **V1.5 stake-pool delegation + DPoS commission + on-chain guardian-fee claim + W-1 escrow**. Epoch WOOD block-rewards moved off-chain to Merkl (registry only emits `BlockerAttributed` events for the bot to attribute). Vault-asset guardian fees stay on-chain via `_proposalGuardianPool` + `claimProposalReward` + `claimDelegatorProposalReward`.
- **SyndicateFactory** — UUPS upgradeable factory. Deploys vault + registers it with the governor. `governor` and `guardianRegistry` are both **set-once at init** (no `setGovernor` — removed to close V-H2; governor upgrades must go through a UUPS upgrade of the governor proxy itself). `createSyndicate` requires the creator to have called `guardianRegistry.prepareOwnerStake` first; `bindOwnerStake` binds the prepared stake to the new vault atomically. `rotateOwner(vault, newOwner)` provides a slot-transfer recovery path for a dead-key vault owner. Owner-configurable: `setVaultImpl`, `setCreationFee`, `setManagementFeeBps`, `setUpgradesEnabled`.
- **BatchExecutorLib** — Stateless 63-line contract for `delegatecall`-based batch execution. The "delegatecall to BatchExecutorLib only" invariant **is enforced in code** via V-C2: `SyndicateVault.initialize` stamps `_expectedExecutorCodehash = executorImpl.codehash`, and `executeGovernorBatch` reverts with `ExecutorCodehashMismatch` if the pinned codehash drifts at call time.
- **Strategy Templates** — `BaseStrategy` (abstract) + `MoonwellSupplyStrategy` + `AerodromeLPStrategy`. ERC-1167 clonable. Vault calls `execute()`/`settle()` via batch.

### Async withdrawal queue

- **VaultWithdrawalQueue** — per-vault, deployed by the factory at `createSyndicate` time. Bound on the vault via factory-only `setWithdrawalQueue`.
- LPs call `vault.requestRedeem(shares, owner)` ONLY while `redemptionsLocked() == true` (a strategy proposal is active). Shares are escrowed in the queue (no burn). Each request gets a `requestId` and lives in `Request{owner, shares, requestedAt, claimed, cancelled}`.
- Anyone calls `queue.claim(requestId)` once `redemptionsLocked() == false` — the queue calls `vault.redeem(shares, owner, address(queue))`, the vault burns the queued shares and forwards underlying assets to the original owner.
- Queue owners can `cancel(requestId)` any time before claim — shares are returned to them.
- Vault tracks `pendingQueueShares()` and `reservedQueueAssets()`. Standard `withdraw`/`redeem` from non-queue callers is capped via `maxWithdraw`/`maxRedeem` overrides so queue claims cannot be starved. The queue address is special-cased to bypass these caps.
- `_withdraw` keeps a `caller != _withdrawalQueue` reserve guard as defense-in-depth.

### Live NAV via strategy adapter (V2)

- **Adapter binding flow** — Proposer creates a strategy clone, then before execute calls `governor.bindProposalAdapter(proposalId, adapter)`. The governor pushes the address synchronously onto `vault._activeStrategyAdapter` via `setActiveStrategyAdapter`. No governor-side mapping is kept (size-aware redesign — every byte counts at the 24,524-byte governor runtime).
- **Bind window closes at Approved** — `bindProposalAdapter` is gated to `Draft || Pending` AND `_approvedCount == 0`. Once a co-proposer approves OR the vote ends, binding is permanently impossible — the proposal will execute without live NAV and deposits/withdraws stay locked for its duration. `sherwood strategy propose` auto-binds the freshly-cloned adapter (CLI v0.53.0+, PR #271); `sherwood proposal bind-adapter --id N --adapter 0x…` is the escape hatch for proposals submitted before that change. There is no recovery path for proposals already Approved without an adapter — they must run their course or be cancelled+reproposed.
- **Implicit clear via lock state** — The vault's `totalAssets` ignores `_activeStrategyAdapter` whenever `!redemptionsLocked()`. After settle, the slot retains the last-bound address but it has zero observable effect. Re-bind on the next proposal overwrites it.
- **Live NAV math** — `totalAssets() = float + (adapter == 0 || !locked ? 0 : (valid ? value : 0))`. Standard OZ ERC-4626 virtual-shares math is unchanged.
- **Lock relaxation** — `_deposit` and `_withdraw` revert only when `redemptionsLocked() && !_liveNAVAvailable()`. When live NAV is available, both are unlocked. `requestRedeem` still requires `redemptionsLocked() == true` (queue path) and works regardless of adapter validity.
- **`onLiveDeposit` hook** — `vault._deposit` forwards new assets via `IStrategy(adapter).onLiveDeposit(assets)` after `super._deposit`. Default in `BaseStrategy` is a no-op; `MoonwellSupplyStrategy` overrides to mint additional mTokens. Push-and-call: vault `safeTransfer`s the assets to the adapter, then calls `onLiveDeposit` (no `transferFrom` allowance flow).
- **Strategy support matrix** — see `docs/superpowers/specs/2026-04-30-live-nav-async-withdrawals-design.md` §6. Currently only `MoonwellSupplyStrategy` is wired for live NAV; other adapters inherit the default no-op and the vault falls back to queue-only behavior under their proposals.

### Governor Key Concepts

- **Optimistic governance** — Proposals pass by default after voting period ends. Only rejected if AGAINST votes reach `vetoThresholdBps`. Vault owner can `vetoProposal()` only while the proposal is `Pending`; once the proposal enters `GuardianReview`, the only way to block is a guardian block-quorum.
- **VoteType enum** — `For`, `Against`, `Abstain` (replaces boolean vote).
- **Separate `executeCalls` / `settlementCalls`** — Proposals store opening and closing calls in two distinct arrays. No `splitIndex`.
- **No on-chain parameter timelock (V1.5)** — Setters (`setVotingPeriod`, `setProtocolFeeBps`, `setGuardianFeeBps`, `setFactory`, etc.) apply immediately on owner call. Owner is a multisig that enforces its own delay via Gnosis Safe + Zodiac Delay. Each setter validates bounds at call time and emits a uniform `ParameterChangeFinalized(key, old, new)` event.
- **Protocol fee** — `protocolFeeBps` + `protocolFeeRecipient` taken from gross profit before agent and management fees. Max 10%. Setting nonzero `protocolFeeBps` requires `protocolFeeRecipient` to be set first.
- **Guardian fee (V1.5)** — `guardianFeeBps` (max 5% / 500 bps) + `guardianFeeRecipient` (set to GuardianRegistry at deploy). On successful settle, a slice is transferred to the registry which stamps `_proposalGuardianPool[proposalId]`. Approvers claim via `registry.claimProposalReward(pid)` (DPoS commission split); delegators via `registry.claimDelegatorProposalReward(delegate, pid)`. W-1 escrow handles USDC-blacklist-style transfer failures (`flushUnclaimedApproverFee` retries). Fixes the approve-bias problem (V1 only rewarded blockers).
- **Four emergency entrypoints** (on `GovernorEmergency`): (1) `unstick()` — owner-instant, pre-committed calls only, no new calldata; (2) `emergencySettleWithCalls(calls)` — commits calldata hash and opens a guardian-reviewed window (default 24h); (3) `finalizeEmergencySettle(calls)` — after review window, executes if not blocked or reverts if guardians reached block quorum (owner stake burned); (4) `cancelEmergencySettle()` — owner withdraws a pending emergency settle during the review window.
- **Standard settlement** still happens via `settleProposal` — proposer anytime, anyone after strategy duration.
- **Vault reads governor from factory** — no `setGovernor` on vault, no lock/unlock storage. `redemptionsLocked()` checks `governor.getActiveProposal()` directly. Lock state is the single source of truth for the active-strategy adapter slot: `totalAssets()` and the deposit/withdraw lock-relaxation only consult `_activeStrategyAdapter` while `redemptionsLocked() == true` (Phase 2 — see "Live NAV via strategy adapter" below).
- **Live NAV via strategy adapter (V2)** — Proposers may call `governor.bindProposalAdapter(proposalId, adapter)` before execute to bind an `IStrategy` clone whose `positionValue() returns (uint256 value, bool valid)` is queryable. The vault reads the adapter inside `totalAssets()` and gates the read on `redemptionsLocked()` so stale pointers are silently ignored after settle. When the adapter reports `valid=true`, `_deposit` and `_withdraw` are unlocked even during an active proposal — share price is queryable so LPs can enter/exit at fair NAV. The vault also forwards new deposits to the adapter via `IStrategy.onLiveDeposit(assets)` so capital starts earning immediately. Strategies without a live NAV (Mamo / Venice / off-chain perps) return `(0, false)` and the vault falls back to the queue path.

### Guardian Review Lifecycle

- **Proposal state:** `GuardianReview` inserted between `Pending` and `Approved`. Lifecycle: `Draft → Pending → GuardianReview → Approved → Executed → Settled`.
- **Staked guardians** review calldata during the review window (default 24h). Block quorum (30% of total guardian stake, default) → proposal `Rejected`, approvers slashed (WOOD **burned**, not sent to treasury).
- **Vote-change** allowed until the final 10% of the review window (late-vote lockout). Approvers are capped at 100/proposal; Blockers uncapped.
- **Owner stake** required at vault creation (`minOwnerStake`, default 10k WOOD). `emergencySettleWithCalls` re-checks the bond at call time using `requiredOwnerBond(vault) = max(floor, TVL * ownerStakeTvlBps / 10_000)` so owners can't stake at TVL=0 and drain at scale (TVL scaling `bps=0` by default in V1).
- **Epoch-based Block rewards** — protocol funds `epochBudget` each 7-day epoch via `GuardianRegistry.fundEpoch`. Guardians who voted Block on blocked proposals claim pro-rata. Unclaimed residuals sweep forward after 12 weeks via permissionless `sweepUnclaimed`.
- **Cold-start fallback** — reviews opened with `totalStakeAtOpen < MIN_COHORT_STAKE_AT_OPEN` (50k WOOD) return `blocked=false` unconditionally; owner veto remains active defence during bootstrap.
- **Appeal path** — slashed parties petition multisig; `refundSlash` draws from a separate Slash Appeal Reserve, capped at 20% of reserve per epoch.
- **Pause** — owner pauses review voting/claims; after 7 days anyone can deadman-unpause.
- **Stake top-up after unstake-request reverts** (`UnstakeAlreadyRequested`) — a guardian with a pending unstake is not active, so allowing top-ups would grow the quorum denominator without growing votable weight (invariant fuzzer finding, 2026-04-20).
- **Cancel-unstake after slash reverts** (`NoActiveStake`) — `_slashApprovers` clears `unstakeRequestedAt` so a slashed guardian cannot "ghost-cancel" back into `activeGuardianCount`.
- Full spec: `docs/superpowers/specs/2026-04-19-guardian-review-lifecycle-design.md` (PR #229).

### V1.5 — Guardian Delegation (Hybrid Rewards)

Full spec: `docs/superpowers/specs/2026-04-21-guardian-delegation-v1.5-design.md`. Plan: `docs/superpowers/plans/2026-04-21-guardian-delegation-v1.5.md`. Branch: `feat/guardian-delegation-v1.5`.

- **Checkpoint-based vote weight.** `voteOnProposal` / `voteBlockEmergencySettle` read `_stakeCheckpoints[voter].upperLookupRecent(r.openedAt)` + `_delegatedInboundCheckpoints[voter].upperLookupRecent(r.openedAt)` instead of live stake. Closes the top-up-before-vote bias — both numerator and denominator measure at the same instant (`openedAt`).
- **Stake-pool delegation.** `delegateStake(delegate, amount)` moves WOOD from delegator into registry custody. Per-(delegator, delegate) balance in `_delegations`, per-delegate inbound total in `_delegatedInbound`. All three checkpointed (delegator-pair, delegate-inbound, global total). Unstake flow mirrors guardian unstake: `requestUnstakeDelegation` → 7d cooldown → `claimUnstakeDelegation`. Self-delegation disallowed (`CannotSelfDelegate`); re-delegation implicitly cancels any pending unstake request.
- **Active-guardian gate reads own stake only.** Delegation adds vote weight but doesn't grant `_isActiveGuardian` activation. A delegate with 0 own stake + 1M delegated is a no-op.
- **DPoS commission.** `setCommission(bps)` per delegate (max 5000 = 50%). Raise-rate cumulative per epoch (max 500 bps above epoch-start rate); `_commissionEpochBaseline[delegate]` anchors the cap, re-seeded on the first raise of each epoch. First-ever set is exempt (no prior rate to raise from). Decreases unbounded. Trace224 history (`_commissionCheckpoints`) lets claim paths freeze the rate at `settledAt` — no retroactive rug-pulls (INV-V1.5-11).
- **Hybrid reward distribution.**
  - **WOOD epoch block-rewards** (inflationary) → **Merkl off-chain**. Registry emits `BlockerAttributed(proposalId, epochId, blocker, weight)` on every resolved-blocked review; Merkl's bot reads these + `CommissionSet` + delegation events to compute Merkle roots with DPoS + time-weighted delegator attribution. Claims via merkl.xyz. V1 on-chain `fundEpoch` / `claimEpochReward` / `sweepUnclaimed` machinery deleted (-1,428 bytes).
  - Epoch funding is a plain WOOD transfer from the owner multisig to the Merkl distributor — no on-chain helper, no `recordEpochBudget`, no registry `minter` (all removed in ToB P1-5).
  - **Vault-asset guardian fees** (revenue) → **on-chain via registry**. Governor `_distributeFees` transfers the fee slice to registry via `transferPerformanceFee(asset, recipient, fee)` + calls `registry.fundProposalGuardianPool(pid, asset, amount)` + emits `GuardianFeeAccrued`. Approvers call `claimProposalReward(pid)` (pulls commission, seeds delegator pool); delegators call `claimDelegatorProposalReward(delegate, pid)`. Attribution timestamp is `settledAt` for both commission rate and delegation balance. Rationale: real capital stays in our contracts (full audit trail, atomic with settle).
- **W-1 escrow on guardian-fee claims.** `_safeRewardTransfer` wraps `IERC20.transfer` in try/catch; on failure (e.g. USDC blacklist) the amount is escrowed in `_unclaimedApproverFees[keccak256(pid, recipient, asset)]`. `flushUnclaimedApproverFee` retries after blacklist lifts. **Key includes `proposalId`** — cross-proposal drain impossible (regression guard from PR #229 review finding class).
- **WOOD = OFT + ERC20Votes + ERC20Permit.** Multi-inherits all three (`WoodToken.sol`). Preserves LayerZero cross-chain while enabling ERC20Votes delegation for Snapshot-style off-chain governance UX. Timestamp-mode clock (EIP-6372) so checkpoint domain matches registry.
- **No on-chain parameter timelock.** Removed as part of V1.5 — owner multisig enforces delay externally. See Governor Key Concepts.

## App (Next.js dashboard)

- No `typecheck` script in `app/package.json`. Run `node_modules/.bin/tsc --noEmit` before pushing app changes.
- `npm run lint` (eslint). Pre-existing warning in `AgentStats.tsx` (unused `formatBps` import) is unrelated noise — ignore unless you touch that file.
- `npm run dev` boots on `:3000`. Reown WalletConnect 403 in the dev console is a missing project-ID env var, not a regression.

## CLI

- TypeScript, viem for chain interaction, Commander for CLI
- Provider pattern: each DeFi protocol = a provider with standard interface
- `npm run typecheck` before every PR
- **Distribution**: Published to npm as `@sherwoodagent/cli` (`npm i -g @sherwoodagent/cli`). Standalone binary via GitHub releases as secondary (no chat/XMTP support).
- **Version bumps are mandatory for every PR that touches `cli/` code.** Bump the `version` field in `cli/package.json` before creating the PR. Stay on `0.x` until mainnet — use **minor** bumps (`0.3.0` → `0.4.0`) for new features or breaking changes, **patch** bumps (`0.3.5` → `0.3.6`) for bug fixes and small improvements. First mainnet release will be `1.0.0`. A merge to main with a new version triggers an npm publish automatically.

### CLI Operational Notes

- `which sherwood` → `~/.linuxbrew/bin/sherwood` → symlinks into the **local `cli/dist/index.js`**. `npm run build` is enough to deploy changes — no `npm install -g` needed. Cron picks up rebuilds immediately.
- `sherwood chat <name> send --stdin` — pipe via stdin to avoid bash `$`-expansion (`$10,000` → `0,000`). Required for any dynamic message containing `$`. Added in 0.40.2.
- **Hermes skill sync**: cron reads skills from `~/.hermes/skills/sherwood/*/SKILL.md`, NOT from the repo. After editing `cron/skills/*/SKILL.md`, copy to hermes: `cp cron/skills/<name>/SKILL.md ~/.hermes/skills/sherwood/<name>/SKILL.md`.
- **Hermes cron prompt**: the job's `--prompt` text overrides SKILL.md instructions. After changing a skill's behavior, also update the prompt via `hermes cron edit <id> --prompt "..."`. The cron for trade-scanner is `c51a4fe8314e`.

### Trading Strategies

The directional agent and grid strategy each have a dedicated SKILL.md
that owns their config, runtime, signal stack, and tuning notes:

- **Directional agent** — `cli/src/agent/SKILL.md`
  Signal weights, regime thresholds, entry gates, calibrator, autoresearch,
  state files (`~/.sherwood/agent/`), data providers, Kronos forecaster.
- **Grid strategy** — `cli/src/grid/SKILL.md`
  Standalone ATR-based grid loop, allocation, leverage, rebalancing,
  state file (`~/.sherwood/grid/portfolio.json`).

Treat the SKILL.md files as the source of truth for signal stack and grid
config — do not duplicate values into this file. Update the SKILL.md when
behavior changes.

## Chat (XMTP)

- Encrypted group messaging via `@xmtp/node-sdk` — direct API calls, singleton Client, no subprocess spawning
- DB stored at `~/.sherwood/xmtp/` with deterministic encryption key derived from sherwood private key (`keccak256(privateKey + "xmtp-db-key")`)
- Single MLS installation per DB — eliminates stale KeyPackage issues (fixes #110)
- Each syndicate gets an XMTP group on creation, group ID stored as ENS text record + cached locally
- Creator is super admin — only they can add members via `syndicate add`
- Agents auto-added to chat after registration, with `AGENT_REGISTERED` lifecycle message
- All messages sent as JSON `ChatEnvelope` text (markdown and reactions encoded as envelope types)
- `--public-chat` on `syndicate create` / `--public` on `chat init` enables public chat (adds dashboard spectator)
- `sherwood chat <name> public --on/--off` toggles dashboard spectator access after creation
- Config stored at `~/.sherwood/config.json` (group ID cache, inbox ID cache)

### Chat Commands
- `sherwood chat <name>` — stream messages in real-time
- `sherwood chat <name> send "msg"` — send a text message
- `sherwood chat <name> send "msg" --markdown` — send formatted markdown
- `sherwood chat <name> react <id> <emoji>` — react to a message
- `sherwood chat <name> log` — show recent messages
- `sherwood chat <name> members` — list group members
- `sherwood chat <name> add <addr>` — add member (creator only)
- `sherwood chat <name> init [--force] [--public]` — create XMTP group + write ENS record (creator only)
- `sherwood chat <name> public --on/--off` — toggle dashboard spectator access

### Agent Chat Onboarding
- XMTP requires each wallet to have initialized an XMTP client at least once before it can be added to groups
- `syndicate join` auto-initializes the agent's XMTP identity via `getXmtpClient()`, so `syndicate approve` can immediately add them to the group
- If XMTP init fails during join, the approve flow warns and the agent can run `sherwood chat <name>` later to join manually

### XMTP Troubleshooting

**Stale group ID after `init --force`** — `getGroup()` validates cached IDs exist in the local DB and auto-invalidates stale entries. If agents have a hardcoded group ID, they need to clear `~/.sherwood/config.json` groupCache or let the CLI re-resolve via conversation name search.

**First run after migration from `@xmtp/cli`** — On first use, the node-sdk creates a new DB in `~/.sherwood/xmtp/` and automatically revokes all stale installations from the old `~/.xmtp/` era. The old `~/.xmtp/` directory can be safely deleted after migration.

## Agent Identity (ERC-8004)

- Agents and syndicate creators must have an ERC-8004 identity NFT (standard ERC-721)
- `SyndicateFactory.createSyndicate()` requires `creatorAgentId` — verifies NFT ownership on-chain
- `SyndicateVault.registerAgent()` requires `agentId` — NFT must be owned by `agentAddress` or vault `owner`
- Verification at registration time only (not per-execution) — keeps gas costs low
- `AgentConfig` struct stores `agentId` for reference/display

### Deployed Contracts (not ours — ERC-8004 standard)
| Contract | Base Mainnet | Base Sepolia |
|----------|-------------|--------------|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

### Agent0 SDK (prerequisite for creating/joining syndicates)
Agents mint their ERC-8004 identity via the Agent0 SDK (`@agent0lab/agent0-ts`). This is a prerequisite before calling `syndicate create` or `syndicate add`. The SDK handles IPFS metadata pinning and on-chain registration. See the levered-swap skill for the full flow.

## EAS (Attestations)

- EAS predeploys on Base: EAS at `0x4200000000000000000000000000000000000021`, SchemaRegistry at `0x4200000000000000000000000000000000000020`
- Two schemas: `SYNDICATE_JOIN_REQUEST` (agent → creator) and `AGENT_APPROVED` (creator → agent)
- Schemas registered one-time via `cli/scripts/register-eas-schemas.ts`, UIDs stored in `addresses.ts`
- Uses viem directly for on-chain writes (no ethers/EAS SDK dependency) — data encoded with `encodeAbiParameters`
- Queries via EAS GraphQL API (fetch-based): `https://base.easscan.org/graphql` / `https://base-sepolia.easscan.org/graphql`
- `syndicate approve` is a superset of `syndicate add` — registers agent + creates approval attestation + XMTP
- `syndicate add` remains for backwards compatibility (direct registration without EAS)

### EAS CLI Commands
- `sherwood syndicate join --subdomain <name> --message "..."` — agent requests to join
- `sherwood syndicate requests` — creator views pending requests
- `sherwood syndicate approve --agent-id <id> --wallet <addr>` — creator approves + registers
- `sherwood syndicate reject --attestation <uid>` — creator rejects by revoking attestation

## Testing

- Contracts: Foundry tests in `contracts/test/`, fork tests for protocol integrations
- CLI: vitest (when wired up)
- Always include test results in PR description
- **`MockRegistryMinimal`** (`test/mocks/MockRegistryMinimal.sol`) is used by ~6 governor test files. It only stubs the read surface (`reviewPeriod`, `resolveReview`, `getReviewState`, `isEmergencyOpen`, `cancelEmergency`). When `IGuardianRegistry` interface changes, this mock MUST be updated or 20+ tests silently fail with `unrecognized function selector`.
- `cli/src/lib/network.test.ts` has 4 pre-existing failures from `BASE_RPC_URL` env-var leak (Moonwell RPC override). Always verify with `git stash && npm test` before assuming new test failures are from your changes.
- **systemd services** need `Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"` — linuxbrew Node.js can't find CA certs without it. All HTTPS fetch calls fail silently with `TypeError: fetch failed`.
- `forge coverage` runs again as of PR #229 (struct-literal refactor in `SyndicateGovernor.propose`). Prior stack-too-deep workaround no longer needed.
- First invariant harness shipped in PR #229 at `test/invariants/` using `StdInvariant` + a handler contract (guardian WOOD conservation, stake accounting). 4 more priority invariants (#226 INV-2 / -3 / -11 / -15) still outstanding.
- Pre-mainnet punch list: issues **#225 (bugs)** and **#226 (process/design)**. Canonical consolidated tracker: **`docs/pre-mainnet-punchlist.md`** — every fix PR should reference the ref code (e.g. `fixes V-C1`, `closes G-C4`) and mark the punch list row closed. New findings go into the issues first, then propagate to the tracker.
- **CLI/contract enum sync**: when changing Solidity's `ProposalState` ordering, also update `cli/src/lib/governor.ts` (`PROPOSAL_STATES` array + `PROPOSAL_STATE` map) AND `cli/src/simulation/phases/10-lifecycle.ts` (parser + `ACTIVE_STATES`). `app/src/lib/governor-data.ts` already mirrors. PR #229 inserted `GuardianReview` at index 2 and the CLI was missed for ~2 months — `proposal execute` rejected valid Approved proposals as "Rejected" until v0.52.1. Treat the enum as a cross-package contract.

## Key Addresses (Base)

- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- Moonwell Comptroller: `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C`
- Uniswap V3 SwapRouter: `0x2626664c2603336E57B271c5C0b26F421741e481`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`

## Safety

- All contracts (Vault, Governor, Factory) are UUPS upgradeable — never change storage layout order, append new slots only, reduce `__gap` accordingly
- Two-layer permission model: on-chain caps (vault) + off-chain policies (agent software)
- Agent wallets are standard EOAs
- Syndicate-level caps are hard limits — no agent can bypass them
- Governor parameter changes require timelock delay — prevents instant governance manipulation
- ERC-4626 inflation protection via dynamic `_decimalsOffset()` — scales to any asset denomination
- `delegatecall` to `BatchExecutorLib` only (stateless, 63-line contract) — not arbitrary strategy contracts. Enforced via codehash pin at `SyndicateVault.sol:343` (V-C2 closure).
- **Exception to the timelock claim**: `setProtocolFeeRecipient` is owner-instant while `setProtocolFeeBps` is timelocked. Asymmetric; see issue #226 A7.
- **Exception to the caps claim**: `maxPerTx` / `maxDailyTotal` / `maxBorrowRatio` / per-agent caps / target allowlist exist in `mintlify-docs/` but NOT in code (issue #226 §4 A10). Treat as aspirational until built.
- `SyndicateFactory.governor` is **set-once at init** (the `setGovernor` function was removed in PR #229 to close V-H2 — a factory-owner instant global retroactive switch that would have orphaned in-flight proposals on every registered vault). Governor upgrades must go through a UUPS upgrade of the governor proxy itself, not a factory rewire.
- **Pull-claim escrow key pattern**: any pull-based claim mapping (e.g. `_unclaimedFees`) MUST be keyed by the *origin* address when the claim function takes a caller-supplied target. Without it, an `onlyGovernor`-guarded `transferXxx(target, ...)` lets a user with any escrow redirect the pull to any target holding the token (cross-vault drain). Shape: `keccak256(originVault, recipient, token) => amount`, via a `private pure _unclaimedKey` helper to keep bytecode flat. Regression test: `FeeBlacklistResilience.t.sol::test_claimUnclaimedFees_cannotDrainUnrelatedVault`.

## Aspirational / not-yet-implemented (read docs with caution)

These appear in `mintlify-docs/` or earlier CLAUDE.md text but are **not live in code**. See `docs/pre-mainnet-punchlist.md` §6 for the full doc↔code mismatch catalog.

**Removed in ToB cleanup (2026-04-23)** — don't search for these:
- `GuardianRegistry.recordEpochBudget`, `GuardianRegistry.minter` + `setMinter`, `GuardianRegistry.activeGuardianCount`, `_emergencyVoteStake`, `SyndicateGovernor.guardianFeeRecipient` + `setGuardianFeeRecipient`. `setCoolDownPeriod` was renamed to `setCooldownPeriod` (matches governor). V1.5 is a fresh mainnet redeployment (`feat/mainnet-redeployment-params`) so storage layout changes are safe — proxies start zeroed; still add per-abstract `__gap` for upgrade hygiene (see `GovernorParameters.__paramsGap[10]`).

- `maxPerTx` / `maxDailyTotal` / `maxBorrowRatio` / per-agent caps / target allowlist on the vault _(punch list: A10, A35)_
- EAS `STRATEGY_PNL` attestation minted at settlement _(punch list: A23)_
- `SyndicateGauge.claimLPRewards` — always reverts (`_calculateLPReward` stub) _(punch list: T-C1)_
- WOOD/shares Uniswap V3 "early exit" pool _(punch list: A41)_
- Automated price/lock-ratio circuit-breaker triggers in `Minter` (manual-only today)
- `expireCollaboration(proposalId)` function referenced in docs (doesn't exist; lazy resolution only) _(punch list: A28)_
- `_distributeFees` try/catch + blacklist-resilient settlement — claim in `economics.mdx`, not in code _(punch list: A22, W-1)_
- Shareholder `vetoProposal` — claimed in `concepts.mdx`, only vault-owner can actually call it _(punch list: A18)_
- Per-syndicate governance parameters — claim in `concepts.mdx`, actual model is global `GovernorParams` _(punch list: A19)_

