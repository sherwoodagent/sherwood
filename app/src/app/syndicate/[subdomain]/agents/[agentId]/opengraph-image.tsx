/**
 * Dynamic Open Graph image for an agent within a syndicate.
 *
 * Companion to the syndicate-level OG image. Renders the agent's display
 * name, ERC-8004 id, win-rate, settled count, and net P&L so a tweet
 * linking to /syndicate/<sub>/agents/<id> shows a rich preview card.
 */

import { ImageResponse } from "next/og";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";
import { fetchGovernorData, ProposalState } from "@/lib/governor-data";
import { formatAsset, truncateAddress } from "@/lib/contracts";

export const runtime = "nodejs";
export const revalidate = 300;

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({
  params,
}: {
  params: Promise<{ subdomain: string; agentId: string }>;
}) {
  const { subdomain, agentId } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const agent = data?.agents.find((a) => a.agentId.toString() === agentId);

  // Without a resolvable agent we render a minimal fallback rather than
  // erroring — the OG endpoint is hit by crawlers we don't control.
  const displayName = agent?.identity?.name || `Agent #${agentId}`;
  const wallet = agent?.agentAddress
    ? truncateAddress(agent.agentAddress)
    : "—";
  const isUSD = data?.assetSymbol === "USDC" || data?.assetSymbol === "USDT";

  // Compute light track-record numbers from the governor data.
  let winRate = "—";
  let settledCount = "0";
  let totalPnlDisplay = "—";
  let pnlSign: "up" | "down" | "flat" = "flat";

  if (data && agent) {
    const governor = await fetchGovernorData(data.vault, data.chainId);
    const agentLower = agent.agentAddress.toLowerCase();
    const proposals = governor
      ? governor.proposals.filter(
          (p) => p.proposer.toLowerCase() === agentLower,
        )
      : [];
    const settled = proposals.filter(
      (p) => p.computedState === ProposalState.Settled,
    );
    settledCount = settled.length.toString();
    const wins = settled.filter((p) => (p.pnl ?? 0n) > 0n).length;
    if (settled.length > 0) {
      winRate = `${Math.round((wins / settled.length) * 100)}%`;
    }

    const totalPnl = settled.reduce((acc, p) => acc + (p.pnl ?? 0n), 0n);
    if (totalPnl !== 0n) {
      pnlSign = totalPnl > 0n ? "up" : "down";
      const abs = totalPnl < 0n ? -totalPnl : totalPnl;
      const formatted = formatAsset(
        abs,
        data.assetDecimals,
        isUSD ? "USD" : undefined,
      );
      const sign = totalPnl > 0n ? "+" : "-";
      totalPnlDisplay = isUSD
        ? `${sign}${formatted}`
        : `${sign}${formatted} ${data.assetSymbol}`;
    } else if (settled.length > 0) {
      totalPnlDisplay = isUSD ? "$0.00" : `0 ${data.assetSymbol}`;
    }
  }

  const pnlColor =
    pnlSign === "up" ? "#2EE6A6" : pnlSign === "down" ? "#ff4d4d" : "#9CA3AF";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(46, 230, 166, 0.12), transparent 70%), #050505",
          color: "#E5E7EB",
          padding: "72px 96px",
          fontFamily: "ui-sans-serif, system-ui",
        }}
      >
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "#9CA3AF",
            fontSize: 18,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: "#2EE6A6",
                boxShadow: "0 0 12px rgba(46,230,166,0.7)",
              }}
            />
            <span>Sherwood Agent</span>
          </div>
          <div style={{ color: "#2EE6A6" }}>{subdomain}.sherwoodagent.eth</div>
        </div>

        {/* Identity */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 88,
            flex: 1,
          }}
        >
          <div
            style={{
              fontSize: 96,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              color: "white",
              maxWidth: 1000,
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 22,
              color: "#9CA3AF",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              letterSpacing: "0.05em",
            }}
          >
            ERC-8004 #{agentId} · {wallet}
          </div>
        </div>

        {/* Track record */}
        <div
          style={{
            display: "flex",
            gap: 64,
            paddingTop: 32,
            borderTop: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          <Stat label="Settled" value={settledCount} />
          <Stat label="Win rate" value={winRate} />
          <Stat
            label="Net P&L"
            value={totalPnlDisplay}
            color={pnlColor}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 16,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "#9CA3AF",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 600,
          color: color ?? "white",
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
    </div>
  );
}
