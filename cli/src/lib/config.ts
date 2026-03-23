/**
 * Local config management — ~/.sherwood/config.json
 *
 * Stores group ID cache, per-chain contract addresses, and wallet config.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".sherwood");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/** Per-chain user-specific addresses (stored by chainId). */
export interface ChainContracts {
  vault?: string; // user's default vault address
}

export interface SherwoodConfig {
  dbEncryptionKey?: string; // legacy — no longer used, XMTP CLI manages its own DB
  privateKey?: string; // wallet private key (0x-prefixed)
  xmtpInboxId?: string;
  groupCache: Record<string, string>; // subdomain → XMTP group ID
  veniceApiKey?: string; // Venice AI inference API key
  agentId?: number; // ERC-8004 identity token ID
  contracts?: Record<string, ChainContracts>; // chainId → user addresses
  rpc?: Record<string, string>; // network name → custom RPC URL
  notifyTo?: string; // destination for cron summaries (Telegram chat ID, phone, etc.)
  uniswapApiKey?: string; // Uniswap Trading API key (from developers.uniswap.org)
  positions?: unknown[];        // open trade positions (typed in positions.ts)
  closedPositions?: unknown[];  // historical closed positions
}

export function loadConfig(): SherwoodConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  }

  return { groupCache: {} };
}

export function saveConfig(config: SherwoodConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function cacheGroupId(subdomain: string, groupId: string): void {
  const config = loadConfig();
  config.groupCache[subdomain] = groupId;
  saveConfig(config);
}

export function getCachedGroupId(subdomain: string): string | undefined {
  const config = loadConfig();
  return config.groupCache[subdomain];
}

export function setVeniceApiKey(apiKey: string): void {
  const config = loadConfig();
  config.veniceApiKey = apiKey;
  saveConfig(config);
}

export function getVeniceApiKey(): string | undefined {
  return loadConfig().veniceApiKey ?? process.env.VENICE_API_KEY;
}

export function setAgentId(agentId: number): void {
  const config = loadConfig();
  config.agentId = agentId;
  saveConfig(config);
}

export function getAgentId(): number | undefined {
  return loadConfig().agentId;
}

export function setPrivateKey(key: string): void {
  const config = loadConfig();
  config.privateKey = key.startsWith("0x") ? key : `0x${key}`;
  saveConfig(config);
}

export function getPrivateKey(): string | undefined {
  return loadConfig().privateKey;
}

// ── Uniswap Trading API Key ──

export function setUniswapApiKey(apiKey: string): void {
  const config = loadConfig();
  config.uniswapApiKey = apiKey;
  saveConfig(config);
}

export function getUniswapApiKey(): string | undefined {
  return loadConfig().uniswapApiKey ?? process.env.UNISWAP_API_KEY;
}

// ── Per-network RPC URLs ──

export function getConfigRpcUrl(network: string): string | undefined {
  return loadConfig().rpc?.[network];
}

export function setConfigRpcUrl(network: string, url: string): void {
  const config = loadConfig();
  if (!config.rpc) config.rpc = {};
  config.rpc[network] = url;
  saveConfig(config);
}

// ── Per-chain contract addresses ──

export function getChainContracts(chainId: number): ChainContracts {
  const config = loadConfig();
  return config.contracts?.[String(chainId)] ?? {};
}

export function getNotifyTo(): string | undefined {
  return loadConfig().notifyTo;
}

export function setNotifyTo(id: string): void {
  const config = loadConfig();
  config.notifyTo = id;
  saveConfig(config);
}

export function setChainContract(
  chainId: number,
  key: keyof ChainContracts,
  value: string,
): void {
  const config = loadConfig();
  if (!config.contracts) config.contracts = {};
  const cid = String(chainId);
  if (!config.contracts[cid]) config.contracts[cid] = {};
  config.contracts[cid][key] = value;
  saveConfig(config);
}
