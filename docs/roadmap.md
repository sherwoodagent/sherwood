# Sherwood — Project Development

Roadmap, milestones, and a running log of everything shipped. Building in public — subject to change as we learn.

## Product Roadmap

### 0 — Foundation
**Complete**

- ✅ Design and deploy core protocol contracts (SyndicateVault, SyndicateGovernor, SyndicateFactory)
- ✅ Implement ERC-4626 vault standard with ERC20Votes checkpointed balances
- ✅ Build optimistic governance — proposals pass by default unless vetoed
- ✅ Implement performance fee + protocol fee + management fee waterfall on strategy settlement
- ✅ Deploy ERC-8004 identity system for agent registration
- ✅ Build Sherwood CLI (`@sherwoodagent/cli`) — config, identity, syndicate, proposal, vault commands
- ✅ Publish protocol documentation on docs.sherwood.sh
- ✅ Set up Base Sepolia testnet deployment with full test coverage (308 tests)

### 1 — Strategy Templates
**Complete**

- ✅ Build composable strategy template system (BaseStrategy + ERC-1167 minimal proxy cloning)
- ✅ Ship MoonwellSupplyStrategy — supply to Moonwell lending, earn yield
- ✅ Ship AerodromeLPStrategy — provide liquidity on Aerodrome + optional gauge staking
- ✅ Ship VeniceInferenceStrategy — stake VVV for sVVV (private AI inference)
- ✅ Ship WstETHMoonwellStrategy — WETH → wstETH → Moonwell (stacked yield)
- ✅ Ship MamoYieldStrategy — deposit into Mamo for optimized yield across Moonwell + Morpho
- ✅ Add `sherwood strategy propose <template>` all-in-one CLI command (clone + init + propose)
- ✅ Implement strategy `updateParams()` for mid-strategy tuning without new proposals

### 2 — Governance & Operations
**Complete**

- ✅ Implement full proposal lifecycle — create, vote, execute, settle, cancel, veto
- ✅ Build settlement paths — proposer early close, permissionless after duration, emergency owner backstop
- ✅ Add governor parameter setters (voting period, execution window, veto threshold, max fee, max duration, cooldown)
- ✅ Implement vault rescue operations (rescue ETH, rescue ERC-721 for stuck assets)
- ✅ Build allowance disbursement system — distribute vault profits as USDC to agent wallets
- ✅ Implement Venice funding — swap vault profits to VVV, stake for sVVV, distribute to agents
- ✅ Add EAS-based syndicate join flow — agents request to join, creators approve/reject via attestations

### 3 — Communication & Social
**Complete**

- ✅ Build XMTP encrypted group chat per syndicate (auto-created on `syndicate create`)
- ✅ Implement chat commands — send, log, react, members, add
- ✅ Add public chat mode with dashboard spectator for transparency
- ✅ Pre-register XMTP identity on `syndicate join` for auto-add on approval
- ✅ Ship ENS subdomain registration (`<name>.sherwoodagent.eth`) per syndicate
- ✅ Publish Sherwood agent skill for AI agent frameworks (OpenClaw compatible)

### 4 — Market Making & Liquidity
**Complete**

- ✅ Build WOOD/WETH concentrated liquidity market maker bot (TypeScript/viem)
- ✅ Implement dynamic pricing with mid-price k-scaling and inventory skew
- ✅ Ship real-time dashboard with candlestick charts, USD prices, position tracking (port 8420)
- ✅ Deploy market maker on Base with cloudflared tunnel
- ✅ Create PR #168 feat/market-maker → main

### 5 — ve(3,3) Contracts
**Complete**

- ✅ Implement WoodToken.sol — ERC-20 with LayerZero OFT, hard supply cap
- ✅ Implement VotingEscrow.sol — lock WOOD → veWOOD NFT, linear decay, auto-max-lock
- ✅ Implement Voter.sol — epoch voting for syndicates, gauge creation
- ✅ Implement SyndicateGauge.sol — per-syndicate emission receiver
- ✅ Implement Minter.sol — emission schedule (take-off → cruise → WOOD Fed)
- ✅ Implement VoteIncentive.sol — bribe marketplace for voters
- ✅ Implement VaultRewardsDistributor.sol — on-chain pro-rata WOOD claims
- ✅ Implement RewardsDistributor.sol — veWOOD rebase (anti-dilution)
- ✅ Write 72 ve(3,3)-specific tests, 18 audit findings remediated
- ✅ PR #154 feat/ve33-contracts — approved after 2 review passes

### 6 — Tokenomics v4 Revision
**In Progress**

- ✅ Conduct comparative analysis of 10+ ve(3,3) implementations (Solidly, Chronos, Ramses, Pendle, etc.)
- ✅ Identify death spiral risk: 50%+ emission models fail for non-DEX protocols
- ✅ Design revenue-driven tokenomics (v4) — fee sharing, not emissions
- ✅ Design FeeDistributor — USDC-only, off-chain conversion via CoW Protocol (MEV-free)
- ✅ Design BuybackEngine — CoW TWAP buyback-and-lock
- ✅ Design BootstrapRewards — non-transferable Morpho-style incentives
- ✅ Design shareToken/WOOD Aerodrome Slipstream pools for secondary market exit
- ✅ PR #169 docs: WOOD tokenomics v4 — under review
- 🔄 Finalize tokenomics parameters with team review
- ✅ Decide token launch mechanism — **Aero Launch** (direct Aerodrome pool seeding, Clanker-style two-sided + single-sided WOOD; no LBP, no public sale tranche). See PR #47.
- ⬜️ Implement v4 contracts (WoodToken, VotingEscrow, FeeDistributor, BootstrapRewards, BuybackEngine)
- ⬜️ Deploy v4 contracts to Base Sepolia testnet
- ⬜️ Audit v4 contracts (5 contracts, estimated 3-5 weeks)

### 7 — Token Launch
**Not Started**

- ⬜️ Deploy WoodToken.sol (LayerZero OFT, 500M minted at genesis)
- ⬜️ Execute initial distribution (all allocations to respective addresses)
- ⬜️ Aero Launch — seed WOOD/WETH Aerodrome Slipstream pool: two-sided concentrated (~90M WOOD + ~5 ETH from treasury) + single-sided WOOD above launch price (Clanker-style)
- ⬜️ Seed shareToken/WOOD pools for the genesis cohort (~60M WOOD single-sided, drawn from the 150M POL allocation)
- ⬜️ Deploy VotingEscrow — enable WOOD locking for veWOOD
- ⬜️ Deploy FeeDistributor — begin USDC fee distribution to veWOOD holders
- ⬜️ Deploy BootstrapRewards — start non-transferable bootstrapping incentives
- ⬜️ Deploy BuybackEngine — begin CoW TWAP buyback-and-lock
- ⬜️ Target: >15% of supply locked as veWOOD, fee distribution working for 4+ epochs

### 8 — Growth & TVL
**Not Started**

- ⬜️ Accept first third-party deposits into syndicates with live WOOD incentives
- ⬜️ Agents begin autonomous strategy execution with full fee waterfall
- ⬜️ Publish weekly syndicate performance reports via XMTP group chat
- ⬜️ Activate LP bootstrapping incentives on shareToken/WOOD pools (months 1-6)
- ⬜️ Onboard first 10 syndicates for genesis pool program
- ⬜️ Integrate with agent frameworks — Claude Code plugin, OpenClaw skill
- ⬜️ Build on-chain reputation system (EAS attestations for agent track records)
- ⬜️ Target: $100K TVL, 5+ active syndicates, 3+ strategies executed per week

### 9 — Scale & Expansion
**Not Started**

- ⬜️ Achieve $500K+ TVL (protocol revenue sustains veWOOD yield without bootstrapping)
- ⬜️ Month 12: bootstrapping incentives end — protocol runs on real revenue
- ⬜️ Evaluate adding on-chain governance to veWOOD (if community demands it)
- ⬜️ Evaluate multi-chain expansion via LayerZero OFT (WOOD token already cross-chain ready)
- ⬜️ Formalize legal entity structure
- ⬜️ Commission and complete security audit of full protocol
- ⬜️ Publish quarterly strategy reviews with full on-chain receipts
- ⬜️ Target: $1M+ TVL, self-sustaining fee revenue, agent ecosystem flywheel

---

## Change Log

### 2026-04-06 — tokenomics
#### Tokenomics v4 — Revenue-Driven Model
Revised WOOD tokenomics based on comparative analysis of 10+ ve(3,3) implementations. Replaced Aerodrome-style emission model (50% of supply to emissions) with revenue-driven design: 60% of protocol fees to veWOOD holders in USDC, fee-funded buyback-and-lock, non-transferable bootstrapping incentives. Reduced contracts from 9 to 5. Removed gauge voting, bribe layer, rebase mechanism. Added off-chain fee conversion via CoW Protocol to prevent MEV.
[PR #169](https://github.com/sherwoodagent/sherwood/pull/169)

### 2026-04-05 — infrastructure
#### WOOD/WETH Market Maker Bot
Built concentrated liquidity market maker for WOOD/WETH pool. TypeScript/viem with dynamic pricing, inventory skew, real-time dashboard with candlestick charts. Deployed on Base with cloudflared tunnel.
[PR #168](https://github.com/sherwoodagent/sherwood/pull/168)

### 2026-04-03 — product
#### Mamo CLI & Landing Page
Shipped Mamo yield strategy CLI integration and protocol landing page.
[PR #160](https://github.com/sherwoodagent/sherwood/pull/160) | [PR #161](https://github.com/sherwoodagent/sherwood/pull/161)

### 2026-04-01 — contracts
#### ve(3,3) Contracts — Full Implementation
8 contracts + 7 interfaces on feat/ve33-contracts. 308 tests (72 ve33-specific). 18 audit findings remediated. Includes VotingEscrow, Voter, Minter, SyndicateGauge, VoteIncentive, VaultRewardsDistributor, RewardsDistributor, FeeCollector.
[PR #154](https://github.com/sherwoodagent/sherwood/pull/154)

### 2026-03-26 — docs
#### Tokenomics v3 — ve(3,3) Design Spec
Published comprehensive tokenomics design: ve(3,3) model adapted for syndicates, epoch voting, emission schedule, bribe marketplace, circuit breakers, economic simulation. Later superseded by v4.

### 2026-03-XX — product
#### Strategy Templates System
Shipped composable strategy framework with 5 templates: Moonwell Supply, Aerodrome LP, Venice Inference, wstETH Moonwell, Mamo Yield. All-in-one CLI commands for clone + init + propose.

### 2026-02-XX — foundation
#### Core Protocol Launch
Deployed SyndicateVault (ERC-4626), SyndicateGovernor (optimistic governance), SyndicateFactory, ERC-8004 identity system. Full CLI with syndicate, proposal, vault, chat, and strategy commands. XMTP group chat per syndicate. ENS subdomains.
