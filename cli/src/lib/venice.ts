/**
 * Venice AI API integration — web3 key generation, validation, and inference.
 *
 * Key provisioning flow:
 *   1. GET /api_keys/generate_web3_key → validation token
 *   2. Sign token with agent wallet (EIP-191)
 *   3. POST /api_keys/generate_web3_key → API key
 *
 * Inference:
 *   POST /chat/completions with Bearer auth → chat completion response
 *
 * The API key is stored in ~/.sherwood/config.json.
 * Venice requires the signing wallet to hold staked VVV (sVVV).
 */

import chalk from "chalk";
import { getAccount } from "./client.js";
import { setVeniceApiKey, getVeniceApiKey } from "./config.js";

const VENICE_API_BASE = "https://api.venice.ai/api/v1";

// ── Retry policy for chatCompletion ──

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAYS_MS = [1000, 2000, 4000]; // 1s, 2s, 4s
const RETRY_JITTER_PCT = 0.2; // ±20%
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Transient HTTP error raised by `chatCompletion` before retry logic kicks in.
 * Carries the response status so `shouldRetry` can inspect it.
 */
class VeniceHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Venice inference failed: ${status} ${body}`);
    this.name = "VeniceHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Decide whether a failed `chatCompletion` HTTP attempt is worth retrying.
 * Retries: 429, 5xx, and network-class errors (fetch TypeError / ECONNRESET).
 * Never retries: AbortError (user/timeout), 4xx client errors, parse errors.
 */
function shouldRetry(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // User/caller abort or outer timeout — never retry
  if (err.name === "AbortError") return false;
  if (err instanceof VeniceHttpError) {
    return RETRYABLE_STATUS.has(err.status);
  }
  // Network-class: Node's fetch surfaces these as TypeError with a cause,
  // or occasionally the cause Error carries codes like ECONNRESET/ETIMEDOUT.
  if (err instanceof TypeError) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" &&
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
      return true;
    }
  }
  return false;
}

function jitter(delayMs: number): number {
  const spread = delayMs * RETRY_JITTER_PCT;
  return Math.max(0, Math.round(delayMs + (Math.random() * 2 - 1) * spread));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Provision a Venice API key via web3 wallet signature.
 * The wallet must hold sVVV for this to succeed.
 */
export async function provisionApiKey(): Promise<string> {
  const account = getAccount();

  // 1. Get validation token (unauthenticated per Venice swagger spec)
  const tokenRes = await fetch(`${VENICE_API_BASE}/api_keys/generate_web3_key`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) {
    throw new Error(`Failed to get validation token: ${tokenRes.status} ${tokenRes.statusText}`);
  }
  const tokenData = await tokenRes.json();
  const token = tokenData?.data?.token;
  if (!token) {
    throw new Error("Venice API returned no validation token");
  }

  // 2. Sign token with wallet (EIP-191)
  const signature = await account.signMessage({ message: token });

  // 3. Generate API key
  const keyRes = await fetch(`${VENICE_API_BASE}/api_keys/generate_web3_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      address: account.address,
      signature,
      token,
      apiKeyType: "INFERENCE",
      description: "Sherwood syndicate agent",
    }),
  });

  if (!keyRes.ok) {
    const body = await keyRes.text();
    throw new Error(`Failed to generate API key: ${keyRes.status} ${body}`);
  }

  const keyData = await keyRes.json();
  const apiKey = keyData?.data?.apiKey;
  if (!apiKey) {
    throw new Error("Venice API returned no API key");
  }

  // Store in config
  setVeniceApiKey(apiKey);

  return apiKey;
}

/**
 * Check if the stored Venice API key is still valid.
 */
export async function checkApiKeyValid(): Promise<boolean> {
  const apiKey = getVeniceApiKey();
  if (!apiKey) return false;

  try {
    const res = await fetch(`${VENICE_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Inference ──

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  enableWebSearch?: boolean;
  disableThinking?: boolean;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Call Venice chat completions API for private inference.
 * Requires a provisioned API key (run `sherwood venice provision` first).
 */
export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const apiKey = getVeniceApiKey();
  if (!apiKey) {
    throw new Error("No Venice API key configured. Run 'sherwood venice provision' first.");
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const veniceParams: Record<string, unknown> = {};
  if (opts.enableWebSearch) veniceParams.enable_web_search = "on";
  if (opts.disableThinking) veniceParams.disable_thinking = true;
  if (Object.keys(veniceParams).length > 0) body.venice_parameters = veniceParams;

  // Retry loop: exponential backoff with jitter on 429/5xx and network errors.
  // Caller-provided timeouts (e.g. Promise.race in the judge) still win — if
  // the outer timeout fires before retries exhaust, the promise rejects normally.
  let lastErr: unknown;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(`${VENICE_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(120_000), // inference can be slow
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new VeniceHttpError(res.status, errBody);
      }
      lastErr = undefined;
      break; // success
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_MAX_ATTEMPTS || !shouldRetry(err)) {
        throw err;
      }
      const baseDelay = RETRY_BASE_DELAYS_MS[attempt - 1] ?? RETRY_BASE_DELAYS_MS[RETRY_BASE_DELAYS_MS.length - 1];
      const delayMs = jitter(baseDelay);
      const reason = err instanceof VeniceHttpError ? `HTTP ${err.status}` : (err as Error).message || "network";
      console.error(chalk.dim(`  [venice] retry ${attempt}/${RETRY_MAX_ATTEMPTS} after ${delayMs}ms — ${reason}`));
      await sleep(delayMs);
    }
  }

  if (!res || lastErr) {
    // Defensive — the loop either breaks on success or throws on final failure.
    throw lastErr ?? new Error("Venice inference failed: no response");
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("Venice returned no choices");
  }

  return {
    content: choice.message?.content ?? "",
    model: data.model ?? opts.model,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * List available Venice models.
 * Requires a provisioned API key.
 */
export async function listModels(): Promise<string[]> {
  const apiKey = getVeniceApiKey();
  if (!apiKey) {
    throw new Error("No Venice API key configured. Run 'sherwood venice provision' first.");
  }

  const res = await fetch(`${VENICE_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to list Venice models: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data ?? []).map((m: { id: string }) => m.id);
}
