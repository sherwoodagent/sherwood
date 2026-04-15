import { Suspense } from "react";
import { notFound } from "next/navigation";
import dynamic from "next/dynamic";
import AmbientBackground from "@/components/AmbientBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import DepositButton from "@/components/DepositButton";
import WithdrawButton from "@/components/WithdrawButton";
import RiskMetricsPanel from "@/components/RiskMetricsPanel";
import VaultOverview from "@/components/VaultOverview";
import AgentRoster from "@/components/AgentRoster";
import AttestationTimeline from "@/components/AttestationTimeline";
import LiveFeed from "@/components/LiveFeed";
import ActiveProposal from "@/components/proposals/ActiveProposal";
import { getAddresses } from "@/lib/contracts";
import StrategyActivity from "@/components/StrategyActivity";
import ReferralBanner from "@/components/ReferralBanner";
import { RecentlyViewedTracker } from "@/components/RecentlyViewed";
import { TargetChainProvider } from "@/components/TargetChainContext";
import RedemptionUnlockWatcher from "@/components/RedemptionUnlockWatcher";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import { loadActiveStrategy } from "@/lib/active-strategy";
import JsonLd from "@/components/JsonLd";
import { buildSyndicateLd, buildBreadcrumbLd } from "@/lib/structured-data";

// Equity chart pulls chart.js (~50kB gzip). Lives below the fold on the
// vault page; dynamic-importing it shifts that weight out of the route's
// initial JS bundle.
// EquityCurveChart already has "use client" — dropping ssr: false (which
// isn't allowed in server-component dynamic imports) lets Next render
// the loading placeholder server-side and hydrate the chart on the client.
const EquityCurveChart = dynamic(() => import("@/components/EquityCurveChart"), {
  loading: () => (
    <div
      style={{
        height: 320,
        background: "rgba(255,255,255,0.02)",
        animation: "sh-skel-shimmer 1.5s ease-in-out infinite",
      }}
      aria-busy="true"
      aria-label="Loading equity chart"
    />
  ),
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const name = data?.metadata?.name || subdomain;
  const tvl = data?.display?.tvl || "—";
  const agentCount = data?.agentCount?.toString() || "0";
  const description = data
    ? `${name} — TVL ${tvl}, ${agentCount} agent${agentCount === "1" ? "" : "s"} on ${subdomain}.sherwoodagent.eth.`
    : `Syndicate ${subdomain}`;
  return {
    title: `Sherwood // ${name}`,
    description,
    alternates: { canonical: `/syndicate/${subdomain}` },
    openGraph: {
      title: `${name} · Sherwood`,
      description,
      type: "website",
      // Each route auto-generates an opengraph-image via opengraph-image.tsx
    },
    twitter: {
      card: "summary_large_image",
      title: `${name} · Sherwood`,
      description,
    },
  };
}

export default async function SyndicateDetailPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);

  if (!data) {
    notFound();
  }

  const name = data.metadata?.name || `Syndicate #${data.syndicateId.toString()}`;

  // Build agentId → display name map for attestation timeline
  const agentNames: Record<string, string> = {};
  // Build address → display name map for live feed
  const addressNames: Record<string, string> = {};
  for (const agent of data.agents) {
    const displayName = agent.identity?.name || `Agent #${agent.agentId.toString()}`;
    agentNames[agent.agentId.toString()] = displayName;
    addressNames[agent.agentAddress.toLowerCase()] = displayName;
  }
  const creatorKey = data.creator.toLowerCase();
  const chainAddrs = getAddresses(data.chainId);
  const hasIdentityRegistry = chainAddrs.identityRegistry !== "0x0000000000000000000000000000000000000000";
  const hasEAS = !!chainAddrs.easExplorer;

  // Load the currently-executing proposal (if any) so the Active Strategy
  // panel can render at the top of the vault page — where depositors first
  // land with the question "what's my capital doing right now?".
  const activeStrategy = await loadActiveStrategy(
    data.vault,
    data.chainId,
    data.assetDecimals,
    data.assetSymbol,
    data.activity,
  );

  const tvlDisplay = data.display?.tvl;

  return (
    <TargetChainProvider chainId={data.chainId}>
      <AmbientBackground />

      <JsonLd
        data={buildSyndicateLd({
          subdomain,
          name,
          description: data.metadata?.description || undefined,
          tvl: tvlDisplay,
          agentCount: Number(data.agentCount),
          assetSymbol: data.assetSymbol,
          chainId: data.chainId,
        })}
      />
      <JsonLd
        data={buildBreadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Leaderboard", path: "/leaderboard" },
          { name, path: `/syndicate/${subdomain}` },
        ])}
      />

      <div className="layout layout-normal">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Client-side header with wallet integration */}
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
            activeTab="vault"
            hideAgentsTab={!hasIdentityRegistry}
            effectiveTotalAssets={data.totalAssets}
            totalSupply={data.totalSupply}
          />

          {/* Referral banner — shown when visitor arrives via ?ref=<agentId> */}
          <Suspense fallback={null}>
            <ReferralBanner subdomain={subdomain} />
          </Suspense>

          {/* Records this visit in the user's recently-viewed strip */}
          <RecentlyViewedTracker
            subdomain={subdomain}
            name={name}
            chainId={data.chainId}
          />

          {/* Toasts the connected wallet when redemptions unlock on this
              vault — only fires when the user holds shares + the vault
              transitions locked → open. */}
          <RedemptionUnlockWatcher
            vault={data.vault}
            vaultName={name}
            chainId={data.chainId}
          />

          {/* Stats bar + Deposit */}
          <div className="stats-bar-row">
            <div className="stats-bar" style={{ flex: 1, marginBottom: 0 }}>
              <div className="stat-item">
                <div className="stat-label">TVL</div>
                <div className="stat-value">{data.display.tvl}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Agents</div>
                <div className="stat-value">{data.agentCount.toString()}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Mgmt Fee</div>
                <div className="stat-value">{data.display.managementFee}</div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", paddingLeft: "1rem" }}>
                <DepositButton
                  vault={data.vault}
                  vaultName={name}
                  openDeposits={data.openDeposits}
                  paused={data.paused}
                  redemptionsLocked={data.redemptionsLocked}
                  assetAddress={data.assetAddress}
                  assetDecimals={data.assetDecimals}
                  assetSymbol={data.assetSymbol}
                  chainId={data.chainId}
                />
                <WithdrawButton
                  vault={data.vault}
                  vaultName={name}
                  assetDecimals={data.assetDecimals}
                  assetSymbol={data.assetSymbol}
                  redemptionsLocked={data.redemptionsLocked}
                  paused={data.paused}
                  chainId={data.chainId}
                />
              </div>
            </div>
          </div>

          {/* Active Strategy — primary "what's my capital doing right now?"
              panel. Renders only when a proposal is executing; cooldown /
              idle states are better left off the vault page so the layout
              doesn't reserve empty space. */}
          {activeStrategy.activeProposal && activeStrategy.governor && (
            <div style={{ marginTop: "1.5rem" }}>
              <ActiveProposal
                proposal={activeStrategy.activeProposal}
                cooldownEnd={activeStrategy.governor.cooldownEnd}
                addressNames={addressNames}
                assetDecimals={data.assetDecimals}
                assetSymbol={data.assetSymbol}
                portfolioAllocations={activeStrategy.portfolioAllocations}
                enrichedPortfolio={activeStrategy.enrichedPortfolio}
                governorAddress={activeStrategy.governor.governorAddress}
                chainId={data.chainId}
                explorerUrl={chainAddrs.blockExplorer}
              />
            </div>
          )}

          {/* Dashboard grid */}
          <div className="grid-dashboard">
            {/* Vault Configuration */}
            <VaultOverview
              openDeposits={data.openDeposits}
              totalSupply={data.totalSupply}
              paused={data.paused}
              redemptionsLocked={data.redemptionsLocked}
              managementFeeBps={data.managementFeeBps}
              assetDecimals={data.assetDecimals}
              vault={data.vault}
              chainId={data.chainId}
            />

            {/* Agent Roster (only on chains with ERC-8004) — or LiveFeed side-by-side when no ERC-8004 and no EAS */}
            {hasIdentityRegistry ? (
              <AgentRoster agents={data.agents} />
            ) : !hasEAS ? (
              <LiveFeed groupId={data.xmtpGroupId ?? undefined} addressNames={addressNames} />
            ) : null}

            {/* Attestation + Agent comms row (only on chains with EAS) */}
            {hasEAS && (
              <>
                <AttestationTimeline attestations={data.attestations} agentNames={agentNames} addressNames={addressNames} chainId={data.chainId} />
                <LiveFeed groupId={data.xmtpGroupId ?? undefined} addressNames={addressNames} />
              </>
            )}

            {/* LiveFeed full-width when we have ERC-8004 but no EAS */}
            {hasIdentityRegistry && !hasEAS && (
              <div style={{ gridColumn: "1 / -1" }}>
                <LiveFeed groupId={data.xmtpGroupId ?? undefined} addressNames={addressNames} />
              </div>
            )}
          </div>

          {/* Equity curve + Risk metrics */}
          <div className="grid-dashboard" style={{ marginTop: 0 }}>
            <div className="panel">
              <EquityCurveChart data={data.equityCurve} hwm={data.display.tvl} />
            </div>

            <RiskMetricsPanel
              series={data.equityCurve}
              assetSymbol={data.assetSymbol}
            />
          </div>

          {/* Strategy activity — full width below */}
          <StrategyActivity
            activity={data.activity}
            assetDecimals={data.assetDecimals}
            assetSymbol={data.assetSymbol}
            addressNames={addressNames}
          />
        </main>
      </div>

      <SiteFooter />
    </TargetChainProvider>
  );
}
