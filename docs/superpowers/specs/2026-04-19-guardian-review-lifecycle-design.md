# Guardian Review Lifecycle — Design Spec (V1)

> **Status:** Design — awaiting review
> **Author:** Ana Julia
> **Date:** 2026-04-19
> **Tracks:** [imthatcarlos/sherwood#227](https://github.com/imthatcarlos/sherwood/issues/227)
> **Scope:** Pre-mainnet; breaking changes to governor lifecycle are acceptable.

## 1. Problem

Sherwood's governance is optimistic: proposals auto-pass after the voting period unless AGAINST votes reach a veto threshold. The only adversarial review today comes from the vault owner (running the informal `syndicate-owner` skill), who monitors proposals for their *own* vault. There is no economically incentivized third-party review layer, and nothing stops a compromised or absent vault owner from either (a) rubber-stamping a malicious proposal, or (b) abusing `emergencySettle` to execute arbitrary calldata against the vault.

Issue #227 proposes a staked, slashable guardian network. This spec scopes V1 to the on-chain primitives needed to:

1. Insert an enforceable guardian review step between proposal approval and execution.
2. Give guardians a quorum-based power to block malicious proposals.
3. Slash guardians who approve proposals that turn out to be malicious.
4. Require vault owners to post a slashable bond so their escape-hatch (`emergencySettle`) is no longer an unbounded trusted-root power.

Out of scope for V1 (tracked as follow-up specs):

- Guardian reward emissions, weekly reward cron, Minter integration for rewarding correct Approves.
- EAS attestation schema for guardian behavior + LLM-consumable knowledge base.
- Shareholder challenge / jury-style post-settlement adjudication (Option C).
- Hermes guardian skill upgrade (the off-chain agent that calls these primitives).

## 2. High-level lifecycle change

```
Today:
  Draft ──▶ Pending ──▶ Approved ──▶ Executed ──▶ Settled
                           │             │
                           └─▶ Rejected  └─▶ (Settled via emergencySettle w/ arbitrary calldata — unbounded owner power)

V1:
  Draft ──▶ Pending ──▶ GuardianReview ──▶ Approved ──▶ Executed ──▶ Settled
                               │                            │
                               ├─▶ Rejected (block quorum)  ├─▶ Settled (normal / proposer / unstick)
                               │   └─ early Approvers slashed
                               │                            └─▶ EmergencySettleReview ──▶ Settled
                               └─▶ Rejected (owner vetoProposal — Pending state only)     │
                                                                                          └─▶ Rejected (block quorum)
                                                                                              └─ owner slashed
```

Key invariants:

- Guardians cannot act before voting ends — they review *approved calldata*, not draft proposals.
- The owner's unilateral `vetoProposal` power is narrowed to `Pending` only (before guardians have weighed in).
- The owner's `emergencyCancel` power is narrowed to `Draft` and `Pending` (where funds are never at risk).
- Post-execution: `unstick(proposalId)` is owner-instant for stuck vaults (no new calldata), but any custom calldata goes through `EmergencySettleReview`.

## 3. Contracts

### 3.1 New: `GuardianRegistry.sol`

A single contract owning staking, unstaking, review vote accounting, and slashing for both guardian agents and vault owners. UUPS upgradeable, owned by the Sherwood protocol multisig. Interacts with `SyndicateGovernor` and `SyndicateFactory` via privileged hooks.

**Storage (conceptual — actual field order chosen to pack tightly):**

```solidity
// Guardian state
struct Guardian {
    uint128 stakedAmount;
    uint64 stakedAt;
    uint64 unstakeRequestedAt; // 0 = not requested
}
mapping(address => Guardian) private _guardians;
uint256 private _totalGuardianStake;      // sum of active guardian stake
uint256 private _activeGuardianCount;

// Owner stake (per-vault)
struct OwnerStake {
    uint128 stakedAmount;
    uint64 unstakeRequestedAt;
    address owner; // the staker (needed for slash credit / refund)
}
mapping(address vault => OwnerStake) private _ownerStakes;

// Pre-bind intent: owner stakes WOOD before the factory creates the vault.
struct PreparedOwnerStake {
    uint128 amount;
    uint64 preparedAt;
    bool bound;
}
mapping(address owner => PreparedOwnerStake) private _prepared;

// Proposal review state (one entry per proposal)
struct Review {
    uint64 reviewStart;
    uint64 reviewEnd;
    uint128 totalStakeAtOpen;   // snapshot of _totalGuardianStake; quorum denominator
    uint128 approveStakeWeight;
    uint128 blockStakeWeight;
    bool resolved;
    bool blocked;
}
mapping(uint256 proposalId => Review) private _reviews;
mapping(uint256 => mapping(address => VoteType)) private _votes;
mapping(uint256 => address[]) private _approvers; // for batch-slashing at resolution

// Emergency settle review
struct EmergencyReview {
    bytes32 callsHash;        // keccak256 of committed calldata array
    uint64 reviewEnd;
    uint128 totalStakeAtOpen; // snapshot of _totalGuardianStake
    uint128 blockStakeWeight;
    bool resolved;
    bool blocked;
}
mapping(uint256 proposalId => EmergencyReview) private _emergencyReviews;
mapping(uint256 => mapping(address => bool)) private _emergencyBlockVotes;

// Parameters (timelocked; pattern mirrors GovernorParameters)
uint256 public minGuardianStake;  // default: 10_000 WOOD
uint256 public minOwnerStake;     // default: 50_000 WOOD
uint256 public coolDownPeriod;    // default: 7 days
uint256 public reviewPeriod;      // default: 24 hours
uint256 public blockQuorumBps;    // default: 3000 (30% of total guardian stake)
address public slashRecipient;    // treasury multisig

// Privileged addresses
address public governor;
address public factory;
IERC20 public immutable wood;     // WOOD token
```

**Public / external functions:**

Guardian role:
- `stakeAsGuardian(uint256 amount)` — pull WOOD, register caller as active guardian. Requires `amount >= minGuardianStake`. Idempotent: existing guardians can top up.
- `requestUnstakeGuardian()` — marks `unstakeRequestedAt = block.timestamp`. Guardian immediately loses voting power (removed from `_totalGuardianStake`). Cannot re-vote until unstake is either cancelled or claimed.
- `cancelUnstakeGuardian()` — reverses an unstake request; stake becomes voting-eligible again.
- `claimUnstakeGuardian()` — after `coolDownPeriod` elapses, releases WOOD to guardian. Zero-stake guardians are fully deregistered.
- `voteOnProposal(uint256 proposalId, VoteType support)` — `Approve` or `Block`. Callable only while `Review.reviewStart <= now < Review.reviewEnd`. One vote per guardian per proposal.

Owner role:
- `prepareOwnerStake(uint256 amount)` — pull WOOD into the registry under `_prepared[msg.sender]`. Does **not** yet bind to a vault. Must be ≥ `minOwnerStake`. One prepared stake per owner at a time.
- `cancelPreparedStake()` — only callable if not yet bound by the factory; refunds WOOD.
- `requestUnstakeOwner(address vault)` — vault owner only. Signals intent to exit; begins cool-down. Unstaking is **blocked while the vault has an active proposal** (any state between `Pending` and `Executed`) to prevent rage-quit around malicious executions.
- `claimUnstakeOwner(address vault)` — after cool-down, releases WOOD. Post-claim the vault is in a **grace-period** state (`ownerStaked == false`): new proposals cannot be created until owner re-binds a fresh stake.

Governor hooks:
- `openReview(uint256 proposalId)` — **onlyGovernor**. Called when proposal transitions Pending → GuardianReview. Sets `reviewStart = now`, `reviewEnd = now + reviewPeriod`. Reverts if already opened.
- `openEmergencyReview(uint256 proposalId, bytes32 callsHash)` — **onlyGovernor**. Commits the calldata hash when owner calls `emergencySettleWithCalls`. Opens the window.
- `resolveReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Requires `block.timestamp >= reviewEnd`. On first successful call, computes `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`, sets `resolved = true`, and if `blocked`, invokes internal `_slashApprovers`. Returns cached `blocked` on subsequent calls. Governor calls this defensively from `_resolveState`; guardians/keepers can also call it to trigger slashing without waiting for someone to execute.
- `resolveEmergencyReview(uint256 proposalId) returns (bool blocked)` — **permissionless** and idempotent. Same shape as `resolveReview` but resolves the emergency-settle window and invokes `_slashOwner` when blocked.

Factory hook (onlyFactory):
- `bindOwnerStake(address owner, address vault)` — consumes `_prepared[owner]`, binds it as `_ownerStakes[vault]`. Reverts if no prepared stake.

Emergency-settle vote:
- `voteBlockEmergencySettle(uint256 proposalId)` — active guardians vote to block. Any single vote adds their stake weight to `blockStakeWeight`. When `blockStakeWeight >= blockQuorumBps * _totalGuardianStake / 10_000`, the review is flagged blocked (resolved at `resolveEmergencyReview` time).

Slashing (internal, triggered by governor):
- `_slashApprovers(uint256 proposalId)` — internal; called by governor via a privileged entrypoint when (a) guardian Block quorum resolves, or (b) owner calls `emergencyCancel` on a proposal that had recorded Approves. Iterates `_approvers[proposalId]`, zeroes each approver's stake, transfers total slashed WOOD to `slashRecipient`. Capped gas-wise by the MAX_GUARDIANS invariant (see §7).
- `_slashOwner(address vault)` — internal; called by governor when `resolveEmergencyReview` returns blocked. Zeros `_ownerStakes[vault].stakedAmount`, transfers to `slashRecipient`. Vault transitions into "owner must re-stake" state.

Parameter setters (timelocked — reuses `GovernorParameters` timelock pattern):
- `setMinGuardianStake`, `setMinOwnerStake`, `setCoolDownPeriod`, `setReviewPeriod`, `setBlockQuorumBps`, `setSlashRecipient`.

Views:
- `guardianStake(address)`, `ownerStake(address vault)`, `totalGuardianStake()`, `isActiveGuardian(address)`, `hasOwnerStake(address vault)`, `getReview(uint256)`, `getEmergencyReview(uint256)`, `preparedStakeOf(address owner)`, `canCreateVault(address owner)`.

### 3.2 Modified: `SyndicateGovernor.sol`

Minimal changes, scoped to what the governor has to know.

- **Enum:** append `GuardianReview` at end of `ProposalState`. New order: `{Draft, Pending, Approved, Rejected, Expired, Executed, Settled, Cancelled, GuardianReview}`. Appending (not inserting) preserves existing storage slots for in-flight proposals on test deployments; on mainnet this is a fresh redeploy under `feat/mainnet-redeployment-params`.
- **Struct:** append `uint256 reviewEnd` at end of `StrategyProposal`. Storage-safe append (mapping entries are independent slots).
- **Storage:** add `address private _guardianRegistry` and reduce `__gap` by one.
- **Initializer:** accept `guardianRegistry` address.
- **`_resolveStateView` / `_resolveState`:** when `stored == Pending` and voting ended with no veto quorum:
  - Transition to `GuardianReview` (not directly to `Approved`).
  - Mutator path (`_resolveState`) calls `registry.openReview(proposalId)` to stamp `reviewEnd`.
  - When `stored == GuardianReview`:
    - If `block.timestamp < reviewEnd`: remain in `GuardianReview`.
    - Else: call `registry.resolveReview(proposalId)` → if `blocked == true`, transition to `Rejected` (and registry auto-slashes approvers during the resolve call). Else transition to `Approved`.
  - `Approved` → `Expired` logic is unchanged.
- **`executeProposal`:** unchanged preconditions — still requires `state == Approved`. (The new gate is earlier: `Approved` is now only reachable after successful guardian review.)
- **`vetoProposal`:** narrow — allow only `Pending` state. Remove `Approved`/`GuardianReview` branch. (Rationale: once the proposal is in `GuardianReview`, owner unilateral veto is disempowering to guardians and bypasses the economic-security layer.)
- **`emergencyCancel`:** narrow — allow only `Draft` and `Pending`. Remove `Approved`/`GuardianReview` branches. In those states, if owner wants to stop execution, they stake WOOD as a guardian and vote Block like everyone else.
- **Remove `emergencySettle`.** Replace with three functions:
  - `unstick(uint256 proposalId)` — owner-only. Runs only the pre-committed `_settlementCalls` (no fallback, no custom calldata). Intended for cases where the settlement calls themselves are correct but need to be force-triggered (e.g., after strategy duration elapsed and proposer is unresponsive). Reverts if calls revert. Transitions proposal to `Settled`. Replaces the owner-instant path in today's `emergencySettle`.
  - `emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. Stores `calls` as committed settlement override. Calls `registry.openEmergencyReview(proposalId, keccak256(abi.encode(calls)))`. Does **not** execute calls yet — opens the review window. Emits `EmergencySettleProposed(proposalId, owner, callsHash, reviewEnd)`.
  - `finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)` — owner-only. Callable after `reviewEnd`. Reverifies `keccak256(abi.encode(calls)) == committed hash`. Calls `registry.resolveEmergencyReview(proposalId)`:
    - If `blocked`: registry slashes owner; function reverts (owner must try `unstick` or propose new calls, posting fresh stake first).
    - If not blocked: executes calls via `vault.executeGovernorBatch(calls)`, transitions proposal to `Settled`.

### 3.3 Modified: `SyndicateFactory.sol`

- Store `address public guardianRegistry` (owner-settable, timelock-gated same as `governor`).
- In `createSyndicate`: before deploying the vault, call `guardianRegistry.canCreateVault(msg.sender)` (reverts if no prepared stake). After vault address is known, call `guardianRegistry.bindOwnerStake(msg.sender, vaultAddr)`. If bind fails, the whole creation reverts (atomic).
- `setGuardianRegistry(address)` — owner, timelocked.

### 3.4 Modified: `ISyndicateGovernor.sol`

New enum value, new struct field, new errors, new events, new function signatures:

- Errors: `NotInGuardianReview`, `EmergencySettleBlocked`, `EmergencySettleNotReady`, `EmergencySettleMismatch`, `ReviewAlreadyOpen`, `RegistryNotSet`.
- Events: `GuardianReviewOpened(uint256 indexed proposalId, uint256 reviewEnd)`, `GuardianReviewResolved(uint256 indexed proposalId, bool blocked)`, `EmergencySettleProposed(uint256 indexed proposalId, address indexed owner, bytes32 callsHash, uint256 reviewEnd)`, `EmergencySettleFinalized(uint256 indexed proposalId, int256 pnl)`, `GuardianRegistryUpdated(address old, address new)`.
- Function changes: drop `emergencySettle`; add `unstick`, `emergencySettleWithCalls`, `finalizeEmergencySettle`.

## 4. Data flow — key scenarios

**Normal happy path:**
1. Agent submits proposal → `Pending` → voting → `GuardianReview` (governor calls `registry.openReview`).
2. Guardians vote Approve (majority) / Block (minority); neither hits block quorum.
3. `reviewEnd` elapses. Anyone calls `executeProposal`; governor calls `registry.resolveReview` first → `resolved=true, blocked=false`. Transitions to `Approved` then immediately proceeds through execution logic.
4. Strategy runs; proposer calls `settleProposal`. Proposal → `Settled`. No slashing.

**Malicious-calldata detection during review:**
1. Proposal reaches `GuardianReview`.
2. Guardian A, B, C vote Approve at hour 2. Guardian D, E, F, G vote Block starting at hour 10. Combined Block stake weight crosses `blockQuorumBps` threshold at hour 14.
3. `reviewEnd` elapses at hour 24. Anyone calls `executeProposal` (or a permissionless `resolveReview`). Governor sees `blocked=true` → transitions to `Rejected`; registry slashes A, B, C stake → treasury.

**Owner abuses emergency settle:**
1. Proposal executes cleanly. Strategy runs its duration.
2. Owner calls `emergencySettleWithCalls(id, maliciousCalls)` at hour 0 of review window. Registry commits `callsHash`, opens 24h EmergencyReview.
3. Guardians vote Block; crosses quorum at hour 10.
4. Owner calls `finalizeEmergencySettle(id, maliciousCalls)` at hour 25. Registry returns `blocked=true`, slashes owner stake, governor reverts.
5. Vault is now ownerless-for-governance-purposes: owner must `prepareOwnerStake` + re-bind before proposing/vetoing anything. (Non-governance owner functions like `rescueERC20` remain on the vault owner.)
6. Stuck assets can still be recovered by the legitimate path: `unstick(id)` runs pre-committed settlement calls. (If pre-committed calls are themselves broken and funds are truly stuck, the protocol multisig has to intervene — same exposure we have today.)

**Compromised owner tries to veto guardians:**
1. Proposal in `GuardianReview`. Owner calls `vetoProposal`. Reverts (`NotInPendingState` — narrowed).
2. Only path for owner to block execution: stake as guardian, vote Block. This means owner can participate in the guardian economy on equal footing, but cannot unilaterally override the quorum.

## 5. Parameters (initial values)

| Parameter | Default | Bounds | Rationale |
|---|---|---|---|
| `minGuardianStake` | 10_000 WOOD | ≥ 1 WOOD | Low enough for early ecosystem, high enough that slashing is a real cost. |
| `minOwnerStake` | 50_000 WOOD | ≥ 10_000 WOOD | 5× guardian — owner has per-vault unilateral power. |
| `coolDownPeriod` | 7 days | 1–30 days | Matches issue #227; aligns with Sherwood's existing multi-day governance rhythms. |
| `reviewPeriod` | 24 hours | 6h–7 days | Long enough for guardian agents (cron-driven) to run a fork simulation; short enough to not block legitimate strategies. |
| `blockQuorumBps` | 3000 (30%) | 1000–10000 | Below 50% so a motivated guardian minority can stop clearly malicious proposals; high enough that random dissent doesn't grief. |
| `slashRecipient` | Protocol treasury multisig | — | LP reimbursement happens off-chain from treasury in V1; on-chain redirect to vault-asset is V2. |

All parameters are timelocked using the same queue/finalize pattern as `GovernorParameters.sol`, with `MIN_PARAM_CHANGE_DELAY = 6 hours` and `MAX_PARAM_CHANGE_DELAY = 7 days`.

## 6. Security notes

- **Gas-bounded slashing:** `_slashApprovers` iterates `_approvers[proposalId]`. Bounded by an invariant cap `MAX_APPROVERS_PER_PROPOSAL = 100`. Guardians attempting to Approve after the cap is hit revert (but can still Block). This prevents griefing via thousands of dust-stakers joining to brick slash resolution.
- **Stake snapshot vs. current:** guardian vote weight = `stakedAmount` at vote time (snapshotted into `_votes`). If a guardian tops up after voting, the extra doesn't count. Prevents sandwich-style weight manipulation.
- **Unstake griefing:** requesting unstake immediately removes voting weight, but the guardian's past votes already count toward their proposal reviews. Slashing still applies during cool-down (stake is held in contract, just earmarked for release). This is critical — otherwise a guardian could Approve a malicious proposal and immediately unstake to dodge slashing.
- **Owner re-stake after slash:** a slashed owner can restake and resume governance powers, but past slashing events are recorded and queryable. Off-chain reputation is out-of-scope for V1.
- **Double-voting prevention:** `_votes[proposalId][guardian]` must be default `None` for first vote; subsequent calls revert.
- **Factory/registry trust:** registry trusts governor to call its hooks honestly and vice-versa. Both upgrades routed through the same multisig.
- **Reentrancy:** slashing and cool-down claims touch WOOD ERC-20 transfers. Reuse `nonReentrant` modifier pattern from existing governor.
- **Owner can't front-run guardian block:** owner's `emergencyCancel` is narrowed to `Draft`/`Pending`. Once in `GuardianReview`, the only cancel vector is guardian Block quorum.
- **`unstick` abuse:** owner could spam `unstick` on a proposal that legitimately needs emergency settle. Mitigation: `unstick` is only callable after the proposal's strategy duration has elapsed (same precondition as current `emergencySettle`), and the call reverts if pre-committed settlement calls themselves revert. This matches current behavior.

## 7. Testing plan

All tests live in `contracts/test/`. New files:

- `test/GuardianRegistry.t.sol` — unit tests for staking, cool-down, voting, slashing math.
- `test/governor/GuardianReviewLifecycle.t.sol` — integration: full proposal lifecycle with guardians approving, blocking, and slashing.
- `test/governor/EmergencySettleReview.t.sol` — owner-slashing path via `emergencySettleWithCalls`.
- `test/factory/OwnerStakeAtCreation.t.sol` — factory reverts without prepared stake; binds correctly.
- `test/invariants/GuardianInvariants.t.sol` — `StdInvariant` handler covering: total WOOD in registry == sum(stakes) + sum(prepared), slashed guardians have zero active stake, one active proposal per vault at all times.

Must-pass scenarios:
1. Happy path — proposal survives review, executes, settles.
2. Block-quorum rejection — Approvers slashed, Blockers keep stake.
3. Unstake griefing — guardian Approves then requests unstake; slashing still applies before claim.
4. Owner attempts `vetoProposal` during `GuardianReview` → reverts.
5. Owner attempts `emergencyCancel` on `Approved` → reverts.
6. `emergencySettleWithCalls` blocked by guardians → owner slashed; `finalizeEmergencySettle` reverts.
7. `emergencySettleWithCalls` not blocked → executes normally after `reviewEnd`.
8. `unstick` with working pre-committed settlement calls → succeeds.
9. Factory `createSyndicate` without prepared owner stake → reverts.
10. Max-approvers cap — 101st Approve reverts, 101st Block succeeds.

Fuzz targets:
- Randomized vote sequences; assert `blockStakeWeight + approveStakeWeight <= totalGuardianStakeAtReviewOpen`.
- Randomized stake/unstake sequences; assert total WOOD conservation.

## 8. Deployment plan

1. Deploy `GuardianRegistry` behind UUPS proxy. Owner = protocol multisig.
2. Configure initial parameters (see §5).
3. Deploy new `SyndicateGovernor` implementation. Proxy upgrade existing governor (still pre-mainnet — no in-flight proposals to migrate).
4. Deploy new `SyndicateFactory` implementation. Proxy upgrade.
5. Protocol multisig calls `factory.setGuardianRegistry(registry)` and `governor.setGuardianRegistry(registry)` (both timelocked).
6. Seed initial guardian cohort (protocol team + launch partners) by distributing WOOD and having them call `stakeAsGuardian`.
7. Existing vault owners (if any on testnets) call `prepareOwnerStake` + a new `factory.bindExistingVault(vault)` admin function (owner-only, one-time, used only for pre-mainnet migration of Base Sepolia test vaults) OR we simply redeploy vaults as part of the mainnet redeployment branch already in flight.

Given this is on `feat/mainnet-redeployment-params`, option 7b (redeploy) is preferred — no migration code needed.

## 9. Follow-up specs (explicitly out of scope)

- **Guardian rewards + weekly cron** — Minter emissions allocated to guardians, distributed based on correct-Approve / correct-Block attestations. Requires EAS schema for attestations.
- **EAS attestation schema** — `GUARDIAN_REVIEW_VOTE` schema capturing (proposalId, guardian, support, reasoning hash). Feeds reward computation.
- **LLM knowledge base** — compiled good/bad attestations + reasoning → off-chain dataset for Hermes guardian skill training.
- **Shareholder challenge (Option C)** — post-settlement jury-style adjudication for malicious proposals that slipped past guardians.
- **Vault-asset slash redirect** — swap slashed WOOD to vault asset at slash time, pay directly to LPs harmed.
- **Guardian reputation decay** — aged-out stake, repeated-correct-vote multipliers.
- **Hermes `guardian` skill** — off-chain agent runtime that scans proposals across all syndicates and calls `voteOnProposal`.

## 10. Open questions (want your call before writing the plan)

1. **Slash destination**: treasury (simple) or burn (deflationary signal, aligns with WOOD tokenomics)? Spec currently says treasury.
2. **`unstick` access control**: owner-only, or permissionless after strategy duration + N hours? Today's `emergencySettle` is owner-only; unchanged here, but worth flagging.
3. **Guardian cap per proposal**: is 100 the right ceiling? Too low risks legitimate large cohorts not all being able to Approve. Too high risks gas griefing on slash.
4. **Factory `bindOwnerStake` atomicity**: spec has factory calling registry *after* vault deploy. If bind reverts, the whole `createSyndicate` reverts and vault deployment is rolled back — confirm this is the desired ordering vs. binding before deploy (which requires computing vault address via CREATE2).
