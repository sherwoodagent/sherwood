"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { SYNDICATE_VAULT_ABI } from "@/lib/contracts";
import WithdrawModal from "./WithdrawModal";

interface WithdrawButtonProps {
  vault: Address;
  vaultName: string;
  assetDecimals: number;
  assetSymbol: string;
  redemptionsLocked: boolean;
  paused: boolean;
  chainId: number;
}

export default function WithdrawButton({
  vault,
  vaultName,
  assetDecimals,
  assetSymbol,
  redemptionsLocked,
  paused,
  chainId,
}: WithdrawButtonProps) {
  const { address, isConnected } = useAccount();
  const [showWithdraw, setShowWithdraw] = useState(false);

  const { data: shareBalance } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  if (!isConnected || !shareBalance || shareBalance === 0n) {
    return null;
  }

  // Pre-flight: surface lock/pause disabled state inline rather than letting
  // users open the modal only to see a warning.
  const blockedReason = paused
    ? { label: "WITHDRAWALS PAUSED", detail: "Vault is temporarily paused" }
    : redemptionsLocked
      ? { label: "REDEMPTIONS LOCKED", detail: "Active strategy in progress" }
      : null;

  if (blockedReason) {
    return (
      <div className="btn-disabled-wrap">
        <button
          className="btn-action-secondary"
          disabled
          style={{ opacity: 0.4, cursor: "not-allowed" }}
          title={blockedReason.detail}
        >
          [ {blockedReason.label} ]
        </button>
        <div className="btn-disabled-wrap__sub">{blockedReason.detail}</div>
      </div>
    );
  }

  return (
    <>
      <button
        className="btn-action-secondary"
        onClick={() => setShowWithdraw(true)}
      >
        [ WITHDRAW ]
      </button>
      {showWithdraw && (
        <WithdrawModal
          vault={vault}
          vaultName={vaultName}
          redemptionsLocked={redemptionsLocked}
          paused={paused}
          assetDecimals={assetDecimals}
          assetSymbol={assetSymbol}
          shareBalance={shareBalance}
          chainId={chainId}
          onClose={() => setShowWithdraw(false)}
        />
      )}
    </>
  );
}
