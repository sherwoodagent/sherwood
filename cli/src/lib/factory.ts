/**
 * SyndicateFactory contract wrapper.
 *
 * Creates new syndicate vaults via the factory. Each syndicate = one vault proxy
 * with shared executor lib and vault implementation.
 */

import type { Address, Hex } from "viem";
import { parseUnits, formatUnits, decodeEventLog } from "viem";
import { getChain, getNetwork } from "./network.js";
import { getPublicClient, getAccount, writeContractWithRetry, waitForReceipt } from "./client.js";
import { SYNDICATE_FACTORY_ABI } from "./abis.js";
import { TOKENS, SHERWOOD } from "./addresses.js";

export interface SyndicateInfo {
  id: bigint;
  vault: Address;
  creator: Address;
  metadataURI: string;
  createdAt: bigint;
  active: boolean;
  subdomain: string;
}

export interface CreateSyndicateParams {
  creatorAgentId: bigint;
  metadataURI: string;
  asset: Address;
  name: string;
  symbol: string;
  openDeposits: boolean;
  subdomain: string;
}

function getFactoryAddress(): Address {
  return SHERWOOD().FACTORY;
}

export interface CreateSyndicateResult {
  hash: Hex;
  syndicateId: bigint;
  vault: Address;
}

/**
 * Create a new syndicate via the factory.
 * Deploys a UUPS vault proxy, initializes it, and registers in the factory.
 * Waits for receipt and extracts vault address from SyndicateCreated event.
 */
export async function createSyndicate(params: CreateSyndicateParams): Promise<CreateSyndicateResult> {
  const client = getPublicClient();

  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "createSyndicate",
    args: [
      params.creatorAgentId,
      {
        metadataURI: params.metadataURI,
        asset: params.asset,
        name: params.name,
        symbol: params.symbol,
        openDeposits: params.openDeposits,
        subdomain: params.subdomain,
      },
    ],
  });

  // Wait for receipt and extract vault from SyndicateCreated event
  const receipt = await waitForReceipt(hash);

  // Parse SyndicateCreated event from receipt logs
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: SYNDICATE_FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === "SyndicateCreated") {
        const args = event.args as { id: bigint; vault: Address; creator: Address };
        return {
          hash,
          syndicateId: args.id,
          vault: args.vault,
        };
      }
    } catch {
      // Not our event, skip
    }
  }

  // Fallback: read from factory state (may lag on RPC replicas)
  const count = await getSyndicateCount();
  const info = await getSyndicate(count);

  return {
    hash,
    syndicateId: count,
    vault: info.vault,
  };
}

/**
 * Check if a subdomain is already registered. Returns the syndicate ID if found, null otherwise.
 */
export async function subdomainExists(subdomain: string): Promise<bigint | null> {
  const client = getPublicClient();
  const id = (await client.readContract({
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "subdomainToSyndicate",
    args: [subdomain],
  })) as bigint;

  return id > 0n ? id : null;
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
  })) as [bigint, Address, Address, string, bigint, boolean, string];

  return {
    id: result[0],
    vault: result[1],
    creator: result[2],
    metadataURI: result[3],
    createdAt: result[4],
    active: result[5],
    subdomain: result[6],
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
    functionName: "getAllActiveSyndicates",
  })) as readonly {
    id: bigint;
    vault: Address;
    creator: Address;
    metadataURI: string;
    createdAt: bigint;
    active: boolean;
    subdomain: string;
  }[];

  return result.map((s) => ({
    id: s.id,
    vault: s.vault,
    creator: s.creator,
    metadataURI: s.metadataURI,
    createdAt: s.createdAt,
    active: s.active,
    subdomain: s.subdomain,
  }));
}

/**
 * Update syndicate metadata (creator only).
 */
export async function updateMetadata(syndicateId: bigint, metadataURI: string): Promise<Hex> {
  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getFactoryAddress(),
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "updateMetadata",
    args: [syndicateId, metadataURI],
  });
  await waitForReceipt(hash);
  return hash;
}
