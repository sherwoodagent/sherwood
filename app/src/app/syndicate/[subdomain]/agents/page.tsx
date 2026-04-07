import { notFound } from "next/navigation";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import AttestationTimeline from "@/components/AttestationTimeline";
import { truncateAddress } from "@/lib/contracts";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const name = data?.metadata?.name || subdomain;
  return { title: `Sherwood // ${name} — Agents` };
}

export default async function AgentsPage({
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
  const activeAgents = data.agents.filter((a) => a.active);
  const inactiveAgents = data.agents.filter((a) => !a.active);

  // Build address/name maps for identity resolution
  const addressNames: Record<string, string> = {};
  const agentNames: Record<string, string> = {};
  for (const agent of data.agents) {
    const displayName = agent.identity?.name || `Agent #${agent.agentId.toString()}`;
    addressNames[agent.agentAddress.toLowerCase()] = displayName;
    agentNames[agent.agentId.toString()] = displayName;
  }
  const creatorKey = data.creator.toLowerCase();

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
            activeTab="agents"
          />

          {/* Stats bar */}
          <div className="stats-bar">
            <div className="stat-item">
              <div className="stat-label">Total Agents</div>
              <div className="stat-value">{data.agents.length}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Active</div>
              <div className="stat-value" style={{ color: "var(--color-accent)" }}>
                {activeAgents.length}
              </div>
            </div>
            {inactiveAgents.length > 0 && (
              <div className="stat-item">
                <div className="stat-label">Inactive</div>
                <div className="stat-value" style={{ color: "#ff4d4d" }}>
                  {inactiveAgents.length}
                </div>
              </div>
            )}
          </div>

          {/* Agent cards */}
          {data.agents.length === 0 ? (
            <div
              className="panel"
              style={{
                textAlign: "center",
                padding: "3rem 0",
                color: "rgba(255,255,255,0.3)",
                fontFamily: "var(--font-plus-jakarta), sans-serif",
                fontSize: "12px",
              }}
            >
              No agents registered yet
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {data.agents.map((agent) => {
                const displayName =
                  agent.identity?.name || `Agent #${agent.agentId.toString()}`;
                const agentAttestations = data.attestations.filter(
                  (att) => att.agentId === agent.agentId,
                );

                return (
                  <div key={agent.agentAddress} className="agent-card" style={{ padding: "1.25rem" }}>
                    {/* Header: name + status */}
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div
                          className="font-[family-name:var(--font-inter)]"
                          style={{
                            fontSize: "16px",
                            fontWeight: 600,
                            color: "white",
                          }}
                        >
                          {displayName}
                        </div>
                        <div
                          className="font-[family-name:var(--font-plus-jakarta)]"
                          style={{
                            fontSize: "10px",
                            color: "var(--color-accent)",
                            marginTop: "2px",
                            opacity: 0.7,
                          }}
                        >
                          ERC-8004 #{agent.agentId.toString()}
                        </div>
                      </div>
                      <span
                        className="glitch-tag text-[9px] px-2 py-0.5"
                        style={
                          agent.active
                            ? undefined
                            : {
                                background: "rgba(255,77,77,0.2)",
                                color: "#ff4d4d",
                              }
                        }
                      >
                        {agent.active ? "ACTIVE" : "INACTIVE"}
                      </span>
                    </div>

                    {/* Description */}
                    {agent.identity?.description && (
                      <div
                        className="font-[family-name:var(--font-plus-jakarta)]"
                        style={{
                          fontSize: "12px",
                          color: "rgba(255,255,255,0.5)",
                          lineHeight: 1.5,
                          marginBottom: "0.75rem",
                        }}
                      >
                        {agent.identity.description}
                      </div>
                    )}

                    {/* Wallet address */}
                    <div
                      className="font-[family-name:var(--font-plus-jakarta)] flex items-center gap-2"
                      style={{
                        fontSize: "11px",
                        color: "rgba(255,255,255,0.35)",
                        marginTop: agent.identity?.description ? 0 : "0.5rem",
                      }}
                    >
                      <span>{truncateAddress(agent.agentAddress)}</span>
                    </div>

                    {/* Agent attestation history */}
                    {agentAttestations.length > 0 && (
                      <div style={{ marginTop: "1rem", borderTop: "1px solid var(--color-border)", paddingTop: "1rem" }}>
                        <AttestationTimeline
                          attestations={agentAttestations}
                          agentNames={agentNames}
                          addressNames={addressNames}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
