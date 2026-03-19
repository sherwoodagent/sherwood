"use client";

import Link from "next/link";
import { type Address } from "viem";
import { truncateAddress } from "@/lib/contracts";
import WalletButton from "@/components/WalletButton";

export type TabId = "vault" | "proposals";

interface SyndicateHeaderProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  paused: boolean;
  activeTab: TabId;
}

function InlineCopy({ value }: { value: string }) {
  return (
    <button
      onClick={() => navigator.clipboard.writeText(value)}
      style={{
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.3)",
        cursor: "pointer",
        padding: 0,
        fontSize: "10px",
      }}
      title="Copy"
    >
      [c]
    </button>
  );
}

export default function SyndicateHeader({
  name,
  subdomain,
  vault,
  creator,
  paused,
  activeTab,
}: SyndicateHeaderProps) {
  return (
    <div className="agent-header" style={{ flexDirection: "column", alignItems: "stretch", gap: "1rem" }}>
      <div className="flex justify-between items-end">
        <div>
          <span className="section-num">
            // SYNDICATE_{subdomain.toUpperCase().replace(/[^A-Z0-9]/g, "_")}
          </span>
          <h1 className="text-5xl font-medium tracking-tight text-white font-[family-name:var(--font-inter)]">
            {name}{" "}
            <span
              className="glitch-tag text-[11px] px-2.5 py-1 align-middle ml-4"
              style={
                paused
                  ? { background: "rgba(255,77,77,0.2)", color: "#ff4d4d" }
                  : undefined
              }
            >
              {paused ? "PAUSED" : "ACTIVE"}
            </span>
          </h1>
        </div>
        <WalletButton />
      </div>

      <div
        className="font-[family-name:var(--font-jetbrains-mono)] text-xs flex items-center gap-6"
        style={{ color: "rgba(255,255,255,0.4)" }}
      >
        <span style={{ color: "var(--color-accent)" }}>
          {subdomain}.sherwoodagent.eth
        </span>
        <span className="flex items-center gap-1">
          Vault: {truncateAddress(vault)} <InlineCopy value={vault} />
        </span>
        <span className="flex items-center gap-1">
          Creator: {truncateAddress(creator)} <InlineCopy value={creator} />
        </span>
      </div>

      {/* Tab Navigation */}
      <nav className="syndicate-tabs">
        <Link
          href={`/syndicate/${subdomain}`}
          className={`syndicate-tab ${activeTab === "vault" ? "syndicate-tab-active" : ""}`}
        >
          Vault
        </Link>
        <Link
          href={`/syndicate/${subdomain}/proposals`}
          className={`syndicate-tab ${activeTab === "proposals" ? "syndicate-tab-active" : ""}`}
        >
          Proposals
        </Link>
      </nav>
    </div>
  );
}
