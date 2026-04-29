/**
 * Anthropic Claude API wrapper for the LLM judge layer.
 *
 * Thin wrapper around @anthropic-ai/sdk matching the pattern of venice.ts.
 * API key sourced from ANTHROPIC_API_KEY env var or ~/.sherwood/config.json.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicApiKey } from "./config.js";

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("No Anthropic API key configured. Run 'sherwood config set --anthropic-api-key <key>' first.");
  }
  if (!_client) {
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export interface JudgeCompletionOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface JudgeCompletionResult {
  content: string;
  usage: { input: number; output: number };
}

/**
 * Call Anthropic Claude for a judge verdict.
 * Hard timeout per call (default 8s) — caller wraps in fallback.
 */
export async function judgeCompletion(opts: JudgeCompletionOptions): Promise<JudgeCompletionResult> {
  const client = getClient();
  const timeout = opts.timeoutMs ?? 8_000;

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 400,
    temperature: opts.temperature ?? 0.1,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  }, {
    signal: AbortSignal.timeout(timeout),
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    content: text,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}
