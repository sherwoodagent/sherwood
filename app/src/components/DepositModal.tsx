"use client";

import { useState, useEffect } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import {
  ERC20_ABI,
  SYNDICATE_VAULT_ABI,
  getAddresses,
  shareDecimals,
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

interface DepositModalProps {
  vault: Address;
  vaultName: string;
  openDeposits: boolean;
  paused: boolean;
  assetAddress: Address;
  assetDecimals: number;
  assetSymbol: string;
  /** Chain the vault lives on — used to pick the right block explorer. */
  chainId: number;
  onClose: () => void;
}

type Step = "input" | "approving" | "depositing" | "success" | "error";

export default function DepositModal({
  vault,
  vaultName,
  openDeposits,
  paused,
  assetAddress,
  assetDecimals,
  assetSymbol,
  chainId,
  onClose,
}: DepositModalProps) {
  const { address } = useAccount();
  // Use the vault's chain — not the default — so explorer links resolve to
  // basescan / hyperevmscan / etc correctly on multichain syndicates.
  const addresses = getAddresses(chainId);
  const toast = useToast();

  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState("");

  // Read asset balance
  const { data: assetBalance } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Read current allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, vault] : undefined,
    query: { enabled: !!address },
  });

  // Check if depositor is approved (when not open deposits)
  const { data: isApproved } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "isApprovedDepositor",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !openDeposits },
  });

  // Approve tx
  const {
    writeContract: approve,
    data: approveHash,
    isPending: isApprovePending,
  } = useWriteContract();

  const { isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  // Deposit tx
  const {
    writeContract: deposit,
    data: depositHash,
    isPending: isDepositPending,
  } = useWriteContract();

  const { isSuccess: isDepositConfirmed } = useWaitForTransactionReceipt({
    hash: depositHash,
  });

  // Parse amount to raw units
  const parsedAmount = (() => {
    try {
      if (!amount || parseFloat(amount) <= 0) return 0n;
      return parseUnits(amount, assetDecimals);
    } catch {
      return 0n;
    }
  })();

  // Preview how many shares the user will receive at current exchange rate.
  // ERC-4626 previewDeposit accounts for fees and rounding; prefer it over manual calc.
  const { data: expectedSharesData } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "previewDeposit",
    args: parsedAmount > 0n ? [parsedAmount] : undefined,
    query: { enabled: parsedAmount > 0n },
  });
  const expectedShares = typeof expectedSharesData === "bigint" ? expectedSharesData : 0n;

  const needsApproval =
    parsedAmount > 0n && (allowance ?? 0n) < parsedAmount;

  const canDeposit =
    !paused &&
    (openDeposits || isApproved === true) &&
    parsedAmount > 0n &&
    parsedAmount <= (assetBalance ?? 0n);

  // Handle approval confirmation
  useEffect(() => {
    if (isApproveConfirmed && step === "approving") {
      refetchAllowance();
      setStep("input");
    }
  }, [isApproveConfirmed, step, refetchAllowance]);

  // Handle deposit confirmation
  useEffect(() => {
    if (isDepositConfirmed && step === "depositing") {
      setStep("success");
      if (depositHash) trackTxConfirmed("deposit", vault, depositHash);
      toast.success(
        `Deposited ${amount} ${assetSymbol}`,
        expectedShares > 0n
          ? `Received ~${parseFloat(formatUnits(expectedShares, shareDecimals(assetDecimals))).toLocaleString(undefined, { maximumFractionDigits: 2 })} shares`
          : "Your position is live onchain.",
      );
    }
  }, [isDepositConfirmed, step, toast, amount, assetSymbol, expectedShares, assetDecimals, depositHash, vault]);

  function handleApprove() {
    if (!address) return;
    setStep("approving");
    approve(
      {
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, parsedAmount],
      },
      {
        onSuccess: (hash) => trackTxSubmitted("approve", vault, hash),
        onError: (err) => {
          const msg = (err as { shortMessage?: string }).shortMessage || "Transaction was rejected or reverted.";
          setErrorMsg(msg);
          setStep("error");
          trackTxFailed("approve", vault, classifyError(err));
        },
      },
    );
  }

  function handleDeposit() {
    if (!address) return;
    setStep("depositing");
    deposit(
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "deposit",
        args: [parsedAmount, address],
      },
      {
        onSuccess: (hash) => trackTxSubmitted("deposit", vault, hash),
        onError: (err) => {
          const msg = (err as { shortMessage?: string }).shortMessage || "Transaction was rejected or reverted.";
          setErrorMsg(msg);
          setStep("error");
          trackTxFailed("deposit", vault, classifyError(err));
        },
      },
    );
  }

  const balanceFormatted = assetBalance
    ? formatUnits(assetBalance, assetDecimals)
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
      aria-labelledby="deposit-modal-title"
      onClick={onClose}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          <span id="deposit-modal-title">Deposit {assetSymbol}</span>
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

        {paused && (
          <div className="modal-warning">Vault is paused — deposits disabled</div>
        )}

        {!openDeposits && isApproved === false && (
          <div className="modal-warning">
            Your address is not an approved depositor
          </div>
        )}

        {step === "success" ? (
          <div style={{ textAlign: "center", padding: "2rem 0" }}>
            <div
              className="font-[family-name:var(--font-plus-jakarta)] text-lg"
              style={{ color: "var(--color-accent)", marginBottom: "1rem" }}
            >
              Deposited {amount} {assetSymbol}
            </div>
            {depositHash && (
              <a
                href={`${addresses.blockExplorer}/tx/${depositHash}`}
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
            {/* Balance */}
            <div
              className="flex justify-between font-[family-name:var(--font-plus-jakarta)]"
              style={{
                fontSize: "11px",
                color: "rgba(255,255,255,0.5)",
                marginBottom: "0.5rem",
              }}
            >
              <span>Your {assetSymbol} Balance</span>
              <span>{parseFloat(balanceFormatted).toLocaleString()} {assetSymbol}</span>
            </div>

            {/* Inline warnings */}
            {parsedAmount > 0n && parsedAmount > (assetBalance ?? 0n) && (
              <div
                className="font-[family-name:var(--font-plus-jakarta)]"
                style={{ fontSize: "10px", color: "#ff6b6b", marginBottom: "0.5rem" }}
              >
                Insufficient balance — you need {formatUnits(parsedAmount - (assetBalance ?? 0n), assetDecimals)} more {assetSymbol}
              </div>
            )}

            {/* Amount input */}
            <div className="deposit-input-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  let val = e.target.value.replace(/[^0-9.]/g, "");
                  // Prevent multiple decimal points
                  const parts = val.split(".");
                  if (parts.length > 2) val = parts[0] + "." + parts.slice(1).join("");
                  setAmount(val);
                }}
                className="deposit-input"
                disabled={step !== "input"}
                aria-label={`Amount of ${assetSymbol} to deposit`}
              />
              <button
                className="btn-follow"
                style={{ fontSize: "9px", padding: "0.3rem 0.6rem" }}
                onClick={() => setAmount(balanceFormatted)}
              >
                MAX
              </button>
            </div>

            {/* Shares preview */}
            {parsedAmount > 0n && expectedShares > 0n && (
              <div
                className="font-[family-name:var(--font-plus-jakarta)]"
                style={{
                  marginTop: "0.75rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(46, 230, 166, 0.04)",
                  border: "1px solid rgba(46, 230, 166, 0.2)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "12px",
                }}
              >
                <span style={{ color: "rgba(255,255,255,0.6)" }}>You will receive</span>
                <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>
                  ~{parseFloat(formatUnits(expectedShares, shareDecimals(assetDecimals))).toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
                </span>
              </div>
            )}

            {/* Pending tx link */}
            {(step === "approving" || step === "depositing") && (approveHash || depositHash) && (
              <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                <a
                  href={`${addresses.blockExplorer}/tx/${step === "approving" ? approveHash : depositHash}`}
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

            {/* Action button */}
            <div style={{ marginTop: "1.5rem" }}>
              {needsApproval ? (
                <button
                  className="btn-action"
                  style={{ width: "100%" }}
                  onClick={handleApprove}
                  disabled={!canDeposit || isApprovePending || step === "approving"}
                >
                  {step === "approving"
                    ? "Approving..."
                    : `Approve ${amount || "0"} ${assetSymbol}`}
                </button>
              ) : (
                <button
                  className="btn-action"
                  style={{ width: "100%" }}
                  onClick={handleDeposit}
                  disabled={!canDeposit || isDepositPending || step === "depositing"}
                >
                  {step === "depositing"
                    ? "Depositing..."
                    : `Deposit ${amount || "0"} ${assetSymbol}`}
                </button>
              )}

              {/* Pre-flight gas estimate. Re-runs as the amount changes. */}
              {parsedAmount > 0n && step === "input" && address && (
                <GasEstimate
                  address={
                    needsApproval ? assetAddress : vault
                  }
                  abi={needsApproval ? ERC20_ABI : SYNDICATE_VAULT_ABI}
                  functionName={needsApproval ? "approve" : "deposit"}
                  args={
                    needsApproval
                      ? [vault, parsedAmount]
                      : [parsedAmount, address]
                  }
                  chainId={chainId}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
