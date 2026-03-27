"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { SYNDICATE_VAULT_ABI } from "@/lib/contracts";
import DepositModal from "./DepositModal";

interface DepositButtonProps {
  vault: Address;
  vaultName: string;
  openDeposits: boolean;
  paused: boolean;
  assetAddress: Address;
  assetDecimals: number;
  assetSymbol: string;
}

export default function DepositButton({
  vault,
  vaultName,
  openDeposits,
  paused,
  assetAddress,
  assetDecimals,
  assetSymbol,
}: DepositButtonProps) {
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [showDeposit, setShowDeposit] = useState(false);

  // Check depositor approval for whitelist vaults
  const { data: isApproved } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "isApprovedDepositor",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !openDeposits },
  });

  // Not connected — prompt to connect
  if (!isConnected) {
    return (
      <button
        className="btn-action"
        onClick={() => openConnectModal?.()}
      >
        [ CONNECT WALLET ]
      </button>
    );
  }

  // Vault paused
  if (paused) {
    return (
      <div style={{ position: "relative" }}>
        <button className="btn-action" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
          [ DEPOSITS PAUSED ]
        </button>
        <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.35)", marginTop: "4px", textAlign: "center" }}>
          Vault is temporarily paused
        </div>
      </div>
    );
  }

  // Whitelist vault — not approved
  if (!openDeposits && isApproved === false) {
    return (
      <div style={{ position: "relative" }}>
        <button className="btn-action" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
          [ APPROVAL REQUIRED ]
        </button>
        <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.35)", marginTop: "4px", textAlign: "center" }}>
          Vault requires depositor approval
        </div>
      </div>
    );
  }

  return (
    <>
      <button className="btn-action" onClick={() => setShowDeposit(true)}>
        [ DEPOSIT ]
      </button>
      {showDeposit && (
        <DepositModal
          vault={vault}
          vaultName={vaultName}
          openDeposits={openDeposits}
          paused={paused}
          assetAddress={assetAddress}
          assetDecimals={assetDecimals}
          assetSymbol={assetSymbol}
          onClose={() => setShowDeposit(false)}
        />
      )}
    </>
  );
}
