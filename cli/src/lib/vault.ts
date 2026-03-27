/**
 * SyndicateVault contract wrapper.
 *
 * The vault is the onchain identity — it holds all positions via delegatecall
 * to a shared BatchExecutorLib. No separate executor contract needed.
 */

import type { Address, Hex } from "viem";
import { formatUnits, parseEther } from "viem";
import { getChain } from "./network.js";
import {
  getPublicClient,
  getAccount,
  getWalletClient,
  writeContractWithRetry,
  waitForReceipt,
} from "./client.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI } from "./abis.js";
import type { BatchCall } from "./batch.js";
import { getChainContracts } from "./config.js";
import { TOKENS } from "./addresses.js";

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

// ── WETH ABI (for auto-wrapping ETH) ──

const WETH_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

// ── Pre-flight Checks ──

/**
 * Validate that a deposit can succeed before submitting any transactions.
 * Throws descriptive errors if any pre-condition fails.
 */
export async function preflightDeposit(amount: bigint): Promise<void> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();
  const account = getAccount();
  const asset = await getAssetAddress();
  const decimals = await getAssetDecimals();

  // 1. Check asset balance
  const balance = (await client.readContract({
    address: asset,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  if (balance < amount) {
    const symbol = (await client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: "symbol",
    })) as string;
    throw new Error(
      `Insufficient ${symbol}. Have ${formatUnits(balance, decimals)}, need ${formatUnits(amount, decimals)}.`,
    );
  }

  // 2. Check ETH for gas
  const ethBalance = await client.getBalance({ address: account.address });
  const minGas = parseEther("0.0005");
  if (ethBalance < minGas) {
    throw new Error(
      `Insufficient ETH for gas. Have ${formatUnits(ethBalance, 18)} ETH, need at least 0.0005 ETH. Top up your wallet with ETH on Base.`,
    );
  }

  // 3. Check vault not paused
  const paused = (await client.readContract({
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "paused",
  })) as boolean;
  if (paused) {
    throw new Error("Vault is paused — deposits are temporarily disabled.");
  }

  // 4. Check deposits not locked (active proposal blocks deposits)
  const locked = (await client.readContract({
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "redemptionsLocked",
  })) as boolean;
  if (locked) {
    throw new Error(
      "Deposits are locked while a strategy is executing. Wait for the proposal to be settled.",
    );
  }

  // 5. Check depositor approval (if whitelist vault)
  const openDeposits = (await client.readContract({
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "openDeposits",
  })) as boolean;
  if (!openDeposits) {
    const approved = (await client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "isApprovedDepositor",
      args: [account.address],
    })) as boolean;
    if (!approved) {
      throw new Error(
        "Your address is not an approved depositor. Ask the vault creator to approve you:\n  sherwood syndicate approve-depositor --depositor " +
        account.address,
      );
    }
  }
}

// ── LP Functions ──

/**
 * Deposit into the vault with optional ETH auto-wrapping for WETH vaults.
 * When `useEth` is true and the vault asset is WETH, wraps ETH first.
 */
export async function depositWithEthWrap(amount: bigint): Promise<Hex> {
  const client = getPublicClient();
  const account = getAccount();
  const asset = await getAssetAddress();
  const wethAddress = TOKENS().WETH;

  if (asset.toLowerCase() !== wethAddress.toLowerCase()) {
    throw new Error("--use-eth is only supported for WETH vaults.");
  }

  // Check current WETH balance — only wrap the shortfall
  const wethBalance = (await client.readContract({
    address: wethAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  if (wethBalance < amount) {
    const shortfall = amount - wethBalance;

    // Verify sufficient ETH to cover shortfall + gas
    const ethBalance = await client.getBalance({ address: account.address });
    const minGas = parseEther("0.0005");
    if (ethBalance < shortfall + minGas) {
      throw new Error(
        `Insufficient ETH. Have ${formatUnits(ethBalance, 18)} ETH, need ${formatUnits(shortfall, 18)} to wrap + gas.`,
      );
    }

    // Wrap ETH → WETH
    const wallet = getWalletClient();
    const wrapHash = await wallet.writeContract({
      address: wethAddress,
      abi: WETH_ABI,
      functionName: "deposit",
      args: [],
      value: shortfall,
      account,
      chain: getChain(),
    });
    await client.waitForTransactionReceipt({ hash: wrapHash });
  }

  // Proceed with normal deposit
  return deposit(amount);
}

/**
 * Deposit into the vault. Handles approval + deposit for the vault's asset.
 */
export async function deposit(amount: bigint): Promise<Hex> {
  const client = getPublicClient();
  const vaultAddress = getVaultAddress();
  const account = getAccount();
  const asset = await getAssetAddress();

  // Check existing allowance — skip approve if sufficient
  const currentAllowance = (await client.readContract({
    address: asset,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, vaultAddress],
  })) as bigint;

  if (currentAllowance < amount) {
    const approveHash = await writeContractWithRetry({
      account,
      chain: getChain(),
      address: asset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, amount],
    });
    // Wait for approve to confirm before deposit — prevents nonce collision
    await waitForReceipt(approveHash);
  }

  // Deposit — retry wrapper handles nonce/gas automatically
  const depositHash = await writeContractWithRetry({
    account,
    chain: getChain(),
    address: vaultAddress,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "deposit",
    args: [amount, account.address],
  });
  await waitForReceipt(depositHash);
  return depositHash;
}

// ── Batch Execution ──

/**
 * Execute a batch of protocol calls through the vault (owner only).
 * The vault delegatecalls to the executor lib.
 * All calls execute as the vault — positions live on the vault.
 */
export async function executeBatch(calls: BatchCall[]): Promise<Hex> {
  const hash = await writeContractWithRetry({
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
  await waitForReceipt(hash);
  return hash;
}

// ── Depositor Management ──

/**
 * Approve a depositor address (owner only).
 */
export async function approveDepositor(depositor: Address): Promise<Hex> {
  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositor",
    args: [depositor],
  });
  await waitForReceipt(hash);
  return hash;
}

/**
 * Remove a depositor from the whitelist (owner only).
 */
export async function removeDepositor(depositor: Address): Promise<Hex> {
  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "removeDepositor",
    args: [depositor],
  });
  await waitForReceipt(hash);
  return hash;
}

/**
 * Approve multiple depositors in a batch (owner only).
 */
export async function approveDepositors(depositors: Address[]): Promise<Hex> {
  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "approveDepositors",
    args: [depositors],
  });
  await waitForReceipt(hash);
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
  const hash = await writeContractWithRetry({
    account: getAccount(),
    chain: getChain(),
    address: getVaultAddress(),
    abi: SYNDICATE_VAULT_ABI,
    functionName: "registerAgent",
    args: [agentId, agentAddress],
  });
  await waitForReceipt(hash);
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
