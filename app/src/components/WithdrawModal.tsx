"use client";

import { useState, useEffect } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits, type Address } from "viem";
import {
  SYNDICATE_VAULT_ABI,
  getAddresses,
  truncateAddress,
} from "@/lib/contracts";

interface WithdrawModalProps {
  vault: Address;
  vaultName: string;
  redemptionsLocked: boolean;
  paused: boolean;
  assetDecimals: number;
  assetSymbol: string;
  shareBalance: bigint;
  onClose: () => void;
}

type Step = "input" | "redeeming" | "success" | "error";

export default function WithdrawModal({
  vault,
  vaultName,
  redemptionsLocked,
  paused,
  assetDecimals,
  assetSymbol,
  shareBalance,
  onClose,
}: WithdrawModalProps) {
  const { address } = useAccount();
  const addresses = getAddresses();

  const [shares, setShares] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState("");

  // Share decimals = assetDecimals * 2 (due to _decimalsOffset)
  const shareDecimals = assetDecimals * 2;

  // Parse shares input to raw units
  const parsedShares = (() => {
    try {
      if (!shares || parseFloat(shares) <= 0) return 0n;
      // Parse as a decimal number with shareDecimals precision
      const parts = shares.split(".");
      const whole = parts[0] || "0";
      const frac = (parts[1] || "").padEnd(shareDecimals, "0").slice(0, shareDecimals);
      return BigInt(whole) * 10n ** BigInt(shareDecimals) + BigInt(frac);
    } catch {
      return 0n;
    }
  })();

  // Preview: convert shares to assets
  const { data: previewAssets } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "convertToAssets",
    args: parsedShares > 0n ? [parsedShares] : undefined,
    query: { enabled: parsedShares > 0n },
  });

  // Redeem tx
  const {
    writeContract: redeem,
    data: redeemHash,
    isPending: isRedeemPending,
  } = useWriteContract();

  const { isSuccess: isRedeemConfirmed } = useWaitForTransactionReceipt({
    hash: redeemHash,
  });

  const canRedeem =
    !paused &&
    !redemptionsLocked &&
    parsedShares > 0n &&
    parsedShares <= shareBalance;

  // Handle redeem confirmation
  useEffect(() => {
    if (isRedeemConfirmed && step === "redeeming") {
      setStep("success");
    }
  }, [isRedeemConfirmed, step]);

  function handleRedeem() {
    if (!address) return;
    setStep("redeeming");
    redeem(
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "redeem",
        args: [parsedShares, address, address],
      },
      {
        onError: (err) => {
          const msg = (err as any).shortMessage || "Transaction was rejected or reverted.";
          setErrorMsg(msg);
          setStep("error");
        },
      },
    );
  }

  const sharesFormatted = parseFloat(formatUnits(shareBalance, shareDecimals)).toLocaleString();
  const previewFormatted = previewAssets
    ? parseFloat(formatUnits(previewAssets, assetDecimals)).toLocaleString()
    : "0";

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
              Redeemed {shares} shares
            </div>
            {redeemHash && (
              <a
                href={`${addresses.blockExplorer}/tx/${redeemHash}`}
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
                color: "rgba(255,255,255,0.3)",
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
            {/* Share balance */}
            <div
              className="flex justify-between font-[family-name:var(--font-plus-jakarta)]"
              style={{
                fontSize: "11px",
                color: "rgba(255,255,255,0.5)",
                marginBottom: "0.5rem",
              }}
            >
              <span>Your Shares</span>
              <span>{sharesFormatted}</span>
            </div>

            {/* Shares input */}
            <div className="deposit-input-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={shares}
                onChange={(e) => {
                  let val = e.target.value.replace(/[^0-9.]/g, "");
                  const parts = val.split(".");
                  if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                  setShares(val);
                }}
                className="deposit-input"
                disabled={step !== "input"}
              />
              <button
                className="btn-follow"
                style={{ fontSize: "9px", padding: "0.3rem 0.6rem" }}
                onClick={() =>
                  setShares(formatUnits(shareBalance, shareDecimals))
                }
              >
                MAX
              </button>
            </div>

            {/* Preview output */}
            {parsedShares > 0n && (
              <div
                className="font-[family-name:var(--font-plus-jakarta)]"
                style={{
                  fontSize: "11px",
                  color: "rgba(255,255,255,0.5)",
                  marginTop: "0.75rem",
                }}
              >
                You will receive ~{previewFormatted} {assetSymbol}
              </div>
            )}

            {/* Action button */}
            <div style={{ marginTop: "1.5rem" }}>
              <button
                className="btn-action"
                style={{ width: "100%" }}
                onClick={handleRedeem}
                disabled={!canRedeem || isRedeemPending || step === "redeeming"}
              >
                {step === "redeeming"
                  ? "Redeeming..."
                  : `Redeem ${shares || "0"} Shares`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
