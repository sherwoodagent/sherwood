/**
 * Shared contract config for the dashboard app.
 *
 * ABIs are subsets of cli/src/lib/abis.ts — keep in sync if contracts change.
 * Addresses are hardcoded per chain (no CLI network module dependency).
 */

import { createPublicClient, http, type Address, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

// ── Chain config ──────────────────────────────────────────

const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || process.env.CHAIN_ID || "84532", 10);

export function getChain(): Chain {
  return CHAIN_ID === 8453 ? base : baseSepolia;
}

export function getChainId(): number {
  return CHAIN_ID;
}

// ── Public client (server-side viem reads) ────────────────

let _client: ReturnType<typeof createPublicClient> | null = null;

export function getPublicClient() {
  if (!_client) {
    const chain = getChain();
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
    _client = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }
  return _client;
}

// ── Addresses by chain ────────────────────────────────────

interface ChainAddresses {
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

const BASE_ADDRESSES: ChainAddresses = {
  factory: "0x0000000000000000000000000000000000000000",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  l2Registry: "0x0000000000000000000000000000000000000000",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  eas: "0x4200000000000000000000000000000000000021",
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  easSchemas: {
    joinRequest: "0x0000000000000000000000000000000000000000000000000000000000000000",
    agentApproved: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  blockExplorer: "https://basescan.org",
  easExplorer: "https://base.easscan.org",
};

const BASE_SEPOLIA_ADDRESSES: ChainAddresses = {
  factory: "0x60bf54dDce61ece85BE5e66CBaA17cC312DEa6C8",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  l2Registry: "0x06eb7b85b59bc3e50fe4837be776cdd26de602cf",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  eas: "0x4200000000000000000000000000000000000021",
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  easSchemas: {
    joinRequest: "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef",
    agentApproved: "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607",
  },
  blockExplorer: "https://sepolia.basescan.org",
  easExplorer: "https://base-sepolia.easscan.org",
};

export function getAddresses(): ChainAddresses {
  return CHAIN_ID === 8453 ? BASE_ADDRESSES : BASE_SEPOLIA_ADDRESSES;
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
    name: "totalDeposited",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Ragequit
  {
    name: "ragequit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "assets", type: "uint256" }],
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
    name: "getAgentOperators",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getAgentConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pkpAddress", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "pkpAddress", type: "address" },
          { name: "operatorEOA", type: "address" },
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
          { name: "splitIndex", type: "uint256" },
          { name: "strategyDuration", type: "uint256" },
          { name: "votesFor", type: "uint256" },
          { name: "votesAgainst", type: "uint256" },
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
          { name: "quorumBps", type: "uint256" },
          { name: "maxPerformanceFeeBps", type: "uint256" },
          { name: "maxStrategyDuration", type: "uint256" },
          { name: "cooldownPeriod", type: "uint256" },
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
      { name: "support", type: "bool" },
    ],
    outputs: [],
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
  const num = Number(raw) / 1e6;
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format basis points to percentage string. */
export function formatBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(1)}%`;
}

/** Format vault shares (6 decimals) to a readable number. */
export function formatShares(raw: bigint): string {
  const num = Number(raw) / 1e6;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}
