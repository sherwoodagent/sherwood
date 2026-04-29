/**
 * Tests for Venice inference retry logic.
 *
 * The retry wrapper around `chatCompletion`'s HTTP call retries on
 * 429 / 5xx / network errors with 1s → 2s → 4s ±20% backoff, 3 attempts max.
 * Client errors (4xx) and AbortError propagate immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetKey } = vi.hoisted(() => ({
  mockGetKey: vi.fn<() => string | undefined>().mockReturnValue("test-key"),
}));

vi.mock("./config.js", () => ({
  getVeniceApiKey: mockGetKey,
  setVeniceApiKey: vi.fn(),
}));

vi.mock("./client.js", () => ({
  getAccount: vi.fn(() => ({ address: "0x0", signMessage: vi.fn() })),
}));

import { chatCompletion } from "./venice.js";

// Build a minimal Response-like object that the wrapper accepts.
function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

function errResponse(status: number, body = "error"): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    text: async () => body,
    json: async () => ({ error: body }),
  } as unknown as Response;
}

const goodPayload = {
  choices: [{ message: { content: "hello" } }],
  model: "llama-3.3-70b",
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

// Helper: advance fake timers through each scheduled setTimeout so awaited
// sleeps resolve. `runAllTimersAsync` advances time in a way that resolves
// pending microtasks between timers.
async function flushRetryDelays() {
  await vi.runAllTimersAsync();
}

describe("chatCompletion retry wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKey.mockReturnValue("test-key");
    // Silence the dim retry log in tests
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("succeeds on first attempt → no retries", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse(goodPayload));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on 429 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(okResponse(goodPayload));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    });

    await flushRetryDelays();
    const result = await promise;

    expect(result.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after 3 attempts when 429 persists", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429, "rate limited"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e) => e);

    await flushRetryDelays();
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 400 client errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errResponse(400, "bad request"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chatCompletion({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 / 403 / 404 / 422 client errors", async () => {
    for (const status of [401, 403, 404, 422]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(errResponse(status, "client"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        chatCompletion({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow(new RegExp(`${status}`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retries on 5xx (503) then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503, "unavailable"))
      .mockResolvedValueOnce(okResponse(goodPayload));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    });
    await flushRetryDelays();
    const result = await promise;

    expect(result.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on network-class TypeError then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse(goodPayload));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    });
    await flushRetryDelays();
    const result = await promise;

    expect(result.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on cause.code = ECONNRESET then succeeds", async () => {
    vi.useFakeTimers();
    const netErr = new Error("socket hang up");
    (netErr as Error & { cause: { code: string } }).cause = { code: "ECONNRESET" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(okResponse(goodPayload));
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    });
    await flushRetryDelays();
    const result = await promise;

    expect(result.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on AbortError (user/timeout abort)", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const fetchMock = vi.fn().mockRejectedValueOnce(abort);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chatCompletion({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(DOMException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses 1s / 2s / 4s backoff with ±20% jitter", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429, "rl"));
    vi.stubGlobal("fetch", fetchMock);

    // Track setTimeout delays (ignore AbortSignal.timeout internals by only
    // capturing the first two sleeps between 3 fetches).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const promise = chatCompletion({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e) => e);

    await flushRetryDelays();
    await promise;

    // Inspect only the sleeps we scheduled — they will be the "round" delays
    // in the 800–1200 / 1600–2400 range (1s ±20% and 2s ±20%).
    const sleepDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((d) => typeof d === "number" && d >= 500 && d <= 5000);

    // Two backoff sleeps (between 3 attempts).
    expect(sleepDelays.length).toBeGreaterThanOrEqual(2);
    const [first, second] = sleepDelays;
    expect(first).toBeGreaterThanOrEqual(800);
    expect(first).toBeLessThanOrEqual(1200);
    expect(second).toBeGreaterThanOrEqual(1600);
    expect(second).toBeLessThanOrEqual(2400);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when API key missing (no retry path hit)", async () => {
    mockGetKey.mockReturnValueOnce(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chatCompletion({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/No Venice API key/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
