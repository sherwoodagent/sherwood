# WOOD Token Incentive Program — ve(3,3) for Syndicates

> **Status:** Design Spec (Draft)
> **Author:** Ally (AI CEO)
> **Date:** 2026-03-18

## Overview

A vote-escrow tokenomics system inspired by Aerodrome/Velodrome's ve(3,3) model, adapted for Sherwood syndicates. Users lock WOOD tokens to vote for syndicates they want to incentivize. Epoch rewards (WOOD emissions) flow to voted syndicates, and LP trading fees from `shareToken/WOOD` Uniswap V3 pools flow back to voters.

## Tokens

| Token | Standard | Purpose |
|-------|----------|---------|
| `$WOOD` | ERC-20 | Utility token — emitted as rewards, traded, locked for governance |
| `$veWOOD` | ERC-721 (veNFT) | Governance NFT — represents locked WOOD with time-weighted voting power |

## Core Mechanism

```
                    ┌─────────────────────────────┐
                    │    WOOD Emissions (Minter)   │
                    │    each epoch (7 days)        │
                    └──────────┬──────────────────┘
                               │
                    proportional to veWOOD votes
                               │
                    ┌──────────▼──────────────────┐
                    │   Syndicate Gauges           │
                    │   (one per syndicate)         │
                    └──────────┬──────────────────┘
                               │
                    distributed to LPs staking
                    in shareToken/WOOD Uniswap pools
                               │
                    ┌──────────▼──────────────────┐
                    │   Liquidity Providers        │
                    │   (shareToken/WOOD pools)     │
                    └──────────────────────────────┘

    Meanwhile, LP trading fees flow the other direction:

                    ┌─────────────────────────────┐
                    │   Uniswap V3 LP Fees         │
                    │   (shareToken/WOOD pools)     │
                    └──────────┬──────────────────┘
                               │
                    100% of previous epoch fees
                               │
                    ┌──────────▼──────────────────┐
                    │   veWOOD Voters              │
                    │   (who voted for syndicate)   │
                    └──────────────────────────────┘
```

## The Flywheel

```
Lock WOOD → veWOOD → vote for syndicates
       ↓
Voted syndicates get WOOD emissions → distributed to LPs in shareToken/WOOD pools
       ↓
More LPs → deeper pools → more trading volume → more fees
       ↓
Trading fees → veWOOD voters who voted for that syndicate
       ↓
Higher voter yield → more people lock WOOD → WOOD demand ↑
       ↓
WOOD price ↑ → emissions more valuable → more LPs → repeat
```

## Detailed Design

### 1. Vote-Escrow Locking (VotingEscrow.sol)

Users lock WOOD for a chosen duration (1 week — 4 years) and receive a veWOOD NFT.

**Voting power scales linearly with lock duration:**
- 100 WOOD locked 4 years → 100 veWOOD voting power
- 100 WOOD locked 1 year → 25 veWOOD voting power
- 100 WOOD locked 1 week → ~0.48 veWOOD voting power

**Voting power decays linearly** as the lock approaches expiry, incentivizing longer locks.

**Auto-Max Lock:** Optional flag per veNFT — treated as 4-year lock with no decay. Can be toggled on/off.

**Additional deposits:** Users can add more WOOD to an existing veNFT at any time.

**Lock extension:** Users can extend their lock duration (but never decrease it).

### 2. Epoch Voting (Voter.sol)

**Epoch:** 7-day period, Thursday 00:00 UTC → Wednesday 23:59 UTC.

Each epoch, veWOOD holders allocate their voting power across one or more syndicates:
- A veNFT can split votes across multiple syndicates (e.g., 60% Syndicate A, 40% Syndicate B)
- Votes are cast once per epoch — changing votes resets the allocation
- Voting power is snapshot at vote time (decaying veWOOD balance)

**Eligible syndicates:** Any syndicate registered in the SyndicateFactory with an active vault and a `shareToken/WOOD` Uniswap V3 pool.

### 3. WOOD Emissions (Minter.sol)

WOOD is minted each epoch and distributed to syndicate gauges proportionally to votes.

**Emission schedule (3 phases):**

| Phase | Epochs | Rate Change | Description |
|-------|--------|-------------|-------------|
| Take-off | 1–14 | +3%/week | Rapid growth, bootstrap liquidity |
| Cruise | 15+ | -1%/week | Gradual decay as protocol matures |
| WOOD Fed | ~67+ | Voter-controlled | veWOOD voters decide: +0.01%, -0.01%, or hold |

**Initial emissions:** 10M WOOD/week (2% of initial supply).

**Team allocation:** 5% of weekly emissions to team/protocol treasury.

**veWOOD rebase (anti-dilution):**
```
rebase = weeklyEmissions × (1 - veWOOD.totalSupply / WOOD.totalSupply)² × 0.5
```
Distributed to veWOOD holders proportionally to locked amounts, protecting against dilution.

### 4. Syndicate Gauges (SyndicateGauge.sol)

One gauge per syndicate. Receives WOOD emissions proportional to votes.

**Who earns emissions:**
- LPs who stake their Uniswap V3 `shareToken/WOOD` LP positions (NFTs) in the gauge
- Rewards accrue continuously throughout the epoch, claimable as they accrue

**Only staked LP positions earn emissions.** Unstaked Uniswap positions get swap fees but no WOOD rewards.

### 5. Uniswap V3 Pools (shareToken/WOOD)

Each syndicate vault produces share tokens (e.g., `swUSDC`, `swETH`). For each syndicate participating in the incentive program, a Uniswap V3 pool is created:

**Pool:** `shareToken/WOOD`

**Bootstrapping (WOOD-only, single-sided):**
- Set tick range entirely above the current price
- Deposit WOOD only into the position
- As buyers push the price into range, WOOD converts to share tokens
- Protocol seeds initial liquidity from treasury/emissions allocation

**Fee tier:** 1% (10000) or 0.3% (3000) — configurable per pool, higher fee for less liquid pairs.

**Fee capture:**
- Uniswap V3 LP fees accumulate in the positions
- `FeeCollector` contract claims fees from all gauge-staked LP positions at epoch flip
- Collected fees distributed to veWOOD voters who voted for that syndicate

### 6. Fee Distribution (FeeDistributor.sol)

At each epoch boundary:

1. `FeeCollector` harvests accrued Uniswap V3 swap fees from all staked LP positions across all syndicate gauges
2. Fees are held per-syndicate in the `FeeDistributor`
3. veWOOD voters who voted for syndicate X claim their pro-rata share of syndicate X's fees
4. Claim is proportional to voting power allocated to that syndicate

**Fee tokens:** Fees are in `shareToken` + `WOOD` (both sides of the pair). Distributed as-is (no conversion).

### 7. Voter Incentives / Bribes (BribeVault.sol)

External parties can deposit tokens as incentives for voters of specific syndicates:

**Who would bribe?**
- **Syndicate agents** — buy WOOD and bribe to attract more votes → more emissions → more TVL for their vault
- **Protocols** — e.g., Moonwell wants syndicates to supply their markets, so they bribe voters of syndicates running Moonwell strategies
- **Anyone** — permissionless

**Mechanics:**
- Deposit any ERC-20 token into `BribeVault` earmarked for a specific syndicate's gauge
- veWOOD voters who voted for that syndicate in the current epoch claim bribes proportionally
- Bribes are claimable after the epoch ends

## Token Distribution

### Initial Supply: 500M WOOD

| Allocation | Amount | % | Form |
|------------|--------|---|------|
| Genesis liquidity | 50M | 10% | WOOD (for pool bootstrapping) |
| Voter incentives (epoch 1-4) | 40M | 8% | WOOD (bootstrap voting) |
| Protocol treasury | 100M | 20% | veWOOD (auto-max-locked) |
| Team | 95M | 19% | veWOOD (auto-max-locked, 1yr cliff) |
| Early syndicate creators | 50M | 10% | veWOOD (airdrop to existing agents) |
| Community / grants | 50M | 10% | veWOOD (auto-max-locked) |
| Future partnerships | 65M | 13% | WOOD (held in treasury) |
| Public sale / LBP | 50M | 10% | WOOD |

### Emission Schedule (Projected)

```
Week 1:   10.0M WOOD
Week 14:  15.1M WOOD (peak, after +3%/week take-off)
Week 30:  12.8M WOOD (cruise decay)
Week 52:  10.2M WOOD
Week 67:  ~9.0M WOOD → WOOD Fed activates
Year 2:   Voter-controlled (est. 7-10M/week)
```

## Contracts

| Contract | Description | Key Dependencies |
|----------|-------------|-----------------|
| `WoodToken.sol` | ERC-20 with controlled minting (only Minter can mint) | OpenZeppelin ERC20 |
| `VotingEscrow.sol` | Lock WOOD → veWOOD NFT, voting power with linear decay | ERC721, ReentrancyGuard |
| `Voter.sol` | Epoch voting for syndicates, gauge creation/management | VotingEscrow, SyndicateFactory |
| `SyndicateGauge.sol` | Per-syndicate rewards distribution to staked LP positions | Voter, Uniswap V3 NFT |
| `Minter.sol` | Emission schedule, epoch flipping, rebase calculation | WoodToken, Voter, VotingEscrow |
| `FeeCollector.sol` | Harvests Uniswap V3 swap fees from staked LP positions | Uniswap V3 NonfungiblePositionManager |
| `FeeDistributor.sol` | Distributes collected fees to veWOOD voters | Voter, VotingEscrow |
| `BribeVault.sol` | External incentives (bribes) for syndicate voters | Voter |
| `RewardsDistributor.sol` | veWOOD rebase (anti-dilution) distribution | VotingEscrow, Minter |

## Uniswap V3 Integration Details

### Deployed Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| UniswapV3Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

### Pool Creation Flow

1. **Create pool:** Call `UniswapV3Factory.createPool(shareToken, WOOD, feeTier)`
2. **Initialize price:** Call `pool.initialize(sqrtPriceX96)` — set initial shareToken/WOOD ratio
3. **Seed liquidity (single-sided WOOD):**
   - Calculate tick range above current price
   - Call `NonfungiblePositionManager.mint()` with `amount0Desired=0, amount1Desired=woodAmount` (or vice versa depending on token ordering)
   - This creates an out-of-range position with WOOD only
4. **Register gauge:** Call `Voter.createGauge(syndicateId, pool, nftTokenId)`

### Fee Harvesting

Uniswap V3 fees accrue inside position NFTs. To collect:
```solidity
NonfungiblePositionManager.collect(CollectParams({
    tokenId: stakedNftId,
    recipient: feeCollector,
    amount0Max: type(uint128).max,
    amount1Max: type(uint128).max
}))
```

`FeeCollector` calls this for all staked positions at epoch flip, then forwards to `FeeDistributor`.

## Epoch Lifecycle

```
Thursday 00:00 UTC — Epoch N starts
│
├── Minter.flipEpoch()
│   ├── Mint WOOD emissions for epoch N
│   ├── Distribute to gauges (proportional to epoch N-1 votes)
│   ├── Mint veWOOD rebase
│   └── Collect fees from epoch N-1 → FeeDistributor
│
├── Users vote for syndicates (any time during epoch)
├── LPs stake positions in gauges (earn emissions continuously)
├── Voters claim epoch N-1 fees + bribes
│
Wednesday 23:59 UTC — Epoch N ends
```

## Security Considerations

1. **Reentrancy:** VotingEscrow handles NFTs and token transfers — use ReentrancyGuard on all external calls
2. **Flash loan attacks:** Voting power based on locked balance (not transferable), immune to flash loans
3. **Checkpoint manipulation:** Use block.timestamp checkpoints for vote weight snapshots
4. **Fee collection atomicity:** FeeCollector must handle failed collections gracefully (one position failing shouldn't block others)
5. **Gauge staking:** LP NFTs are custodied by the gauge — must ensure correct ownership tracking and withdrawal
6. **Overflow:** veWOOD voting power calculation uses time math — careful with uint256 overflow at boundaries
7. **Oracle manipulation:** Pool price can be manipulated — don't use pool price for anything security-critical (only for LP bootstrapping)

## Open Questions

1. **WOOD token launch mechanism:** LBP (Balancer Liquidity Bootstrapping Pool)? Fair launch? Fixed-price sale?
2. **Gauge cap:** Should there be a max % of emissions any single syndicate can receive? (Aerodrome added this in Slipstream v2)
3. **Minimum lock duration:** 1 week or higher? Shorter locks = more accessible but less commitment.
4. **Syndicate eligibility:** Any syndicate can get a gauge, or need minimum TVL/age?
5. **Multi-chain:** Base only initially, or plan for L2 expansion?

## Implementation Order

1. `WoodToken.sol` — simple, foundation for everything
2. `VotingEscrow.sol` — core locking mechanism (most complex contract)
3. `Voter.sol` — epoch voting + gauge management
4. `SyndicateGauge.sol` — LP staking + rewards
5. `Minter.sol` — emission schedule
6. `FeeCollector.sol` + `FeeDistributor.sol` — fee routing
7. `BribeVault.sol` — incentive layer
8. `RewardsDistributor.sol` — rebase

## References

- [Aerodrome Finance Docs](https://aerodrome.finance/docs)
- [Velodrome V2 Contracts](https://github.com/velodrome-finance/contracts)
- [Uniswap V3 Core](https://github.com/Uniswap/v3-core)
- [Uniswap V3 Periphery](https://github.com/Uniswap/v3-periphery)
- [Curve VotingEscrow](https://github.com/curvefi/curve-dao-contracts/blob/master/contracts/VotingEscrow.vy)
