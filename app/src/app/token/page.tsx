import Link from "next/link";
import type { Metadata } from "next";
import HeroVideo from "@/components/HeroVideo";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import TokenomicsBreakdown from "@/components/token/TokenomicsBreakdown";
import GuardianLifecycleFlow from "@/components/token/GuardianLifecycleFlow";
import TokenContractComingSoon from "@/components/token/TokenContractComingSoon";

export const metadata: Metadata = {
  title: "Sherwood // $WOOD",
  description:
    "WOOD is the protocol token that secures every Sherwood strategy. Staked guardians simulate proposals, block malicious calldata, and earn WOOD for correct calls.",
  alternates: { canonical: "/token" },
  openGraph: {
    title: "$WOOD · Sherwood",
    description:
      "The token that secures every strategy. Staked guardians block malicious calldata; correct Block votes earn WOOD; bad approvals get slashed.",
    type: "website",
  },
};

export default async function TokenPage() {
  return (
    <>
      <HeroVideo src="/token-bg.mp4" />
      <div className="scanlines" />
      <div className="grain" />

      <div className="layout">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* ── Hero ─────────────────────────────────────────── */}
          <section className="py-24 md:py-32 relative">
            <div style={{ maxWidth: 760 }}>
              <span
                className="font-[family-name:var(--font-jetbrains-mono)]"
                style={{
                  color: "var(--color-accent)",
                  fontSize: "11px",
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  border: "1px solid var(--color-accent)",
                  padding: "2px 8px",
                  background: "rgba(46, 230, 166, 0.06)",
                }}
              >
                {"// $WOOD"}
              </span>
              <h1
                className="font-[family-name:var(--font-inter)]"
                style={{
                  fontSize: "clamp(2.5rem, 5vw, 4rem)",
                  lineHeight: 1.05,
                  fontWeight: 500,
                  letterSpacing: "-0.02em",
                  margin: "1.5rem 0 1.25rem",
                  color: "white",
                }}
              >
                The token that secures{" "}
                <span style={{ color: "var(--color-accent)" }}>every strategy.</span>
              </h1>
              <p
                className="font-[family-name:var(--font-plus-jakarta)]"
                style={{
                  fontSize: "1.125rem",
                  lineHeight: 1.55,
                  color: "rgba(255, 255, 255, 0.7)",
                  maxWidth: "560px",
                  margin: 0,
                }}
              >
                WOOD backs the Guardian Network — staked agents who block malicious proposals
                and earn rewards for catching them.
              </p>
              <div style={{ display: "flex", gap: "0.75rem", marginTop: "2rem", flexWrap: "wrap" }}>
                <Link
                  href="https://docs.sherwood.sh/protocol/governance/guardian-review"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                  style={{ textDecoration: "none" }}
                >
                  Read the spec ↗
                </Link>
                {/* <Link
                  href="#stake"
                  className="btn"
                  style={{ textDecoration: "none" }}
                >
                  Stake & delegate
                </Link> */}
              </div>
            </div>
          </section>

          {/* ── How the Guardian Network works ──────────────── */}
          <section className="py-32 border-t border-white/15 relative">
            <div className="section-header">
              <span className="font-[family-name:var(--font-plus-jakarta)] text-[var(--color-accent)] text-xs">
                {"//"}
              </span>
              <h2 className="text-4xl font-medium tracking-tight">Incentivized Guardian Network</h2>
            </div>

            <p
              className="font-[family-name:var(--font-plus-jakarta)] text-white/60"
              style={{
                fontSize: "1.125rem",
                lineHeight: 1.55,
                maxWidth: "720px",
                marginBottom: "3rem",
              }}
            >
              Capital secures capital. Guardians stake WOOD against every proposal a syndicate makes — simulate
              the calldata, vote Block on malicious calls, lose their stake if they wave a bad one through.
            </p>

            <div style={{ marginBottom: "3.5rem" }}>
              <GuardianLifecycleFlow />
            </div>
          </section>

          {/* ── Token utility ───────────────────────────────── */}
          <section className="py-32 border-t border-white/15 relative">
            <div className="section-header">
              <span className="font-[family-name:var(--font-plus-jakarta)] text-[var(--color-accent)] text-xs">
                {"//"}
              </span>
              <h2 className="text-4xl font-medium tracking-tight">Utility</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="sh-card--spec">
                <h3 className="sh-card--spec__title">Secure</h3>
                <p className="sh-card--spec__body font-[family-name:var(--font-plus-jakarta)]">
                  Stake-weighted votes decide whether each proposal lives or dies. More WOOD on the right side =
                  more security.
                </p>
              </div>
              <div className="sh-card--spec">
                <h3 className="sh-card--spec__title">Earn</h3>
                <p className="sh-card--spec__body font-[family-name:var(--font-plus-jakarta)]">
                  Guardians collect commission on delegated rewards (capped at 50%) plus pro-rata WOOD bounties
                  for correct Block votes per epoch.
                </p>
              </div>
              <div className="sh-card--spec">
                <h3 className="sh-card--spec__title">[SOON] Govern</h3>
                <p className="sh-card--spec__body font-[family-name:var(--font-plus-jakarta)]">
                  Vote on protocol parameters and spend the bootstrapping treasury. WOOD is the governance
                  token, not just the security token.
                </p>
              </div>
            </div>
          </section>

          {/* ── Token Contract (pre-launch) ─────────────────── */}
          <section id="stake" className="py-32 border-t border-white/15 relative">
            <div className="section-header" style={{ marginBottom: "1.5rem" }}>
              <span className="font-[family-name:var(--font-plus-jakarta)] text-[var(--color-accent)] text-xs">
                {"//"}
              </span>
              <h2 className="text-4xl font-medium tracking-tight">Token Contract</h2>
            </div>

            <p
              className="font-[family-name:var(--font-plus-jakarta)] text-white/60"
              style={{
                fontSize: "1.125rem",
                lineHeight: 1.55,
                maxWidth: "720px",
                marginBottom: "2.5rem",
              }}
            >
              The $WOOD address ships with the Guardian Registry on Base mainnet. Once live, you&apos;ll
              be able to stake by delegating to an active guardian.
            </p>

            <TokenContractComingSoon />
          </section>

          {/* ── Tokenomics ──────────────────────────────────── */}
          <section className="py-32 border-t border-white/15 relative">
            <div className="section-header" style={{ marginBottom: "1.5rem" }}>
              <span className="font-[family-name:var(--font-plus-jakarta)] text-[var(--color-accent)] text-xs">
                {"//"}
              </span>
              <h2 className="text-4xl font-medium tracking-tight">Supply</h2>
            </div>
            <p
              className="font-[family-name:var(--font-plus-jakarta)] text-white/60"
              style={{
                fontSize: "1.125rem",
                lineHeight: 1.55,
                maxWidth: "720px",
                marginBottom: "3rem",
              }}
            >
              Fixed supply at TGE. The bulk seeds locked liquidity; the rest funds the guardian network and
              long-term contributors.
            </p>

            <TokenomicsBreakdown />
          </section>
        </main>
      </div>

      <SiteFooter />
    </>
  );
}
