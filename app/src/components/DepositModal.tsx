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
  truncateAddress,
} from "@/lib/contracts";

interface DepositModalProps {
  vault: Address;
  vaultName: string;
  openDeposits: boolean;
  paused: boolean;
  onClose: () => void;
}

type Step = "input" | "approving" | "depositing" | "success" | "error";

export default function DepositModal({
  vault,
  vaultName,
  openDeposits,
  paused,
  onClose,
}: DepositModalProps) {
  const { address } = useAccount();
  const addresses = getAddresses();
  const usdc = addresses.usdc;

  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorMsg, setErrorMsg] = useState("");

  // Read USDC balance
  const { data: usdcBalance } = useReadContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Read current allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdc,
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
      return parseUnits(amount, 6);
    } catch {
      return 0n;
    }
  })();

  const needsApproval =
    parsedAmount > 0n && (allowance ?? 0n) < parsedAmount;

  const canDeposit =
    !paused &&
    (openDeposits || isApproved === true) &&
    parsedAmount > 0n &&
    parsedAmount <= (usdcBalance ?? 0n);

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
    }
  }, [isDepositConfirmed, step]);

  function handleApprove() {
    if (!address) return;
    setStep("approving");
    approve(
      {
        address: usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, parsedAmount],
      },
      {
        onError: (err) => {
          setErrorMsg(err.message);
          setStep("error");
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
        onError: (err) => {
          setErrorMsg(err.message);
          setStep("error");
        },
      },
    );
  }

  const balanceFormatted = usdcBalance
    ? formatUnits(usdcBalance, 6)
    : "0";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          <span>Deposit USDC</span>
          <button
            onClick={onClose}
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
              Deposited {amount} USDC
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
                fontSize: "10px",
                color: "rgba(255,255,255,0.4)",
                maxHeight: "100px",
                overflow: "auto",
                wordBreak: "break-all",
              }}
            >
              {errorMsg}
            </div>
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
              <span>Your USDC Balance</span>
              <span>{parseFloat(balanceFormatted).toLocaleString()} USDC</span>
            </div>

            {/* Amount input */}
            <div className="deposit-input-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9.]/g, "");
                  setAmount(val);
                }}
                className="deposit-input"
                disabled={step !== "input"}
              />
              <button
                className="btn-follow"
                style={{ fontSize: "9px", padding: "0.3rem 0.6rem" }}
                onClick={() => setAmount(balanceFormatted)}
              >
                MAX
              </button>
            </div>

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
                    : `Approve ${amount || "0"} USDC`}
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
                    : `Deposit ${amount || "0"} USDC`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
