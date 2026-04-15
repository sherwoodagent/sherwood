/**
 * Agent persona definitions.
 *
 * Agents 1-5 (indices) are creators, 6-12 are joiners.
 * Index 0 is the master/funding wallet — no persona needed.
 */

export interface Persona {
  index: number; // wallet derivation index (1-12)
  name: string; // display name for the agent
  description: string; // agent description for ERC-8004 identity
  role: "creator" | "joiner";
  syndicateName?: string; // only for creators
  syndicateSubdomain?: string; // only for creators (must be lowercase, 3+ chars, hyphens OK)
  syndicateDescription?: string; // only for creators
  vaultAsset?: "USDC" | "WETH"; // only for creators — vault denomination
  strategyTemplate?: string; // only for creators — moonwell-supply, venice-inference, wsteth-moonwell
  chatLines: string[]; // XMTP message lines themed to persona
  depositAmount: string; // amount to deposit (USDC for USDC vaults, max $10)
}

export const PERSONAS: Persona[] = [
  // ── Creators (indices 1-5) ──
  {
    index: 1,
    name: "Yield Maximizer",
    description:
      "Conservative USDC yield specialist. Focuses on Moonwell lending markets with capital preservation as the primary objective.",
    role: "creator",
    syndicateName: "Steady Yield Fund",
    syndicateSubdomain: "steady-yield",
    syndicateDescription: "Conservative USDC yield via Moonwell lending — capital preservation first.",
    vaultAsset: "USDC",
    strategyTemplate: "moonwell-supply",
    chatLines: [
      "Moonwell USDC supply APY is looking strong this week. Deploying 80% of vault capital.",
      "Risk check complete — no liquidation risk at current rates. Proceeding with supply strategy.",
      "Settlement complete. Returned principal + interest to vault. All good.",
    ],
    depositAmount: "10",
  },
  {
    index: 2,
    name: "LP Hunter",
    description:
      "Aerodrome liquidity pool specialist. Optimizes fee income by targeting high-volume stable and volatile pools.",
    role: "creator",
    syndicateName: "Aerodrome Alpha Fund",
    syndicateSubdomain: "aero-alpha",
    syndicateDescription: "Aerodrome LP strategies targeting high-fee pools with gauge incentives.",
    vaultAsset: "USDC",
    strategyTemplate: "moonwell-supply",
    chatLines: [
      "USDC/WETH pool volume up 40% this week. LP fees look attractive. Preparing position.",
      "Gauge rewards are live on this pool. Staking LP tokens for extra AERO yield.",
      "Impermanent loss within acceptable range. Fees more than compensate. Holding position.",
    ],
    depositAmount: "10",
  },
  {
    index: 3,
    name: "Venice Oracle",
    description:
      "AI inference fund powered by Venice. Stakes VVV for private compute access and earns yield from AI inference credits.",
    role: "creator",
    syndicateName: "Venice Inference Fund",
    syndicateSubdomain: "venice-oracle",
    syndicateDescription: "Private AI inference yield via Venice VVV staking + sVVV rewards.",
    vaultAsset: "USDC",
    strategyTemplate: "venice-inference",
    chatLines: [
      "VVV staking APY currently at 8.2%. Initiating position via Aerodrome swap.",
      "sVVV accumulated. Venice compute credits active. Ready to settle when duration elapses.",
      "Research query complete. Attestation published on-chain. Profit returned to vault.",
    ],
    depositAmount: "10",
  },
  {
    index: 4,
    name: "Basis Trader",
    description:
      "Ethereum liquid staking yield strategist. Stacks Lido + Moonwell yields via wstETH supply positions.",
    role: "creator",
    syndicateName: "ETH Staking Fund",
    syndicateSubdomain: "eth-staking",
    syndicateDescription: "Stack Lido + Moonwell yields — WETH to wstETH to mWstETH.",
    vaultAsset: "WETH",
    strategyTemplate: "wsteth-moonwell",
    chatLines: [
      "wstETH Moonwell supply rate + Lido base APY = 6.8% combined. Initiating.",
      "Position live. Monitoring wstETH/WETH exchange rate for settlement optimization.",
      "Strategy duration elapsed. Unwinding position and returning WETH to vault.",
    ],
    depositAmount: "10",
  },
  {
    index: 5,
    name: "Multi-Strategy",
    description:
      "Diversified allocation across multiple DeFi primitives. Balances yield, risk, and liquidity across Moonwell, Aerodrome, and Venice.",
    role: "creator",
    syndicateName: "Diversified DeFi Fund",
    syndicateSubdomain: "diversified-defi",
    syndicateDescription: "Diversified DeFi allocation: Moonwell + Aerodrome + Venice in rotation.",
    vaultAsset: "WETH",
    strategyTemplate: "moonwell-supply",
    chatLines: [
      "Portfolio allocation: 50% Moonwell supply, 30% Aerodrome LP, 20% Venice VVV. Balanced approach.",
      "Rebalancing trigger hit — Moonwell rates compressed. Rotating to Aerodrome.",
      "All positions settled. Composite return: +4.2% over 7 days. Ready for next cycle.",
    ],
    depositAmount: "10",
  },

  // ── Joiners (indices 6-12) ──
  {
    index: 6,
    name: "DeFi Scout",
    description:
      "Protocol researcher and DeFi opportunity evaluator. Identifies high-yield positions and risk factors before capital deployment.",
    role: "joiner",
    chatLines: [
      "Scanning Moonwell rates across markets. USDC supply at 4.1% APY — competitive.",
      "Risk assessment complete: protocol TVL stable, no liquidation events in 30 days.",
      "New Aerodrome incentive campaign detected. Might be worth rotating some capital.",
    ],
    depositAmount: "10",
  },
  {
    index: 7,
    name: "Risk Sentinel",
    description:
      "Risk management specialist. Monitors protocol health, collateral ratios, and market conditions to protect vault capital.",
    role: "joiner",
    chatLines: [
      "Market volatility elevated. Recommending conservative positioning for next strategy.",
      "Collateral ratios healthy across Moonwell markets. No immediate concern.",
      "AGAINST this proposal — duration too long given current macro uncertainty.",
    ],
    depositAmount: "8",
  },
  {
    index: 8,
    name: "Alpha Seeker",
    description:
      "High-yield opportunity hunter. Targets emerging pools and new protocol incentives for outsized returns.",
    role: "joiner",
    chatLines: [
      "New gauge live on Aerodrome WETH/USDC. AERO rewards look juicy. Vote FOR.",
      "Spotted a temporary rate spike on Moonwell. Window is narrow — act fast.",
      "This strategy is solid. FOR. Expected return beats risk-free by 200bps.",
    ],
    depositAmount: "10",
  },
  {
    index: 9,
    name: "Stable Hand",
    description:
      "Conservative capital preservationist. Focuses on stablecoin yield with strict drawdown limits.",
    role: "joiner",
    chatLines: [
      "USDC-only strategy preferred. Sticking to Moonwell supply for this cycle.",
      "Voting FOR the supply proposal. Low risk, predictable return.",
      "Performance looks good. Glad we stayed conservative this round.",
    ],
    depositAmount: "10",
  },
  {
    index: 10,
    name: "Whale Watcher",
    description:
      "On-chain analytics specialist. Tracks large capital flows and protocol TVL changes to anticipate rate movements.",
    role: "joiner",
    chatLines: [
      "Large deposit detected on Moonwell mUSDC. Rates will compress soon — deploy now.",
      "Whale exit from Aerodrome pool. LP ratio shifted — reassess position.",
      "TVL trending up across Base DeFi. Bullish signal for yield strategies.",
    ],
    depositAmount: "10",
  },
  {
    index: 11,
    name: "Gas Optimizer",
    description:
      "Transaction efficiency expert. Minimizes gas costs and optimizes batch call sequencing.",
    role: "joiner",
    chatLines: [
      "Base gas is low right now — good time to submit proposal.",
      "Batching the approve + deposit in one tx saves ~20k gas. Smart.",
      "Settlement timing looks optimal from a gas perspective. Go for it.",
    ],
    depositAmount: "8",
  },
  {
    index: 12,
    name: "Governance Hawk",
    description:
      "Active governance participant. Votes on every proposal and monitors parameter changes across syndicates.",
    role: "joiner",
    chatLines: [
      "Reviewing proposal parameters. Performance fee at 10% is fair for this strategy.",
      "Voted FOR. Strategy aligns with fund mandate and risk parameters.",
      "Reminder: voting period closes in 2 hours. Get your votes in.",
    ],
    depositAmount: "10",
  },
];

/**
 * Robinhood L2 Testnet personas — PortfolioStrategy with stock token combinations.
 * All vaults are WETH-denominated (no USDC on Robinhood testnet).
 * Token symbols map to addresses via CHAIN_REGISTRY at propose time.
 */
export const ROBINHOOD_PERSONAS: Persona[] = [
  // ── Creators (indices 1-5) — each uses a different stock combo ──
  {
    index: 1,
    name: "Tech Momentum Fund",
    description: "Momentum-driven portfolio targeting high-growth tech equities. TSLA and AMZN weighted by market cap velocity.",
    role: "creator",
    syndicateName: "Tech Momentum Fund",
    syndicateSubdomain: "tech-momentum",
    syndicateDescription: "TSLA + AMZN portfolio weighted by momentum signals on Robinhood L2.",
    vaultAsset: "WETH",
    strategyTemplate: "portfolio",
    chatLines: [
      "TSLA up 12% week-over-week. Momentum signals strong — overweighting to 60%.",
      "AMZN earnings beat. AWS revenue accelerating. Holding 40% allocation.",
      "Portfolio rebalanced. Composite return ahead of benchmark. Staying the course.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 2,
    name: "Streaming Giants Fund",
    description: "Concentrated bet on digital streaming and e-commerce dominance. AMZN and NFLX equal-weighted.",
    role: "creator",
    syndicateName: "Streaming Giants Fund",
    syndicateSubdomain: "streaming-giants",
    syndicateDescription: "AMZN + NFLX 50/50 — streaming and e-commerce at scale.",
    vaultAsset: "WETH",
    strategyTemplate: "portfolio",
    chatLines: [
      "NFLX subscriber growth beat estimates. Ad-tier revenue ramping fast.",
      "AMZN Prime is a moat. Logistics + AWS + advertising all firing.",
      "Equal-weight rebalance triggered. Both positions back to 50%. Clean.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 3,
    name: "Disruptors Alpha Fund",
    description: "Diversified tech disruption exposure across EVs, data analytics, and advanced computing.",
    role: "creator",
    syndicateName: "Disruptors Alpha Fund",
    syndicateSubdomain: "disruptors-alpha",
    syndicateDescription: "TSLA + PLTR + AMD — EV, data, and silicon disruption basket.",
    vaultAsset: "WETH",
    strategyTemplate: "portfolio",
    chatLines: [
      "PLTR government contract pipeline expanding. TSLA FSD rollout accelerating. Both bullish.",
      "AMD gaining server market share vs Intel. AI chip demand structural.",
      "Three-way portfolio holding up. TSLA leading, AMD steady, PLTR catching bids.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 4,
    name: "Entertainment Tech Fund",
    description: "Media and semiconductor exposure. NFLX content moat paired with AMD silicon leadership.",
    role: "creator",
    syndicateName: "Entertainment Tech Fund",
    syndicateSubdomain: "entertainment-tech",
    syndicateDescription: "NFLX + AMD — content platform + AI silicon, 60/40 allocation.",
    vaultAsset: "WETH",
    strategyTemplate: "portfolio",
    chatLines: [
      "NFLX password sharing crackdown driving subscriber additions. Revenue up.",
      "AMD MI300X shipments ahead of schedule. Data center AI demand strong.",
      "60/40 split holding well. NFLX providing stability, AMD adding alpha.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 5,
    name: "Mega Cap Diversified Fund",
    description: "Broad exposure across the largest tech equities. Equal-weighted across TSLA, AMZN, NFLX, and PLTR.",
    role: "creator",
    syndicateName: "Mega Cap Diversified Fund",
    syndicateSubdomain: "mega-cap-div",
    syndicateDescription: "TSLA + AMZN + NFLX + PLTR equal-weight diversified tech basket.",
    vaultAsset: "WETH",
    strategyTemplate: "portfolio",
    chatLines: [
      "Four-asset basket provides sector diversification. No single name dominates.",
      "Correlation between holdings is low right now — diversification benefit is real.",
      "Quarterly rebalance complete. All positions within 2% of target weights.",
    ],
    depositAmount: "0.0005",
  },

  // ── Joiners (indices 6-12) — stock-market-themed ──
  {
    index: 6,
    name: "Momentum Tracker",
    description: "Quantitative momentum trader. Identifies trend continuation signals across tech equities.",
    role: "joiner",
    chatLines: [
      "12-month momentum on TSLA still positive. Trend intact.",
      "AMZN broke above resistance. Volume confirming the move.",
      "Momentum signals mixed on PLTR. Watch for confirmation before adding.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 7,
    name: "Fundamental Analyst",
    description: "Bottom-up equity researcher. Focuses on earnings quality and revenue durability.",
    role: "joiner",
    chatLines: [
      "NFLX free cash flow conversion improving. FCF yield attractive at current price.",
      "AMD gross margins expanding as mix shifts to data center. Quality improving.",
      "AGAINST — TSLA multiple too rich relative to auto peers. Prefer PLTR here.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 8,
    name: "Volatility Arb",
    description: "Options-informed investor. Reads implied volatility skew to gauge positioning and risk.",
    role: "joiner",
    chatLines: [
      "TSLA IV crush post-earnings. Good entry window now.",
      "AMZN skew flat — market not pricing downside. FOR.",
      "AMD vol elevated before earnings. Size accordingly.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 9,
    name: "Index Arb Bot",
    description: "Index rebalancing specialist. Tracks index inclusion events and forced buy flows.",
    role: "joiner",
    chatLines: [
      "PLTR S&P 500 inclusion flow largely absorbed. Float-adjusted weights stable.",
      "AMD index weight increasing as market cap grows. Passive bid ongoing.",
      "TSLA weighting at top of index. Rebalance flows neutral this quarter.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 10,
    name: "Macro Overlay",
    description: "Top-down macro strategist. Adjusts tech exposure based on rates, dollar, and growth expectations.",
    role: "joiner",
    chatLines: [
      "Fed pause bullish for growth multiples. Overweight tech makes sense here.",
      "Dollar softening — international revenues will get a boost for AMZN, NFLX.",
      "Risk-off tone developing. Trimming high-beta TSLA exposure temporarily.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 11,
    name: "Sector Rotator",
    description: "Relative value trader. Rotates between tech sub-sectors based on earnings cycle positioning.",
    role: "joiner",
    chatLines: [
      "Semi cycle inflecting up. AMD is the cleanest play — rotating in.",
      "Cloud spending reaccelerating. AMZN AWS margin expansion story intact.",
      "EV demand softening near-term. Neutral TSLA until next catalyst.",
    ],
    depositAmount: "0.0005",
  },
  {
    index: 12,
    name: "Risk Manager",
    description: "Portfolio risk oversight. Monitors concentration, drawdown limits, and correlation across positions.",
    role: "joiner",
    chatLines: [
      "Portfolio concentration within limits. Max single-name at 60% for momentum fund.",
      "Correlation between TSLA and AMD rising — diversification benefit compressing.",
      "Drawdown threshold not breached. All positions within acceptable bands.",
    ],
    depositAmount: "0.0005",
  },
];

/**
 * Portfolio strategy specs per creator on Robinhood — stock token combos.
 * Tokens are symbols (resolved to addresses by the CLI via TOKENS() on the active chain).
 */
export const ROBINHOOD_PORTFOLIO_SPECS: Record<number, { tokens: string; weights: string }> = {
  1: { tokens: "TSLA,AMZN", weights: "6000,4000" },
  2: { tokens: "AMZN,NFLX", weights: "5000,5000" },
  3: { tokens: "TSLA,PLTR,AMD", weights: "4000,3000,3000" },
  4: { tokens: "NFLX,AMD", weights: "6000,4000" },
  5: { tokens: "TSLA,AMZN,NFLX,PLTR", weights: "3000,3000,2000,2000" },
};

/**
 * Get all creator personas (sorted by index).
 */
export function getCreators(chain?: string): Persona[] {
  const list = chain === "robinhood-testnet" ? ROBINHOOD_PERSONAS : PERSONAS;
  return list.filter((p) => p.role === "creator").sort((a, b) => a.index - b.index);
}

/**
 * Get all joiner personas (sorted by index).
 */
export function getJoiners(chain?: string): Persona[] {
  const list = chain === "robinhood-testnet" ? ROBINHOOD_PERSONAS : PERSONAS;
  return list.filter((p) => p.role === "joiner").sort((a, b) => a.index - b.index);
}

/**
 * Get a persona by agent index.
 */
export function getPersona(index: number, chain?: string): Persona | undefined {
  const list = chain === "robinhood-testnet" ? ROBINHOOD_PERSONAS : PERSONAS;
  return list.find((p) => p.index === index);
}
