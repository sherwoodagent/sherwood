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

import { getAccount } from "./client.js";
import { setVeniceApiKey, getVeniceApiKey } from "./config.js";

const VENICE_API_BASE = "https://api.venice.ai/api/v1";

/**
 * Provision a Venice API key via web3 wallet signature.
 * The wallet must hold sVVV for this to succeed.
 */
export async function provisionApiKey(): Promise<string> {
  const account = getAccount();

  // 1. Get validation token
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
    headers: { "Content-Type": "application/json" },
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

  const res = await fetch(`${VENICE_API_BASE}/chat/completions`, {
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
    throw new Error(`Venice inference failed: ${res.status} ${errBody}`);
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
