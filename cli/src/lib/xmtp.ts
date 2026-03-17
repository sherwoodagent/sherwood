/**
 * XMTP client and group operations for syndicate chat.
 *
 * Shells out to the @xmtp/cli binary instead of using @xmtp/node-sdk directly.
 * This avoids native binding (GLIBC) issues on Linux.
 *
 * Credentials: the sherwood private key is passed to each subprocess via the
 * XMTP_WALLET_KEY env var. We never write to ~/.xmtp/.env — the XMTP CLI
 * manages its own DB encryption key and env file. This avoids destroying
 * existing XMTP setups when agents already have the CLI configured.
 */

import { execFileSync, spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  loadConfig,
  saveConfig,
  cacheGroupId,
  getCachedGroupId,
} from "./config.js";
import { getTextRecord } from "./ens.js";
import { getNetwork } from "./network.js";
import type { ChatEnvelope } from "./types.js";
import { getAccount } from "./client.js";

// ── Types ──

export interface XmtpMessage {
  id: string;
  conversationId: string;
  senderInboxId: string;
  contentType: string;
  content: string;
  sentAt: Date;
}

export interface XmtpMember {
  inboxId: string;
  permissionLevel: string;
}

// ── Binary resolution ──

let _binaryPath: string | null = null;

function getXmtpBinaryPath(): string {
  if (_binaryPath) return _binaryPath;

  // Try local node_modules/@xmtp/cli/bin/run.js relative to this file
  const searchPaths = [
    // From dist/ after build
    path.resolve(import.meta.dirname, "..", "node_modules", "@xmtp", "cli", "bin", "run.js"),
    // From src/ during dev
    path.resolve(import.meta.dirname, "..", "..", "node_modules", "@xmtp", "cli", "bin", "run.js"),
    // From cwd
    path.resolve(process.cwd(), "node_modules", "@xmtp", "cli", "bin", "run.js"),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      _binaryPath = p;
      return _binaryPath;
    }
  }

  // Fall back to system PATH
  try {
    const which = execSync("which xmtp", { encoding: "utf8" }).trim();
    if (which) {
      _binaryPath = which;
      return _binaryPath;
    }
  } catch {
    // Not on PATH
  }

  throw new Error(
    "XMTP CLI not found. Install with: npm install -g @xmtp/cli",
  );
}

// ── Environment ──

function getXmtpEnv(): string {
  return getNetwork() === "base" ? "production" : "dev";
}

function getXmtpEnvFile(): string {
  return path.join(homedir(), ".xmtp", ".env");
}

/**
 * Ensure ~/.xmtp/.env exists with at least the wallet key and a DB encryption key.
 * If the file already exists, only update the wallet key line — preserve everything
 * else (especially XMTP_DB_ENCRYPTION_KEY). If no file exists, run `xmtp init` to
 * let the CLI generate its own keys, then patch in our wallet key.
 */
let _envReady = false;

function ensureXmtpEnv(): void {
  if (_envReady) return;

  const config = loadConfig();
  if (!config.privateKey) {
    throw new Error(
      'No private key configured. Run "sherwood config set --private-key 0x..."',
    );
  }

  const envFile = getXmtpEnvFile();
  const walletKey = config.privateKey.replace(/^0x/, "");

  if (fs.existsSync(envFile)) {
    const existing = fs.readFileSync(envFile, "utf8");
    if (existing.includes(`XMTP_WALLET_KEY=${walletKey}`)) {
      _envReady = true;
      return;
    }

    // Update wallet key while preserving all other vars (DB encryption key, etc.)
    const lines = existing.split("\n").filter((l) => !l.startsWith("XMTP_WALLET_KEY="));
    lines.push(`XMTP_WALLET_KEY=${walletKey}`);
    fs.writeFileSync(envFile, lines.filter(Boolean).join("\n") + "\n", { mode: 0o600 });
  } else {
    // No env file — let XMTP CLI generate keys via `init`, then patch wallet key
    const xmtpDir = path.join(homedir(), ".xmtp");
    fs.mkdirSync(xmtpDir, { recursive: true });

    const bin = getXmtpBinaryPath();
    const initArgs = ["init", "--env", getXmtpEnv()];
    if (bin.endsWith(".js")) {
      execFileSync("node", [bin, ...initArgs], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, XMTP_WALLET_KEY: walletKey },
      });
    } else {
      execFileSync(bin, initArgs, {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, XMTP_WALLET_KEY: walletKey },
      });
    }

    // Patch in our wallet key (init may have generated a different one)
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      const lines = content.split("\n").filter((l) => !l.startsWith("XMTP_WALLET_KEY="));
      lines.push(`XMTP_WALLET_KEY=${walletKey}`);
      fs.writeFileSync(envFile, lines.filter(Boolean).join("\n") + "\n", { mode: 0o600 });
    } else {
      // init didn't create the file — write a minimal one
      fs.writeFileSync(envFile, `XMTP_WALLET_KEY=${walletKey}\n`, { mode: 0o600 });
    }
  }

  _envReady = true;
}

// ── Subprocess runners ──

function execXmtp(args: string[]): string {
  ensureXmtpEnv();
  const bin = getXmtpBinaryPath();
  const fullArgs = [...args, "--env", getXmtpEnv(), "--env-file", getXmtpEnvFile()];

  if (bin.endsWith(".js")) {
    return execFileSync("node", [bin, ...fullArgs], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  }

  return execFileSync(bin, fullArgs, {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function execXmtpJson<T>(args: string[]): T {
  const stdout = execXmtp([...args, "--json", "--log-level", "off"]);
  return JSON.parse(stdout) as T;
}

// ── Conversation sync ──

let _conversationsSynced = false;

/**
 * Sync conversations from the network into the local XMTP DB.
 * One-shot commands (send, messages, members) spawn a fresh process
 * that may not have the group locally — this ensures it's available.
 *
 * Uses `sync-all` instead of `sync` because `sync` only refreshes
 * already-known conversations. `sync-all` also processes MLS welcome
 * messages, which is required for agents that were added to a group
 * by someone else. Only runs once per process.
 */
function syncConversations(): void {
  if (_conversationsSynced) return;
  execXmtp(["conversations", "sync-all"]);
  _conversationsSynced = true;
}

// ── Stale installation cleanup ──

/**
 * Revoke stale XMTP installations for the current wallet.
 *
 * When an agent wipes ~/.xmtp/ and re-initializes, a new MLS installation is
 * created but old ones remain registered on the network. When add-members runs,
 * the MLS welcome may target a stale installation's KeyPackage — the current
 * installation can never sync that group.
 *
 * This function detects and revokes all installations except the current one,
 * ensuring add-members targets the right installation.
 */
function revokeStaleInstallations(inboxId: string, currentInstallationId: string): void {
  try {
    // Get all installations for this inbox from the network
    const inboxStates = execXmtpJson<Array<{
      inboxId: string;
      installations: Array<{ id: string }>;
    }>>(["inbox-states", inboxId]);

    const state = inboxStates?.[0];
    if (!state?.installations || state.installations.length <= 1) return;

    const staleIds = state.installations
      .map((i) => i.id)
      .filter((id) => id !== currentInstallationId);

    if (staleIds.length === 0) return;

    // Revoke stale installations — only the wallet owner can do this
    execXmtp([
      "revoke-installations",
      inboxId,
      "-i",
      staleIds.join(","),
      "--force",
    ]);
  } catch {
    // Non-fatal — stale installations are a UX issue, not a blocker
  }
}

// ── Client ──

export async function getXmtpClient(): Promise<string> {
  // client info returns { properties: { inboxId, installationId, ... }, options: { ... } }
  const result = execXmtpJson<{
    properties: {
      inboxId: string;
      installationId: string;
    };
  }>(["client", "info"]);

  const { inboxId, installationId } = result.properties;

  // Cache inbox ID
  const config = loadConfig();
  if (!config.xmtpInboxId && inboxId) {
    config.xmtpInboxId = inboxId;
    saveConfig(config);
  }

  // Clean up stale installations so add-members targets the current one
  if (inboxId && installationId) {
    revokeStaleInstallations(inboxId, installationId);
  }

  return inboxId;
}

// ── Group Creation ──

export async function createSyndicateGroup(
  _client: string,
  subdomain: string,
  isPublic: boolean = false,
): Promise<string> {
  // CLI requires at least one member address; use creator's own address
  // (creator is auto-added as super admin regardless)
  const creatorAddress = getAccount().address;
  const result = execXmtpJson<{ id?: string; conversationId?: string; groupId?: string }>(
    [
      "conversations",
      "create-group",
      creatorAddress,
      "--name",
      subdomain,
      "--description",
      `Sherwood syndicate: ${subdomain}.sherwoodagent.eth`,
      "--permissions",
      "admin-only",
    ],
  );

  const groupId = result.id || result.conversationId || result.groupId;
  if (!groupId) {
    throw new Error("Failed to parse group ID from xmtp CLI output");
  }

  // Add spectator if requested
  if (isPublic && process.env.DASHBOARD_SPECTATOR_ADDRESS) {
    await addMember(groupId, process.env.DASHBOARD_SPECTATOR_ADDRESS);
  }

  // Cache locally
  cacheGroupId(subdomain, groupId);

  return groupId;
}

// ── Group Lookup ──

/**
 * Check if a conversation exists in the local XMTP DB.
 * Returns true if `conversations get <id>` succeeds.
 */
function conversationExists(groupId: string): boolean {
  try {
    execXmtp(["conversations", "get", groupId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search synced conversations for a group matching the syndicate name.
 * Falls back to this when the cached/ENS group ID is stale.
 */
function findGroupByName(subdomain: string): string | null {
  try {
    const conversations = execXmtpJson<Array<{ id?: string; name?: string; description?: string }>>(
      ["conversations", "list", "--type", "group"],
    );
    if (!Array.isArray(conversations)) return null;

    const match = conversations.find(
      (c) => c.name === subdomain || c.description?.includes(`${subdomain}.sherwoodagent.eth`),
    );
    return match?.id || null;
  } catch {
    return null;
  }
}

export async function getGroup(
  _client: string,
  subdomain: string,
): Promise<string> {
  // Sync first so we have the latest conversations locally
  syncConversations();

  // Try local cache
  let groupId: string | undefined = getCachedGroupId(subdomain);

  // Validate cached ID actually exists in the local DB
  if (groupId && !conversationExists(groupId)) {
    cacheGroupId(subdomain, ""); // invalidate stale entry
    groupId = undefined;
  }

  // Fall back to on-chain ENS text record
  if (!groupId) {
    const ensId = await getTextRecord(subdomain, "xmtpGroupId");
    if (ensId && conversationExists(ensId)) {
      groupId = ensId;
      cacheGroupId(subdomain, groupId);
    }
  }

  // Last resort: search synced conversations by name
  if (!groupId) {
    const found = findGroupByName(subdomain);
    if (found) {
      groupId = found;
      cacheGroupId(subdomain, groupId);
    }
  }

  if (!groupId) {
    throw new Error(
      `No XMTP group found for syndicate "${subdomain}". Run "sherwood chat ${subdomain} init" to create one.`,
    );
  }

  return groupId;
}

// ── Member Management ──

export async function addMember(
  groupId: string,
  address: string,
): Promise<void> {
  // Verify the target has an active XMTP identity before adding
  const reachable = execXmtpJson<Array<{ identifier: string; reachable: boolean }>>(
    ["can-message", address],
  );
  if (!reachable?.[0]?.reachable) {
    throw new Error(
      `${address} is not reachable on XMTP. They need to initialize their client first (run: xmtp client info --env ${getXmtpEnv()}).`,
    );
  }

  syncConversations();
  execXmtp(["conversation", "add-members", groupId, address]);

  // Set consent to "allowed" on the adder's side so subsequent operations
  // (send, messages) don't skip this conversation due to unknown consent state
  try {
    execXmtp(["conversation", "update-consent", groupId, "--state", "allowed"]);
  } catch {
    // Non-fatal — consent state is a filtering concern, not a blocker
  }
}

export async function removeMember(
  groupId: string,
  address: string,
): Promise<void> {
  syncConversations();
  execXmtp(["conversation", "remove-members", groupId, address]);
}

// ── Messaging ──

export async function sendEnvelope(
  groupId: string,
  envelope: ChatEnvelope,
): Promise<void> {
  const text = JSON.stringify(envelope);
  execXmtp(["conversation", "send-text", groupId, text]);
}

export async function sendMarkdown(
  groupId: string,
  markdown: string,
): Promise<void> {
  const envelope: ChatEnvelope = {
    type: "MESSAGE",
    from: getAccount().address,
    text: markdown,
    data: { format: "markdown" },
    timestamp: Math.floor(Date.now() / 1000),
  };
  await sendEnvelope(groupId, envelope);
}

export async function sendReaction(
  groupId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const envelope: ChatEnvelope = {
    type: "REACTION",
    from: getAccount().address,
    data: { reference: messageId, emoji },
    timestamp: Math.floor(Date.now() / 1000),
  };
  await sendEnvelope(groupId, envelope);
}

// ── Streaming ──

export async function streamMessages(
  groupId: string,
  onMessage: (msg: XmtpMessage) => void,
): Promise<() => void> {
  ensureXmtpEnv();
  const bin = getXmtpBinaryPath();

  const args = [
    "conversations",
    "stream-all-messages",
    "--json",
    "--log-level",
    "off",
    "--env",
    getXmtpEnv(),
    "--env-file",
    getXmtpEnvFile(),
  ];

  const proc = bin.endsWith(".js")
    ? spawn("node", [bin, ...args])
    : spawn(bin, args);

  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // Filter to our group
        if (msg.conversationId === groupId) {
          onMessage({
            id: msg.id || "",
            conversationId: msg.conversationId || "",
            senderInboxId: msg.senderInboxId || "",
            contentType: msg.contentType?.typeId || "text",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            sentAt: new Date(msg.sentAt || Date.now()),
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }
  });

  // Return cleanup function
  return () => {
    proc.kill("SIGTERM");
  };
}

// ── Message History ──

export async function getRecentMessages(
  groupId: string,
  limit: number = 20,
): Promise<XmtpMessage[]> {
  const raw = execXmtpJson<Array<Record<string, unknown>>>([
    "conversation",
    "messages",
    groupId,
  ]);

  const messages: XmtpMessage[] = (Array.isArray(raw) ? raw : []).map((m) => ({
    id: String(m.id || ""),
    conversationId: String(m.conversationId || ""),
    senderInboxId: String(m.senderInboxId || ""),
    contentType: String(
      (m.contentType as Record<string, unknown>)?.typeId || "text",
    ),
    content:
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    sentAt: new Date((m.sentAt as string) || Date.now()),
  }));

  return messages.slice(-limit);
}

// ── Members ──

export async function getMembers(
  groupId: string,
): Promise<XmtpMember[]> {
  const raw = execXmtpJson<Array<Record<string, unknown>>>([
    "conversation",
    "members",
    groupId,
  ]);

  // permissionLevel from CLI: 0 = member, 1 = admin, 2 = super_admin
  const levelMap: Record<number, string> = { 0: "member", 1: "admin", 2: "super_admin" };
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    inboxId: String(m.inboxId || ""),
    permissionLevel: levelMap[Number(m.permissionLevel)] || "member",
  }));
}
