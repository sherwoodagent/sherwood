/**
 * StrategyRegistry contract wrapper.
 *
 * Permissionless registration — anyone can register a strategy.
 * Creator address is public (for future carry fees).
 */

import type { Address, Hex } from "viem";
import { getChain, getNetwork } from "./network.js";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { STRATEGY_REGISTRY_ABI } from "./abis.js";
import { SHERWOOD } from "./addresses.js";

export interface StrategyRecord {
  id: bigint;
  implementation: Address;
  creator: Address;
  strategyTypeId: bigint;
  active: boolean;
  name: string;
  metadataURI: string;
}

function getRegistryAddress(): Address {
  // StrategyRegistry has been removed — this module is deprecated
  return "0x0000000000000000000000000000000000000000" as Address;
}

/**
 * Register a new strategy on-chain.
 */
export async function registerStrategy(
  implementation: Address,
  strategyTypeId: bigint,
  name: string,
  metadataURI: string,
): Promise<Hex> {
  const wallet = getWalletClient();
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getRegistryAddress(),
    abi: STRATEGY_REGISTRY_ABI,
    functionName: "registerStrategy",
    args: [implementation, strategyTypeId, name, metadataURI],
  });
}

/**
 * Get a strategy by ID.
 */
export async function getStrategy(id: bigint): Promise<StrategyRecord> {
  const client = getPublicClient();
  const result = (await client.readContract({
    address: getRegistryAddress(),
    abi: STRATEGY_REGISTRY_ABI,
    functionName: "getStrategy",
    args: [id],
  })) as {
    implementation: Address;
    creator: Address;
    strategyTypeId: bigint;
    active: boolean;
    name: string;
    metadataURI: string;
  };

  return {
    id,
    implementation: result.implementation,
    creator: result.creator,
    strategyTypeId: result.strategyTypeId,
    active: result.active,
    name: result.name,
    metadataURI: result.metadataURI,
  };
}

/**
 * List all strategies, optionally filtered by type.
 */
export async function listStrategies(typeId?: bigint): Promise<StrategyRecord[]> {
  const client = getPublicClient();
  const registryAddress = getRegistryAddress();

  let ids: readonly bigint[];

  if (typeId !== undefined) {
    ids = (await client.readContract({
      address: registryAddress,
      abi: STRATEGY_REGISTRY_ABI,
      functionName: "getStrategiesByType",
      args: [typeId],
    })) as readonly bigint[];
  } else {
    const count = (await client.readContract({
      address: registryAddress,
      abi: STRATEGY_REGISTRY_ABI,
      functionName: "strategyCount",
    })) as bigint;

    ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  }

  const strategies: StrategyRecord[] = [];
  for (const id of ids) {
    const s = await getStrategy(id);
    strategies.push(s);
  }

  return strategies;
}

/**
 * Get total number of registered strategies.
 */
export async function strategyCount(): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getRegistryAddress(),
    abi: STRATEGY_REGISTRY_ABI,
    functionName: "strategyCount",
  }) as Promise<bigint>;
}
