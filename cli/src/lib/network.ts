/**
 * Network state singleton.
 *
 * Called once at CLI startup via the --testnet flag's preAction hook.
 * Every other module reads from here — never hardcodes a chain.
 */

import { base, baseSepolia } from "viem/chains";

export type Network = "base" | "base-sepolia";

let _network: Network = "base";

export function setNetwork(n: Network) {
  _network = n;
}

export function getNetwork(): Network {
  return _network;
}

export function getChain() {
  return _network === "base" ? base : baseSepolia;
}

export function getRpcUrl(): string {
  if (_network === "base-sepolia") {
    return process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  }
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

export function getExplorerUrl(txHash: string): string {
  const host = _network === "base" ? "basescan.org" : "sepolia.basescan.org";
  return `https://${host}/tx/${txHash}`;
}

export function isTestnet(): boolean {
  return _network === "base-sepolia";
}
