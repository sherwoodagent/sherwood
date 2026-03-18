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
import { fetchGovernorData, ProposalState } from "@/lib/governor-data";
import { formatBps } from "@/lib/contracts";
import { formatDuration } from "@/lib/governor-data";

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

  const governor = await fetchGovernorData(data.vault);

  // Categorize proposals
  const activeProposal = governor?.proposals.find(
    (p) => p.computedState === ProposalState.Executed,
  ) ?? null;

  const votingQueue = governor?.proposals.filter(
    (p) =>
      p.computedState === ProposalState.Pending ||
      p.computedState === ProposalState.Approved,
  ) ?? [];

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
        <main className="px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          <SyndicateClient
            name={name}
            subdomain={subdomain}
            vault={data.vault}
            creator={data.creator}
            paused={data.paused}
            openDeposits={data.openDeposits}
          />

          {!governor ? (
            <div className="panel" style={{ marginTop: "2rem" }}>
              <div className="panel-title">
                <span>Governance</span>
              </div>
              <div
                style={{
                  textAlign: "center",
                  padding: "3rem 0",
                  color: "rgba(255,255,255,0.3)",
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "12px",
                }}
              >
                Governor not configured for this vault
              </div>
            </div>
          ) : (
            <>
              {/* Governor params bar */}
              <div className="stats-bar">
                <div className="stat-item">
                  <div className="stat-label">Voting Period</div>
                  <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                    {formatDuration(governor.params.votingPeriod)}
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">Quorum</div>
                  <div className="stat-value" style={{ fontSize: "1.2rem" }}>
                    {formatBps(governor.params.quorumBps)}
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
              <ActiveProposal
                proposal={activeProposal}
                cooldownEnd={governor.cooldownEnd}
              />

              {/* Voting Queue */}
              {votingQueue.length > 0 && (
                <div style={{ marginTop: "1.5rem" }}>
                  <div
                    className="panel-title"
                    style={{ marginBottom: "1rem" }}
                  >
                    <span>Voting Queue</span>
                    <span
                      style={{
                        color: "rgba(255,255,255,0.2)",
                        fontSize: "9px",
                      }}
                    >
                      {votingQueue.length} PENDING
                    </span>
                  </div>
                  {votingQueue.map((p) => (
                    <ProposalCard
                      key={p.id.toString()}
                      proposal={p}
                      governorAddress={governor.governorAddress}
                      params={governor.params}
                    />
                  ))}
                </div>
              )}

              {/* History + Agent Stats grid */}
              <div className="grid-dashboard" style={{ marginTop: "1.5rem" }}>
                <ProposalHistory proposals={governor.proposals} />
                <AgentStats proposals={governor.proposals} />
              </div>
            </>
          )}
        </main>
      </div>

      <SiteFooter
        left="&copy; 2025 Sherwood Protocol // Proposals"
        right="Governance // Dashboard"
      />
    </>
  );
}
