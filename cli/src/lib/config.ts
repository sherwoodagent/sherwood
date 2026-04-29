/**
 * Local config management — ~/.sherwood/config.json
 *
 * Stores group ID cache, per-chain contract addresses, and wallet config.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const CONFIG_DIR = path.join(os.homedir(), ".sherwood");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DASHBOARD_BRIDGE_PATH = path.join(CONFIG_DIR, "dashboard.json");

/** Per-chain user-specific addresses (stored by chainId). */
export interface ChainContracts {
  vault?: string; // user's default vault address
}

/** A syndicate the agent belongs to (creator or member). */
export interface SyndicateMembership {
  subdomain: string;
  vault: string;
  role: "creator" | "agent";
}

export interface SherwoodConfig {
  dbEncryptionKey?: string; // legacy — no longer used, XMTP CLI manages its own DB
  privateKey?: string; // wallet private key (0x-prefixed)
  xmtpInboxId?: string;
  groupCache: Record<string, string>; // subdomain → XMTP group ID
  veniceApiKey?: string; // Venice AI inference API key
  anthropicApiKey?: string; // Anthropic Claude API key (for LLM judge)
  agentId?: number; // ERC-8004 identity token ID
  contracts?: Record<string, ChainContracts>; // chainId → user addresses
  syndicates?: Record<string, SyndicateMembership[]>; // chainId → syndicate memberships
  primarySyndicate?: Record<string, string>; // chainId → subdomain of the active syndicate
  rpc?: Record<string, string>; // network name → custom RPC URL
  notifyTo?: string; // destination for cron summaries (Telegram chat ID, phone, etc.)
  uniswapApiKey?: string; // Uniswap Trading API key (from developers.uniswap.org)
  positions?: unknown[];        // open trade positions (typed in positions.ts)
  closedPositions?: unknown[];  // historical closed positions
  _xmtpMigrated?: boolean;     // one-time flag: revoked stale installations from ~/.xmtp/ era
  /** Cached swap routes per chain: chainId → { tokenPair → SwapRoute } */
  swapRoutes?: Record<string, Record<string, SwapRoute>>;
}

/** Persisted swap route detected by the CLI during portfolio strategy proposal. */
export interface SwapRoute {
  mode: "direct" | "multi-hop";
  feeTier: number;                  // direct pool fee tier
  hop?: { via: string; feeIn: number; feeOut: number }; // multi-hop details
  detectedAt: number;               // unix timestamp
}

export function loadConfig(): SherwoodConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (!config.groupCache) config.groupCache = {};
    return config;
  }

  return { groupCache: {} };
}

export function saveConfig(config: SherwoodConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  writeDashboardBridge(config);
}

/**
 * Public-safe derivation of config.json for Hermes dashboard plugins to read.
 * Excludes privateKey + every other sensitive field. Hermes' sherwood-companion
 * plugin reads ~/.sherwood/dashboard.json to auto-detect the operator's
 * primary syndicate without prompting.
 *
 * Wrapped in try/catch — bridge-write failure must not break a config save.
 */
function writeDashboardBridge(config: SherwoodConfig): void {
  try {
    let agentWallet: string | null = null;
    if (config.privateKey) {
      const key = config.privateKey.startsWith("0x")
        ? (config.privateKey as `0x${string}`)
        : (`0x${config.privateKey}` as `0x${string}`);
      agentWallet = privateKeyToAccount(key).address;
    }
    const bridge = {
      version: 1,
      agentWallet,
      syndicates: config.syndicates ?? {},
      primarySyndicate: config.primarySyndicate ?? {},
    };
    fs.writeFileSync(
      DASHBOARD_BRIDGE_PATH,
      JSON.stringify(bridge, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // Non-fatal: plugin will fall back to manual subdomain entry.
  }
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

export function invalidateCachedGroupId(subdomain: string): void {
  const config = loadConfig();
  if (config.groupCache[subdomain]) {
    delete config.groupCache[subdomain];
    saveConfig(config);
  }
}

export function setVeniceApiKey(apiKey: string): void {
  const config = loadConfig();
  config.veniceApiKey = apiKey;
  saveConfig(config);
}

export function getVeniceApiKey(): string | undefined {
  return loadConfig().veniceApiKey ?? process.env.VENICE_API_KEY;
}

// ── Anthropic API Key ──

export function setAnthropicApiKey(apiKey: string): void {
  const config = loadConfig();
  config.anthropicApiKey = apiKey;
  saveConfig(config);
}

export function getAnthropicApiKey(): string | undefined {
  return loadConfig().anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
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

// ── Syndicate Membership ──

/**
 * Add (or update) a syndicate membership. Deduplicates by subdomain.
 * Automatically sets it as primary if it's the first syndicate on this chain.
 */
export function addSyndicate(
  chainId: number,
  membership: SyndicateMembership,
): void {
  const config = loadConfig();
  const cid = String(chainId);
  if (!config.syndicates) config.syndicates = {};
  if (!config.syndicates[cid]) config.syndicates[cid] = [];

  // Upsert — replace existing entry with same subdomain
  const idx = config.syndicates[cid].findIndex(
    (s) => s.subdomain === membership.subdomain,
  );
  if (idx >= 0) {
    config.syndicates[cid][idx] = membership;
  } else {
    config.syndicates[cid].push(membership);
  }

  // Auto-set as primary if it's the first syndicate (or no primary set)
  if (!config.primarySyndicate) config.primarySyndicate = {};
  if (!config.primarySyndicate[cid]) {
    config.primarySyndicate[cid] = membership.subdomain;
  }

  saveConfig(config);
}

/** Get all syndicate memberships for a chain. */
export function getSyndicates(chainId: number): SyndicateMembership[] {
  const config = loadConfig();
  return config.syndicates?.[String(chainId)] ?? [];
}

/** Set which syndicate is the active/primary one for CLI commands. */
export function setPrimarySyndicate(
  chainId: number,
  subdomain: string,
): void {
  const config = loadConfig();
  if (!config.primarySyndicate) config.primarySyndicate = {};
  config.primarySyndicate[String(chainId)] = subdomain;
  saveConfig(config);
}

/**
 * Get the primary syndicate for this chain.
 * Falls back to ChainContracts.vault for backwards compat with older configs.
 */
export function getPrimarySyndicate(
  chainId: number,
): SyndicateMembership | undefined {
  const config = loadConfig();
  const cid = String(chainId);

  // Check new syndicates store first
  const primarySubdomain = config.primarySyndicate?.[cid];
  if (primarySubdomain && config.syndicates?.[cid]) {
    const found = config.syndicates[cid].find(
      (s) => s.subdomain === primarySubdomain,
    );
    if (found) return found;
  }

  // Backwards compat: if syndicates list has entries but no primary, use the first one
  if (config.syndicates?.[cid]?.length) {
    return config.syndicates[cid][0];
  }

  // Legacy fallback: config only has a vault address, no subdomain
  const vault = config.contracts?.[cid]?.vault;
  if (vault) {
    return { subdomain: "", vault, role: "creator" };
  }

  return undefined;
}

// ── Swap Route Cache ──

function swapRouteKey(asset: string, token: string): string {
  return `${asset.toLowerCase()}→${token.toLowerCase()}`;
}

/** Get a cached swap route for a token pair on a chain. */
export function getCachedSwapRoute(chainId: number, asset: string, token: string): SwapRoute | undefined {
  const config = loadConfig();
  return config.swapRoutes?.[String(chainId)]?.[swapRouteKey(asset, token)];
}

/** Save a detected swap route to the config cache. */
export function cacheSwapRoute(chainId: number, asset: string, token: string, route: SwapRoute): void {
  const config = loadConfig();
  const cid = String(chainId);
  if (!config.swapRoutes) config.swapRoutes = {};
  if (!config.swapRoutes[cid]) config.swapRoutes[cid] = {};
  config.swapRoutes[cid][swapRouteKey(asset, token)] = route;
  saveConfig(config);
}

/** Clear all cached swap routes for a chain (e.g. after pool migration). */
export function clearSwapRoutes(chainId: number): void {
  const config = loadConfig();
  delete config.swapRoutes?.[String(chainId)];
  saveConfig(config);
}
