"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, type Address } from "viem";
import { ERC20_ABI, SYNDICATE_VAULT_ABI } from "@/lib/contracts";
import DepositModal from "./DepositModal";

interface DepositButtonProps {
  vault: Address;
  vaultName: string;
  openDeposits: boolean;
  paused: boolean;
  /** Server-rendered snapshot of vault.redemptionsLocked(). Used as an
   *  initial guard; the live read below catches mid-session transitions. */
  redemptionsLocked: boolean;
  assetAddress: Address;
  assetDecimals: number;
  assetSymbol: string;
  chainId: number;
}

export default function DepositButton({
  vault,
  vaultName,
  openDeposits,
  paused,
  redemptionsLocked: initialRedemptionsLocked,
  assetAddress,
  assetDecimals,
  assetSymbol,
  chainId,
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

  // Live redemptions-locked flag — server snapshot is the initial value,
  // wagmi's polling catches the locked → open transition (and vice versa)
  // mid-session so the button reflects current state without a reload.
  const { data: liveRedemptionsLocked } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "redemptionsLocked",
    chainId,
  });
  const redemptionsLocked =
    typeof liveRedemptionsLocked === "boolean"
      ? liveRedemptionsLocked
      : initialRedemptionsLocked;

  // Pre-flight wallet balance — disable the button if the user holds none of
  // the deposit asset, with a clear inline reason. Avoids opening the modal
  // just to discover "insufficient funds".
  const { data: assetBalance } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const hasBalance = (assetBalance ?? 0n) > 0n;
  const balanceDisplay = assetBalance
    ? parseFloat(formatUnits(assetBalance, assetDecimals)).toLocaleString(undefined, {
        maximumFractionDigits: assetDecimals <= 6 ? 2 : 4,
      })
    : "0";

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
      <div className="btn-disabled-wrap">
        <button className="btn-action" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
          [ DEPOSITS PAUSED ]
        </button>
        <div className="btn-disabled-wrap__sub">
          Vault is temporarily paused
        </div>
      </div>
    );
  }

  // Active strategy — must block deposits.
  //
  // ERC-4626 share math during an active strategy is broken from the
  // depositor's perspective: vault.totalAssets() is drained (capital sits
  // in the strategy contract) but vault.totalSupply() still reflects all
  // outstanding shares. previewDeposit() therefore prices new shares at
  // a near-zero asset/supply ratio and mints far more than the depositor
  // is paying for (e.g. 1 USDC → 150 shares observed onchain).
  //
  // The vault contract should also revert deposit() while
  // redemptionsLocked is true (per CLAUDE.md), but we guard at the UI
  // level too so users never see the inflated previewDeposit number or
  // sign a tx that's going to either revert or mint inflated shares.
  if (redemptionsLocked) {
    return (
      <div className="btn-disabled-wrap">
        <button
          className="btn-action"
          disabled
          style={{ opacity: 0.4, cursor: "not-allowed" }}
          title="Deposits are blocked while a strategy is executing"
        >
          [ DEPOSITS LOCKED ]
        </button>
        <div className="btn-disabled-wrap__sub">
          Active strategy in progress
        </div>
      </div>
    );
  }

  // Whitelist vault — not approved
  if (!openDeposits && isApproved === false) {
    return (
      <div className="btn-disabled-wrap">
        <button className="btn-action" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
          [ APPROVAL REQUIRED ]
        </button>
        <div className="btn-disabled-wrap__sub">
          Vault requires depositor approval
        </div>
      </div>
    );
  }

  // No balance — disable + suggest acquiring the asset.
  if (!hasBalance) {
    return (
      <div className="btn-disabled-wrap">
        <button
          className="btn-action"
          disabled
          style={{ opacity: 0.4, cursor: "not-allowed" }}
          title={`You have no ${assetSymbol} in this wallet`}
        >
          [ NO {assetSymbol.toUpperCase()} ]
        </button>
        <div className="btn-disabled-wrap__sub">
          Acquire {assetSymbol} to deposit
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        className="btn-action"
        onClick={() => setShowDeposit(true)}
        title={`Wallet balance: ${balanceDisplay} ${assetSymbol}`}
      >
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
          chainId={chainId}
          onClose={() => setShowDeposit(false)}
        />
      )}
    </>
  );
}
