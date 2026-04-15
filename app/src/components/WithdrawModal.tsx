"use client";

import { useState, useEffect } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits, parseUnits, type Address } from "viem";
import {
  SYNDICATE_VAULT_ABI,
  getAddresses,
  truncateAddress,
} from "@/lib/contracts";
import { useToast } from "@/components/ui/Toast";
import { GasEstimate } from "@/components/ui/GasEstimate";
import {
  trackTxSubmitted,
  trackTxConfirmed,
  trackTxFailed,
  classifyError,
} from "@/lib/analytics";

interface WithdrawModalProps {
  vault: Address;
  vaultName: string;
  redemptionsLocked: boolean;
  paused: boolean;
  assetDecimals: number;
  assetSymbol: string;
  shareBalance: bigint;
  /** Chain the vault lives on — used to pick the right block explorer. */
  chainId: number;
  onClose: () => void;
}

type Step = "input" | "withdrawing" | "success" | "error";

export default function WithdrawModal({
  vault,
  vaultName,
  redemptionsLocked,
  paused,
  assetDecimals,
  assetSymbol,
  shareBalance,
  chainId,
  onClose,
}: WithdrawModalProps) {
  const { address } = useAccount();
  // Use the vault's chain so explorer links resolve to the right scanner.
  const addresses = getAddresses(chainId);
  const toast = useToast();

  const [amount, setAmount] = useState("");
  const [isMax, setIsMax] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState("");

  // Parse asset amount to raw units
  const parsedAmount = (() => {
    try {
      if (!amount || parseFloat(amount) <= 0) return 0n;
      return parseUnits(amount, assetDecimals);
    } catch {
      return 0n;
    }
  })();

  // Convert share balance to asset value for display/validation
  const { data: maxAssets } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "convertToAssets",
    args: shareBalance > 0n ? [shareBalance] : undefined,
    query: { enabled: shareBalance > 0n },
  });

  // Withdraw tx
  const {
    writeContract: doWithdraw,
    data: withdrawHash,
    isPending: isWithdrawPending,
  } = useWriteContract();

  const { isSuccess: isWithdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawHash,
  });

  const maxAssetsValue = maxAssets ?? 0n;
  const canWithdraw =
    !paused &&
    !redemptionsLocked &&
    (isMax ? shareBalance > 0n : parsedAmount > 0n && parsedAmount <= maxAssetsValue);

  // Handle withdraw confirmation
  useEffect(() => {
    if (isWithdrawConfirmed && step === "withdrawing") {
      setStep("success");
      if (withdrawHash) trackTxConfirmed("withdraw", vault, withdrawHash);
      toast.success(
        "Withdrawal confirmed",
        `Your ${assetSymbol} is back in your wallet.`,
      );
    }
  }, [isWithdrawConfirmed, step, toast, assetSymbol, withdrawHash, vault]);

  function handleWithdraw() {
    if (!address) return;
    setStep("withdrawing");

    if (isMax) {
      // Use redeem(shares) for MAX to avoid rounding revert
      doWithdraw(
        {
          address: vault,
          abi: SYNDICATE_VAULT_ABI,
          functionName: "redeem",
          args: [shareBalance, address, address],
        },
        {
          onSuccess: (hash) => trackTxSubmitted("withdraw", vault, hash),
          onError: (err) => {
            const msg = (err as { shortMessage?: string }).shortMessage || "Transaction was rejected or reverted.";
            setErrorMsg(msg);
            setStep("error");
            trackTxFailed("withdraw", vault, classifyError(err));
          },
        },
      );
    } else {
      // Use withdraw(assets) for specific amounts
      doWithdraw(
        {
          address: vault,
          abi: SYNDICATE_VAULT_ABI,
          functionName: "withdraw",
          args: [parsedAmount, address, address],
        },
        {
          onSuccess: (hash) => trackTxSubmitted("withdraw", vault, hash),
          onError: (err) => {
            const msg = (err as { shortMessage?: string }).shortMessage || "Transaction was rejected or reverted.";
            setErrorMsg(msg);
            setStep("error");
            trackTxFailed("withdraw", vault, classifyError(err));
          },
        },
      );
    }
  }

  const displayDecimals = Math.min(assetDecimals, 6);
  const maxFormatted = maxAssets
    ? parseFloat(formatUnits(maxAssets, assetDecimals)).toFixed(displayDecimals)
    : "0";

  // Truncate display amount to 6 decimals
  function truncateDisplay(val: string): string {
    if (!val) return "0";
    const dot = val.indexOf(".");
    if (dot < 0) return val;
    return val.slice(0, dot + displayDecimals + 1);
  }

  // Close modal on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-modal-title"
      onClick={onClose}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          <span id="withdraw-modal-title">Withdraw {assetSymbol}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.4)",
              cursor: "pointer",
              fontSize: "16px",
            }}
          >
            x
          </button>
        </div>

        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{
            fontSize: "10px",
            color: "rgba(255,255,255,0.4)",
            marginBottom: "1.5rem",
          }}
        >
          {vaultName} &middot; {truncateAddress(vault)}
        </div>

        {redemptionsLocked && (
          <div className="modal-warning">
            Redemptions are locked while a strategy is active
          </div>
        )}

        {paused && (
          <div className="modal-warning">Vault is paused — withdrawals disabled</div>
        )}

        {step === "success" ? (
          <div style={{ textAlign: "center", padding: "2rem 0" }}>
            <div
              className="font-[family-name:var(--font-plus-jakarta)] text-lg"
              style={{ color: "var(--color-accent)", marginBottom: "1rem" }}
            >
              Withdrew {isMax ? maxFormatted : truncateDisplay(amount)} {assetSymbol}
            </div>
            {withdrawHash && (
              <a
                href={`${addresses.blockExplorer}/tx/${withdrawHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="attestation-link"
                style={{ fontSize: "12px" }}
              >
                View transaction
              </a>
            )}
          </div>
        ) : step === "error" ? (
          <div style={{ textAlign: "center", padding: "2rem 0" }}>
            <div
              className="font-[family-name:var(--font-plus-jakarta)] text-sm"
              style={{ color: "#ff4d4d", marginBottom: "1rem" }}
            >
              Transaction failed
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "rgba(255,255,255,0.5)",
                marginBottom: "0.5rem",
              }}
            >
              {errorMsg}
            </div>
            <details
              style={{
                fontSize: "10px",
                color: "rgba(255,255,255,0.55)",
                maxHeight: "100px",
                overflow: "auto",
                wordBreak: "break-all",
              }}
            >
              <summary style={{ cursor: "pointer", marginBottom: "0.25rem" }}>
                Technical details
              </summary>
              {errorMsg}
            </details>
            <button
              className="btn-follow"
              style={{ marginTop: "1rem" }}
              onClick={() => setStep("input")}
            >
              Try Again
            </button>
          </div>
        ) : (
          <>
            {/* Available balance */}
            <div
              className="flex justify-between font-[family-name:var(--font-plus-jakarta)]"
              style={{
                fontSize: "11px",
                color: "rgba(255,255,255,0.5)",
                marginBottom: "0.5rem",
              }}
            >
              <span>Available</span>
              <span>{maxFormatted} {assetSymbol}</span>
            </div>

            {/* Asset amount input */}
            <div className="deposit-input-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => {
                  let val = e.target.value.replace(/[^0-9.]/g, "");
                  const parts = val.split(".");
                  if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                  // Cap decimals to asset precision
                  if (parts.length === 2 && parts[1].length > assetDecimals) {
                    val = parts[0] + "." + parts[1].slice(0, assetDecimals);
                  }
                  setAmount(val);
                  setIsMax(false);
                }}
                className="deposit-input"
                disabled={step !== "input"}
              />
              <span
                className="font-[family-name:var(--font-plus-jakarta)]"
                style={{
                  fontSize: "12px",
                  color: "rgba(255,255,255,0.5)",
                  marginRight: "0.5rem",
                }}
              >
                {assetSymbol}
              </span>
              <button
                className="btn-follow"
                style={{ fontSize: "9px", padding: "0.3rem 0.6rem" }}
                onClick={() => {
                  if (maxAssets) {
                    setAmount(maxFormatted);
                    setIsMax(true);
                  }
                }}
              >
                MAX
              </button>
            </div>

            {/* Action button */}
            <div style={{ marginTop: "1.5rem" }}>
              <button
                className="btn-action"
                style={{ width: "100%" }}
                onClick={handleWithdraw}
                disabled={!canWithdraw || isWithdrawPending || step === "withdrawing"}
              >
                {step === "withdrawing"
                  ? "Withdrawing..."
                  : `Withdraw ${isMax ? "All" : truncateDisplay(amount) || "0"} ${assetSymbol}`}
              </button>

              {/* Pre-flight gas estimate. */}
              {(isMax || parsedAmount > 0n) && step === "input" && address && (
                <GasEstimate
                  address={vault}
                  abi={SYNDICATE_VAULT_ABI}
                  functionName={isMax ? "redeem" : "withdraw"}
                  args={
                    isMax
                      ? [shareBalance, address, address]
                      : [parsedAmount, address, address]
                  }
                  chainId={chainId}
                />
              )}
            </div>

            {/* Pending tx link */}
            {step === "withdrawing" && withdrawHash && (
              <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                <a
                  href={`${addresses.blockExplorer}/tx/${withdrawHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    letterSpacing: "0.1em",
                    color: "var(--color-accent)",
                    textDecoration: "underline",
                  }}
                >
                  View pending transaction ↗
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
