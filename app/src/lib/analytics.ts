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
