/**
 * XMTP client and group operations for syndicate chat.
 *
 * Shells out to the @xmtp/cli binary instead of using @xmtp/node-sdk directly.
 * This avoids native binding (GLIBC) issues on Linux.
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

// ── Environment sync ──

let _synced = false;

function syncXmtpEnv(): void {
  if (_synced) return;

  const config = loadConfig();
  if (!config.privateKey) {
    throw new Error(
      'No private key configured. Run "sherwood config set --private-key 0x..."',
    );
  }

  const xmtpDir = path.join(homedir(), ".xmtp");
  const envFile = path.join(xmtpDir, ".env");
  const walletKey = config.privateKey.replace(/^0x/, "");

  // Only write if wallet key is missing or different — preserve existing DB encryption key
  if (fs.existsSync(envFile)) {
    const existing = fs.readFileSync(envFile, "utf8");
    if (existing.includes(`XMTP_WALLET_KEY=${walletKey}`)) {
      _synced = true;
      return;
    }
  }

  // Write wallet key to env file — omit DB encryption key so XMTP CLI manages its own
  fs.mkdirSync(xmtpDir, { recursive: true });
  fs.writeFileSync(envFile, `XMTP_WALLET_KEY=${walletKey}\n`, { mode: 0o600 });

  _synced = true;
}

function getXmtpEnv(): string {
  return getNetwork() === "base" ? "production" : "dev";
}

// ── Subprocess runners ──

function execXmtp(args: string[]): string {
  syncXmtpEnv();
  const bin = getXmtpBinaryPath();
  const fullArgs = [...args, "--env", getXmtpEnv()];

  // Use node to run the bin/run.js if it's a .js file
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
 * Only runs once per process.
 */
function syncConversations(): void {
  if (_conversationsSynced) return;
  execXmtp(["conversations", "sync"]);
  _conversationsSynced = true;
}

// ── Client ──

export async function getXmtpClient(): Promise<string> {
  syncXmtpEnv();

  const result = execXmtpJson<{ inboxId: string }>(["client", "info"]);

  // Cache inbox ID
  const config = loadConfig();
  if (!config.xmtpInboxId && result.inboxId) {
    config.xmtpInboxId = result.inboxId;
    saveConfig(config);
  }

  return result.inboxId;
}

// ── Group Creation ──

export async function createSyndicateGroup(
  _client: string,
  subdomain: string,
  publicChat: boolean = false,
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
  if (publicChat && process.env.DASHBOARD_SPECTATOR_ADDRESS) {
    await addMember(groupId, process.env.DASHBOARD_SPECTATOR_ADDRESS);
  }

  // Cache locally
  cacheGroupId(subdomain, groupId);

  return groupId;
}

// ── Group Lookup ──

export async function getGroup(
  _client: string,
  subdomain: string,
): Promise<string> {
  // Try local cache first
  let groupId = getCachedGroupId(subdomain);

  // Fall back to on-chain ENS text record
  if (!groupId) {
    groupId = await getTextRecord(subdomain, "xmtpGroupId");
    if (groupId) {
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
  syncConversations();
  execXmtp(["conversation", "add-members", groupId, address]);
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
  syncConversations();
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
  syncXmtpEnv();
  const bin = getXmtpBinaryPath();

  const args = [
    "conversations",
    "stream-all-messages",
    "--json",
    "--log-level",
    "off",
    "--env",
    getXmtpEnv(),
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
  syncConversations();
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
  syncConversations();
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
