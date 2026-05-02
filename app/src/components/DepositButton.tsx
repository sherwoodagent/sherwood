"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, type Address } from "viem";
import { ERC20_ABI, SYNDICATE_VAULT_ABI, ISTRATEGY_ABI } from "@/lib/contracts";
import DepositModal from "./DepositModal";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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

  // Live NAV gate — when a strategy proposal is active, the vault now
  // accepts deposits if the bound adapter reports `valid=true` from
  // positionValue() (per CLAUDE.md "Live NAV via strategy adapter").
  // We must mirror that gate in the UI so previewDeposit pricing matches
  // what the contract will actually mint.
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

  // Active strategy WITHOUT live NAV — must block deposits.
  //
  // When a strategy adapter is bound and reports `valid=true` from
  // positionValue(), the vault knows the deployed capital's current
  // worth and prices shares correctly via totalAssets() = float +
  // adapter.positionValue(). Both the vault's deposit() and the
  // previewDeposit() preview the user sees stay sound.
  //
  // Without that signal (legacy templates, perp / off-chain strategies,
  // or a clone that pre-dates positionValue()) totalAssets() is just
  // the float — drained near zero by execute() — while totalSupply
  // still reflects all outstanding shares. previewDeposit then mints
  // far more shares than the depositor is paying for, and the vault
  // reverts at submit time. Keep the UI guard for that case.
  if (redemptionsLocked && !liveNAVAvailable) {
    return (
      <div className="btn-disabled-wrap">
        <button
          className="btn-action"
          disabled
          style={{ opacity: 0.4, cursor: "not-allowed" }}
          title="Deposits are blocked while a strategy without live NAV is executing"
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
