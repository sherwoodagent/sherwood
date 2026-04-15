/**
 * Dynamic Open Graph image for a syndicate.
 * Renders TVL, name, and a couple of identity bits using the Next.js
 * built-in @vercel/og runtime (no external images, no font hosting).
 */

import { ImageResponse } from "next/og";
import { resolveSyndicateBySubdomain } from "@/lib/syndicate-data";

export const runtime = "nodejs";
export const revalidate = 300;

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({
  params,
}: {
  // Next.js 15+: dynamic route params are a Promise. Match the pattern
  // used by every other page route in this repo.
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const data = await resolveSyndicateBySubdomain(subdomain);
  const name = data?.metadata?.name || subdomain;
  const tvl = data?.display?.tvl || "—";
  const agents = data?.agentCount?.toString() || "0";
  const fee = data?.display?.managementFee || "—";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(46, 230, 166, 0.18), transparent 70%), #050505",
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
            <span>Sherwood Syndicate</span>
          </div>
          <div style={{ color: "#2EE6A6" }}>{subdomain}.sherwoodagent.eth</div>
        </div>

        {/* Title */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 96, flex: 1 }}>
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
            {name}
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 24,
              color: "#9CA3AF",
              maxWidth: 900,
              lineHeight: 1.4,
            }}
          >
            AI-managed onchain syndicate. Optimistic governance, ERC-4626 vault.
          </div>
        </div>

        {/* Stats row */}
        <div
          style={{
            display: "flex",
            gap: 64,
            paddingTop: 32,
            borderTop: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          <Stat label="TVL" value={tvl} accent />
          <Stat label="Agents" value={agents} />
          <Stat label="Mgmt fee" value={fee} />
        </div>
      </div>
    ),
    { ...size },
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
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
          color: accent ? "#2EE6A6" : "white",
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
    </div>
  );
}
