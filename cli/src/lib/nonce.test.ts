/**
 * Tests for nonce management: stuck detection, gas bumping, retry logic.
 *
 * Unit tests that mock viem at the transport layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hex } from "viem";

// ── Test the pure logic extracted from client.ts ──
// We test the exported helpers by mocking the underlying viem client calls.

// Mock getPublicClient, getWalletClient, getAccount at module level
const mockGetTransactionCount = vi.fn<(args: { address: string; blockTag: string }) => Promise<number>>();
const mockEstimateFeesPerGas = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();
const mockSendTransaction = vi.fn<(args: Record<string, unknown>) => Promise<Hex>>();
const mockWriteContract = vi.fn<(args: Record<string, unknown>) => Promise<Hex>>();

const TEST_ADDRESS = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionCount: mockGetTransactionCount,
      estimateFeesPerGas: mockEstimateFeesPerGas,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
      chain: { id: 8453 },
    }),
    createWalletClient: () => ({
      sendTransaction: mockSendTransaction,
      writeContract: mockWriteContract,
      chain: { id: 8453 },
    }),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: TEST_ADDRESS,
  }),
}));

vi.mock("./network.js", () => ({
  getChain: () => ({ id: 8453, name: "Base" }),
  getRpcUrl: () => "https://mainnet.base.org",
  getRpcUrls: () => ["https://mainnet.base.org"],
}));

vi.mock("./config.js", () => ({
  loadConfig: () => ({ privateKey: "0x" + "ab".repeat(32) }),
}));

// Use fake timers to avoid real delays in detectStuckNonce staleness check and retry backoff
vi.useFakeTimers();

// Import after mocks
const clientModule = await import("./client.js");

// ── Setup ──

const BASE_FEES = {
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 100000000n,
};

beforeEach(() => {
  vi.clearAllMocks();
  clientModule.resetClients();
  mockEstimateFeesPerGas.mockResolvedValue(BASE_FEES);
  mockWaitForTransactionReceipt.mockResolvedValue({
    status: "success",
    transactionHash: "0xabc" as Hex,
  });
});

/**
 * Helper: advance fake timers while a promise is pending.
 * Repeatedly ticks to resolve any setTimeout-based delays.
 */
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  let result: T | undefined;
  let error: unknown;
  let done = false;

  promise.then(
    (r) => { result = r; done = true; },
    (e) => { error = e; done = true; },
  );

  // Keep advancing timers until the promise resolves
  while (!done) {
    await vi.advanceTimersByTimeAsync(5000);
  }

  if (error !== undefined) throw error;
  return result as T;
}

// ── detectStuckNonce ──

describe("detectStuckNonce", () => {
  it("returns null when pending == confirmed (no stuck tx)", async () => {
    mockGetTransactionCount.mockResolvedValue(5);
    const result = await runWithTimers(clientModule.detectStuckNonce());
    expect(result).toBeNull();
  });

  it("returns stuck nonce when pending > confirmed (persists after staleness check)", async () => {
    mockGetTransactionCount.mockImplementation(async (args) => {
      if (args.blockTag === "latest") return 5;
      if (args.blockTag === "pending") return 7;
      return 5;
    });
    const result = await runWithTimers(clientModule.detectStuckNonce());
    expect(result).toBe(5);
    // Should have been called 4 times: 2 for initial check + 2 for staleness re-check
    expect(mockGetTransactionCount).toHaveBeenCalledTimes(4);
  });

  it("returns null on false positive (gap resolves after delay)", async () => {
    let callCount = 0;
    mockGetTransactionCount.mockImplementation(async (args) => {
      callCount++;
      // First check: pending > confirmed (looks stuck)
      if (callCount <= 2) {
        return args.blockTag === "latest" ? 5 : 7;
      }
      // Second check after delay: gap resolved (tx confirmed)
      return 7;
    });
    const result = await runWithTimers(clientModule.detectStuckNonce());
    expect(result).toBeNull();
  });
});

// ── unstickWallet ──

describe("unstickWallet", () => {
  it("sends a 0-value self-transfer at the stuck nonce with 5x gas", async () => {
    mockGetTransactionCount.mockImplementation(async (args) => {
      if (args.blockTag === "latest") return 3;
      if (args.blockTag === "pending") return 5;
      return 3;
    });
    mockSendTransaction.mockResolvedValue("0xunstick_hash" as Hex);

    // unstickWallet loops — after first unstick it calls detectStuckNonce again.
    // We need it to eventually return clean. Simulate: stuck on first few calls, then clean.
    let txCount = 0;
    mockSendTransaction.mockImplementation(async () => {
      txCount++;
      // After each unstick, the next detectStuckNonce should see clean state
      // Override mockGetTransactionCount to return clean after first unstick
      mockGetTransactionCount.mockResolvedValue(5);
      return `0xunstick_${txCount}` as Hex;
    });

    const hashes = await runWithTimers(clientModule.unstickWallet());

    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toBe("0xunstick_1");

    // Verify 5x gas multiplier: base * 1.2 (buffer) * 5 = 6x base
    const txParams = mockSendTransaction.mock.calls[0][0] as Record<string, bigint>;
    expect(txParams.to).toBe(TEST_ADDRESS);
    expect(txParams.value).toBe(0n);
    expect(txParams.nonce).toBe(3);
    // maxFeePerGas should be: 1000000000 * 120/100 * 5 = 6000000000
    expect(txParams.maxFeePerGas).toBe(6000000000n);
    expect(txParams.maxPriorityFeePerGas).toBe(600000000n);
  });

  it("clears multiple stuck nonces in a loop", async () => {
    // Simulate 3 stuck nonces: confirmed=5, pending=8
    // After each unstick, confirmed increments by 1
    let confirmed = 5;
    const pending = 8;
    let unstickCount = 0;

    mockGetTransactionCount.mockImplementation(async (args) => {
      if (args.blockTag === "latest") return confirmed;
      if (args.blockTag === "pending") return pending;
      return confirmed;
    });

    mockSendTransaction.mockImplementation(async () => {
      unstickCount++;
      // After receipt confirmation, confirmed nonce advances
      confirmed++;
      return `0xunstick_${unstickCount}` as Hex;
    });

    const hashes = await runWithTimers(clientModule.unstickWallet());

    expect(hashes).toHaveLength(3);
    expect(hashes).toEqual(["0xunstick_1", "0xunstick_2", "0xunstick_3"]);
    expect(mockSendTransaction).toHaveBeenCalledTimes(3);
  });

  it("throws when no stuck nonce is detected", async () => {
    mockGetTransactionCount.mockResolvedValue(5);
    await expect(runWithTimers(clientModule.unstickWallet())).rejects.toThrow("No stuck nonce detected");
  });

  it("handles replacement tx failure gracefully (insufficient ETH)", async () => {
    mockGetTransactionCount.mockImplementation(async (args) => {
      if (args.blockTag === "latest") return 3;
      if (args.blockTag === "pending") return 5;
      return 3;
    });
    mockSendTransaction.mockRejectedValue(new Error("insufficient funds for gas"));

    await expect(runWithTimers(clientModule.unstickWallet()))
      .rejects.toThrow("insufficient funds for gas");
  });
});

// ── writeContractWithRetry ──

describe("writeContractWithRetry", () => {
  it("succeeds on first attempt", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockWriteContract.mockResolvedValue("0xsuccess" as Hex);

    const hash = await runWithTimers(clientModule.writeContractWithRetry({ test: true }));
    expect(hash).toBe("0xsuccess");
    expect(mockWriteContract).toHaveBeenCalledOnce();
  });

  it("retries and bumps gas on 'replacement transaction underpriced'", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockWriteContract
      .mockRejectedValueOnce(new Error("replacement transaction underpriced"))
      .mockResolvedValueOnce("0xretried" as Hex);

    const hash = await runWithTimers(clientModule.writeContractWithRetry({ test: true }));

    expect(hash).toBe("0xretried");
    expect(mockWriteContract).toHaveBeenCalledTimes(2);

    // Second call should have bumped fees (110% of buffered)
    const firstCall = mockWriteContract.mock.calls[0][0] as Record<string, bigint>;
    const secondCall = mockWriteContract.mock.calls[1][0] as Record<string, bigint>;
    expect(secondCall.maxFeePerGas).toBeGreaterThan(firstCall.maxFeePerGas);
    expect(secondCall.maxPriorityFeePerGas).toBeGreaterThan(firstCall.maxPriorityFeePerGas);
  });

  it("refreshes nonce on 'nonce too low'", async () => {
    let nonceCallCount = 0;
    mockGetTransactionCount.mockImplementation(async () => {
      nonceCallCount++;
      // First 2 calls are detectStuckNonce (latest + pending = both 10, not stuck → no re-check)
      // Third call is the initial nonce fetch = 10
      // Fourth+fifth calls are the retry's detectStuckNonce re-check (not stuck)
      // ... then refreshed nonce = 11
      if (nonceCallCount <= 3) return 10;
      return 11;
    });

    mockWriteContract
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce("0xfresh_nonce" as Hex);

    const hash = await runWithTimers(clientModule.writeContractWithRetry({ test: true }));

    expect(hash).toBe("0xfresh_nonce");
    const secondCall = mockWriteContract.mock.calls[1][0] as Record<string, number>;
    expect(secondCall.nonce).toBe(11);
  });

  it("auto-unsticks wallet before sending", async () => {
    let callCount = 0;
    mockGetTransactionCount.mockImplementation(async (args) => {
      callCount++;
      // First 4 calls: detectStuckNonce initial + re-check (stuck both times)
      // Then unstickWalletSingle calls detectStuckNonce again (4 more calls, stuck)
      // After unstick receipt, next detectStuckNonce loop check returns clean
      if (callCount <= 8) {
        return args.blockTag === "latest" ? 5 : 7;
      }
      // Post-unstick: all clean
      return 6;
    });

    mockSendTransaction.mockResolvedValue("0xunstick" as Hex);
    mockWriteContract.mockResolvedValue("0xactual_tx" as Hex);

    const hash = await runWithTimers(clientModule.writeContractWithRetry({ test: true }));

    expect(hash).toBe("0xactual_tx");
    expect(mockSendTransaction).toHaveBeenCalledOnce(); // unstick self-transfer
  });

  it("throws after exhausting retries", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockWriteContract.mockRejectedValue(new Error("replacement transaction underpriced"));

    await expect(runWithTimers(clientModule.writeContractWithRetry({ test: true })))
      .rejects.toThrow("A previous transaction is stuck");

    // MAX_RETRIES = 3, so 4 total attempts (0,1,2,3)
    expect(mockWriteContract).toHaveBeenCalledTimes(4);
  });

  it("does not retry on non-retryable errors", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockWriteContract.mockRejectedValue(new Error("execution reverted: UNAUTHORIZED"));

    await expect(runWithTimers(clientModule.writeContractWithRetry({ test: true })))
      .rejects.toThrow("execution reverted: UNAUTHORIZED");

    expect(mockWriteContract).toHaveBeenCalledOnce();
  });
});

// ── sendTxWithRetry ──

describe("sendTxWithRetry", () => {
  it("succeeds on first attempt", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockSendTransaction.mockResolvedValue("0xtx_hash" as Hex);

    const hash = await runWithTimers(clientModule.sendTxWithRetry({ test: true }));
    expect(hash).toBe("0xtx_hash");
  });

  it("retries on NONCE_EXPIRED", async () => {
    mockGetTransactionCount.mockResolvedValue(10);
    mockSendTransaction
      .mockRejectedValueOnce(new Error("NONCE_EXPIRED"))
      .mockResolvedValueOnce("0xretried" as Hex);

    const hash = await runWithTimers(clientModule.sendTxWithRetry({ test: true }));

    expect(hash).toBe("0xretried");
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });
});

// ── estimateFeesWithBuffer ──

describe("estimateFeesWithBuffer", () => {
  it("applies 20% buffer to gas fees", async () => {
    const fees = await clientModule.estimateFeesWithBuffer();
    expect(fees.maxFeePerGas).toBe(1200000000n);
    expect(fees.maxPriorityFeePerGas).toBe(120000000n);
  });
});

// ── waitForReceipt ──

describe("waitForReceipt", () => {
  it("returns receipt on success", async () => {
    const receipt = await clientModule.waitForReceipt("0xabc" as Hex);
    expect(receipt.status).toBe("success");
  });

  it("detects stuck nonce on timeout and attempts unstick", async () => {
    mockWaitForTransactionReceipt.mockRejectedValue(new Error("Timed out while waiting"));
    mockGetTransactionCount.mockImplementation(async (args) => {
      if (args.blockTag === "latest") return 5;
      if (args.blockTag === "pending") return 7;
      return 5;
    });
    mockSendTransaction.mockImplementation(async () => {
      // After unstick, simulate nonces becoming clean
      mockGetTransactionCount.mockResolvedValue(7);
      return "0xunstick" as Hex;
    });

    // Still throws (the original tx is lost), but unstick was attempted
    await expect(runWithTimers(clientModule.waitForReceipt("0xstuck" as Hex))).rejects.toThrow("Timed out");
    expect(mockSendTransaction).toHaveBeenCalled(); // unstick attempt
  });
});
