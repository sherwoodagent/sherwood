/**
 * x402 fetch wrapper — wraps native fetch with automatic USDC micropayments.
 *
 * Uses the Coinbase x402 protocol: when a server responds 402 Payment Required,
 * the wrapper automatically signs a USDC payment on Base and retries the request.
 * The agent pays from its own wallet — no vault interaction needed.
 *
 * Singleton pattern matching client.ts — cached after first creation.
 */

import { getAccount } from "./client.js";

let _x402Fetch: typeof fetch | null = null;

/**
 * Returns a fetch function that automatically handles x402 (402 Payment Required)
 * responses by signing USDC micropayments on Base.
 *
 * Lazily initializes the x402 client on first call and caches it.
 * Uses dynamic imports so @x402 packages are only loaded when research commands run.
 */
export async function getX402Fetch(): Promise<typeof fetch> {
  if (_x402Fetch) return _x402Fetch;

  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const signer = getAccount();
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  _x402Fetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  return _x402Fetch;
}

/**
 * Reset cached x402 fetch. Required for tests that change accounts.
 */
export function resetX402Fetch(): void {
  _x402Fetch = null;
}

// ── x402 USDC balance check ──

/** USDC on Base mainnet. */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** Minimum USDC balance (in 6-decimal units) to consider x402 available. $0.50 */
const MIN_USDC_BALANCE = 500_000n; // 0.50 USDC (6 decimals)

/** Cache: { balance, timestamp }. Refreshed at most once per scan cycle. */
let _balanceCache: { available: boolean; timestamp: number } | null = null;
const BALANCE_CACHE_TTL_MS = 60_000; // 1 minute — covers a full scan cycle

/**
 * Check whether the cron wallet has enough USDC on Base to pay for x402 requests.
 * Result is cached for 60s so we only make one RPC call per scan cycle.
 * On RPC error, returns true (assume available — don't break scoring).
 */
export async function isX402WalletFunded(): Promise<boolean> {
  // Return cached result if fresh
  if (_balanceCache && Date.now() - _balanceCache.timestamp < BALANCE_CACHE_TTL_MS) {
    return _balanceCache.available;
  }

  try {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");

    const account = getAccount();
    const client = createPublicClient({
      chain: base,
      transport: http("https://base-rpc.publicnode.com"),
    });

    // ERC-20 balanceOf(address) — minimal ABI
    const balance = await client.readContract({
      address: BASE_USDC_ADDRESS,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [account.address],
    });

    const available = (balance as bigint) >= MIN_USDC_BALANCE;
    _balanceCache = { available, timestamp: Date.now() };
    return available;
  } catch (err) {
    // RPC failure — assume funded so we don't break scoring
    console.error(`x402 balance check failed (assuming available): ${(err as Error).message}`);
    _balanceCache = { available: true, timestamp: Date.now() };
    return true;
  }
}

/** Reset balance cache — for tests. */
export function resetBalanceCache(): void {
  _balanceCache = null;
}
