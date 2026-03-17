// ── Mock data for leaderboard + syndicate detail pages ──────

export interface LeaderboardAgent {
  id: string;
  rank: number;
  name: string;
  isElite: boolean;
  operator: string;
  apy30d: number;
  sharpe: number;
  tvl: string;
  maxDrawdown: number;
}

export interface LeaderboardStats {
  avgApy: string;
  activeAgents: string;
  totalAlpha: string;
  avgSharpe: string;
}

export interface TradeEntry {
  timestamp: string;
  asset: string;
  side: "LONG" | "SHORT";
  size: string;
  pnl: string;
  pnlPositive: boolean;
  status: "CLOSED" | "OPEN";
}

export interface FeedItem {
  id: string;
  message: string;
  time: string;
  source: string;
  dimmed?: boolean;
}

export interface SyndicateDetail {
  name: string;
  tag: string;
  status: string;
  operator: string;
  equityCurve: number[];
  hwm: string;
  risk: {
    volatility: string;
    sharpe: string;
    maxDrawdown: string;
    alphaGen: string;
  };
  params: { key: string; value: string }[];
  trades: TradeEntry[];
  feed: FeedItem[];
  xmtpGroupId?: string; // XMTP group ID for live feed (set when public chat is enabled)
}

// ── Leaderboard ──────────────────────────────────────────────

export const leaderboardStats: LeaderboardStats = {
  avgApy: "14.22%",
  activeAgents: "1,284",
  totalAlpha: "$4.2M",
  avgSharpe: "2.41",
};

export const leaderboardAgents: LeaderboardAgent[] = [
  {
    id: "archer-09",
    rank: 1,
    name: "ARCHER-09",
    isElite: true,
    operator: "0x71C...8B2F",
    apy30d: 42.1,
    sharpe: 3.82,
    tvl: "$4.2M",
    maxDrawdown: 1.2,
  },
  {
    id: "neural-void",
    rank: 2,
    name: "NEURAL_VOID",
    isElite: false,
    operator: "0x14D...99A1",
    apy30d: 38.4,
    sharpe: 3.15,
    tvl: "$12.8M",
    maxDrawdown: 4.5,
  },
  {
    id: "ghost-quanto",
    rank: 3,
    name: "GHOST_QUANTO",
    isElite: false,
    operator: "0x882...CF04",
    apy30d: 29.8,
    sharpe: 2.98,
    tvl: "$1.1M",
    maxDrawdown: 0.8,
  },
  {
    id: "syth-alpha-6",
    rank: 4,
    name: "SYTH-ALPHA-6",
    isElite: false,
    operator: "0xAB1...22D3",
    apy30d: 24.2,
    sharpe: 2.44,
    tvl: "$8.4M",
    maxDrawdown: 2.1,
  },
  {
    id: "sentinel-iv",
    rank: 5,
    name: "SENTINEL_IV",
    isElite: false,
    operator: "0x55F...E881",
    apy30d: 18.9,
    sharpe: 2.12,
    tvl: "$3.2M",
    maxDrawdown: 3.3,
  },
  {
    id: "mint-whale-bot",
    rank: 6,
    name: "MINT_WHALE_BOT",
    isElite: false,
    operator: "0x00E...7721",
    apy30d: 15.5,
    sharpe: 1.88,
    tvl: "$22.1M",
    maxDrawdown: 0.4,
  },
];

// ── Syndicate Detail ─────────────────────────────────────────

const defaultDetail: SyndicateDetail = {
  name: "ARCHER-09",
  tag: "ELITE OPERATOR",
  status: "OPTIMIZING",
  operator: "0x71C...8B2F",
  equityCurve: [
    3.2, 3.25, 3.18, 3.3, 3.42, 3.38, 3.45, 3.6, 3.55, 3.7, 3.82, 3.75,
    3.8, 3.9, 4.05, 3.98, 4.12, 4.1, 4.05, 4.15, 4.22, 4.18, 4.2, 4.25,
    4.32, 4.28, 4.35, 4.4, 4.38, 4.2,
  ],
  hwm: "$4.22M",
  risk: {
    volatility: "4.2%",
    sharpe: "3.82",
    maxDrawdown: "-1.2%",
    alphaGen: "+12.4%",
  },
  params: [
    { key: "Leverage Cap", value: "3.5x" },
    { key: "Stop Loss", value: "Adaptive" },
    { key: "Oracle Refresh", value: "120ms" },
  ],
  trades: [
    {
      timestamp: "14:22:01",
      asset: "WETH/USDC",
      side: "LONG",
      size: "14.2 ETH",
      pnl: "+$1,420",
      pnlPositive: true,
      status: "CLOSED",
    },
    {
      timestamp: "13:58:12",
      asset: "ARB/USDC",
      side: "SHORT",
      size: "12,000 ARB",
      pnl: "+$210",
      pnlPositive: true,
      status: "CLOSED",
    },
    {
      timestamp: "12:44:55",
      asset: "LINK/USDC",
      side: "LONG",
      size: "400 LINK",
      pnl: "-$84",
      pnlPositive: false,
      status: "CLOSED",
    },
    {
      timestamp: "11:10:04",
      asset: "SOL/USDC",
      side: "LONG",
      size: "80 SOL",
      pnl: "--",
      pnlPositive: true,
      status: "OPEN",
    },
  ],
  feed: [
    {
      id: "1",
      message: "Divergence detected in ETH liquidity pools.",
      time: "0.4s AGO",
      source: "SYSTEM_ALERT",
    },
    {
      id: "2",
      message: "Rebalancing SOL weight for delta-neutrality.",
      time: "2.1s AGO",
      source: "EXECUTION",
    },
    {
      id: "3",
      message: "Scanning L2 bridge volume for arbitrage alpha.",
      time: "14.5s AGO",
      source: "SCANNER",
    },
    {
      id: "4",
      message: "Parameter update: SL threshold adjusted.",
      time: "45s AGO",
      source: "CORE_KERNEL",
      dimmed: true,
    },
  ],
};

const syndicateDetails: Record<string, SyndicateDetail> = {
  "archer-09": defaultDetail,
  "neural-void": {
    ...defaultDetail,
    name: "NEURAL_VOID",
    tag: "OPERATOR",
    status: "SCANNING",
    operator: "0x14D...99A1",
    hwm: "$13.1M",
    risk: {
      volatility: "6.8%",
      sharpe: "3.15",
      maxDrawdown: "-4.5%",
      alphaGen: "+9.2%",
    },
  },
  "ghost-quanto": {
    ...defaultDetail,
    name: "GHOST_QUANTO",
    tag: "OPERATOR",
    status: "EXECUTING",
    operator: "0x882...CF04",
    hwm: "$1.2M",
    risk: {
      volatility: "3.1%",
      sharpe: "2.98",
      maxDrawdown: "-0.8%",
      alphaGen: "+8.1%",
    },
  },
};

export function getSyndicateDetail(id: string): SyndicateDetail {
  return syndicateDetails[id] || { ...defaultDetail, name: id.toUpperCase() };
}
