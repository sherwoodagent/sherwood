"use client";

import { useRef, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { ConnectWallet, Wallet } from "@coinbase/onchainkit/wallet";
import SyndicateHeader from "./SyndicateHeader";
import DepositModal from "./DepositModal";
import { SYNDICATE_VAULT_ABI, formatUSDC } from "@/lib/contracts";

interface SyndicateClientProps {
  name: string;
  subdomain: string;
  vault: Address;
  creator: Address;
  paused: boolean;
  openDeposits: boolean;
}

export default function SyndicateClient({
  name,
  subdomain,
  vault,
  creator,
  paused,
  openDeposits,
}: SyndicateClientProps) {
  const { address, isConnected } = useAccount();
  const [showDeposit, setShowDeposit] = useState(false);
  const connectRef = useRef<HTMLDivElement>(null);

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

  function handleDeposit() {
    if (!isConnected) {
      // Click the hidden ConnectWallet to trigger the OnchainKit modal
      const btn = connectRef.current?.querySelector("button");
      btn?.click();
      return;
    }
    setShowDeposit(true);
  }

  return (
    <>
      {/* Hidden ConnectWallet — triggers OnchainKit modal when clicked */}
      <div ref={connectRef} className="hidden-connect-trigger">
        <Wallet>
          <ConnectWallet />
        </Wallet>
      </div>

      <SyndicateHeader
        name={name}
        subdomain={subdomain}
        vault={vault}
        creator={creator}
        paused={paused}
        onDeposit={handleDeposit}
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

      {showDeposit && (
        <DepositModal
          vault={vault}
          vaultName={name}
          openDeposits={openDeposits}
          paused={paused}
          onClose={() => setShowDeposit(false)}
        />
      )}
    </>
  );
}
