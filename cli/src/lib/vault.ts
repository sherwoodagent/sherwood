/**
 * SyndicateVault contract wrapper.
 *
 * The vault is the onchain identity — it holds all positions via delegatecall
 * to a shared BatchExecutorLib. No separate executor contract needed.
 */

import type { Address, Hex } from "viem";
import { formatUnits } from "viem";
import { getChain } from "./network.js";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI } from "./abis.js";
import type { BatchCall } from "./batch.js";
import { getChainContracts } from "./config.js";

// Per-command override (set by --vault flag in index.ts)
let _vaultOverride: Address | null = null;

export function setVaultAddress(addr: Address): void {
  _vaultOverride = addr;
}

export function getVaultAddress(): Address {
  // 1. Per-command override (--vault flag)
  if (_vaultOverride) return _vaultOverride;

  // 2. Config (~/.sherwood/config.json) — default vault
  const chainId = getChain().id;
  const fromConfig = getChainContracts(chainId).vault;
  if (fromConfig) return fromConfig as Address;

  throw new Error(
    "Vault address not found. Pass --vault <addr> or run 'sherwood config set --vault <addr>'.",
  );
}

// ── Asset Helpers ──

/**
 * Read the vault's underlying ERC-20 asset address.
 */
export async function getAssetAddress(): Promise<Address> {
  const client = getPublicClient();
  return client.readContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "asset",
  }) as Promise<Address>;
}

/**
 * Read decimals from the vault's underlying asset.
 * Works with any ERC-20 (USDC=6, WETH=18, WBTC=8, etc.).
 */
export async function getAssetDecimals(): Promise<number> {
  const client = getPublicClient();
  const asset = await getAssetAddress();
  return client.readContract({
    address: asset,
    abi: ERC20_ABI,
    functionName: "decimals",
  }) as Promise<number>;
}

// ── LP Functions ──

/**
 * Deposit into the vault. Handles approval + deposit for the vault's asset.
 */
export async function deposit(amount: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();
  const account = getAccount();

  // Approve vault to pull the underlying asset
  const asset = await getAssetAddress();
  const approveHash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vaultAddress, amount],
  });
  await client.waitForTransactionReceipt({ hash: approveHash });

  // Deposit
  const depositHash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "deposit",
    args: [amount, account.address],
  });
  await client.waitForTransactionReceipt({ hash: depositHash });
  return depositHash;
}

// ── Batch Execution ──

/**
 * Execute a batch of protocol calls through the vault (owner only).
 * The vault delegatecalls to the executor lib.
 * All calls execute as the vault — positions live on the vault.
 */
export async function executeBatch(calls: BatchCall[]): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "executeBatch",
    args: [
      calls.map((c) => ({
        target: c.target,
        data: c.data,
        value: c.value,
      })),
    ],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

// ── Depositor Management ──

/**
 * Approve a depositor address (owner only).
 */
export async function approveDepositor(depositor: Address): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositor",
    args: [depositor],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Remove a depositor from the whitelist (owner only).
 */
export async function removeDepositor(depositor: Address): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "removeDepositor",
    args: [depositor],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Approve multiple depositors in a batch (owner only).
 */
export async function approveDepositors(depositors: Address[]): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositors",
    args: [depositors],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Check if an address is a registered agent on the vault.
 */
export async function isAgent(agentAddress: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "isAgent",
    args: [agentAddress],
  }) as Promise<boolean>;
}

/**
 * Check if an address is an approved depositor.
 */
export async function isApprovedDepositor(depositor: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "isApprovedDepositor",
    args: [depositor],
  }) as Promise<boolean>;
}

/**
 * Get LP share balance and asset value.
 */
export async function getBalance(address?: Address): Promise<{
  shares: bigint;
  assetsValue: string;
  percentOfVault: string;
}> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();
  const account = address || getAccount().address;

  const [shares, totalSupply] = await Promise.all([
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>,
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "totalSupply",
    }) as Promise<bigint>,
  ]);

  let assetsValue = 0n;
  if (shares > 0n) {
    assetsValue = (await client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "convertToAssets",
      args: [shares],
    })) as bigint;
  }

  const percent =
    totalSupply > 0n ? ((Number(shares) / Number(totalSupply)) * 100).toFixed(2) : "0.00";

  const decimals = await getAssetDecimals();

  return {
    shares,
    assetsValue: formatUnits(assetsValue, decimals),
    percentOfVault: `${percent}%`,
  };
}

// ── Agent Management ──

/**
 * Register a new agent (owner only). Requires ERC-8004 agent identity.
 */
export async function registerAgent(
  agentId: bigint,
  agentAddress: Address,
): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "registerAgent",
    args: [agentId, agentAddress],
  });

  await client.waitForTransactionReceipt({ hash });
  return hash;
}

// ── Views ──

export interface VaultInfo {
  address: Address;
  totalAssets: string;
  agentCount: bigint;
  redemptionsLocked: boolean;
  managementFeeBps: bigint;
}

/**
 * Get vault overview info.
 */
export async function getVaultInfo(): Promise<VaultInfo> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();

  const [totalAssets, agentCount, redemptionsLocked, managementFeeBps, decimals] =
    await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "totalAssets",
      }) as Promise<bigint>,
      client.readContract({
        address: vaultAddress,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "getAgentCount",
      }) as Promise<bigint>,
      client.readContract({
        address: vaultAddress,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "redemptionsLocked",
      }) as Promise<boolean>,
      client.readContract({
        address: vaultAddress,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "managementFeeBps",
      }) as Promise<bigint>,
      getAssetDecimals(),
    ]);

  return {
    address: vaultAddress,
    totalAssets: formatUnits(totalAssets, decimals),
    agentCount,
    redemptionsLocked,
    managementFeeBps,
  };
}
