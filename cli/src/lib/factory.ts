/**
 * SyndicateFactory contract wrapper.
 *
 * Creates new syndicate vaults via the factory. Each syndicate = one vault proxy
 * with shared executor lib and vault implementation.
 */

import type { Address, Hex } from "viem";
import { parseUnits, formatUnits } from "viem";
import { getChain, getNetwork } from "./network.js";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { SYNDICATE_FACTORY_ABI } from "./abis.js";
import { TOKENS } from "./addresses.js";

export interface SyndicateInfo {
  id: bigint;
  vault: Address;
  creator: Address;
  metadataURI: string;
  createdAt: bigint;
  active: boolean;
}

export interface CreateSyndicateParams {
  metadataURI: string;
  asset: Address;
  name: string;
  symbol: string;
  maxPerTx: bigint;
  maxDailyTotal: bigint;
  maxBorrowRatio: bigint;
  initialTargets: Address[];
  openDeposits: boolean;
}

function getFactoryAddress(): Address {
  const envKey = getNetwork() === "base-sepolia" ? "FACTORY_ADDRESS_TESTNET" : "FACTORY_ADDRESS";
  const addr = process.env[envKey];
  if (!addr) {
    throw new Error(`${envKey} env var is required`);
  }
  return addr as Address;
}

/**
 * Create a new syndicate via the factory.
 * Deploys a UUPS vault proxy, initializes it, and registers in the factory.
 */
export async function createSyndicate(params: CreateSyndicateParams): Promise<Hex> {
  const wallet = getWalletClient();

  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "createSyndicate",
    args: [
      {
        metadataURI: params.metadataURI,
        asset: params.asset,
        name: params.name,
        symbol: params.symbol,
        caps: {
          maxPerTx: params.maxPerTx,
          maxDailyTotal: params.maxDailyTotal,
          maxBorrowRatio: params.maxBorrowRatio,
        },
        initialTargets: params.initialTargets,
        openDeposits: params.openDeposits,
      },
    ],
  });
}

/**
 * Get syndicate info by ID.
 */
export async function getSyndicate(id: bigint): Promise<SyndicateInfo> {
  const client = getPublicClient();
  const result = (await client.readContract({
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "syndicates",
    args: [id],
  })) as [bigint, Address, Address, string, bigint, boolean];

  return {
    id: result[0],
    vault: result[1],
    creator: result[2],
    metadataURI: result[3],
    createdAt: result[4],
    active: result[5],
  };
}

/**
 * Get the total number of syndicates created.
 */
export async function getSyndicateCount(): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "syndicateCount",
  }) as Promise<bigint>;
}

/**
 * Get all active syndicates from the factory.
 */
export async function getActiveSyndicates(): Promise<SyndicateInfo[]> {
  const client = getPublicClient();
  const result = (await client.readContract({
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "getActiveSyndicates",
  })) as readonly {
    id: bigint;
    vault: Address;
    creator: Address;
    metadataURI: string;
    createdAt: bigint;
    active: boolean;
  }[];

  return result.map((s) => ({
    id: s.id,
    vault: s.vault,
    creator: s.creator,
    metadataURI: s.metadataURI,
    createdAt: s.createdAt,
    active: s.active,
  }));
}

/**
 * Update syndicate metadata (creator only).
 */
export async function updateMetadata(syndicateId: bigint, metadataURI: string): Promise<Hex> {
  const wallet = getWalletClient();
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "updateMetadata",
    args: [syndicateId, metadataURI],
  });
}
