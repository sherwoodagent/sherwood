/**
 * SyndicateVault contract wrapper.
 *
 * The vault is the onchain identity — it holds all positions via delegatecall
 * to a shared BatchExecutorLib. No separate executor contract needed.
 */

import type { Address, Hex } from "viem";
import { formatUnits, encodeFunctionData, decodeFunctionResult } from "viem";
import { getChain, getNetwork } from "./network.js";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI } from "./abis.js";
import type { BatchCall } from "./batch.js";

export interface SimulationResult {
  success: boolean;
  returnData: Hex;
}

function getVaultAddress(): Address {
  const envKey = getNetwork() === "base-sepolia" ? "VAULT_ADDRESS_TESTNET" : "VAULT_ADDRESS";
  const addr = process.env[envKey];
  if (!addr) {
    throw new Error(`${envKey} env var is required`);
  }
  return addr as Address;
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
  const vaultAddress = getVaultAddress();
  const account = getAccount();

  // Approve vault to pull the underlying asset
  const asset = await getAssetAddress();
  await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vaultAddress, amount],
  });

  // Deposit
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "deposit",
    args: [amount, account.address],
  });
}

/**
 * Ragequit — withdraw all shares for pro-rata assets.
 */
export async function ragequit(): Promise<Hex> {
  const wallet = getWalletClient();
  const account = getAccount();

  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "ragequit",
    args: [account.address],
  });
}

// ── Batch Execution ──

/**
 * Execute a batch of protocol calls through the vault.
 * The vault checks caps + allowlist, then delegatecalls to the executor lib.
 * All calls execute as the vault — positions live on the vault.
 */
export async function executeBatch(
  calls: BatchCall[],
  assetAmount: bigint,
): Promise<Hex> {
  const wallet = getWalletClient();

  return wallet.writeContract({
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
      assetAmount,
    ],
  });
}

/**
 * Simulate a batch via eth_call (no state committed).
 * simulateBatch is NOT a view function — must use raw eth_call.
 * Anyone can call this (no agent check).
 */
export async function simulateBatch(calls: BatchCall[]): Promise<SimulationResult[]> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();

  const calldata = encodeFunctionData({
    abi: SYNDICATE_VAULT_ABI,
    functionName: "simulateBatch",
    args: [
      calls.map((c) => ({
        target: c.target,
        data: c.data,
        value: c.value,
      })),
    ],
  });

  const { data } = await client.call({
    to: vaultAddress,
    data: calldata,
  });

  if (!data) {
    throw new Error("simulateBatch returned no data");
  }

  const decoded = decodeFunctionResult({
    abi: SYNDICATE_VAULT_ABI,
    functionName: "simulateBatch",
    data,
  });

  return (decoded as readonly { success: boolean; returnData: Hex }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

// ── Target Management ──

/**
 * Add a single target to the vault's allowlist (owner only).
 */
export async function addTarget(target: Address): Promise<Hex> {
  const client = getWalletClient();
  return client.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "addTarget",
    args: [target],
  });
}

/**
 * Remove a target from the vault's allowlist (owner only).
 */
export async function removeTarget(target: Address): Promise<Hex> {
  const client = getWalletClient();
  return client.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "removeTarget",
    args: [target],
  });
}

/**
 * Add multiple targets to the vault's allowlist (owner only).
 */
export async function addTargets(targets: Address[]): Promise<Hex> {
  const client = getWalletClient();
  return client.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "addTargets",
    args: [targets],
  });
}

/**
 * Check if a target is in the vault's allowlist.
 */
export async function isAllowedTarget(target: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "isAllowedTarget",
    args: [target],
  }) as Promise<boolean>;
}

/**
 * Get all allowed targets.
 */
export async function getAllowedTargets(): Promise<Address[]> {
  const client = getPublicClient();
  return client.readContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "getAllowedTargets",
  }) as Promise<Address[]>;
}

// ── Depositor Management ──

/**
 * Approve a depositor address (owner only).
 */
export async function approveDepositor(depositor: Address): Promise<Hex> {
  const wallet = getWalletClient();
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositor",
    args: [depositor],
  });
}

/**
 * Remove a depositor from the whitelist (owner only).
 */
export async function removeDepositor(depositor: Address): Promise<Hex> {
  const wallet = getWalletClient();
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "removeDepositor",
    args: [depositor],
  });
}

/**
 * Approve multiple depositors in a batch (owner only).
 */
export async function approveDepositors(depositors: Address[]): Promise<Hex> {
  const wallet = getWalletClient();
  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositors",
    args: [depositors],
  });
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
 * Register a new agent (owner only).
 */
export async function registerAgent(
  pkpAddress: Address,
  operatorEOA: Address,
  maxPerTx: bigint,
  dailyLimit: bigint,
): Promise<Hex> {
  const wallet = getWalletClient();

  return wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "registerAgent",
    args: [pkpAddress, operatorEOA, maxPerTx, dailyLimit],
  });
}

// ── Views ──

export interface VaultInfo {
  address: Address;
  totalAssets: string;
  syndicateCaps: {
    maxPerTx: string;
    maxDailyTotal: string;
    maxBorrowRatio: string;
  };
  agentCount: bigint;
  dailySpendTotal: string;
}

/**
 * Get vault overview info.
 */
export async function getVaultInfo(): Promise<VaultInfo> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();

  const [totalAssets, caps, agentCount, dailySpend, decimals] = await Promise.all([
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "totalAssets",
    }) as Promise<bigint>,
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getSyndicateCaps",
    }) as Promise<{ maxPerTx: bigint; maxDailyTotal: bigint; maxBorrowRatio: bigint }>,
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentCount",
    }) as Promise<bigint>,
    client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getDailySpendTotal",
    }) as Promise<bigint>,
    getAssetDecimals(),
  ]);

  return {
    address: vaultAddress,
    totalAssets: formatUnits(totalAssets, decimals),
    syndicateCaps: {
      maxPerTx: formatUnits(caps.maxPerTx, decimals),
      maxDailyTotal: formatUnits(caps.maxDailyTotal, decimals),
      maxBorrowRatio: `${(Number(caps.maxBorrowRatio) / 100).toFixed(1)}%`,
    },
    agentCount,
    dailySpendTotal: formatUnits(dailySpend, decimals),
  };
}
