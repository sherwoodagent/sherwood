/**
 * viem client factory — resolves chain and RPC from the network module.
 * Private key is read from ~/.sherwood/config.json (set via `sherwood config set --private-key`),
 * with PRIVATE_KEY env var as fallback.
 */

// dotenv loaded at entrypoint
import type { Hex, TransactionReceipt } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, getRpcUrl } from "./network.js";
import { loadConfig } from "./config.js";
import { formatContractError } from "./errors.js";
export { formatContractError } from "./errors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _walletClient: any = null;

/**
 * Resolve the private key: config → env → error.
 */
function getPrivateKey(): `0x${string}` {
  // 1. Config (~/.sherwood/config.json)
  const config = loadConfig();
  if (config.privateKey) {
    const k = config.privateKey;
    return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
  }

  // 2. Env var fallback
  const env = process.env.PRIVATE_KEY;
  if (env) {
    return (env.startsWith("0x") ? env : `0x${env}`) as `0x${string}`;
  }

  throw new Error(
    "Private key not found. Run 'sherwood config set --private-key <key>' or set PRIVATE_KEY env var.",
  );
}

export function getPublicClient() {
  const chain = getChain();
  // Auto-invalidate if network changed since last creation
  if (_publicClient && _publicClient.chain?.id !== chain.id) {
    _publicClient = null;
  }
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain,
      transport: http(getRpcUrl()),
    });
  }
  return _publicClient as ReturnType<typeof createPublicClient>;
}

export function getWalletClient() {
  const chain = getChain();
  // Auto-invalidate if network changed since last creation
  if (_walletClient && _walletClient.chain?.id !== chain.id) {
    _walletClient = null;
  }
  if (!_walletClient) {
    const account = privateKeyToAccount(getPrivateKey());
    _walletClient = createWalletClient({
      account,
      chain,
      transport: http(getRpcUrl()),
    });
  }
  return _walletClient as ReturnType<typeof createWalletClient>;
}

/**
 * Reset cached clients. Required for tests that call setNetwork()
 * after a client was already created.
 */
export function resetClients() {
  _publicClient = null;
  _walletClient = null;
}

export function getAccount() {
  return privateKeyToAccount(getPrivateKey());
}

/**
 * Estimate EIP-1559 fees with a 20% buffer to avoid stuck txs on Base gas spikes.
 */
export async function estimateFeesWithBuffer() {
  const client = getPublicClient();
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await client.estimateFeesPerGas();
  return {
    maxFeePerGas: (maxFeePerGas * 120n) / 100n,
    maxPriorityFeePerGas: (maxPriorityFeePerGas * 120n) / 100n,
  };
}

// ── Nonce management + retry helpers ──
//
// Handles: nonce collisions, underpriced replacements, stuck pending txs.
// Gas bump ceiling: base * 1.2 (buffer) * 1.1^3 (max retries) ≈ 1.6x base fee.

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500; // backoff between retries
const STUCK_NONCE_CONFIRM_DELAY_MS = 2500; // staleness check delay
const GAS_BUMP_NUMERATOR = 110n;
const GAS_BUMP_DENOMINATOR = 100n;

function isUnderpricedError(msg: string): boolean {
  return msg.includes("replacement transaction underpriced");
}

function isNonceStaleError(msg: string): boolean {
  return msg.includes("nonce too low") || msg.includes("NONCE_EXPIRED");
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isUnderpricedError(msg) || isNonceStaleError(msg);
}

function bumpFees(fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  return {
    maxFeePerGas: (fees.maxFeePerGas * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR,
  };
}

// ── Stuck nonce detection ──

/**
 * Check if the wallet has a stuck nonce (pending tx count > confirmed tx count).
 * Returns the stuck nonce number, or null if the wallet is clean.
 *
 * Includes a staleness guard: if pending > confirmed, waits ~2.5s and re-checks
 * to avoid false positives from propagation delays.
 */
export async function detectStuckNonce(): Promise<number | null> {
  const client = getPublicClient();
  const address = getAccount().address;
  const [confirmed, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  if (pending <= confirmed) return null;

  // Staleness guard: re-check after a short delay to avoid false positives
  await new Promise((r) => setTimeout(r, STUCK_NONCE_CONFIRM_DELAY_MS));
  const [confirmed2, pending2] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return pending2 > confirmed2 ? confirmed2 : null;
}

/**
 * Clear a single stuck nonce by sending a 0-value self-transfer with aggressively bumped gas.
 * Uses 5x the buffered fee estimate to guarantee replacement even if the original tx
 * was sent during a gas spike (EIP-1559 requires >= 110% of original maxPriorityFeePerGas).
 */
async function unstickWalletSingle(): Promise<Hex> {
  const stuckNonce = await detectStuckNonce();
  if (stuckNonce === null) {
    throw new Error("No stuck nonce detected — wallet is clean.");
  }

  console.warn(`  Unsticking wallet: replacing stuck tx at nonce ${stuckNonce}...`);
  const wallet = getWalletClient();
  const account = getAccount();

  // Use 5x gas buffer to guarantee replacement even for txs sent during gas spikes
  const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeesWithBuffer();
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: account.address,
    value: 0n,
    nonce: stuckNonce,
    maxFeePerGas: maxFeePerGas * 5n,
    maxPriorityFeePerGas: maxPriorityFeePerGas * 5n,
  });

  const client = getPublicClient();
  await client.waitForTransactionReceipt({ hash });
  console.warn(`  Wallet unstuck (nonce ${stuckNonce} replaced).`);
  return hash;
}

/**
 * Unstick a wallet by clearing ALL stuck nonces, not just the first one.
 * Loops until pending == confirmed nonce count.
 */
export async function unstickWallet(): Promise<Hex[]> {
  const hashes: Hex[] = [];
  while ((await detectStuckNonce()) !== null) {
    hashes.push(await unstickWalletSingle());
  }
  if (hashes.length === 0) {
    throw new Error("No stuck nonce detected — wallet is clean.");
  }
  return hashes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxSender = (params: any) => Promise<Hex>;

/**
 * Shared retry loop: explicit nonce + EIP-1559 fee buffer + gas-bump on underpriced errors.
 * On "nonce too low" / "NONCE_EXPIRED", re-fetches nonce from pending state before retrying.
 * Also detects stuck nonces before sending and auto-unsticks the wallet.
 */
async function withRetry(send: TxSender, txParams: Record<string, unknown>): Promise<Hex> {
  const client = getPublicClient();
  const account = getAccount();
  let fees = await estimateFeesWithBuffer();

  // Auto-detect and clear ALL stuck nonces before attempting the tx
  while ((await detectStuckNonce()) !== null) {
    await unstickWalletSingle();
  }

  let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await send({ ...txParams, ...fees, nonce });
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryableError(err)) {
        // Decode contract revert into a human-readable message before throwing
        throw new Error(formatContractError(err));
      }

      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Retry ${attempt + 1}/${MAX_RETRIES}: ${isNonceStaleError(msg) ? "refreshing nonce" : "bumping gas"}...`);

      // Backoff between retries to let mempool settle
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

      if (isNonceStaleError(msg)) {
        // Fresh nonce = fresh tx, no replacement needed — only bump fees for underpriced errors
        nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      } else {
        fees = bumpFees(fees);
      }
    }
  }
  throw new Error("withRetry: exhausted retries");
}

/**
 * Send a raw transaction with automatic gas-bump retry on nonce/underpriced errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendTxWithRetry(txParams: Record<string, any>): Promise<Hex> {
  const wallet = getWalletClient();
  return withRetry((p) => wallet.sendTransaction(p), txParams);
}

/**
 * Call writeContract with automatic gas-bump retry on nonce/underpriced errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function writeContractWithRetry(txParams: Record<string, any>): Promise<Hex> {
  const wallet = getWalletClient();
  return withRetry((p) => wallet.writeContract(p), txParams);
}

/**
 * Wait for a tx receipt. On timeout, checks for stuck nonce and auto-unsticks.
 *
 * **Important**: After unsticking, the error is still re-thrown because the original
 * tx is lost. Callers should use `writeContractWithRetry` / `sendTxWithRetry` which
 * re-fetch nonces automatically. Do NOT manually retry after this throws — use the
 * retry-aware wrappers instead.
 */
export async function waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
  const client = getPublicClient();
  try {
    return await client.waitForTransactionReceipt({ hash });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    // If receipt wait times out, check for stuck nonce
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("Timed out")) {
      if ((await detectStuckNonce()) !== null) {
        console.warn(`  Tx ${hash} appears stuck — attempting to unstick wallet...`);
        while ((await detectStuckNonce()) !== null) {
          await unstickWalletSingle();
        }
      }
    }
    throw err;
  }
}
