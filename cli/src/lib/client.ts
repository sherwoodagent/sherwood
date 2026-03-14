/**
 * viem client factory for Base.
 */

import "dotenv/config";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _walletClient: any = null;

function rpcUrl() {
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

export function getPublicClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl()),
    });
  }
  return _publicClient as ReturnType<typeof createPublicClient>;
}

export function getWalletClient() {
  if (!_walletClient) {
    const key = process.env.PRIVATE_KEY;
    if (!key) {
      throw new Error("PRIVATE_KEY env var is required");
    }
    const account = privateKeyToAccount(key as `0x${string}`);
    _walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl()),
    });
  }
  return _walletClient as ReturnType<typeof createWalletClient>;
}

export function getAccount() {
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error("PRIVATE_KEY env var is required");
  }
  return privateKeyToAccount(key as `0x${string}`);
}
