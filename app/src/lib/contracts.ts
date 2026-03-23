/**
 * Shared contract config for the dashboard app.
 *
 * Multichain — the app reads from all chains in CHAINS simultaneously.
 * ABIs are subsets of cli/src/lib/abis.ts — keep in sync if contracts change.
 */

import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";

export const IS_TESTNET = process.env.NEXT_PUBLIC_TESTNET === "true";

// ── Robinhood L2 Testnet chain definition ────────────────

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
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
  testnet: true,
});

// ── Per-chain RPC ────────────────────────────────────────

const RPC_CONFIG: Record<number, { envSuffix: string; fallback: string }> = {
  8453: { envSuffix: "BASE", fallback: "https://mainnet.base.org" },
  84532: { envSuffix: "BASE_SEPOLIA", fallback: "https://sepolia.base.org" },
  46630: {
    envSuffix: "ROBINHOOD_TESTNET",
    fallback: "https://rpc.testnet.chain.robinhood.com",
  },
};

/** Resolve RPC URL: NEXT_PUBLIC_RPC_URL_{BASE|BASE_SEPOLIA|ROBINHOOD_TESTNET} > fallback */
export function getRpcUrl(chainId: number): string {
  const cfg = RPC_CONFIG[chainId];
  if (!cfg) return RPC_CONFIG[IS_TESTNET ? 84532 : 8453].fallback;
  const envVal = process.env[`NEXT_PUBLIC_RPC_URL_${cfg.envSuffix}`];
  return envVal || cfg.fallback;
}

// ── Chain addresses ──────────────────────────────────────

export interface ChainAddresses {
  factory: Address;
  usdc: Address;
  l2Registry: Address;
  identityRegistry: Address;
  eas: Address;
  schemaRegistry: Address;
  easSchemas: {
    joinRequest: `0x${string}`;
    agentApproved: `0x${string}`;
  };
  blockExplorer: string;
  easExplorer: string;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

const BASE_ADDRESSES: ChainAddresses = {
  factory: "0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  l2Registry: "0x7a019ce699e27b0ad1e5b51344a58116b9f3b9b1",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  eas: "0x4200000000000000000000000000000000000021",
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  easSchemas: {
    joinRequest:
      "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef",
    agentApproved:
      "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607",
  },
  blockExplorer: "https://basescan.org",
  easExplorer: "https://base.easscan.org",
};

const BASE_SEPOLIA_ADDRESSES: ChainAddresses = {
  factory: "0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  l2Registry: "0x06eb7b85b59bc3e50fe4837be776cdd26de602cf",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  eas: "0x4200000000000000000000000000000000000021",
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  easSchemas: {
    joinRequest:
      "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef",
    agentApproved:
      "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607",
  },
  blockExplorer: "https://sepolia.basescan.org",
  easExplorer: "https://base-sepolia.easscan.org",
};

const ROBINHOOD_TESTNET_ADDRESSES: ChainAddresses = {
  factory: "0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284",
  usdc: ZERO,
  l2Registry: ZERO,
  identityRegistry: ZERO,
  eas: ZERO,
  schemaRegistry: ZERO,
  easSchemas: {
    joinRequest: ZERO_BYTES32,
    agentApproved: ZERO_BYTES32,
  },
  blockExplorer: "https://explorer.testnet.chain.robinhood.com",
  easExplorer: "",
};

// ── Chain registry ───────────────────────────────────────

export interface ChainEntry {
  chain: Chain;
  addresses: ChainAddresses;
  subgraphUrl: string | null;
}

const _ALL_CHAINS: Record<number, ChainEntry> = {
  84532: {
    chain: baseSepolia,
    addresses: BASE_SEPOLIA_ADDRESSES,
    subgraphUrl:
      "https://api.studio.thegraph.com/query/18207/sherwood-sepolia/version/latest",
  },
  46630: {
    chain: robinhoodTestnet,
    addresses: ROBINHOOD_TESTNET_ADDRESSES,
    subgraphUrl: null,
  },
  8453: {
    chain: base,
    addresses: BASE_ADDRESSES,
    subgraphUrl:
      "https://api.studio.thegraph.com/query/18207/sherwood/version/latest",
  },
};

/** Active chains — filtered by NEXT_PUBLIC_TESTNET at build time. */
export const CHAINS: Record<number, ChainEntry> = Object.fromEntries(
  Object.entries(_ALL_CHAINS).filter(([, entry]) =>
    IS_TESTNET ? entry.chain.testnet === true : entry.chain.testnet !== true
  )
);

// ── Public clients (one per chain, server-side) ──────────

const _clients: Record<number, PublicClient> = {};

export function getPublicClient(chainId?: number): PublicClient {
  // Legacy single-chain call — default to first chain in registry
  const id = chainId ?? Number(Object.keys(CHAINS)[0]);
  if (!_clients[id]) {
    const entry = CHAINS[id];
    if (!entry) throw new Error(`Unknown chain: ${id}`);
    _clients[id] = createPublicClient({
      chain: entry.chain,
      transport: http(getRpcUrl(id)),
    });
  }
  return _clients[id];
}

// ── Legacy helpers (backwards compat for wagmi/Providers) ─

const DEFAULT_CHAIN_ID = IS_TESTNET ? 84532 : 8453;

export function getChain(): Chain {
  return CHAINS[DEFAULT_CHAIN_ID]?.chain ?? (IS_TESTNET ? baseSepolia : base);
}

export function getChainId(): number {
  return DEFAULT_CHAIN_ID;
}

/** Get addresses for a specific chain. */
export function getAddresses(chainId?: number): ChainAddresses {
  const id = chainId ?? DEFAULT_CHAIN_ID;
  return (
    CHAINS[id]?.addresses ??
    (IS_TESTNET ? BASE_SEPOLIA_ADDRESSES : BASE_ADDRESSES)
  );
}

// ── ABIs ──────────────────────────────────────────────────

export const SYNDICATE_FACTORY_ABI = [
  {
    name: "syndicates",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "vault", type: "address" },
      { name: "creator", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "createdAt", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "subdomain", type: "string" },
    ],
  },
  {
    name: "subdomainToSyndicate",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "subdomain", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "syndicateCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAllActiveSyndicates",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "vault", type: "address" },
          { name: "creator", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "createdAt", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "subdomain", type: "string" },
        ],
      },
    ],
  },
] as const;

export const SYNDICATE_VAULT_ABI = [
  // ERC-4626
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Views
  {
    name: "getAgentCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAgentAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getAgentConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "agentAddress", type: "address" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "openDeposits",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "isApprovedDepositor",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getApprovedDepositors",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  // Governor integration
  {
    name: "governor",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "redemptionsLocked",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "managementFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // OZ inherited
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "paused",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const SYNDICATE_GOVERNOR_ABI = [
  {
    name: "proposalCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getProposal",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "proposer", type: "address" },
          { name: "vault", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "performanceFeeBps", type: "uint256" },
          { name: "strategyDuration", type: "uint256" },
          { name: "votesFor", type: "uint256" },
          { name: "votesAgainst", type: "uint256" },
          { name: "votesAbstain", type: "uint256" },
          { name: "snapshotTimestamp", type: "uint256" },
          { name: "voteEnd", type: "uint256" },
          { name: "executeBy", type: "uint256" },
          { name: "executedAt", type: "uint256" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
  {
    name: "getProposalState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "getActiveProposal",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getGovernorParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "votingPeriod", type: "uint256" },
          { name: "executionWindow", type: "uint256" },
          { name: "vetoThresholdBps", type: "uint256" },
          { name: "maxPerformanceFeeBps", type: "uint256" },
          { name: "cooldownPeriod", type: "uint256" },
          { name: "collaborationWindow", type: "uint256" },
          { name: "maxCoProposers", type: "uint256" },
          { name: "minStrategyDuration", type: "uint256" },
          { name: "maxStrategyDuration", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getCooldownEnd",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCapitalSnapshot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getVoteWeight",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "hasVoted",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "vote",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "getCoProposers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "agent", type: "address" },
          { name: "splitBps", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "isRegisteredVault",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const L2_REGISTRY_ABI = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const IDENTITY_REGISTRY_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ── Helpers ───────────────────────────────────────────────

/** Truncate an address for display: 0x1234...5678 */
export function truncateAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Format a raw uint256 USDC amount (6 decimals) to a display string. */
export function formatUSDC(raw: bigint): string {
  return formatAsset(raw, 6, "USD");
}

/** Format a raw uint256 token amount with the given decimals. */
export function formatAsset(
  raw: bigint,
  decimals: number,
  currency?: string,
): string {
  const num = Number(raw) / 10 ** decimals;
  if (currency === "USD") {
    return num.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (num !== 0 && Math.abs(num) < 0.01) {
    return num.toPrecision(4);
  }
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals <= 6 ? 2 : 4,
    maximumFractionDigits: decimals <= 6 ? 2 : 4,
  });
}

/** Format basis points to percentage string. */
export function formatBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(1)}%`;
}

/** Format vault shares to a readable number.
 *  Shares have assetDecimals * 2 decimals due to _decimalsOffset() (12 for USDC). */
export function formatShares(raw: bigint, decimals: number = 12): string {
  const num = Number(raw) / 10 ** decimals;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// ── Chain badge config ───────────────────────────────────

export const CHAIN_BADGES: Record<
  number,
  { label: string; bg: string; color: string }
> = {
  8453: { label: "BASE", bg: "rgba(59,130,246,0.2)", color: "#3b82f6" },
  84532: { label: "BASE SEPOLIA", bg: "rgba(59,130,246,0.2)", color: "#3b82f6" },
  46630: { label: "ROBINHOOD TESTNET", bg: "rgba(234,179,8,0.2)", color: "#eab308" },
};
