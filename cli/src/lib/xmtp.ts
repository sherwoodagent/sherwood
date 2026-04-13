/**
 * XMTP client and group operations for syndicate chat.
 *
 * Uses @xmtp/node-sdk directly with a singleton Client instance.
 * Deterministic DB path (~/.sherwood/xmtp/) and encryption key derived
 * from the sherwood private key via keccak256.
 *
 * This replaces the previous @xmtp/cli subprocess architecture which
 * caused stale MLS installations (issue #110).
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  Client,
  ConsentState,
  Group,
  GroupPermissionsOptions,
  IdentifierKind,
  type CreateGroupOptions,
  type DecodedMessage,
  type Identifier,
  type NetworkOptions,
  type Signer,
  type XmtpEnv,
} from "@xmtp/node-sdk";
import { keccak256, toBytes } from "viem";
import {
  loadConfig,
  saveConfig,
  cacheGroupId,
  getCachedGroupId,
  invalidateCachedGroupId,
} from "./config.js";
import { getTextRecord } from "./ens.js";
import { getChainConfig } from "./network.js";
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

// ── Internal helpers ──

let _client: Client | null = null;

function getXmtpEnv(): string {
  return getChainConfig().xmtpEnv;
}

function getDbEncryptionKey(privateKey: string): Uint8Array {
  const hash = keccak256(toBytes(privateKey + "xmtp-db-key"));
  return toBytes(hash);
}

function getDbPath(): string {
  const dir = path.join(homedir(), ".sherwood", "xmtp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "xmtp.db3");
}

function ethIdentifier(address: string): Identifier {
  return {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };
}

async function getOrCreateClient(): Promise<Client> {
  if (_client) return _client;

  const config = loadConfig();
  if (!config.privateKey) {
    throw new Error(
      'No private key configured. Run "sherwood config set --private-key 0x..."',
    );
  }

  const account = getAccount();

  const signer: Signer = {
    type: "EOA",
    getIdentifier: () => ({
      identifier: account.address.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string) => {
      const signature = await account.signMessage({ message });
      return toBytes(signature);
    },
  };

  const clientOptions: NetworkOptions = {
    env: getXmtpEnv() as XmtpEnv,
  };
  _client = await Client.create(signer, {
    ...clientOptions,
    dbEncryptionKey: getDbEncryptionKey(config.privateKey),
    dbPath: getDbPath(),
  });

  // Sync all conversations on first connect (processes MLS welcome messages)
  await _client.conversations.syncAll([ConsentState.Allowed]);

  // One-time migration: revoke stale installations from the old ~/.xmtp/ era
  if (!config._xmtpMigrated) {
    try {
      await _client.revokeAllOtherInstallations();
    } catch {
      // Non-fatal — stale installations are a UX issue, not a blocker
    }
    config._xmtpMigrated = true;
    saveConfig(config);
  }

  return _client;
}

// ── Client ──

export async function getXmtpClient(): Promise<string> {
  const client = await getOrCreateClient();

  // Cache inbox ID
  const config = loadConfig();
  if (!config.xmtpInboxId && client.inboxId) {
    config.xmtpInboxId = client.inboxId;
    saveConfig(config);
  }

  return client.inboxId;
}

// ── Group Creation ──

export async function createSyndicateGroup(
  _client: string,
  subdomain: string,
  isPublic: boolean = false,
): Promise<string> {
  const client = await getOrCreateClient();

  const group = await client.conversations.createGroup([], {
    name: subdomain,
    description: `Sherwood syndicate: ${subdomain}.sherwoodagent.eth`,
    permissionLevel: GroupPermissionsOptions.AdminOnly,
  } as CreateGroupOptions);

  const groupId = group.id;
  if (!groupId) {
    throw new Error("Failed to create XMTP group — no group ID returned");
  }

  // Add spectator if requested — enables dashboard live feed
  const SPECTATOR_ADDRESS =
    process.env.DASHBOARD_SPECTATOR_ADDRESS ||
    "0x9f6518e69a62c526ead155ad2661f5957b6b2fc3";
  if (isPublic) {
    await addMember(groupId, SPECTATOR_ADDRESS);
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
  const client = await getOrCreateClient();

  // Sync to get latest conversations (including MLS welcome messages)
  await client.conversations.syncAll([ConsentState.Allowed]);

  // Try local cache — validate it exists in the local DB before trusting.
  // Stale cache entries (e.g. after `init --force` recreated the group) would
  // otherwise short-circuit every downstream call with a nonexistent group.
  let groupId: string | undefined = getCachedGroupId(subdomain);
  if (groupId) {
    const conv = await client.conversations.getConversationById(groupId);
    if (conv) {
      return groupId;
    }
    // Stale cache — clear and fall through to ENS / name search.
    invalidateCachedGroupId(subdomain);
    groupId = undefined;
  }

  // Fall back to on-chain ENS text record (may not exist on all chains)
  if (!groupId) {
    try {
      const ensId = await getTextRecord(subdomain, "xmtpGroupId");
      if (ensId) {
        const conv = await client.conversations.getConversationById(ensId);
        if (conv) {
          groupId = ensId;
          cacheGroupId(subdomain, groupId);
        }
      }
    } catch {
      // ENS not available on this chain (e.g. HyperEVM) — skip
    }
  }

  // Last resort: search synced conversations by name
  if (!groupId) {
    const groups = client.conversations.listGroups();
    const match = groups.find(
      (g) =>
        g.name === subdomain ||
        g.description?.includes(`${subdomain}.sherwoodagent.eth`),
    );
    if (match) {
      groupId = match.id;
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
  const client = await getOrCreateClient();

  // Verify the target has an active XMTP identity before adding
  const reachable = await client.canMessage([ethIdentifier(address)]);
  // Try both original and lowercased as map key
  const isReachable =
    reachable.get(address) ?? reachable.get(address.toLowerCase()) ?? false;
  if (!isReachable) {
    throw new Error(
      `${address} is not reachable on XMTP. They need to initialize their client first.`,
    );
  }

  await client.conversations.syncAll([ConsentState.Allowed]);
  const conv = await client.conversations.getConversationById(groupId);
  if (!conv) throw new Error(`Conversation ${groupId} not found`);

  // Cast to Group — we know syndicate conversations are always groups
  const group = conv as Group;
  await group.addMembersByIdentifiers([ethIdentifier(address)]);

  // Set consent to "allowed" so subsequent operations don't skip this conversation
  try {
    group.updateConsentState(ConsentState.Allowed);
  } catch {
    // Non-fatal — consent state is a filtering concern, not a blocker
  }
}

export async function removeMember(
  groupId: string,
  address: string,
): Promise<void> {
  const client = await getOrCreateClient();
  await client.conversations.syncAll([ConsentState.Allowed]);

  const conv = await client.conversations.getConversationById(groupId);
  if (!conv) throw new Error(`Conversation ${groupId} not found`);

  // Cast to Group — we know syndicate conversations are always groups
  const group = conv as Group;
  await group.removeMembersByIdentifiers([ethIdentifier(address)]);
}

// ── Messaging ──

export async function sendEnvelope(
  groupId: string,
  envelope: ChatEnvelope,
): Promise<void> {
  const client = await getOrCreateClient();
  const conv = await client.conversations.getConversationById(groupId);
  if (!conv) throw new Error(`Conversation ${groupId} not found`);

  const text = JSON.stringify(envelope);
  await conv.sendText(text);
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
  const client = await getOrCreateClient();

  const stream = await client.conversations.streamAllMessages({
    consentStates: [ConsentState.Allowed],
  });

  let stopped = false;

  // Consume stream in background
  (async () => {
    try {
      for await (const message of stream) {
        if (stopped) break;
        // Filter to our group
        if (message.conversationId !== groupId) continue;

        onMessage({
          id: message.id || "",
          conversationId: message.conversationId || "",
          senderInboxId: message.senderInboxId || "",
          contentType:
            typeof message.contentType === "object"
              ? (message.contentType as { typeId?: string })?.typeId || "text"
              : String(message.contentType || "text"),
          content:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          sentAt: message.sentAt || new Date(),
        });
      }
    } catch {
      // Stream ended or errored — expected on cleanup
    }
  })();

  // Return cleanup function
  return () => {
    stopped = true;
    try {
      // AsyncStreamProxy exposes end() to terminate the stream
      if (typeof (stream as any).end === "function") {
        (stream as any).end();
      } else if (typeof (stream as any).return === "function") {
        (stream as any).return();
      }
    } catch {
      // Best-effort cleanup
    }
  };
}

// ── Message History ──

export async function getRecentMessages(
  groupId: string,
  limit: number = 20,
): Promise<XmtpMessage[]> {
  const client = await getOrCreateClient();
  const conv = await client.conversations.getConversationById(groupId);
  if (!conv) throw new Error(`Conversation ${groupId} not found`);

  // Sync to get latest messages
  await conv.sync();

  const rawMessages = await conv.messages({ limit });

  return rawMessages.map((m) => ({
    id: m.id || "",
    conversationId: m.conversationId || "",
    senderInboxId: m.senderInboxId || "",
    contentType:
      typeof m.contentType === "object"
        ? (m.contentType as { typeId?: string })?.typeId || "text"
        : String(m.contentType || "text"),
    content:
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content),
    sentAt: m.sentAt || new Date(),
  }));
}

// ── Members ──

export async function getMembers(
  groupId: string,
): Promise<XmtpMember[]> {
  const client = await getOrCreateClient();
  const conv = await client.conversations.getConversationById(groupId);
  if (!conv) throw new Error(`Conversation ${groupId} not found`);

  const members = await conv.members();

  return (Array.isArray(members) ? members : []).map((m: any) => ({
    inboxId: String(m.inboxId || ""),
    permissionLevel:
      m.permissionLevel === 2
        ? "super_admin"
        : m.permissionLevel === 1
          ? "admin"
          : "member",
  }));
}
