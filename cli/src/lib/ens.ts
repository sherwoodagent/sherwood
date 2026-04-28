/**
 * ENS resolution + text records via Durin L2Registry on Base.
 *
 * Two responsibilities:
 *   1. Resolve syndicate subdomain → on-chain syndicate data (via factory)
 *   2. Read/write ENS text records (via L2Registry, routed through vault's executeBatch)
 *
 * The vault owns the ENS subdomain node (registered in the factory via
 * `ensRegistrar.register(subdomain, vault)`). Only the vault can write text
 * records. We route writes through vault.executeBatch → L2Registry.setText,
 * which executes as the vault via delegatecall to the shared executor lib.
 */

import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { namehash } from "viem/ens";
import { getPublicClient, getWalletClient, getAccount, waitForReceipt } from "./client.js";
import {
  getChain,
  getNetwork,
  withNetwork,
  VALID_NETWORKS,
  CHAIN_REGISTRY,
  type Network,
} from "./network.js";
import { SYNDICATE_FACTORY_ABI, L2_REGISTRY_ABI } from "./abis.js";
import { ENS, SHERWOOD } from "./addresses.js";
import * as vaultLib from "./vault.js";

/**
 * Wait for a transaction to be mined before proceeding.
 */
async function waitForTx(hash: Hex): Promise<void> {
  await waitForReceipt(hash);
}

const ENS_DOMAIN = "sherwoodagent.eth";

function getFactoryAddress(): Address {
  return SHERWOOD().FACTORY;
}

// ── Syndicate Resolution (via factory) ──

export interface SyndicateResolution {
  id: bigint;
  vault: Address;
  creator: Address;
  subdomain: string;
}

/**
 * Resolve a syndicate subdomain to its on-chain data.
 * Uses factory.subdomainToSyndicate() → factory.syndicates().
 */
export async function resolveSyndicate(subdomain: string): Promise<SyndicateResolution> {
  const client = getPublicClient();
  const factory = getFactoryAddress();

  // Get syndicate ID from subdomain
  const syndicateId = (await client.readContract({
    address: factory,
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "subdomainToSyndicate",
    args: [subdomain],
  })) as bigint;

  if (syndicateId === 0n) {
    throw new Error(`Syndicate "${subdomain}" not found`);
  }

  // Get full syndicate record
  const result = (await client.readContract({
    address: factory,
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "syndicates",
    args: [syndicateId],
  })) as [bigint, Address, Address, string, bigint, boolean, string];

  return {
    id: result[0],
    vault: result[1],
    creator: result[2],
    subdomain: result[6],
  };
}

/**
 * Probe every supported chain for a subdomain registration. Skips testnets
 * unless `ENABLE_TESTNET=true` (so we never surface "found on testnet" hints
 * to a user who can't act on them). Returns every hit — most queries find
 * zero or one, but post-CREATE3 the same subdomain may exist on multiple
 * chains and the caller needs to disambiguate. RPC errors on individual
 * chains are swallowed so a flaky chain doesn't fail the whole search.
 */
export async function searchSyndicateAcrossChains(
  subdomain: string,
): Promise<{ network: Network; result: SyndicateResolution }[]> {
  const includeTestnets = process.env.ENABLE_TESTNET === "true";
  const candidates = VALID_NETWORKS.filter(
    (n) => includeTestnets || !CHAIN_REGISTRY[n].isTestnet,
  );

  const hits: { network: Network; result: SyndicateResolution }[] = [];
  for (const net of candidates) {
    try {
      const result = await withNetwork(net, () => resolveSyndicate(subdomain));
      hits.push({ network: net, result });
    } catch {
      // Not registered on this chain, or RPC failed — keep searching.
    }
  }
  return hits;
}

/**
 * Reverse lookup: vault address → syndicate info.
 * Uses factory.vaultToSyndicate() → factory.syndicates().
 */
export async function resolveVaultSyndicate(
  vaultAddress: Address,
): Promise<SyndicateResolution> {
  const client = getPublicClient();
  const factory = getFactoryAddress();

  const syndicateId = (await client.readContract({
    address: factory,
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "vaultToSyndicate",
    args: [vaultAddress],
  })) as bigint;

  if (syndicateId === 0n) {
    throw new Error(`No syndicate found for vault ${vaultAddress}`);
  }

  const result = (await client.readContract({
    address: factory,
    abi: SYNDICATE_FACTORY_ABI,
    functionName: "syndicates",
    args: [syndicateId],
  })) as [bigint, Address, Address, string, bigint, boolean, string];

  return {
    id: result[0],
    vault: result[1],
    creator: result[2],
    subdomain: result[6],
  };
}

// ── ENS Text Records (via L2Registry) ──

/**
 * Compute the ENS node hash for a subdomain under sherwoodagent.eth.
 */
function getSubdomainNode(subdomain: string): Hex {
  return namehash(`${subdomain}.${ENS_DOMAIN}`);
}

/**
 * Write a text record to the L2Registry via the vault's executeBatch.
 *
 * The vault owns the ENS node, so only the vault can call setText.
 * We route the call through vault.executeBatch (delegatecall → executor lib → L2Registry),
 * which means L2Registry sees msg.sender = vault address.
 *
 * Requires the caller to be a registered agent on the vault (creator is auto-registered).
 */
export async function setTextRecord(
  subdomain: string,
  key: string,
  value: string,
  vaultAddress: Address,
): Promise<Hex> {
  const l2Registry = ENS().L2_REGISTRY;
  const node = getSubdomainNode(subdomain);

  vaultLib.setVaultAddress(vaultAddress);

  // Encode the L2Registry.setText call
  const setTextData = encodeFunctionData({
    abi: L2_REGISTRY_ABI,
    functionName: "setText",
    args: [node, key, value],
  });

  // Route through vault.executeBatch (owner only)
  return vaultLib.executeBatch(
    [{ target: l2Registry, data: setTextData, value: 0n }],
  );
}

/**
 * Read a text record from the L2Registry.
 * Used to look up xmtpGroupId when not cached locally.
 */
export async function getTextRecord(
  subdomain: string,
  key: string,
): Promise<string> {
  const client = getPublicClient();
  const node = getSubdomainNode(subdomain);

  return client.readContract({
    address: ENS().L2_REGISTRY,
    abi: L2_REGISTRY_ABI,
    functionName: "text",
    args: [node, key],
  }) as Promise<string>;
}
