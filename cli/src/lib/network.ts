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
      url: "https://hyperevmscan.io",
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
  /**
   * Ordered list of public RPC URLs tried in sequence when no user RPC is set.
   * First entry is the primary; the rest are fallbacks used transparently via
   * viem's `fallback` transport on rate-limit / network errors.
   */
  rpcFallbacks: string[];
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
    // Ordered by observed reliability (issue #182). publicnode first because
    // mainnet.base.org is aggressively rate-limited on fresh installs.
    rpcFallbacks: [
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base.drpc.org",
    ],
    rpcEnvVar: "BASE_RPC_URL",
    explorerHost: "basescan.org",
    easGraphqlUrl: "https://base.easscan.org/graphql",
    easScanHost: "base.easscan.org",
    xmtpEnv: "production",
    isTestnet: false,
  },
  "base-sepolia": {
    chain: baseSepolia,
    rpcFallbacks: [
      "https://base-sepolia-rpc.publicnode.com",
      "https://sepolia.base.org",
      "https://base-sepolia.drpc.org",
    ],
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
    explorerHost: "sepolia.basescan.org",
    easGraphqlUrl: "https://base-sepolia.easscan.org/graphql",
    easScanHost: "base-sepolia.easscan.org",
    xmtpEnv: "dev",
    isTestnet: true,
  },
  "robinhood-testnet": {
    chain: robinhoodTestnet,
    rpcFallbacks: ["https://rpc.testnet.chain.robinhood.com"],
    explorerHost: "explorer.testnet.chain.robinhood.com",
    easGraphqlUrl: null,
    easScanHost: null,
    xmtpEnv: "dev",
    isTestnet: true,
  },
  hyperevm: {
    chain: hyperevm,
    rpcFallbacks: ["https://rpc.hyperliquid.xyz/evm"],
    rpcEnvVar: "HYPEREVM_RPC_URL",
    explorerHost: "hyperevmscan.io",
    easGraphqlUrl: null,
    easScanHost: null,
    xmtpEnv: "production",
    isTestnet: false,
  },
  "hyperevm-testnet": {
    chain: hyperevmTestnet,
    rpcFallbacks: ["https://rpc.hyperliquid-testnet.xyz/evm"],
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

/**
 * Run `fn` with the network singleton temporarily switched to `network`,
 * restoring the previous network in `finally`. Bypasses the ENABLE_TESTNET
 * gate that `setNetwork` enforces — the caller is already running on some
 * chain that passed the gate at startup, so swapping should not be re-gated.
 *
 * The viem clients (`getPublicClient`, `getWalletClient`) auto-invalidate on
 * chain change, so callers get fresh per-chain RPC + chain context inside the
 * block. Used for cross-chain syndicate resolution and for routing EAS
 * attestations to Base regardless of the active chain.
 */
export async function withNetwork<T>(
  network: Network,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = _network;
  _network = network;
  try {
    return await fn();
  } finally {
    _network = previous;
  }
}

export function getChainConfig(): ChainConfig {
  return CHAIN_REGISTRY[_network];
}

export function getChain(): Chain {
  return CHAIN_REGISTRY[_network].chain;
}

/**
 * Ordered list of RPC URLs to try, deduped:
 *   1. User config (~/.sherwood/config.json) — honored first
 *   2. Legacy env var (BASE_RPC_URL, etc.)
 *   3. Public fallback list from CHAIN_REGISTRY
 *
 * Fed to viem's `fallback()` transport so rate-limited RPCs transparently
 * advance to the next entry. See issue #182.
 */
export function getRpcUrls(): string[] {
  const cfg = CHAIN_REGISTRY[_network];
  const urls: string[] = [];

  const fromConfig = getConfigRpcUrl(_network);
  if (fromConfig) urls.push(fromConfig);

  if (cfg.rpcEnvVar && process.env[cfg.rpcEnvVar]) {
    urls.push(process.env[cfg.rpcEnvVar]!);
  }

  urls.push(...cfg.rpcFallbacks);

  return Array.from(new Set(urls));
}

export function getRpcUrl(): string {
  return getRpcUrls()[0];
}

export function getExplorerUrl(txHash: string): string {
  return `https://${CHAIN_REGISTRY[_network].explorerHost}/tx/${txHash}`;
}

export function isTestnet(): boolean {
  return CHAIN_REGISTRY[_network].isTestnet;
}
