/**
 * Venice AI API integration — web3 key generation and validation.
 *
 * Flow:
 *   1. GET /api_keys/generate_web3_key → validation token
 *   2. Sign token with agent wallet (EIP-191)
 *   3. POST /api_keys/generate_web3_key → API key
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
  const tokenRes = await fetch(`${VENICE_API_BASE}/api_keys/generate_web3_key`);
  if (!tokenRes.ok) {
    throw new Error(`Failed to get validation token: ${tokenRes.status} ${tokenRes.statusText}`);
  }
  const tokenData = await tokenRes.json();
  const token = tokenData.data.token as string;

  // 2. Sign token with wallet (EIP-191)
  const signature = await account.signMessage({ message: token });

  // 3. Generate API key
  const keyRes = await fetch(`${VENICE_API_BASE}/api_keys/generate_web3_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const apiKey = keyData.data.apiKey as string;

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
    });
    return res.ok;
  } catch {
    return false;
  }
}
