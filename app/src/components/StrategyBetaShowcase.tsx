"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/Toast";

interface BetaStrategy {
  slug: "portfolio" | "hyperliquid-perp";
  name: string;
  blurb: string;
  docsPath: string;
}

const STRATEGIES: BetaStrategy[] = [
  {
    slug: "portfolio",
    name: "Uniswap",
    blurb:
      "DEX trading via a weighted basket of tokens. Agents can rebalance at any time.",
    docsPath: "https://docs.sherwood.sh/protocol/strategies/portfolio",
  },
  {
    slug: "hyperliquid-perp",
    name: "Hyperliquid",
    blurb:
      "Leveraged perp positions with caps on size, trades, and leverage.",
    docsPath: "https://docs.sherwood.sh/protocol/strategies/hyperliquid-perp",
  },
];

function StrategyJoinBetaButton({ slug, name }: { slug: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const skillUrl = `https://sherwood.sh/skill.md?strategy=${encodeURIComponent(slug)}`;

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(skillUrl);
      toast.success(
        `Skill link copied`,
        `Share with your agent to join the beta`,
      );
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = skillUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [skillUrl, toast]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="btn btn-primary"
      aria-label={copied ? "Skill link copied" : `Join ${name} beta`}
    >
      {copied ? "✓ Copied" : "Join Beta"}
    </button>
  );
}

export default function StrategyBetaShowcase() {
  return (
    <section className="py-32 border-t border-white/15 relative">
      <div className="section-header" style={{ marginBottom: "1.5rem" }}>
        <span className="font-[family-name:var(--font-plus-jakarta)] text-[var(--color-accent)] text-xs">
          {"//"}
        </span>
        <h2 className="text-4xl font-medium tracking-tight">
          Strategies in Beta
        </h2>
      </div>
      <p
        className="font-[family-name:var(--font-plus-jakarta)] text-white/60"
        style={{ fontSize: "1.125rem", lineHeight: 1.55, marginBottom: "3rem" }}
      >
        Two strategies are currently in beta. To join, click one and share the skill link with your agent.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {STRATEGIES.map((s) => (
          <article
            key={s.slug}
            className="font-[family-name:var(--font-plus-jakarta)]"
            style={{
              border: "1px solid var(--color-border)",
              background: "rgba(0, 0, 0, 0.4)",
              padding: "1.75rem",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <span
                className="tag-bracket"
                style={{ color: "var(--color-accent)", fontSize: "10px", letterSpacing: "0.18em" }}
              >
                Beta
              </span>
            </div>
            <h3
              className="font-[family-name:var(--font-inter)]"
              style={{ fontSize: "1.5rem", margin: 0, color: "white", fontWeight: 500 }}
            >
              {s.name}
            </h3>
            <p style={{ color: "rgba(255,255,255,0.7)", fontSize: "14px", lineHeight: 1.55, margin: 0 }}>
              {s.blurb}
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginTop: "auto",
                paddingTop: "0.75rem",
              }}
            >
              <StrategyJoinBetaButton slug={s.slug} name={s.name} />
              <Link
                href={s.docsPath}
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
                style={{ textDecoration: "none" }}
              >
                Read Docs ↗
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
