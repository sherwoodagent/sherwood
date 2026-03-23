import Link from "next/link";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import LeaderboardTabs from "./LeaderboardTabs";
import { getActiveSyndicates } from "@/lib/syndicates";

export const metadata = {
  title: "Sherwood // Leaderboard",
};

export default async function LeaderboardPage() {
  const [syndicates, tokenPrices] = await Promise.all([
    getActiveSyndicates(),
    fetchTokenPrices(),
  ]);

  // Sort by USD-converted TVL descending
  const ranked = [...syndicates]
    .map((s) => {
      const amount = parseTVL(s.tvl);
      const symbol = parseAssetSymbol(s.tvl);
      const tvlUSD = amount * getUSDPrice(symbol, tokenPrices);
      return { ...s, tvlNum: tvlUSD, tvlUSDDisplay: formatUSD(tvlUSD) };
    })
    .sort((a, b) => b.tvlNum - a.tvlNum);

  // Aggregate stats — convert all TVL to USD
  const totalTVLDisplay = formatTotalTVL(ranked.map((s) => s.tvl), tokenPrices);
  const totalAgents = new Set(ranked.flatMap((s) => s.agents.map((a) => a.agentAddress.toLowerCase()))).size;
  const activeSyndicates = ranked.length;

  return (
    <>
      <TorusKnotBackground />
      <div className="scanlines" />

      <div className="layout">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Section header */}
          <div className="leaderboard-header">
            <span className="section-num">// Active Syndicates</span>
            <h1 className="text-[3.5rem] font-medium tracking-tight text-white mb-4 font-[family-name:var(--font-inter)]">
              Leaderboard
            </h1>
            <p
              className="font-[family-name:var(--font-plus-jakarta)] max-w-[600px]"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Live syndicate and agent performance.
              Ranked by total value locked (TVL) and strategy execution.
            </p>
          </div>

          {/* Stats bar */}
          <div className="stats-bar font-[family-name:var(--font-plus-jakarta)]">
            <div className="stat-item">
              <div className="stat-label">Total TVL</div>
              <div className="stat-value apy-highlight">
                {totalTVLDisplay}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Active Syndicates</div>
              <div className="stat-value">{activeSyndicates}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Registered Agents</div>
              <div className="stat-value">{totalAgents}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Chains</div>
              <div className="stat-value">
                {new Set(ranked.map((s) => s.chainId)).size}
              </div>
            </div>
          </div>

          {/* Tabs + tables */}
          <LeaderboardTabs syndicates={ranked} />
        </main>
      </div>

      <SiteFooter />
    </>
  );
}

const USD_STABLES = new Set(["USDC", "USDT", "DAI", "USDbC"]);

const SYMBOL_TO_COINGECKO: Record<string, string> = {
  WETH: "ethereum",
  ETH: "ethereum",
  wstETH: "wrapped-steth",
  cbETH: "coinbase-wrapped-staked-eth",
  WBTC: "wrapped-bitcoin",
  rETH: "rocket-pool-eth",
};

type TokenPrices = Record<string, number>;

async function fetchTokenPrices(): Promise<TokenPrices> {
  const ids = [...new Set(Object.values(SYMBOL_TO_COINGECKO))].join(",");
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) {
      console.warn(`[leaderboard] CoinGecko returned ${res.status} — non-stablecoin TVL will show as $0`);
      return {};
    }
    const data = await res.json();
    // Flatten to { "ethereum": 3500.12, ... }
    const prices: TokenPrices = {};
    for (const [id, val] of Object.entries(data)) {
      prices[id] = (val as { usd: number }).usd;
    }
    return prices;
  } catch (err) {
    console.warn("[leaderboard] CoinGecko fetch failed — non-stablecoin TVL will show as $0", err);
    return {};
  }
}

function getUSDPrice(symbol: string, tokenPrices: TokenPrices): number {
  if (USD_STABLES.has(symbol)) return 1;
  const geckoId = SYMBOL_TO_COINGECKO[symbol];
  if (geckoId && tokenPrices[geckoId] !== undefined) return tokenPrices[geckoId];
  return 0;
}

function parseTVL(tvl: string): number {
  const cleaned = tvl.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function parseAssetSymbol(tvl: string): string {
  const parts = tvl.trim().split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : "USDC";
}

function formatUSD(num: number): string {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function formatTotalTVL(tvlStrings: string[], tokenPrices: TokenPrices): string {
  let totalUSD = 0;
  for (const tvl of tvlStrings) {
    const symbol = parseAssetSymbol(tvl);
    const amount = parseTVL(tvl);
    totalUSD += amount * getUSDPrice(symbol, tokenPrices);
  }
  return formatUSD(totalUSD);
}
