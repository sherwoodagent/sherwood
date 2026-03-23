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
}

export default function WithdrawButton({
  vault,
  vaultName,
  assetDecimals,
  assetSymbol,
  redemptionsLocked,
  paused,
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
          onClose={() => setShowWithdraw(false)}
        />
      )}
    </>
  );
}
