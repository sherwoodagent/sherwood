"use client";

import { type Address } from "viem";
import { truncateAddress } from "@/lib/contracts";

interface SyndicateHeaderProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  paused: boolean;
  onDeposit: () => void;
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
  onDeposit,
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
        <div className="flex gap-3">
          <button className="btn-action" onClick={onDeposit}>
            [ DEPOSIT ]
          </button>
        </div>
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
    </div>
  );
}
