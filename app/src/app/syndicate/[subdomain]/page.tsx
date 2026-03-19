import { notFound } from "next/navigation";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import SyndicateClient from "@/components/SyndicateClient";
import DepositButton from "@/components/DepositButton";
import EquityCurveChart from "@/components/EquityCurveChart";
import VaultOverview from "@/components/VaultOverview";
import AgentRoster from "@/components/AgentRoster";
import AttestationTimeline from "@/components/AttestationTimeline";
import LiveFeed from "@/components/LiveFeed";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import { formatUSDC } from "@/lib/contracts";

// Mock equity curve data — will be replaced when execution indexing is available
const MOCK_EQUITY_CURVE = [
  3.2, 3.25, 3.18, 3.3, 3.42, 3.38, 3.45, 3.6, 3.55, 3.7, 3.82, 3.75, 3.8,
  3.9, 4.05, 3.98, 4.12, 4.1, 4.05, 4.15, 4.22, 4.18, 4.2, 4.25, 4.32, 4.28,
  4.35, 4.4, 4.38, 4.2,
];

const MOCK_TRADES = [
  { timestamp: "14:22:01", asset: "WETH/USDC", side: "LONG" as const, size: "14.2 ETH", pnl: "+$1,420", pnlPositive: true, status: "CLOSED" as const },
  { timestamp: "13:58:12", asset: "ARB/USDC", side: "SHORT" as const, size: "12,000 ARB", pnl: "+$210", pnlPositive: true, status: "CLOSED" as const },
  { timestamp: "12:44:55", asset: "LINK/USDC", side: "LONG" as const, size: "400 LINK", pnl: "-$84", pnlPositive: false, status: "CLOSED" as const },
  { timestamp: "11:10:04", asset: "SOL/USDC", side: "LONG" as const, size: "80 SOL", pnl: "--", pnlPositive: true, status: "OPEN" as const },
];

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
    addressNames[agent.pkpAddress.toLowerCase()] = displayName;
    addressNames[agent.operatorEOA.toLowerCase()] = displayName;
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
        <main className="px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Client-side header with wallet integration */}
          <SyndicateClient
            name={name}
            subdomain={subdomain}
            vault={data.vault}
            creator={data.creator}
            paused={data.paused}
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
                <div className="stat-label">Total Deposited</div>
                <div className="stat-value">{data.display.totalDeposited}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Agents</div>
                <div className="stat-value">{data.agentCount.toString()}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Mgmt Fee</div>
                <div className="stat-value">{data.display.managementFee}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Redemptions</div>
                <div className="stat-value" style={{ color: data.redemptionsLocked ? "#ff4d4d" : "var(--color-accent)" }}>
                  {data.redemptionsLocked ? "LOCKED" : "OPEN"}
                </div>
              </div>
            </div>
            <DepositButton
              vault={data.vault}
              vaultName={name}
              openDeposits={data.openDeposits}
              paused={data.paused}
            />
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
            />

            {/* Top-right: Agent Roster */}
            <AgentRoster agents={data.agents} />

            {/* Bottom-left: Attestation Timeline */}
            <AttestationTimeline attestations={data.attestations} agentNames={agentNames} />

            {/* Bottom-right: Live Intelligence Feed */}
            <LiveFeed groupId={data.xmtpGroupId ?? undefined} addressNames={addressNames} />
          </div>

          {/* Mock sections (labeled) — will be replaced with real data */}
          <div className="grid-dashboard" style={{ marginTop: 0 }}>
            <div className="panel">
              <div className="panel-title">
                <span>Equity Curve (30d)</span>
                <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
                  MOCK DATA
                </span>
              </div>
              <EquityCurveChart data={MOCK_EQUITY_CURVE} hwm={data.display.tvl} />
            </div>

            <div className="panel">
              <div className="panel-title">
                <span>Trade History Log</span>
                <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
                  MOCK DATA
                </span>
              </div>
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Asset</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>PnL</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_TRADES.map((trade, i) => (
                    <tr key={i}>
                      <td>{trade.timestamp}</td>
                      <td>{trade.asset}</td>
                      <td
                        style={{
                          color:
                            trade.side === "LONG"
                              ? "var(--color-accent)"
                              : "#ff4d4d",
                        }}
                      >
                        {trade.side}
                      </td>
                      <td>{trade.size}</td>
                      <td
                        style={{
                          color: trade.pnlPositive
                            ? "var(--color-accent)"
                            : "#ff4d4d",
                        }}
                      >
                        {trade.pnl}
                      </td>
                      <td
                        style={
                          trade.status === "OPEN"
                            ? { color: "var(--color-accent)" }
                            : undefined
                        }
                      >
                        [{trade.status}]
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      <SiteFooter
        left="&copy; 2025 Sherwood Protocol // Syndicate Dashboard"
        right="Live Feed // API Docs // Governance"
      />
    </>
  );
}
