// Umami Cloud analytics helpers
// All functions are safe to call even if Umami is not loaded (e.g. local dev, SSR)

export function track(eventName: string, data?: Record<string, string | number>) {
  if (typeof window === "undefined") return;
  window.umami?.track(eventName, data);
}

export function trackWalletConnect(chainId: number) {
  track("wallet_connect", { chainId });
}

export function trackVaultView(vaultAddress: string) {
  track("vault_view", { vaultAddress });
}

export function trackStrategyPropose(vaultAddress: string, strategyType: string) {
  track("strategy_propose", { vaultAddress, strategyType });
}

export function trackDeposit(vaultAddress: string, amount: string) {
  track("deposit", { vaultAddress, amount });
}

export function trackWithdraw(vaultAddress: string, amount: string) {
  track("withdraw", { vaultAddress, amount });
}

export function trackVote(proposalId: string, support: number) {
  track("vote", { proposalId, support });
}

// ── Web3 outcome telemetry ───────────────────────────────
// These complement the optimistic events above with confirmed/failed states
// so we can build a real funnel (initiated → submitted → mined → reverted /
// rejected). All take a `vault` so we can group by syndicate downstream.

export type TxKind = "deposit" | "withdraw" | "vote" | "approve" | "settle";
export type TxFailureReason =
  | "user_rejected"
  | "insufficient_funds"
  | "nonce"
  | "execution_reverted"
  | "rpc_error"
  | "unknown";

export function classifyError(err: unknown): TxFailureReason {
  const msg = String((err as Error)?.message || "").toLowerCase();
  if (msg.includes("user rejected") || msg.includes("user denied")) return "user_rejected";
  if (msg.includes("insufficient funds") || msg.includes("transfer amount exceeds balance"))
    return "insufficient_funds";
  if (msg.includes("nonce")) return "nonce";
  if (msg.includes("execution reverted") || msg.includes("revert")) return "execution_reverted";
  if (msg.includes("network") || msg.includes("rpc") || msg.includes("timeout"))
    return "rpc_error";
  return "unknown";
}

export function trackTxSubmitted(kind: TxKind, vault: string, hash: string) {
  track(`tx_submitted_${kind}`, { vault, hash });
}

export function trackTxConfirmed(kind: TxKind, vault: string, hash: string) {
  track(`tx_confirmed_${kind}`, { vault, hash });
}

export function trackTxFailed(kind: TxKind, vault: string, reason: TxFailureReason) {
  track(`tx_failed_${kind}`, { vault, reason });
}

export function trackChainSwitchRequired(currentChain: number, expectedChain: number) {
  track("chain_switch_required", { currentChain, expectedChain });
}

export function trackRpcSlow(chainId: number, latencyMs: number) {
  track("rpc_slow", { chainId, latencyMs });
}
