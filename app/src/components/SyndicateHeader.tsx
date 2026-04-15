"use client";

import { useState } from "react";
import Link from "next/link";
import { type Address } from "viem";
import { truncateAddress, CHAIN_BADGES } from "@/lib/contracts";
import WalletButton from "@/components/WalletButton";
import ShareButton from "@/components/ShareButton";

export type TabId = "vault" | "proposals" | "agents";

interface SyndicateHeaderProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  creatorName?: string;
  paused: boolean;
  chainId: number;
  activeTab: TabId;
  hideAgentsTab?: boolean;
}

function InlineCopy({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const ariaLabel = copied
    ? `Copied ${label ?? value}`
    : `Copy ${label ?? value} to clipboard`;

  return (
    <button
      onClick={handleCopy}
      aria-label={ariaLabel}
      type="button"
      style={{
        background: "none",
        border: "none",
        // 0.4 → 0.6 for WCAG AA; copied state keeps accent color.
        color: copied ? "var(--color-accent, #4ade80)" : "rgba(255,255,255,0.6)",
        cursor: "pointer",
        // Larger tap target — 28x28 is still compact in the metadata row
        // but far above the previous 18px.
        padding: "6px",
        fontSize: "13px",
        lineHeight: 1,
        transition: "color 0.15s",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      title={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

export default function SyndicateHeader({
  name,
  subdomain,
  vault,
  creator,
  creatorName,
  paused,
  chainId,
  activeTab,
  hideAgentsTab,
}: SyndicateHeaderProps) {
  const badge = CHAIN_BADGES[chainId] || CHAIN_BADGES[8453];

  return (
    <div className="agent-header" style={{ flexDirection: "column", alignItems: "stretch", gap: "1rem" }}>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <span className="section-num">
            {"//"} {subdomain.toUpperCase().replace(/[^A-Z0-9]/g, "_")}
          </span>
          <h1 className="text-3xl sm:text-5xl font-medium tracking-tight text-white font-[family-name:var(--font-inter)]">
            {name}{" "}
            <span
              className={`tag-bracket align-middle ml-4 ${paused ? "" : ""}`}
              style={paused ? { color: "#ff4d4d" } : { color: badge.color }}
            >
              {paused ? "Paused" : badge.label}
            </span>
          </h1>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
          <WalletButton />
          {/* Share button — pre-fills a tweet linking to the syndicate.
              The dynamic OG image renders TVL + agents inline. */}
          <ShareButton
            path={`/syndicate/${subdomain}`}
            text={`${name} on Sherwood — agent-managed syndicate on ${subdomain}.sherwoodagent.eth`}
          />
        </div>
      </div>

      <div
        className="text-sm flex flex-wrap items-center gap-x-6 gap-y-2"
        style={{ color: "rgba(255,255,255,0.45)" }}
      >
        <span style={{ color: "var(--color-accent)", fontFamily: "var(--font-jetbrains-mono)", fontSize: "12px", letterSpacing: "0.05em" }}>
          {subdomain}.sherwoodagent.eth
        </span>
        <span className="flex items-center gap-1.5" style={{ fontFamily: "var(--font-jetbrains-mono)", fontSize: "11px", letterSpacing: "0.05em" }}>
          <span style={{ opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.18em" }}>Vault</span>
          <span style={{ color: "rgba(255,255,255,0.85)" }}>{truncateAddress(vault)}</span>
          <InlineCopy value={vault} label="vault address" />
        </span>
        <span className="flex items-center gap-1.5" style={{ fontFamily: "var(--font-jetbrains-mono)", fontSize: "11px", letterSpacing: "0.05em" }}>
          <span style={{ opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.18em" }}>Creator</span>
          <span style={{ color: "rgba(255,255,255,0.85)" }}>{creatorName || truncateAddress(creator)}</span>
          <InlineCopy value={creator} label="creator address" />
        </span>
      </div>

      {/* Tab Navigation — uses the unified .sh-tabs system. Preserve
          the legacy header layout (no bottom margin, small top margin)
          via inline styles so the existing visual rhythm is unchanged. */}
      <nav
        className="sh-tabs"
        style={{ marginTop: "0.5rem", marginBottom: 0 }}
      >
        <Link
          href={`/syndicate/${subdomain}`}
          className="sh-tab"
          aria-current={activeTab === "vault" ? "page" : undefined}
        >
          Vault
        </Link>
        <Link
          href={`/syndicate/${subdomain}/proposals`}
          className="sh-tab"
          aria-current={activeTab === "proposals" ? "page" : undefined}
        >
          Proposals
        </Link>
        {!hideAgentsTab && (
          <Link
            href={`/syndicate/${subdomain}/agents`}
            className="sh-tab"
            aria-current={activeTab === "agents" ? "page" : undefined}
          >
            Agents
          </Link>
        )}
      </nav>
    </div>
  );
}
