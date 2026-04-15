import { notFound } from "next/navigation";
import Link from "next/link";
import AmbientBackground from "@/components/AmbientBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import AttestationTimeline from "@/components/AttestationTimeline";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import { fetchGovernorData, ProposalState } from "@/lib/governor-data";
import { truncateAddress, formatAsset, getAddresses } from "@/lib/contracts";
import { TargetChainProvider } from "@/components/TargetChainContext";
import JsonLd from "@/components/JsonLd";
import { buildBreadcrumbLd } from "@/lib/structured-data";
import ShareButton from "@/components/ShareButton";

interface PageParams {
  subdomain: string;
  agentId: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { subdomain, agentId } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const agent = data?.agents.find((a) => a.agentId.toString() === agentId);
  const name = agent?.identity?.name || `Agent #${agentId}`;
  const description = agent?.identity?.description
    ? agent.identity.description.slice(0, 160)
    : `Agent on ${subdomain}.sherwoodagent.eth — ERC-8004 identity #${agentId}.`;
  const canonical = `/syndicate/${subdomain}/agents/${agentId}`;
  return {
    title: `Sherwood // ${name}`,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${name} · Sherwood`,
      description,
      type: "profile",
      // opengraph-image.tsx in this dir auto-generates the rich card.
    },
    twitter: {
      card: "summary_large_image",
      title: `${name} · Sherwood`,
      description,
    },
  };
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { subdomain, agentId } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  if (!data) notFound();

  const agent = data.agents.find((a) => a.agentId.toString() === agentId);
  if (!agent) notFound();

  const syndicateName =
    data.metadata?.name || `Syndicate #${data.syndicateId.toString()}`;
  const displayName = agent.identity?.name || `Agent #${agent.agentId.toString()}`;
  const chainAddrs = getAddresses(data.chainId);
  const hasIdentityRegistry =
    chainAddrs.identityRegistry !== "0x0000000000000000000000000000000000000000";

  // Fetch governor data to compute per-agent track record (if deployed).
  const governor = await fetchGovernorData(data.vault, data.chainId);
  const agentLower = agent.agentAddress.toLowerCase();
  const agentProposals = governor
    ? governor.proposals.filter((p) => p.proposer.toLowerCase() === agentLower)
    : [];
  const settled = agentProposals.filter(
    (p) => p.computedState === ProposalState.Settled,
  );
  const wins = settled.filter((p) => (p.pnl ?? 0n) > 0n).length;
  const winRate = settled.length > 0 ? (wins / settled.length) * 100 : 0;
  const totalPnl = settled.reduce(
    (acc, p) => acc + (p.pnl ?? 0n),
    0n,
  );

  const addressNames: Record<string, string> = {};
  const agentNames: Record<string, string> = {};
  for (const a of data.agents) {
    const dn = a.identity?.name || `Agent #${a.agentId.toString()}`;
    addressNames[a.agentAddress.toLowerCase()] = dn;
    agentNames[a.agentId.toString()] = dn;
  }

  const agentAttestations = data.attestations.filter(
    (att) => att.agentId === agent.agentId,
  );

  const sign = totalPnl > 0n ? "+" : totalPnl < 0n ? "-" : "";
  const totalPnlAbs = totalPnl < 0n ? -totalPnl : totalPnl;
  const isUSD = data.assetSymbol === "USDC" || data.assetSymbol === "USDT";
  const totalPnlDisplay =
    settled.length === 0
      ? "—"
      : isUSD
        ? `${sign}${formatAsset(totalPnlAbs, data.assetDecimals, "USD")}`
        : `${sign}${formatAsset(totalPnlAbs, data.assetDecimals)} ${data.assetSymbol}`;

  return (
    <TargetChainProvider chainId={data.chainId}>
      <AmbientBackground />

      <JsonLd
        data={buildBreadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Leaderboard", path: "/leaderboard" },
          { name: syndicateName, path: `/syndicate/${subdomain}` },
          { name: "Agents", path: `/syndicate/${subdomain}/agents` },
          {
            name: displayName,
            path: `/syndicate/${subdomain}/agents/${agentId}`,
          },
        ])}
      />

      <div className="layout layout-normal">
        <main
          id="main-content"
          className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]"
        >
          <SiteHeader />

          <SyndicateClient
            name={syndicateName}
            subdomain={subdomain}
            vault={data.vault}
            creator={data.creator}
            creatorName={addressNames[data.creator.toLowerCase()]}
            paused={data.paused}
            chainId={data.chainId}
            assetDecimals={data.assetDecimals}
            assetSymbol={data.assetSymbol}
            activeTab="agents"
            hideAgentsTab={!hasIdentityRegistry}
          />

          {/* Breadcrumb */}
          <div
            className="font-[family-name:var(--font-jetbrains-mono)]"
            style={{
              fontSize: "11px",
              letterSpacing: "0.1em",
              color: "var(--color-fg-secondary)",
              margin: "1rem 0",
            }}
          >
            <Link
              href={`/syndicate/${subdomain}/agents`}
              style={{ color: "var(--color-accent)" }}
            >
              ← All agents
            </Link>
            <span style={{ margin: "0 0.5rem" }}>/</span>
            <span>{displayName}</span>
          </div>

          {/* Agent header */}
          <div className="panel">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "1rem",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 280 }}>
                <h2
                  className="font-[family-name:var(--font-inter)]"
                  style={{
                    fontSize: "28px",
                    fontWeight: 600,
                    color: "white",
                    marginBottom: "0.25rem",
                  }}
                >
                  {displayName}
                </h2>
                <div
                  className="font-[family-name:var(--font-jetbrains-mono)]"
                  style={{
                    fontSize: "12px",
                    color: "var(--color-accent)",
                    letterSpacing: "0.05em",
                  }}
                >
                  ERC-8004 #{agent.agentId.toString()} ·{" "}
                  {truncateAddress(agent.agentAddress)}
                </div>
                {agent.identity?.description && (
                  <p
                    className="font-[family-name:var(--font-plus-jakarta)]"
                    style={{
                      marginTop: "1rem",
                      color: "var(--color-fg-secondary)",
                      fontSize: "14px",
                      lineHeight: 1.6,
                      maxWidth: 720,
                    }}
                  >
                    {agent.identity.description}
                  </p>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: "0.75rem",
                }}
              >
                <Badge variant={agent.active ? "success" : "danger"}>
                  {agent.active ? "Active" : "Inactive"}
                </Badge>
                {/* Share button — pre-fills a tweet linking to this agent's
                    detail page; OG card auto-renders a rich preview. */}
                <ShareButton
                  path={`/syndicate/${subdomain}/agents/${agent.agentId.toString()}`}
                  text={`${displayName} on Sherwood — ERC-8004 #${agent.agentId.toString()} · ${syndicateName}`}
                />
              </div>
            </div>
          </div>

          {/* Track record */}
          <div className="metrics-grid" style={{ marginTop: "1.5rem" }}>
            <div className="sh-card--metric">
              <div className="metric-label">Proposals</div>
              <div className="metric-val">{agentProposals.length}</div>
            </div>
            <div className="sh-card--metric">
              <div className="metric-label">Settled</div>
              <div className="metric-val">{settled.length}</div>
            </div>
            <div className="sh-card--metric">
              <div className="metric-label">Win rate</div>
              <div className="metric-val">
                {settled.length === 0 ? "—" : `${winRate.toFixed(0)}%`}
              </div>
            </div>
            <div className="sh-card--metric">
              <div className="metric-label">Net P&amp;L</div>
              <div
                className="metric-val"
                style={{
                  color:
                    totalPnl > 0n
                      ? "var(--color-accent)"
                      : totalPnl < 0n
                        ? "#ff4d4d"
                        : undefined,
                }}
              >
                {totalPnlDisplay}
              </div>
            </div>
          </div>

          {/* Attestations */}
          {chainAddrs.easExplorer && (
            <div className="panel" style={{ marginTop: "1.5rem" }}>
              <div className="panel-title">
                <span>Attestation history</span>
                <span style={{ color: "var(--color-fg-secondary)", fontSize: "10px" }}>
                  {agentAttestations.length} EVENTS
                </span>
              </div>
              {agentAttestations.length === 0 ? (
                <EmptyState
                  title="No attestations yet"
                  description="This agent has no recorded EAS attestations on this syndicate."
                />
              ) : (
                <AttestationTimeline
                  attestations={agentAttestations}
                  agentNames={agentNames}
                  addressNames={addressNames}
                  chainId={data.chainId}
                />
              )}
            </div>
          )}

          {/* Proposal list */}
          {governor && (
            <div className="panel" style={{ marginTop: "1.5rem" }}>
              <div className="panel-title">
                <span>Proposals by {displayName}</span>
                <span style={{ color: "var(--color-fg-secondary)", fontSize: "10px" }}>
                  {agentProposals.length} TOTAL
                </span>
              </div>
              {agentProposals.length === 0 ? (
                <EmptyState
                  title="No proposals submitted"
                  description="This agent hasn't proposed a strategy in this syndicate yet."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {agentProposals.map((p) => {
                    const pnl = p.pnl ?? 0n;
                    const pnlSign = pnl > 0n ? "+" : pnl < 0n ? "-" : "";
                    const pnlAbs = pnl < 0n ? -pnl : pnl;
                    const pnlColor =
                      pnl > 0n
                        ? "var(--color-accent)"
                        : pnl < 0n
                          ? "#ff4d4d"
                          : "var(--color-fg-secondary)";
                    return (
                      <div
                        key={p.id.toString()}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "60px 1fr 100px 120px",
                          gap: "1rem",
                          padding: "0.75rem",
                          alignItems: "center",
                          borderBottom: "1px solid var(--color-border-soft)",
                        }}
                      >
                        <span
                          className="font-[family-name:var(--font-jetbrains-mono)]"
                          style={{ color: "var(--color-fg-secondary)", fontSize: "11px" }}
                        >
                          #{p.id.toString().padStart(2, "0")}
                        </span>
                        <span
                          style={{ fontSize: "13px", color: "var(--color-fg)" }}
                        >
                          {p.metadata?.title || `Proposal #${p.id.toString()}`}
                        </span>
                        <Badge
                          variant={
                            p.computedState === ProposalState.Settled
                              ? "success"
                              : p.computedState === ProposalState.Rejected
                                ? "danger"
                                : "warn"
                          }
                        >
                          {ProposalState[p.computedState]}
                        </Badge>
                        <span
                          className="font-[family-name:var(--font-jetbrains-mono)]"
                          style={{
                            color: pnlColor,
                            fontSize: "12px",
                            textAlign: "right",
                          }}
                        >
                          {p.computedState === ProposalState.Settled
                            ? `${pnlSign}${formatAsset(pnlAbs, data.assetDecimals, isUSD ? "USD" : undefined)}`
                            : "—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      <SiteFooter />
    </TargetChainProvider>
  );
}
