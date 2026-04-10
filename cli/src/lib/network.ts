/**
 * Network state singleton.
 *
 * Called once at CLI startup via the --chain flag's preAction hook.
 * Every other module reads from here — never hardcodes a chain.
 */

import { type Chain, defineChain } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getConfigRpcUrl } from "./config.js";

// ── Robinhood L2 Testnet (Arbitrum Orbit, chain ID 46630) ──

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

// ── HyperEVM (Hyperliquid L1, chain ID 999) ──

export const hyperevm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid.xyz/evm"] },
  },
  blockExplorers: {
    default: {
      name: "Routescan",
      url: "https://explorer.hyperliquid.xyz",
    },
  },
  testnet: false,
});

// ── HyperEVM Testnet (chain ID 998) ──

export const hyperevmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] },
  },
  blockExplorers: {
    default: {
      name: "Routescan",
      url: "https://explorer.hyperliquid-testnet.xyz",
    },
  },
  testnet: true,
});

// ── Types ──

export type Network = "base" | "base-sepolia" | "robinhood-testnet" | "hyperevm" | "hyperevm-testnet";

export interface ChainConfig {
  chain: Chain;
  rpcFallback: string;
  /** Legacy env var for backwards compat (base / base-sepolia only) */
  rpcEnvVar?: string;
  explorerHost: string;
  /** EAS GraphQL endpoint — null if EAS is not available on this chain */
  easGraphqlUrl: string | null;
  /** EAS scan host — null if unavailable */
  easScanHost: string | null;
  xmtpEnv: "production" | "dev";
  isTestnet: boolean;
}

// ── Chain Registry ──

export const CHAIN_REGISTRY: Record<Network, ChainConfig> = {
  base: {
    chain: base,
    rpcFallback: "https://mainnet.base.org",
    rpcEnvVar: "BASE_RPC_URL",
    explorerHost: "basescan.org",
    easGraphqlUrl: "https://base.easscan.org/graphql",
    easScanHost: "base.easscan.org",
    xmtpEnv: "production",
    isTestnet: false,
  },
  "base-sepolia": {
    chain: baseSepolia,
    rpcFallback: "https://sepolia.base.org",
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
    explorerHost: "sepolia.basescan.org",
    easGraphqlUrl: "https://base-sepolia.easscan.org/graphql",
    easScanHost: "base-sepolia.easscan.org",
    xmtpEnv: "dev",
    isTestnet: true,
  },
  "robinhood-testnet": {
    chain: robinhoodTestnet,
    rpcFallback: "https://rpc.testnet.chain.robinhood.com",
    explorerHost: "explorer.testnet.chain.robinhood.com",
    easGraphqlUrl: null,
    easScanHost: null,
    xmtpEnv: "dev",
    isTestnet: true,
  },
  hyperevm: {
    chain: hyperevm,
    rpcFallback: "https://rpc.hyperliquid.xyz/evm",
    rpcEnvVar: "HYPEREVM_RPC_URL",
    explorerHost: "explorer.hyperliquid.xyz",
    easGraphqlUrl: null,
    easScanHost: null,
    xmtpEnv: "production",
    isTestnet: false,
  },
  "hyperevm-testnet": {
    chain: hyperevmTestnet,
    rpcFallback: "https://rpc.hyperliquid-testnet.xyz/evm",
    rpcEnvVar: "HYPEREVM_TESTNET_RPC_URL",
    explorerHost: "explorer.hyperliquid-testnet.xyz",
    easGraphqlUrl: null,
    easScanHost: null,
    xmtpEnv: "dev",
    isTestnet: true,
  },
};

export const VALID_NETWORKS = Object.keys(CHAIN_REGISTRY) as Network[];

// ── Singleton state ──

let _network: Network = "base";

export function setNetwork(n: Network) {
  const config = CHAIN_REGISTRY[n];
  if (!config) {
    throw new Error(
      `Unknown network: ${n}. Valid: ${VALID_NETWORKS.join(", ")}`,
    );
  }
  if (config.isTestnet && process.env.ENABLE_TESTNET !== "true") {
    throw new Error(
      `Testnet "${n}" is disabled. Set ENABLE_TESTNET=true to enable.`,
    );
  }
  _network = n;
}

export function getNetwork(): Network {
  return _network;
}

export function getChainConfig(): ChainConfig {
  return CHAIN_REGISTRY[_network];
}

export function getChain(): Chain {
  return CHAIN_REGISTRY[_network].chain;
}

export function getRpcUrl(): string {
  // 1. User config (~/.sherwood/config.json)
  const fromConfig = getConfigRpcUrl(_network);
  if (fromConfig) return fromConfig;

  // 2. Legacy env var (backwards compat for base / base-sepolia)
  const cfg = CHAIN_REGISTRY[_network];
  if (cfg.rpcEnvVar && process.env[cfg.rpcEnvVar]) {
    return process.env[cfg.rpcEnvVar]!;
  }

  // 3. Public fallback
  return cfg.rpcFallback;
}

export function getExplorerUrl(txHash: string): string {
  return `https://${CHAIN_REGISTRY[_network].explorerHost}/tx/${txHash}`;
}

export function isTestnet(): boolean {
  return CHAIN_REGISTRY[_network].isTestnet;
}
