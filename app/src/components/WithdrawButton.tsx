"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { SYNDICATE_VAULT_ABI, ISTRATEGY_ABI } from "@/lib/contracts";
import WithdrawModal from "./WithdrawModal";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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

  // Live NAV gate — when an adapter is bound and reports valid=true,
  // the vault unlocks immediate _withdraw alongside the queue path. The
  // WithdrawModal handles routing (immediate vs requestRedeem) based on
  // its own redemptionsLocked prop, so we only need this here to decide
  // whether to surface the modal at all.
  const { data: activeAdapter } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "activeStrategyAdapter",
    chainId,
    query: { enabled: redemptionsLocked },
  });
  const adapterAddress =
    typeof activeAdapter === "string" && activeAdapter !== ZERO_ADDRESS
      ? (activeAdapter as Address)
      : undefined;
  const { data: positionData } = useReadContract({
    address: adapterAddress,
    abi: ISTRATEGY_ABI,
    functionName: "positionValue",
    chainId,
    query: { enabled: !!adapterAddress, refetchInterval: 30_000 },
  });
  const liveNAVAvailable = Array.isArray(positionData)
    ? Boolean(positionData[1])
    : false;

  if (!isConnected || !shareBalance || shareBalance === 0n) {
    return null;
  }

  // Pre-flight: surface lock/pause disabled state inline rather than letting
  // users open the modal only to see a warning. With live NAV available the
  // vault accepts immediate withdraws even during an active proposal, so
  // only block on pause in that case.
  const blockedReason = paused
    ? { label: "WITHDRAWALS PAUSED", detail: "Vault is temporarily paused" }
    : redemptionsLocked && !liveNAVAvailable
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
          // Effective lock — when live NAV is available, the vault accepts
          // immediate withdraws even during an active proposal, so the
          // modal's redeem/withdraw path is sound. The queue is still
          // there as a fallback if liveNAV flips invalid mid-flow.
          redemptionsLocked={redemptionsLocked && !liveNAVAvailable}
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
