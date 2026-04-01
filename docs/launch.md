# WOOD Token Launch Strategy — Options & Analysis

> **Status:** Draft for discussion
> **Date:** 2026-03-27
> **For:** Carlos + team review

## The Core Question

How do we launch 75M WOOD (15% of supply, public sale allocation) in a way that:
1. Creates fair price discovery
2. Generates enough WETH to seed a legitimate WOOD/WETH Uniswap pool
3. Looks credible on DEXScreener (not a rugpull)
4. Gets eyes on the project

## Option A: Fjord Foundry LBP (Recommended if <100 ETH available)

**How it works:** Deposit WOOD only into Fjord. Price starts high, decays over 2-3 days. Buyers bring their own WETH. Price settles where demand meets supply. After LBP, use WETH proceeds to seed Uniswap pool.

**Pros:**
- No WETH needed upfront — buyers bring the WETH side
- Fair price discovery (anti-whale: early large buys get punished as price decays)
- Battle-tested platform ($1.1B+ raised, 717 LBPs, supports Base natively)
- Creates a marketing event (countdown, community engagement)
- After LBP, you have real WETH to seed a credible Uniswap pool

**Cons:**
- Platform fee ~1-2%
- Average ~149 participants per LBP (median likely 50-100)
- Not a distribution/awareness channel — reach is small
- Track record of launched tokens is poor (most -90-99% from raise)

**Fjord launch results (current market caps):**

| Token | Chain | LBP Raised | Current Market Cap | Performance |
|-------|-------|-----------|-------------------|-------------|
| Fjord Foundry (FJO) | Multi | $15M | ~$134K | -99% |
| Zero1 Labs (DEAI) | Multi | $10M | ~$300K-$1.1M | -90-97% |
| Analog (ANLOG) | Multi | $1-3M | ~$110K-$3.2M | Down significantly |
| Arcadia Finance (AAA) | **Base** | $289K | ~$700K-$890K | **Up 2-3x** (only winner) |

**Key takeaway:** Arcadia (Base, small raise, DeFi protocol) is the closest comp and the only one that performed. Modest expectations outperform hype-driven launches.

**Recommended Fjord parameters:**
- Duration: 48-72 hours
- Starting price: 5-10x target FDV (e.g., if targeting $10M FDV, start at $0.10-0.20, let it decay to ~$0.02)
- Allocation: 75M WOOD (full public sale allocation)
- Expected proceeds: $50K-$300K in WETH (realistic given ~100 participants)

**Post-LBP flow:**
```
LBP ends → collect WETH proceeds + unsold WOOD
         → create WOOD/WETH Uniswap V3 full-range pool
         → token appears on DEXScreener with real liquidity
         → Phase 0 complete
```

## Option B: Direct Uniswap V3 Pool Bootstrap

**How it works:** Deploy WoodToken, create WOOD/WETH pool, seed with WOOD + WETH. People buy by swapping WETH on Uniswap.

**Pros:**
- Simplest approach. Zero platform fees or dependencies.
- Pool is permanent from day one.
- No coordination needed — deploy and announce.

**Cons:**
- Requires WETH upfront to seed the pool
- No price discovery — team picks initial price (risk of mispricing)
- Bots/MEV will snipe the first block
- No marketing event

**WETH requirements by target FDV (using 75M WOOD):**

| Target FDV | WOOD Price | 75M WOOD Value | WETH Needed (1:1) | ETH @ $2000 |
|-----------|-----------|---------------|-------------------|-------------|
| $5M | $0.01 | $750K | $750K | 375 ETH |
| $10M | $0.02 | $1.5M | $1.5M | 750 ETH |
| $25M | $0.05 | $3.75M | $3.75M | 1,875 ETH |

**Single-sided variant (WOOD only, no WETH):**
Deposit 75M WOOD in a range above $0. Buyers bring WETH. Pool becomes two-sided over time. Zero WETH needed — but starts with $0 liquidity on DEXScreener, which looks terrible.

## Option C: Flaunch (Base-native Launchpad)

**How it works:** Memecoin launchpad on Base using Uniswap V4. 30-min no-sell rule, progressive bid wall from trading fees.

**Pros:**
- Base-native, popular platform
- Built-in buy support mechanism (bid wall)
- No WETH needed

**Cons:**
- Positioned as a memecoin platform — wrong signal for a DeFi governance token
- Flaunch takes all trading fees
- Associates WOOD with memecoins, not serious DeFi

**Verdict:** Not recommended. Wrong brand positioning.

## DEXScreener Optics — Why Liquidity Matters

When traders check a new token on DEXScreener, the first thing they see is liquidity. This determines whether they buy or close the tab.

| Pool Liquidity | DEXScreener Perception | Can Handle | Verdict |
|---------------|----------------------|------------|---------|
| $10K (5 ETH) | "Rug pull" — red flags everywhere | $100 buys | Dead on arrival |
| $50K (25 ETH) | Micro-cap, risky but real | $1K buys | Minimum viable |
| $200K (100 ETH) | Legit small project | $5-10K buys | Good launch |
| $500K+ (250 ETH) | Serious protocol | $25K+ buys | Excellent |

**The minimum to not look like a scam: ~$50K liquidity (25 ETH + equivalent WOOD).**

Anything under $50K gets a "Low liquidity" warning on DEXScreener. Under $10K is indistinguishable from the thousands of memecoin rugs that launch daily on Base.

## Decision Matrix

| Factor | Fjord LBP | Direct Uniswap | Flaunch |
|--------|:---------:|:--------------:|:-------:|
| WETH needed upfront | None | 100-750 ETH | None |
| Price discovery | Built-in | Manual (team sets) | Built-in |
| Bot/MEV protection | Yes (decay model) | No | Partial (30-min no-sell) |
| Marketing event | Yes (countdown) | No | Yes |
| Platform fees | 1-2% | 0% | All trading fees |
| Brand positioning | Neutral | Neutral | Negative (memecoin) |
| DEXScreener optics | Good (post-LBP pool has real WETH) | Depends on ETH budget | Good |
| Complexity | Medium | Low | Low |

## Recommendation

**If we have <100 ETH: Use Fjord LBP.** It solves the WETH bootstrapping problem — buyers bring the WETH. Even with ~100 participants contributing $50-200K total, we get enough to seed a credible Uniswap pool post-LBP.

**If we have 100+ ETH: Direct Uniswap pool is simpler.** Skip the platform, seed a $200K+ pool, announce, and let the market come. Pair with a strong marketing push (Twitter, Farcaster, Base ecosystem partnerships).

**Either way, the launch platform is not the make-or-break factor.** The tokens that survived (Arcadia) did so because of product traction, not launch mechanics. WOOD's success depends on syndicate TVL and bribe demand, not how it launches.

## Open Questions for Discussion

1. **How much ETH do we have available for launch?** This determines Fjord vs. direct Uniswap.
2. **Target launch FDV?** $5M (conservative) vs $10M (base case) changes everything about pool sizing.
3. **Timeline?** Fjord needs 2-4 weeks of setup + marketing before the LBP. Direct Uniswap can launch same-day.
4. **Marketing plan?** Neither Fjord (~100 buyers) nor Uniswap (zero built-in audience) drives meaningful distribution. The marketing push around the launch matters more than the platform.
5. **Do we want the 75M public sale allocation to go entirely into the pool, or keep some for future raises/incentives?**

## Market Context (March 2026)

- AI agent tokens in deep winter: AIXBT -95%, elizaOS -99% from peak
- Aerodrome (closest ve(3,3) comp on Base): $310M mcap
- Entire OpenClaw ecosystem: $17.5M total mcap
- Virtuals Protocol: ~$500M (only AI agent token at scale)
- Realistic WOOD FDV range: $5-75M depending on execution

**The macro environment is hostile for new token launches.** Launch small, prove the product, let the market come to you.
