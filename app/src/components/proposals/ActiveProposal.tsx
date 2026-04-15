import dynamic from "next/dynamic";
import {
  type ProposalData,
  ProposalState,
  formatDuration,
} from "@/lib/governor-data";
import { truncateAddress, formatAsset, formatBps } from "@/lib/contracts";
import ExecutionCallPreview from "./ExecutionCallPreview";
import { ProposalStepper } from "@/components/ui/ProposalStepper";
import { Countdown } from "@/components/ui/Countdown";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Address } from "viem";

// Lazy-load the chart.js consumers — they only render when an active
// proposal exists with portfolio data, and pulling chart.js + react-chartjs-2
// out of the route's initial JS dropped the vault page from ~82kB → ~10kB.
// Both already have "use client" so SSR isn't an issue; we just ship them
// as a separate chunk.
const PortfolioAllocation = dynamic(() => import("./PortfolioAllocation"), {
  loading: () => <ChartSkeleton />,
});
const PortfolioDashboard = dynamic(() => import("./PortfolioDashboard"), {
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return (
    <div
      style={{
        height: 220,
        marginTop: "1rem",
        background:
          "linear-gradient(90deg, rgba(255,255,255,0.02), rgba(255,255,255,0.05), rgba(255,255,255,0.02))",
        backgroundSize: "200% 100%",
        animation: "sh-skel-shimmer 1.5s ease-in-out infinite",
      }}
      aria-busy="true"
      aria-label="Loading allocation chart"
    />
  );
}

interface PortfolioAllocProps {
  allocations: { symbol: string; weightPct: number }[];
  totalAmount: string;
  assetSymbol: string;
}

interface EnrichedPortfolioProps {
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
}

interface ActiveProposalProps {
  proposal: ProposalData | null;
  cooldownEnd: bigint;
  addressNames?: Record<string, string>;
  assetDecimals: number;
  assetSymbol: string;
  portfolioAllocations?: PortfolioAllocProps | null;
  enrichedPortfolio?: EnrichedPortfolioProps | null;
  /** Optional — if provided, renders ExecutionCallPreview. */
  governorAddress?: Address;
  chainId?: number;
  explorerUrl?: string;
}

export default function ActiveProposal({
  proposal,
  cooldownEnd,
  addressNames,
  assetDecimals,
  assetSymbol,
  portfolioAllocations,
  enrichedPortfolio,
  governorAddress,
  chainId,
  explorerUrl,
}: ActiveProposalProps) {
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (!proposal) {
    const inCooldown = cooldownEnd > now;
    return (
      <div className="panel" style={{ borderColor: "var(--color-border)" }}>
        <div className="panel-title">
          <span>Active Strategy</span>
        </div>
        <EmptyState
          icon="Q.00"
          title="No active strategy"
          description={
            inCooldown
              ? "Syndicate is in post-settlement cooldown. New proposals can't execute until the cooldown window ends."
              : "Awaiting the next proposal from an agent in this syndicate."
          }
          action={
            inCooldown ? (
              <Countdown to={cooldownEnd} label="Cooldown" whenDone="Ready" />
            ) : null
          }
        />
      </div>
    );
  }

  const strategyEnd =
    proposal.executedAt + proposal.strategyDuration;
  const timeLeft = strategyEnd > now ? strategyEnd - now : 0n;
  const title =
    proposal.metadata?.title || `Proposal #${proposal.id.toString()}`;

  return (
    <div
      className="panel"
      style={{
        borderColor: "var(--color-accent)",
        boxShadow: "0 0 15px rgba(46, 230, 166, 0.1)",
      }}
    >
      <div className="panel-title">
        <span>Active Strategy</span>
        <span style={{ color: "var(--color-accent)", fontSize: "9px" }}>
          LIVE
        </span>
      </div>

      {/* Proposal state stepper — gives LPs an at-a-glance view of where we are */}
      <ProposalStepper
        state={proposal.computedState}
        subLabel={
          proposal.computedState === ProposalState.Executed && strategyEnd > now
            ? `Settles after duration (${formatDuration(proposal.strategyDuration)})`
            : proposal.computedState === ProposalState.Executed
              ? "Ready to settle"
              : undefined
        }
      />

      <div style={{ marginBottom: "1rem" }}>
        <div
          style={{
            fontSize: "16px",
            color: "#fff",
            fontWeight: 500,
            marginBottom: "0.5rem",
          }}
        >
          {title}
        </div>
        {proposal.metadata?.description && (
          <div
            style={{
              fontSize: "12px",
              color: "rgba(255,255,255,0.5)",
              fontFamily: "var(--font-plus-jakarta), sans-serif",
              lineHeight: 1.5,
              maxHeight: "3em",
              overflow: "hidden",
            }}
          >
            {proposal.metadata.description}
          </div>
        )}
      </div>

      <div className="metrics-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="sh-card--metric">
          <div className="metric-label">Agent</div>
          <div className="metric-val" style={{ fontSize: "1rem" }}>
            {addressNames?.[proposal.proposer.toLowerCase()] || truncateAddress(proposal.proposer)}
          </div>
        </div>
        <div className="sh-card--metric">
          <div className="metric-label">Capital Deployed</div>
          <div className="metric-val" style={{ fontSize: "1rem" }}>
            {formatAsset(proposal.deployedCapital, assetDecimals)} {assetSymbol}
          </div>
        </div>
        <div className="sh-card--metric">
          <div className="metric-label">Settles In</div>
          <div className="metric-val" style={{ fontSize: "1rem" }}>
            {timeLeft > 0n ? (
              <Countdown to={strategyEnd} whenDone="Ready to settle" />
            ) : (
              <span style={{ color: "var(--color-accent)" }}>Ready to settle</span>
            )}
          </div>
        </div>
        <div className="sh-card--metric">
          <div className="metric-label">Performance Fee</div>
          <div className="metric-val" style={{ fontSize: "1rem" }}>
            {formatBps(proposal.performanceFeeBps)}
          </div>
        </div>
      </div>

      {/* Portfolio dashboard (enriched) or simple allocation chart */}
      {enrichedPortfolio ? (
        <PortfolioDashboard
          allocations={enrichedPortfolio.allocations}
          totalInvested={enrichedPortfolio.totalAmount}
          assetSymbol={enrichedPortfolio.assetSymbol}
          assetAddress={enrichedPortfolio.assetAddress}
          assetDecimals={enrichedPortfolio.assetDecimals}
          chainId={enrichedPortfolio.chainId}
        />
      ) : portfolioAllocations ? (
        <PortfolioAllocation
          allocations={portfolioAllocations.allocations}
          totalAmount={portfolioAllocations.totalAmount}
          assetSymbol={portfolioAllocations.assetSymbol}
        />
      ) : null}

      {/* Execution call preview — what contracts are being called on-chain */}
      {governorAddress && chainId && explorerUrl && (
        <ExecutionCallPreview
          governorAddress={governorAddress}
          proposalId={proposal.id}
          chainId={chainId}
          explorerUrl={explorerUrl}
        />
      )}
    </div>
  );
}
