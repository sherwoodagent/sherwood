"use client";

import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import SyndicateHeader, { type TabId } from "./SyndicateHeader";
import { SYNDICATE_VAULT_ABI, formatUSDC } from "@/lib/contracts";

interface SyndicateClientProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  paused: boolean;
  activeTab?: TabId;
}

export default function SyndicateClient({
  name,
  subdomain,
  vault,
  creator,
  paused,
  activeTab = "vault",
}: SyndicateClientProps) {
  const { address, isConnected } = useAccount();

  // User's vault shares
  const { data: userShares } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Convert shares to assets
  const { data: userAssets } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "convertToAssets",
    args: userShares ? [userShares] : undefined,
    query: { enabled: !!userShares && userShares > 0n },
  });

  return (
    <>
      <SyndicateHeader
        name={name}
        subdomain={subdomain}
        vault={vault}
        creator={creator}
        paused={paused}
        activeTab={activeTab}
      />

      {/* User position — only shown when connected and has shares */}
      {isConnected && userShares && userShares > 0n && (
        <div className="stats-bar" style={{ marginTop: "1rem" }}>
          <div className="stat-item">
            <div className="stat-label">Your Shares</div>
            <div className="stat-value">
              {parseFloat(formatUnits(userShares, 6)).toLocaleString()}
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Your Value</div>
            <div className="stat-value" style={{ color: "var(--color-accent)" }}>
              {userAssets ? formatUSDC(userAssets) : "—"}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
