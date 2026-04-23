# Contracts

Solidity smart contracts for Sherwood, built with Foundry and OpenZeppelin (UUPS upgradeable). All contracts deploy on Base.

> **Pre-mainnet tracker:** `docs/pre-mainnet-punchlist.md` consolidates the Critical/High findings from issues [#225](https://github.com/imthatcarlos/sherwood/issues/225) and [#226](https://github.com/imthatcarlos/sherwood/issues/226). Read it before making changes. Notable open items in this domain: V-C1 (donation-inflated PnL via `balanceOf` diff), V-C2 (`_executorImpl` codehash unchecked), I-1 (`redemptionsLocked()` fails open on `gov == 0`). ERC-4626 `maxDeposit/maxMint/maxWithdraw/maxRedeem` currently don't honor `paused()` / `redemptionsLocked()` / whitelist — tracked in punch list §7. V-C3 (owner `executeBatch` bypass) was closed by removing the owner-direct batch path.

## Architecture

```
                   ┌──────────────┐
   owner stake ──► │   Factory    │ ── deploys vault proxies, registers ENS subnames
                   └──────┬───────┘
                          │                    ┌────────────────────────┐
              ┌───────────▼───────────┐        │   GuardianRegistry     │
              │    SyndicateVault     │        │   (UUPS Proxy)         │
              │  (ERC1967 Proxy)      │◄───────┤  stakes, reviews,      │
              │                       │        │  slashing, epoch       │
              │  delegatecall ───────►│        │  rewards               │
              │                       │        └────────┬───────────────┘
              └───────────────────────┘                 │ (registry hooks)
                          ▲                             ▼
                          │                  ┌────────────────────────┐
                          └──────────────────┤   SyndicateGovernor    │
                                             │   proposals, review,   │
                                             │   execution, settle    │
                                             └────────────────────────┘

             BatchExecutorLib (stateless) — delegatecalled from vault
```

The vault is the identity — all DeFi positions (Moonwell supply/borrow, Uniswap swaps, Venice staking) live on the vault address. Agents execute through the vault via delegatecall into a shared stateless library.

## Contracts

### SyndicateVault

ERC-4626 vault with two-layer permission model. Extends `ERC4626Upgradeable`, `OwnableUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, `ERC721Holder`.

**Permissions:**
- **Layer 1 (onchain):** Syndicate caps (`maxPerTx`, `maxDailyTotal`, `maxBorrowRatio`) + per-agent caps + target allowlist
- **Layer 2 (offchain):** Lit Action policies on agent PKP wallets

**Key functions:**
- `executeGovernorBatch(calls)` — governor-only delegatecall to BatchExecutorLib. Strategy execution only reaches the vault via a passed shareholder proposal. (The owner-direct `executeBatch` path was removed to close V-C3.)
- `simulateBatch(calls)` — dry-run via `eth_call`, returns success/failure per call without submitting onchain
- `ragequit(receiver)` — LP emergency exit, burns all shares for pro-rata assets
- `registerAgent(agentId, pkp, eoa, limits)` — registers agent with ERC-8004 identity verification
- `deposit(assets, receiver)` / `withdraw(assets, receiver, owner)` — standard ERC-4626 with `totalDeposited` tracking

**Storage:**
- `_syndicateCaps` — syndicate-wide spending limits
- `_agents` mapping — pkp address → `AgentConfig` (agentId, operatorEOA, limits, active)
- `_allowedTargets` — `EnumerableSet` of whitelisted protocol addresses
- `_approvedDepositors` — `EnumerableSet` of whitelisted depositor addresses
- `_openDeposits` — bool toggle for permissionless deposits
- `_dailySpendTotal` / `_lastResetDay` — rolling daily spend tracking
- `totalDeposited` — cumulative deposits minus withdrawals (for profit calculation)

### SyndicateFactory

Deploys vault proxies (ERC1967) in one transaction. Registers ENS subnames atomically. Verifies ERC-8004 agent identity ownership on creation.

**Storage:**
- `syndicates[]` — syndicate ID → struct (vault, creator, metadata, subdomain, active)
- `vaultToSyndicate` — reverse lookup from vault address
- `subdomainToSyndicate` — reverse lookup from ENS subdomain

### BatchExecutorLib

Shared stateless library. Vault delegatecalls into it to execute batches of protocol calls (supply, borrow, swap, stake). Each call's target must be in the vault's allowlist.

### StrategyRegistry

Onchain registry of strategy implementations. Permissionless registration with creator tracking (for future carry fees). UUPS upgradeable.

### GuardianRegistry

UUPS upgradeable contract that adds a staked, slashable third-party review layer between proposal approval and execution (PR #229). Single contract handling four concerns:

1. **Guardian staking** — agents stake WOOD (≥ `minGuardianStake`, default 10k) to join the review cohort. 7-day cool-down on unstake. Vote weight = stake snapshotted at first vote per proposal.
2. **Owner staking** — vault owners post a WOOD bond at vault creation via `SyndicateFactory.createSyndicate` → `prepareOwnerStake` → `bindOwnerStake`. Bond is slashable via guardian block-quorum on `emergencySettleWithCalls`. `requiredOwnerBond(vault) = max(minOwnerStake, totalAssets * ownerStakeTvlBps / 10_000)`, re-checked at emergency-settle call time.
3. **Review vote accounting** — permissionless `openReview(id)` at `voteEnd` snapshots the quorum denominator. Guardians vote Approve / Block; block quorum (default 30% of total stake) → proposal `Rejected`, approvers slashed. WOOD is **burned** (not sent to treasury).
4. **Epoch rewards** — per-epoch (7-day) pool funded by protocol via `fundEpoch(epochId, amount)`; Block voters on blocked proposals split the epoch pool pro-rata by stake weight.

Also holds: `pause()` / `unpause()` (7-day deadman), pull-based burn fallback (`_pendingBurn` / `flushBurn` if the ERC-20 transfer reverts), and the `slashAppealReserve` (separate internal balance; `refundSlash` capped at 20% per epoch for wrongful slashes upheld by governance).

**Trust assumptions:** WOOD is non-hook / non-fee / non-rebasing. `governor` and `factory` pointers on the registry are stamped at `initialize()` and never reassigned.

Full spec: `docs/superpowers/specs/2026-04-19-guardian-review-lifecycle-design.md`.

## Deployed Addresses

### Sherwood (Base Sepolia)

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0xc705F04fF2781aF9bB53ba416Cb32A29540c4624` |
| StrategyRegistry | `0x8A45f769553D10F26a6633d019B04f7805b1368A` |
| SyndicateVault (impl) | `0x7E1F71A72a88Ce8418cf82CACDE9ce5Bbbcf5772` |
| BatchExecutorLib | `0x0c63Ea92336eA0324B81eB6D0fD62455eC38091b` |
| GuardianRegistry | TBD after first post-#229 deploy — see `contracts/chains/84532.json` → `GUARDIAN_REGISTRY` |

### External (Base Mainnet)

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| Uniswap V3 SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

### ERC-8004 Identity (not ours)

| Contract | Base Mainnet | Base Sepolia |
|----------|-------------|--------------|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

## Testing

Tests live in `contracts/test/`. Count drifts with the codebase — check `forge test --list` for the current total.

```bash
cd contracts
forge build        # compile
forge test         # run all tests
forge test -vvv    # verbose with traces
forge fmt          # format before committing
```

**SyndicateVault (49 tests):** ERC-4626 deposits/withdrawals, agent registration with ERC-8004 verification, batch execution with target allowlist, syndicate + per-agent daily spend tracking, ragequit, depositor whitelist, total deposited tracking, pause/unpause, simulation, fuzz testing.

**SyndicateFactory (17 tests):** Syndicate creation with ENS subname registration, ERC-8004 verification on create, metadata updates, deactivation, proxy storage isolation, subdomain availability.

## Deployment

```bash
forge script script/testnet/Deploy.s.sol:DeployTestnet \
  --rpc-url base_sepolia \
  --account sherwood-agent \
  --broadcast
```

Deployment records saved in `contracts/chains/{chainId}.json`.

## Storage Layout (UUPS Safety)

When modifying `SyndicateVault`, always append new storage variables at the end. Never reorder or remove existing slots. See `contracts/README.md` for the full slot map.
