/**
 * SyndicateVault contract wrapper.
 */

import type { Address, Hex } from "viem";
import { formatUnits } from "viem";
import { base } from "viem/chains";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI } from "./abis.js";
import { TOKENS } from "./addresses.js";

function getVaultAddress(): Address {
  const addr = process.env.VAULT_ADDRESS;
  if (!addr) {
    throw new Error("VAULT_ADDRESS env var is required");
  }
  return addr as Address;
}

/**
 * Deposit USDC into the vault. Handles approval + deposit.
 */
export async function deposit(amount: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const vaultAddress = getVaultAddress();
  const account = getAccount();

  // Approve vault to pull USDC
  await wallet.writeContract({
    account: getAccount(),
    chain: base,
    address: TOKENS.USDC,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vaultAddress, amount],
  });

  // Deposit
  return wallet.writeContract({
    account: getAccount(),
    chain: base,
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "deposit",
    args: [amount, account.address],
  });
}

/**
 * Ragequit — withdraw all shares for pro-rata USDC.
 */
export async function ragequit(): Promise<Hex> {
  const wallet = getWalletClient();
  const account = getAccount();

  return wallet.writeContract({
    account: getAccount(),
    chain: base,
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "ragequit",
    args: [account.address],
  });
}

/**
 * Execute a strategy through the vault.
 * The vault approves the strategy for assetAmount, then calls strategy.call(data).
 */
export async function executeStrategy(
  strategyAddress: Address,
  data: Hex,
  assetAmount: bigint,
): Promise<Hex> {
  const wallet = getWalletClient();

  return wallet.writeContract({
    account: getAccount(),
    chain: base,
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "executeStrategy",
    args: [strategyAddress, data, assetAmount],
  });
}

/**
 * Simulate executeStrategy via eth_call (no state committed).
 * More accurate than simulateBatch alone because it includes vault cap checks.
 */
export async function simulateStrategy(
  strategyAddress: Address,
  data: Hex,
  assetAmount: bigint,
): Promise<void> {
  const client = getPublicClient();
  const account = getAccount();

  // This will revert with a reason if caps are exceeded or batch fails
  await client.simulateContract({
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "executeStrategy",
    args: [strategyAddress, data, assetAmount],
    account: account.address,
  });
}

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
    chain: base,
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "registerAgent",
    args: [pkpAddress, operatorEOA, maxPerTx, dailyLimit],
  });
}

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

  const [totalAssets, caps, agentCount, dailySpend] = await Promise.all([
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
  ]);

  return {
    address: vaultAddress,
    totalAssets: formatUnits(totalAssets, 6),
    syndicateCaps: {
      maxPerTx: formatUnits(caps.maxPerTx, 6),
      maxDailyTotal: formatUnits(caps.maxDailyTotal, 6),
      maxBorrowRatio: `${(Number(caps.maxBorrowRatio) / 100).toFixed(1)}%`,
    },
    agentCount,
    dailySpendTotal: formatUnits(dailySpend, 6),
  };
}
