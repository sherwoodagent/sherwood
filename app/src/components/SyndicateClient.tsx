"use client";

import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import SyndicateHeader, { type TabId } from "./SyndicateHeader";
import { SYNDICATE_VAULT_ABI, formatAsset, shareDecimals } from "@/lib/contracts";

interface SyndicateClientProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  creatorName?: string;
  paused: boolean;
  chainId: number;
  assetDecimals: number;
  assetSymbol: string;
  activeTab?: TabId;
  hideAgentsTab?: boolean;
  /** Effective TVL from server data, including deployed capital during
   *  active strategies. Passed through so "Your Value" matches "TVL". */
  effectiveTotalAssets?: bigint;
  totalSupply?: bigint;
}

export default function SyndicateClient({
  name,
  subdomain,
  vault,
  creator,
  creatorName,
  paused,
  chainId,
  assetDecimals,
  assetSymbol,
  activeTab = "vault",
  hideAgentsTab,
  effectiveTotalAssets,
  totalSupply,
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

  // Compute user's asset value.
  // Prefer client-side math against the server's effective TVL so we capture
  // deployed capital during active strategies. Falls back to the vault's
  // convertToAssets when the server didn't pass totals (shouldn't happen on
  // the vault page, but safe default for other tabs).
  const canComputeLocally =
    typeof effectiveTotalAssets === "bigint" &&
    typeof totalSupply === "bigint" &&
    totalSupply > 0n &&
    !!userShares &&
    userShares > 0n;

  const computedUserAssets = canComputeLocally
    ? (userShares * effectiveTotalAssets!) / totalSupply!
    : undefined;

  const { data: fallbackUserAssets } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "convertToAssets",
    args: userShares ? [userShares] : undefined,
    query: { enabled: !canComputeLocally && !!userShares && userShares > 0n },
  });

  const userAssets = computedUserAssets ?? fallbackUserAssets;

  const isUSD = assetSymbol === "USDC" || assetSymbol === "USDT";

  return (
    <>
      <SyndicateHeader
        name={name}
        subdomain={subdomain}
        vault={vault}
        creator={creator}
        creatorName={creatorName}
        paused={paused}
        chainId={chainId}
        activeTab={activeTab}
        hideAgentsTab={hideAgentsTab}
      />

      {/* User position — only shown on vault tab when connected and has shares */}
      {activeTab === "vault" && isConnected && !!userShares && userShares > 0n && (
        <div className="stats-bar" style={{ marginTop: "1rem" }}>
          <div className="stat-item">
            <div className="stat-label">Your Shares</div>
            <div className="stat-value">
              {parseFloat(formatUnits(userShares, shareDecimals(assetDecimals))).toLocaleString()}
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Your Value</div>
            <div className="stat-value" style={{ color: "var(--color-accent)" }}>
              {userAssets
                ? isUSD
                  ? formatAsset(userAssets, assetDecimals, "USD")
                  : `${formatAsset(userAssets, assetDecimals)} ${assetSymbol}`
                : "—"}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
