# SyndicateGovernor — Architecture

## Overview

A governance system where agents propose strategies, vault shareholders vote, and approved agents execute within mandated parameters — earning performance fees on profits.

**One-liner:** Agents pitch trade plans. Shareholders vote. Winners execute and earn carry.

**Multi-vault:** A single governor manages multiple vaults. Proposals target a specific vault. Only shareholders of that vault vote on its proposals.

---

## The Flow

```
1. Agent submits proposal
   "I'm a DeFi expert. I propose borrowing 5,000 USDC against the vault's WETH
    collateral on Moonwell. Health factor drops to 2.1 (still safe). I'll deploy
    the borrowed USDC into Uniswap WETH/USDC LP. Expected APY: 12%.
    My performance fee: 15% of profits."

2. Shareholders vote YES/NO (weighted by vault shares)

3. If quorum + majority → Approved

4. Agent executes within the mandate
   - Can only use up to the approved capital
   - Can only call the approved target contracts
   - Must execute within the execution window

5. On settlement
   - Profit = (position value at close) - (capital used)
   - Performance fee paid to agent
   - Remaining profit accrues to vault (all shareholders)
```

---

## Proposal Struct

```solidity
struct StrategyProposal {
    uint256 id;
    address proposer;              // agent address (must be registered in vault)
    string metadataURI;            // IPFS: full rationale, research, risk analysis
    uint256 capitalRequired;       // vault capital requested (in asset terms, e.g. USDC)
    uint256 performanceFeeBps;     // agent's cut of profits (e.g. 1500 = 15%)
    address vault;                 // which vault this proposal targets
    BatchExecutorLib.Call[] calls; // exact calls to execute (target, data, value)
    uint256 strategyDuration;      // how long the position runs (seconds), capped by maxStrategyDuration
    uint256 votesFor;              // share-weighted votes in favor
    uint256 votesAgainst;          // share-weighted votes against
    uint256 snapshotTimestamp;     // block.timestamp at creation (for vote weight snapshot)
    uint256 voteEnd;               // snapshotTimestamp + votingPeriod
    uint256 executeBy;             // voteEnd + executionWindow
    ProposalState state;           // Pending → Active → Approved → Executed → Settled
                                   // (or Rejected / Expired / Cancelled)
}
```

### Calls are committed at proposal time, not execution time

The exact `calls[]` (target, data, value) are part of the proposal. Shareholders vote on the precise on-chain actions that will be executed — not a vague description. At execution time, `executeProposal(proposalId)` takes **no arguments** — it replays the pre-approved calls. The agent cannot change what gets executed after the vote.

This means:
- Shareholders can inspect every calldata byte before voting
- The metadataURI provides human-readable context ("borrow 5k USDC from Moonwell")
- The calls[] provide machine-verifiable truth (the actual encoded function calls)
- No bait-and-switch possible

### Who controls what

| Parameter | Controlled by | Notes |
|-----------|--------------|-------|
| vault | Agent (proposer) | Which vault this proposal targets |
| calls | Agent (proposer) | Exact on-chain calls to execute — committed at proposal time |
| capitalRequired | Agent (proposer) | How much vault capital they need |
| performanceFeeBps | Agent (proposer) | Their fee, capped by maxPerformanceFeeBps |
| strategyDuration | Agent (proposer) | How long the position runs, capped by maxStrategyDuration |
| metadataURI | Agent (proposer) | IPFS link to full strategy rationale |
| votingPeriod | Governor (owner setter) | How long voting lasts |
| executionWindow | Governor (owner setter) | Time after approval to execute |
| quorumBps | Governor (owner setter) | Min participation (% of total shares) |
| maxPerformanceFeeBps | Governor (owner setter) | Cap on agent fees |
| maxStrategyDuration | Governor (owner setter) | Cap on how long a strategy can run (e.g. 90 days) |

---

## Voting

- **Voting power = shares of the target vault** (ERC-4626 balanceOf on `proposal.vault`)
- Only shareholders of the target vault can vote — your money, your decision
- Snapshot at proposal creation (block.timestamp) to prevent flash-loan manipulation
- 1 address = 1 vote per proposal (weighted by shares at snapshot)
- Simple majority: votesFor > votesAgainst (if quorum met)
- Quorum = minimum % of target vault's total supply that must participate

---

## Agent Registration — Removed

No agent registration needed. Anyone with an ERC-8004 identity NFT can propose strategies to any vault. Shareholders vote on the strategy, not the person. The governor verifies ERC-8004 ownership at proposal time — that's the only gate.

Track record is built on-chain via proposal history (past proposals, P&L, settled vs defaulted). No need for a separate agent registry in the vault.

---

## Proposal States

```
              ┌─────────┐
              │ Pending  │  (created, voting not started — or voting active)
              └────┬─────┘
                   │ votingPeriod expires
          ┌────────┼────────┐
          ▼        │        ▼
    ┌──────────┐   │  ┌──────────┐
    │ Approved │   │  │ Rejected │  (votesAgainst >= votesFor, or quorum not met)
    └────┬─────┘   │  └──────────┘
         │         │
         │         ▼
         │   ┌──────────┐
         │   │ Expired  │  (execution window passed without execution)
         │   └──────────┘
         ▼
   ┌──────────┐
   │ Executed │  (agent called executeProposal within window)
   └────┬─────┘
        │
        ▼
   ┌──────────┐
   │ Settled  │  (P&L calculated, performance fee distributed)
   └──────────┘

   At any point before settlement:
   - Proposer can Cancel their own proposal
   - Owner can Emergency Cancel any proposal
```

---

## Mandate Execution

When a proposal is approved, the pre-committed calls are executed via an isolated escrow:

1. Anyone calls `executeProposal(proposalId)` on the governor (no arguments beyond the ID)
2. Governor verifies: proposal is Approved, within execution window
3. Governor deploys a new `ProposalEscrow` contract for this proposal
4. Governor calls `vault.fundEscrow(escrow, capitalRequired)` — vault transfers capital to escrow
5. Governor calls `escrow.execute(proposal.calls)` — escrow runs the pre-approved calls
6. All DeFi positions (mTokens, LP tokens, borrows) now live on the escrow address

**No new input from the agent at execution time.** The calls were locked in at proposal creation and voted on by shareholders. Execution is just replaying what was approved.

**Capital isolation:** The strategy operates on the escrow, not the vault. The agent cannot access the vault's other assets. Other strategies running simultaneously are completely isolated in their own escrows.

---

## Strategy Duration & Settlement

Two separate clocks:

1. **Execution deadline** — time to *start* executing after approval (`executionWindow`, governor-controlled)
2. **Strategy duration** — time the position *runs* before settlement (`strategyDuration`, agent-proposed, capped by `maxStrategyDuration`)

```
|-- voting --|-- execution window --|-------- strategy duration --------|
   propose      execute calls          position is live        settlement
```

### Who can settle and when

| Who | When | Use case |
|-----|------|----------|
| Agent (proposer) | Anytime after execution | Early close — agent decides position has run its course |
| Owner | Anytime (emergency) | Force-close, agent no-show, or emergency |

If agent never settles, owner force-settles. Escrow returns whatever it holds to the vault.

### P&L Calculation — Escrow Pattern

**Problem:** If multiple strategies run simultaneously in the same vault, you can't use the vault's total balance change to attribute P&L. And allowing agents to submit arbitrary settlement calls against the vault is an attack vector — they could drain funds instead of unwinding.

**Solution:** Each proposal gets an isolated escrow. Capital is transferred from the vault to the escrow at execution. The agent's calls operate on the escrow, not the vault. Settlement returns whatever is in the escrow back to the vault. Agent physically cannot touch other strategies' funds or vault reserves.

#### ProposalEscrow.sol (new contract)

A minimal contract deployed per proposal. Holds the capital for one strategy.

```solidity
contract ProposalEscrow {
    address public immutable governor;
    address public immutable vault;
    uint256 public immutable proposalId;

    // Only governor can trigger execution and settlement
    modifier onlyGovernor();

    // Execute the pre-approved calls (delegatecall to BatchExecutorLib)
    function execute(BatchExecutorLib.Call[] calldata calls) external onlyGovernor;

    // Return all assets to vault
    function settle(address asset) external onlyGovernor returns (uint256 returned);
}
```

#### Lifecycle

```
Execute:
  1. Vault transfers capitalRequired to a new ProposalEscrow
  2. Governor records capitalDeployed[proposalId]
  3. Escrow executes the pre-approved calls[] 
     (positions now live on the escrow address, NOT the vault)

During strategy:
  - Position is live on the escrow (e.g. mTokens, LP tokens, borrowed assets)
  - Agent cannot interact with escrow directly — only governor can
  - Vault funds are untouched

Settle:
  1. Escrow returns all held assets to the vault
  2. P&L = assetsReturned - capitalDeployed
  3. If P&L > 0: fee = P&L * performanceFeeBps / 10000, transferred to proposer
  4. If P&L ≤ 0: no fee, loss is socialized across shareholders
  5. Proposal state → Settled
```

#### Why escrow solves the trust problem

- **No malicious settlement calls** — settlement is just "return everything to vault." No arbitrary calldata.
- **No cross-contamination** — each proposal's capital is isolated. Multiple strategies can run simultaneously without accounting complexity.
- **No attack surface** — agent never submits unwind calls. The escrow just sends back whatever it holds.
- **Clean P&L** — `assetsReturned - capitalDeployed`. No balance-diff tricks needed.

#### Who can trigger settlement

| Who | When |
|-----|------|
| Proposer (agent) | Anytime after execution — early close |
| Owner | Anytime — emergency |

No permissionless settlement by random addresses. Settlement is just an asset transfer from escrow to vault, so no risk of malicious calls.

**If agent never settles:** Owner force-settles. The escrow holds the position assets (mTokens, LP tokens, etc.) which get returned to the vault as-is. The vault/owner can then manually unwind those positions.

#### Unwind problem

The escrow holds DeFi positions (mTokens, LP tokens, borrows), not just the deposit asset (USDC). When `settle()` is called, it returns whatever tokens the escrow holds — but these might not be USDC.

**Options:**

**A. Settle returns all tokens, P&L calculated on deposit asset only**
- Escrow sends all ERC-20 balances back to vault
- P&L only measured in the deposit asset (USDC balance of escrow at settlement)
- Non-USDC tokens (mTokens, LP tokens) return to vault but aren't counted in P&L
- Vault owner must manually swap them back or agents can propose new strategies to handle them
- Simple but imprecise

**B. Agent must unwind before settling (via separate proposal)**
- Agent submits a new "unwind proposal" with calls to close the position (repay borrow, remove LP, swap back to USDC)
- Shareholders vote on the unwind calls (short voting period)
- Once executed, escrow holds USDC → settle returns clean P&L
- Safe but adds friction

**C. Pre-committed unwind calls at proposal time**
- Proposal includes `executeCalls[]` and `unwindCalls[]`
- `unwindCalls` are executed on the escrow before returning assets to vault
- Shareholders voted on everything upfront
- Con: unwind params (slippage, repayment amounts) may be stale

**Recommendation for hackathon:** Option A — keep it simple. Escrow returns whatever it holds. P&L on deposit asset. Complex position unwinding is manual / v2.

**Open question for Carlos:** Which unwind approach fits the demo best?

---

## Open Design Questions

### 1. LP Withdrawal When Capital is Deployed

**Problem:** If 100% of vault capital is deployed in active strategies, LPs can't ragequit — the vault has no liquid assets to return.

**Option A: Secondary market for vault shares**
- Vault shares are ERC-20 tokens — tradeable on any DEX or OTC
- LP sells shares instead of redeeming against vault
- Capital stays deployed, LP gets liquidity from a buyer
- Zero contract changes needed (already works)
- Con: requires a liquid market for shares (bootstrap problem)

**Option B: Withdrawal queue**
- LP signals intent to withdraw → enters queue
- When a strategy settles (agent closes position), queued withdrawals are filled first before capital can be re-deployed
- Capital is never idle — either in a strategy or being withdrawn
- Con: LP has to wait, unknown timing

**Option C: Redemption at settlement only**
- LPs can only redeem when a proposal settles
- Between settlements, trade shares on secondary
- Clean but restrictive

**Option D: Minimum liquidity reserve**
- Governor enforces X% of TVL must stay liquid
- Proposals can only request capital up to `totalAssets - reserve`
- Con: idle capital not earning yield — defeats the purpose

**Current recommendation:** Option A for hackathon (already works). Option B for production.

---

### 2. Multiple Active Proposals

Can multiple proposals be active simultaneously?
- Yes → capital allocation becomes complex (what if 3 proposals each want 50% of vault?)
- No → simpler but slower (one strategy at a time)

**Recommendation:** Yes, but with a capital budget. Sum of all active proposals' `capitalRequired` cannot exceed `totalAssets`. Governor tracks `totalCapitalAllocated` and rejects proposals that would over-commit.

---

### 3. Strategy Carry Model

From the Notion: *"Strategies are free to use. Strategy creators earn a cut of protocol fee on all TVL running their strategy."*

Two possible models:

**A. Per-proposal performance fee (current design)**
- Agent sets fee when proposing
- Fee paid on settlement from profits only
- Simple, clear, hackathon-ready

**B. Protocol-level revenue share (v2)**
- Strategy creators earn ongoing % of all TVL running their strategy
- More DeFi-native (like Uniswap LP fees)
- Needs StrategyRegistry integration, TVL tracking, streaming payments

**Recommendation:** Model A for hackathon. Model B is the long-term vision.

---

### 4. What Happens if a Strategy Loses Money?

- Agent earns nothing (performance fee only applies to profits)
- Loss is socialized across all shareholders (standard fund behavior)
- Agent's reputation takes a hit (EAS attestation records the loss)
- No slashing mechanism in v1

**Future consideration:** Agent bonds / slashing for repeated losses.

---

### 5. Can Agents Update a Live Proposal?

No. Once submitted, proposal params are immutable. If an agent wants different terms, they cancel and create a new proposal. Keeps voting clean — shareholders know exactly what they're voting on.

---

## Contract Architecture

```
                         ┌──────────────────────┐
                    ┌───▶│   SyndicateVault A    │──▶ BatchExecutorLib
                    │    │   (ERC-4626 proxy)    │
┌──────────────────┐│    └──────────────────────┘
│ SyndicateGovernor ├┤
│  (UUPS proxy)    ││    ┌──────────────────────┐
│                  │├───▶│   SyndicateVault B    │──▶ BatchExecutorLib
│  - proposals     ││    │   (ERC-4626 proxy)    │
│  - voting        ││    └──────────────────────┘
│  - parameters    ││
│  - vault registry│└───▶│   SyndicateVault N    │──▶ ...
└──────────────────┘     └──────────────────────┘
```

One governor manages multiple vaults. Each vault sets the governor as its trusted governance contract. Proposals target a specific vault. Only that vault's shareholders vote.

**Vault management is owner-controlled** — owner adds/removes vaults via `addVault` / `removeVault`. This is consistent with parameters being owner-controlled (global settings that affect all vaults).

---

## Required Changes

### New Contracts

#### 1. ProposalEscrow.sol (new file)

Minimal contract deployed per proposal. Isolates strategy capital from the vault.

- Deployed by governor during `executeProposal`
- Immutable references: `governor`, `vault`, `proposalId`
- `execute(calls[])` — onlyGovernor, delegatecalls BatchExecutorLib with the pre-approved calls
- `settle(asset)` — onlyGovernor, transfers all deposit-asset balance to vault, returns amount
- `recoverTokens(token, to)` — onlyGovernor, recovers non-deposit-asset tokens (mTokens, LP tokens) stuck after settlement
- Receives ETH (for WETH unwrapping)

#### 2. ISyndicateGovernor.sol (new file)

Full interface: structs (`StrategyProposal`, `ProposalState` enum), all errors, events, and function signatures.

#### 3. SyndicateGovernor.sol (new file)

UUPS upgradeable. Holds all governance logic.

**Storage:**
- `proposals` mapping (uint256 → StrategyProposal)
- `proposalCount` counter
- `hasVoted` mapping (proposalId → address → bool)
- `snapshotBalances` mapping (proposalId → address → uint256) for vote weight snapshots
- `proposalEscrows` mapping (proposalId → address) — escrow contract per proposal
- `totalCapitalAllocated` mapping (vault address → uint256) — per-vault sum of capitalRequired for Approved+Executed proposals
- `registeredVaults` — EnumerableSet of vault addresses the governor manages
- Governor parameters: `votingPeriod`, `executionWindow`, `quorumBps`, `maxPerformanceFeeBps`, `maxStrategyDuration`

**Functions:**
- `initialize(owner, votingPeriod, executionWindow, quorumBps, maxPerformanceFeeBps, maxStrategyDuration)`
- `addVault(address vault)` — governance proposal (or owner during bootstrap)
- `removeVault(address vault)` — governance proposal
- `propose(vault, metadataURI, capitalRequired, performanceFeeBps, strategyDuration, calls[])` → returns proposalId
  - Vault must be registered in governor
  - Caller must own an ERC-8004 identity NFT (verified on-chain)
  - `performanceFeeBps ≤ maxPerformanceFeeBps`
  - `strategyDuration ≤ maxStrategyDuration`
  - `totalCapitalAllocated[vault] + capitalRequired ≤ vault.totalAssets()`
  - Snapshots all current shareholder balances (or uses a checkpoint pattern)
- `vote(proposalId, support)` — support = true (FOR) / false (AGAINST)
  - Must be within voting period
  - Voter must have had shares at snapshot time
  - Cannot vote twice
  - Weight = share balance at snapshot
- `executeProposal(proposalId)` — permissionless, no arguments beyond ID
  - Proposal must be Approved (voting ended, quorum met, majority FOR)
  - Must be within execution window
  - Deploys a new ProposalEscrow contract
  - Calls `vault.fundEscrow(escrow, capitalRequired)` to transfer capital
  - Calls `escrow.execute(proposal.calls)` to run the pre-approved strategy
  - Updates `proposal.state = Executed`, records `executedAt`
  - Stores escrow address in `proposalEscrows[proposalId]`
- `settleProposal(proposalId)`
  - If caller is proposer: anytime after execution (early close)
  - If caller is owner: anytime (emergency)
  - Calls `escrow.settle(asset)` — returns all deposit-asset tokens to vault
  - Calls `vault.receiveSettlement(proposalId, proposer, performanceFeeBps, capitalDeployed)`
  - Frees `capitalRequired` from `totalCapitalAllocated[vault]`
- `cancelProposal(proposalId)` — proposer can cancel before voting ends
- `emergencyCancel(proposalId)` — owner can cancel anytime before settlement
- **Setters** (onlyOwner): `setVotingPeriod`, `setExecutionWindow`, `setQuorumBps`, `setMaxPerformanceFeeBps`, `setMaxStrategyDuration`, `addVault`, `removeVault`
- **Views**: `getProposal`, `getProposalState`, `getVoteWeight`, `hasVoted`, `proposalCount`, `getGovernorParams`, `getRegisteredVaults`

#### Why parameters are owner-controlled (not self-governed)

Governor parameters (votingPeriod, quorumBps, etc.) are **global** — they affect all vaults. But voting power is **per-vault** (only target vault shareholders vote). There's no fair way to decide which vault's shareholders get to change global settings. So parameters stay owner-controlled.

Shareholders govern **what happens with their money** (strategy proposals). The owner governs **the rules of the game** (governor parameters, vault registry).

**Safety bounds** (hardcoded, owner cannot exceed):
- `votingPeriod`: min 1 hour, max 30 days
- `executionWindow`: min 1 hour, max 7 days
- `quorumBps`: min 1000 (10%), max 10000 (100%)
- `maxPerformanceFeeBps`: min 0, max 5000 (50%)
- `maxStrategyDuration`: min 1 hour, max 365 days

**Emergency powers** (onlyOwner):
- `emergencyCancel(proposalId)` — cancel any proposal before settlement
- Parameter setters — change governor settings within safety bounds
- `addVault` / `removeVault` — manage vault registry

### Existing Contract Changes

#### 3. SyndicateVault.sol (modifications)

**New storage slots** (appended — UUPS safe):
- `address private _governor` — trusted governor contract

**New functions:**
- `setGovernor(address governor_)` — onlyOwner, sets trusted governor address
- `fundEscrow(address escrow, uint256 amount)` — onlyGovernor
  - Transfers `amount` of vault's deposit asset to the escrow contract
- `receiveSettlement(uint256 proposalId, address proposer, uint256 performanceFeeBps, uint256 capitalDeployed)` — onlyGovernor
  - Called after escrow returns assets to vault
  - Calculates P&L = deposit asset balance received - capitalDeployed
  - If profit > 0: transfers performance fee to proposer
  - Emits settlement event

**Removed functions:**
- `registerAgent` — no longer needed. Agent registration is replaced by ERC-8004 identity check at proposal time in the governor.
- `removeAgent` — no longer needed.
- `executeBatch` (by agents) — all execution goes through governor proposals. Consider removing or restricting to owner-only for manual vault management.

**New modifier:**
- `onlyGovernor` — `require(msg.sender == _governor)`

**New events:**
- `GovernorUpdated(address indexed oldGovernor, address indexed newGovernor)`
- `ProposalExecuted(uint256 indexed proposalId, uint256 capitalSnapshot)`
- `ProposalSettled(uint256 indexed proposalId, int256 pnl, uint256 performanceFee)`

#### 4. SyndicateFactory.sol (modifications)

Since the governor is a singleton managing multiple vaults, the factory doesn't deploy a governor. Instead:

1. Governor is deployed once (separate from factory)
2. Factory's `createSyndicate()` accepts an optional `governor` address in config
3. If provided, factory calls `vault.setGovernor(governor)` after deployment
4. Governor's `addVault()` is called separately (governance proposal, or owner during bootstrap)

```solidity
// Added to SyndicateConfig:
address governor;  // optional — address(0) means no governor
```

### New Tests

#### 5. SyndicateGovernor.t.sol (new file)

Full test suite:
- **Lifecycle:** propose → vote → approve → execute → settle (happy path)
- **Rejection:** votes against > votes for
- **Quorum:** not met → proposal cannot be executed
- **Expiry:** execution window passes → Expired
- **Snapshot:** buying shares after proposal doesn't increase vote weight
- **Double vote:** same address cannot vote twice
- **ERC-8004 gate:** only identity holders can propose, others rejected
- **Performance fee:** correct calculation and distribution on profit
- **No fee on loss:** zero fee when strategy loses money
- **Capital budget:** proposals rejected when total allocated exceeds vault assets
- **Settlement timing:** agent can settle early, anyone after duration, owner anytime
- **Cancel:** proposer cancels, owner emergency cancels
- **Parameter setters:** only owner, values validated
- **Fuzz:** voting weights, fee calculations, capital limits

#### 6. Existing tests — MAY NEED UPDATES

Some existing vault tests use `registerAgent` and `executeBatch` (agent direct execution) which are being removed/modified. These tests should be reviewed:
- Tests for `registerAgent` / `removeAgent` → remove or adapt
- Tests for `executeBatch` by agents → remove or change to owner-only
- Deposit/withdraw/ragequit tests → should still pass unchanged

### CLI Changes

#### 7. CLI commands (new)

- `sherwood proposal create --capital 5000 --fee 1500 --duration 7d --metadata ipfs://... --calls <encoded>`
- `sherwood proposal list [--state active|approved|executed]`
- `sherwood proposal show <id>` — full detail including decoded calls
- `sherwood proposal vote --id 1 --support yes|no`
- `sherwood proposal execute --id 1`
- `sherwood proposal settle --id 1`
- `sherwood governor set-voting-period --seconds 3600`
- `sherwood governor set-execution-window --seconds 86400`
- `sherwood governor set-quorum --bps 4000`
- `sherwood governor info` — current parameters

### Subgraph Changes

#### 8. Subgraph entities (new)

- `Proposal` entity: all proposal fields, state, votes
- `Vote` entity: voter, proposalId, support, weight
- `ProposalExecution` entity: proposalId, timestamp, txHash
- `ProposalSettlement` entity: proposalId, pnl, performanceFee

Event handlers for: `ProposalCreated`, `VoteCast`, `ProposalExecuted`, `ProposalSettled`, `ProposalCancelled`

### Dashboard Changes

#### 9. Dashboard pages (new/updated)

- **Proposals page** — list active/past proposals with vote status, call decoding
- **Proposal detail** — full rationale (IPFS metadata), vote breakdown, execution status, P&L
- **Vote UI** — connect wallet, vote for/against
- **Syndicate page** — add active proposals section, capital allocation breakdown
