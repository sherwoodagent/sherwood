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
 * Get all creator personas (sorted by index).
 */
export function getCreators(): Persona[] {
  return PERSONAS.filter((p) => p.role === "creator").sort((a, b) => a.index - b.index);
}

/**
 * Get all joiner personas (sorted by index).
 */
export function getJoiners(): Persona[] {
  return PERSONAS.filter((p) => p.role === "joiner").sort((a, b) => a.index - b.index);
}

/**
 * Get a persona by agent index.
 */
export function getPersona(index: number): Persona | undefined {
  return PERSONAS.find((p) => p.index === index);
}
