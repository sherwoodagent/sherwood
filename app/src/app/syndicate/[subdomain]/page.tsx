import { notFound } from "next/navigation";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import DepositButton from "@/components/DepositButton";
import WithdrawButton from "@/components/WithdrawButton";
import EquityCurveChart from "@/components/EquityCurveChart";
import VaultOverview from "@/components/VaultOverview";
import AgentRoster from "@/components/AgentRoster";
import AttestationTimeline from "@/components/AttestationTimeline";
import LiveFeed from "@/components/LiveFeed";
import StrategyActivity from "@/components/StrategyActivity";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const name = data?.metadata?.name || subdomain;
  return { title: `Sherwood // ${name}` };
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
  // Add creator only if not already mapped via agent identity
  const creatorKey = data.creator.toLowerCase();
  if (!addressNames[creatorKey]) {
    addressNames[creatorKey] = data.metadata?.name || `Syndicate #${data.syndicateId.toString()}`;
  }

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
              <DepositButton
                vault={data.vault}
                vaultName={name}
                openDeposits={data.openDeposits}
                paused={data.paused}
                assetAddress={data.assetAddress}
                assetDecimals={data.assetDecimals}
                assetSymbol={data.assetSymbol}
              />
              <WithdrawButton
                vault={data.vault}
                vaultName={name}
                assetDecimals={data.assetDecimals}
                assetSymbol={data.assetSymbol}
                redemptionsLocked={data.redemptionsLocked}
                paused={data.paused}
              />
            </div>
          </div>

          {/* Dashboard grid */}
          <div className="grid-dashboard">
            {/* Top-left: Vault Configuration */}
            <VaultOverview
              openDeposits={data.openDeposits}
              totalSupply={data.totalSupply}
              paused={data.paused}
              redemptionsLocked={data.redemptionsLocked}
              managementFeeBps={data.managementFeeBps}
              assetDecimals={data.assetDecimals}
            />

            {/* Top-right: Agent Roster */}
            <AgentRoster agents={data.agents} />

            {/* Bottom-left: Attestation Timeline */}
            <AttestationTimeline attestations={data.attestations} agentNames={agentNames} addressNames={addressNames} />

            {/* Bottom-right: Agent comms */}
            <LiveFeed groupId={data.xmtpGroupId ?? undefined} addressNames={addressNames} />
          </div>

          {/* Equity curve + Strategy activity */}
          <div className="grid-dashboard" style={{ marginTop: 0 }}>
            <div className="panel">
              <EquityCurveChart data={data.equityCurve} hwm={data.display.tvl} />
            </div>

            <StrategyActivity
              activity={data.activity}
              assetDecimals={data.assetDecimals}
              assetSymbol={data.assetSymbol}
              addressNames={addressNames}
            />
          </div>
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
