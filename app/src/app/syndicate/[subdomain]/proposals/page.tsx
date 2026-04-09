import { notFound } from "next/navigation";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import ActiveProposal from "@/components/proposals/ActiveProposal";
import ProposalCard from "@/components/proposals/ProposalCard";
import ProposalHistory from "@/components/proposals/ProposalHistory";
import AgentStats from "@/components/proposals/AgentStats";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import {
  fetchGovernorData,
  ProposalState,
  type ProposalData,
  type GovernorData,
} from "@/lib/governor-data";
import { formatBps } from "@/lib/contracts";
import { formatDuration } from "@/lib/governor-data";
import { fetchPortfolioData } from "@/lib/portfolio-data";
import type { Address } from "viem";

// ── Mock badge ──────────────────────────────────────────────────────────────

function MockBadge() {
  return (
    <div
      style={{
        position: "absolute",
        top: "0.75rem",
        right: "0.75rem",
        zIndex: 1,
        color: "rgba(255,255,255,0.2)",
        fontSize: "9px",
        fontFamily: "var(--font-plus-jakarta), sans-serif",
      }}
    >
      MOCK DATA
    </div>
  );
}

// ── Mock data (shown when governor is not yet deployed) ─────────────────────

const DAY = 86400n;

function buildMockData(vault: Address): GovernorData {
  const NOW = BigInt(Math.floor(Date.now() / 1000));
  const mockProposals: ProposalData[] = [
    // ── Active (Executed) ──────────────────────────────────────────────────
    {
      id: 5n,
      proposer: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address,
      vault,
      metadataURI: "ipfs://mock",
      performanceFeeBps: 1500n,
      strategyDuration: 7n * DAY,
      votesFor: 124_000_000_000n,   // 124,000 shares
      votesAgainst: 18_000_000_000n, // 18,000 shares
      snapshotTimestamp: NOW - 4n * DAY,
      voteEnd: NOW - 3n * DAY,
      executeBy: NOW - 2n * DAY,
      executedAt: NOW - 3n * DAY,
      state: ProposalState.Executed,
      computedState: ProposalState.Executed,
      capitalSnapshot: 50_000_000_000n, // 50,000 USDC
      deployedCapital: 50_000_000_000n,
      metadata: {
        title: "Moonwell WETH Supply + USDC Borrow",
        description:
          "Supply 22 WETH as collateral on Moonwell (Base), borrow 50k USDC at ~4.2% APY, deploy into Uniswap V3 WETH/USDC concentrated LP at 0.05% tier. Expected net yield: 11–14% APY. Health factor maintained above 2.1.",
      },
    },

    // ── Pending (voting active) ────────────────────────────────────────────
    {
      id: 6n,
      proposer: "0x81aF49a68bb2197992897016F9932dc1e4a99901" as Address,
      vault,
      metadataURI: "ipfs://mock2",
      performanceFeeBps: 1000n,
      strategyDuration: 14n * DAY,
      votesFor: 87_000_000_000n,
      votesAgainst: 31_000_000_000n,
      snapshotTimestamp: NOW - DAY,
      voteEnd: NOW + 2n * DAY,
      executeBy: NOW + 4n * DAY,
      executedAt: 0n,
      state: ProposalState.Pending,
      computedState: ProposalState.Pending,
      capitalSnapshot: 0n,
      deployedCapital: 0n,
      metadata: {
        title: "Aerodrome USDC/cbBTC LP Strategy",
        description:
          "Deploy 30k USDC into Aerodrome Finance USDC/cbBTC stable pool. Compound farming rewards weekly. Target APY: 18–22%. Duration: 14 days.",
      },
    },
    {
      id: 7n,
      proposer: "0xc2b856ba96De21a4EB84B8D21FD749aC5AeF314" as Address,
      vault,
      metadataURI: "ipfs://mock3",
      performanceFeeBps: 2000n,
      strategyDuration: 3n * DAY,
      votesFor: 12_000_000_000n,
      votesAgainst: 0n,
      snapshotTimestamp: NOW - 6n * 3600n,
      voteEnd: NOW + 5n * DAY,
      executeBy: NOW + 7n * DAY,
      executedAt: 0n,
      state: ProposalState.Pending,
      computedState: ProposalState.Pending,
      capitalSnapshot: 0n,
      deployedCapital: 0n,
      metadata: {
        title: "Short-term AAVE USDC Lending",
        description:
          "Supply 12k USDC to AAVE v3 on Base. Pure lending yield, no leverage. Conservative play for the cooldown window. Target: 6–8% APY.",
      },
    },

    // ── History ────────────────────────────────────────────────────────────
    {
      id: 4n,
      proposer: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address,
      vault,
      metadataURI: "",
      performanceFeeBps: 1500n,
      strategyDuration: 7n * DAY,
      votesFor: 98_000_000_000n,
      votesAgainst: 14_000_000_000n,
      snapshotTimestamp: NOW - 18n * DAY,
      voteEnd: NOW - 17n * DAY,
      executeBy: NOW - 16n * DAY,
      executedAt: NOW - 16n * DAY,
      state: ProposalState.Settled,
      computedState: ProposalState.Settled,
      capitalSnapshot: 40_000_000_000n,
      deployedCapital: 40_000_000_000n,
      pnl: 3_200_000_000n, // +$3,200 profit
      metadata: {
        title: "Uniswap V3 ETH/USDC LP",
        description: "",
      },
    },
    {
      id: 3n,
      proposer: "0x81aF49a68bb2197992897016F9932dc1e4a99901" as Address,
      vault,
      metadataURI: "",
      performanceFeeBps: 1000n,
      strategyDuration: 5n * DAY,
      votesFor: 44_000_000_000n,
      votesAgainst: 71_000_000_000n,
      snapshotTimestamp: NOW - 30n * DAY,
      voteEnd: NOW - 29n * DAY,
      executeBy: NOW - 28n * DAY,
      executedAt: 0n,
      state: ProposalState.Rejected,
      computedState: ProposalState.Rejected,
      capitalSnapshot: 0n,
      deployedCapital: 0n,
      metadata: {
        title: "High-leverage WBTC Short via GMX",
        description: "",
      },
    },
    {
      id: 2n,
      proposer: "0xc2b856ba96De21a4EB84B8D21FD749aC5AeF314" as Address,
      vault,
      metadataURI: "",
      performanceFeeBps: 2000n,
      strategyDuration: 10n * DAY,
      votesFor: 105_000_000_000n,
      votesAgainst: 22_000_000_000n,
      snapshotTimestamp: NOW - 45n * DAY,
      voteEnd: NOW - 44n * DAY,
      executeBy: NOW - 43n * DAY,
      executedAt: NOW - 43n * DAY,
      state: ProposalState.Settled,
      computedState: ProposalState.Settled,
      capitalSnapshot: 25_000_000_000n,
      deployedCapital: 25_000_000_000n,
      pnl: -1_800_000_000n, // -$1,800 loss
      metadata: {
        title: "Morpho USDC Vault Deposit",
        description: "",
      },
    },
    {
      id: 1n,
      proposer: "0x81aF49a68bb2197992897016F9932dc1e4a99901" as Address,
      vault,
      metadataURI: "",
      performanceFeeBps: 1500n,
      strategyDuration: 7n * DAY,
      votesFor: 62_000_000_000n,
      votesAgainst: 8_000_000_000n,
      snapshotTimestamp: NOW - 70n * DAY,
      voteEnd: NOW - 69n * DAY,
      executeBy: NOW - 68n * DAY,
      executedAt: NOW - 68n * DAY,
      state: ProposalState.Settled,
      computedState: ProposalState.Settled,
      capitalSnapshot: 20_000_000_000n,
      deployedCapital: 20_000_000_000n,
      pnl: 1_400_000_000n, // +$1,400 profit
      metadata: {
        title: "Moonwell USDC Supply",
        description: "",
      },
    },
  ];

  return {
    governorAddress: "0x0000000000000000000000000000000000000000" as Address,
    proposals: mockProposals,
    activeProposalId: 5n,
    cooldownEnd: 0n,
    params: {
      votingPeriod: 3n * DAY,
      executionWindow: DAY,
      vetoThresholdBps: 2000n,  // 20%
      maxPerformanceFeeBps: 3000n, // 30%
      cooldownPeriod: DAY,
      collaborationWindow: 48n * 3600n,
      maxCoProposers: 5n,
      minStrategyDuration: DAY,
      maxStrategyDuration: 90n * DAY,
    },
  };
}

// ── Page ────────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const name = data?.metadata?.name || subdomain;
  return { title: `Sherwood // ${name} — Proposals` };
}

export default async function ProposalsPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);

  if (!data) {
    notFound();
  }

  const name =
    data.metadata?.name || `Syndicate #${data.syndicateId.toString()}`;

  // Build address → display name map from agent identities
  const addressNames: Record<string, string> = {};
  for (const agent of data.agents) {
    const displayName = agent.identity?.name || `Agent #${agent.agentId.toString()}`;
    addressNames[agent.agentAddress.toLowerCase()] = displayName;
  }
  const creatorKey = data.creator.toLowerCase();

  const liveGovernor = await fetchGovernorData(data.vault);
  const isMock = !liveGovernor;
  const governor = liveGovernor ?? buildMockData(data.vault);

  // Enrich proposals with P&L from activity feed
  if (liveGovernor && data.activity.length > 0) {
    for (const proposal of governor.proposals) {
      const settled = data.activity.find(
        (a) => a.type === "settled" && a.proposalId === proposal.id,
      );
      if (settled && settled.pnl !== undefined) {
        proposal.pnl = settled.pnl;
      }
    }
  }

  const activeProposal =
    governor.proposals.find(
      (p) => p.computedState === ProposalState.Executed,
    ) ?? null;

  // Fetch portfolio strategy data if active proposal exists
  let portfolioAllocations: {
    allocations: { symbol: string; weightPct: number }[];
    totalAmount: string;
    assetSymbol: string;
  } | null = null;

  let enrichedPortfolio: {
    allocations: {
      token: Address;
      symbol: string;
      decimals: number;
      weightPct: number;
      tokenAmount: string;
      investedAmount: string;
      feeTier: number;
      logo: string | null;
      marketCap: number | null;
    }[];
    totalAmount: string;
    assetSymbol: string;
    assetAddress: Address;
    assetDecimals: number;
    chainId: number;
  } | null = null;

  if (activeProposal && liveGovernor) {
    const portfolioData = await fetchPortfolioData(
      liveGovernor.governorAddress,
      activeProposal.id,
      data.chainId,
      data.assetDecimals,
      data.assetSymbol,
    );
    if (portfolioData) {
      portfolioAllocations = {
        allocations: portfolioData.allocations.map((a) => ({
          symbol: a.symbol,
          weightPct: a.targetWeightBps / 100,
        })),
        totalAmount: portfolioData.totalAmount,
        assetSymbol: portfolioData.assetSymbol,
      };

      // Build enriched data for PortfolioDashboard
      enrichedPortfolio = {
        allocations: portfolioData.allocations.map((a) => ({
          token: a.token,
          symbol: a.symbol,
          decimals: a.decimals,
          weightPct: a.targetWeightBps / 100,
          tokenAmount: a.tokenAmount,
          investedAmount: a.investedAmount,
          feeTier: a.feeTier,
          logo: a.logo,
          marketCap: a.marketCap,
        })),
        totalAmount: portfolioData.totalAmount,
        assetSymbol: portfolioData.assetSymbol,
        assetAddress: portfolioData.assetAddress,
        assetDecimals: portfolioData.assetDecimals,
        chainId: data.chainId,
      };
    }
  }

  // Mock portfolio data when using mock governor
  if (isMock && activeProposal) {
    portfolioAllocations = {
      allocations: [
        { symbol: "JPM", weightPct: 25.0 },
        { symbol: "NVDA", weightPct: 20.0 },
        { symbol: "MSFT", weightPct: 18.0 },
        { symbol: "V", weightPct: 15.0 },
        { symbol: "AAPL", weightPct: 12.0 },
        { symbol: "META", weightPct: 10.0 },
      ],
      totalAmount: "50,000.00",
      assetSymbol: data.assetSymbol,
    };
  }

  const votingQueue = governor.proposals.filter(
    (p) =>
      p.computedState === ProposalState.Pending ||
      p.computedState === ProposalState.Approved,
  );

  const mockTag = isMock ? (
    <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px", fontFamily: "var(--font-plus-jakarta), sans-serif" }}>
      MOCK DATA
    </span>
  ) : null;

  return (
    <>
      <TorusKnotBackground
        radius={10}
        tube={0.2}
        tubularSegments={128}
        radialSegments={16}
        p={3}
        q={4}
        opacity={0.15}
        fogDensity={0.08}
      />
      <div className="scanlines" style={{ opacity: 0.2 }} />

      <div className="layout layout-normal">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          <SyndicateClient
            name={name}
            subdomain={subdomain}
            vault={data.vault}
            creator={data.creator}
            creatorName={addressNames[creatorKey]}
            paused={data.paused}
            chainId={data.chainId}
            assetDecimals={data.assetDecimals}
            assetSymbol={data.assetSymbol}
            activeTab="proposals"
          />

          {/* Governor params bar */}
          <div className="stats-bar">
            <div className="stat-item">
              <div className="stat-label">Voting Period</div>
              <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                {formatDuration(governor.params.votingPeriod)}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Veto Threshold</div>
              <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                {formatBps(governor.params.vetoThresholdBps)}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Max Fee</div>
              <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                {formatBps(governor.params.maxPerformanceFeeBps)}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Cooldown</div>
              <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                {formatDuration(governor.params.cooldownPeriod)}
              </div>
            </div>
          </div>

          {/* Active Strategy */}
          <div style={{ position: "relative" }}>
            {isMock && <MockBadge />}
            <ActiveProposal
              proposal={activeProposal}
              cooldownEnd={governor.cooldownEnd}
              addressNames={addressNames}
              assetDecimals={data.assetDecimals}
              assetSymbol={data.assetSymbol}
              portfolioAllocations={portfolioAllocations}
              enrichedPortfolio={enrichedPortfolio}
            />
          </div>

          {/* Voting Queue */}
          {votingQueue.length > 0 && (
            <div style={{ marginTop: "1.5rem" }}>
              <div
                className="panel-title"
                style={{ marginBottom: "1rem" }}
              >
                <span>Voting Queue</span>
                <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  {mockTag}
                  <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
                    {votingQueue.length} PENDING
                  </span>
                </div>
              </div>
              {votingQueue.map((p) => (
                <ProposalCard
                  key={p.id.toString()}
                  proposal={p}
                  governorAddress={governor.governorAddress}
                  params={governor.params}
                  assetDecimals={data.assetDecimals}
                  addressNames={addressNames}
                />
              ))}
            </div>
          )}

          {/* History + Agent Stats grid */}
          <div className="grid-dashboard" style={{ marginTop: "1.5rem" }}>
            <div style={{ position: "relative" }}>
              {isMock && <MockBadge />}
              <ProposalHistory
                proposals={governor.proposals}
                assetDecimals={data.assetDecimals}
                assetSymbol={data.assetSymbol}
                addressNames={addressNames}
              />
            </div>
            <div style={{ position: "relative" }}>
              {isMock && <MockBadge />}
              <AgentStats
                proposals={governor.proposals}
                assetDecimals={data.assetDecimals}
                assetSymbol={data.assetSymbol}
                addressNames={addressNames}
              />
            </div>
          </div>
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
