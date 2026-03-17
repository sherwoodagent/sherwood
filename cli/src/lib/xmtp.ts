/**
 * XMTP client and group operations for syndicate chat.
 *
 * Uses the wallet's PRIVATE_KEY as the XMTP identity signer.
 * Groups are creator-managed (super admin only) with E2E encryption via MLS.
 */

import {
  Client,
  type Signer,
  type Identifier,
  IdentifierKind,
  type Group,
  type DecodedMessage,
} from "@xmtp/node-sdk";
import { ReactionAction, ReactionSchema } from "@xmtp/node-bindings";
import { getAccount } from "./client.js";
import {
  loadConfig,
  saveConfig,
  cacheGroupId,
  getCachedGroupId,
} from "./config.js";
import { getTextRecord } from "./ens.js";
import type { ChatEnvelope } from "./types.js";

// ── Signer ──

function createSigner(): Signer {
  return {
    type: "EOA" as const,
    getIdentifier: () => ({
      identifier: getAccount().address,
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string) => {
      const account = getAccount();
      const sig = await account.signMessage({ message });
      return Buffer.from(sig.slice(2), "hex");
    },
  };
}

// ── Client ──

let _client: Client | null = null;

export async function getXmtpClient(): Promise<Client> {
  if (_client) return _client;

  const config = loadConfig();
  const signer = createSigner();

  const keyBytes = new Uint8Array(
    Buffer.from(config.dbEncryptionKey.replace(/^0x/, ""), "hex"),
  );

  _client = await Client.create(signer, {
    dbEncryptionKey: keyBytes,
  });

  // Cache inbox ID
  if (!config.xmtpInboxId) {
    config.xmtpInboxId = _client.inboxId;
    saveConfig(config);
  }

  return _client;
}

// ── Group Creation ──

export async function createSyndicateGroup(
  client: Client,
  subdomain: string,
  publicChat: boolean = false,
): Promise<string> {
  // Create group with creator-only permissions
  const group = await client.conversations.createGroupWithIdentifiers(
    [], // no other members yet; creator is auto-added as super admin
    {
      groupName: subdomain,
      groupDescription: `Sherwood syndicate: ${subdomain}.sherwoodagent.eth`,
    },
  );

  // If public chat, add spectator bot for dashboard integration
  if (publicChat && process.env.DASHBOARD_SPECTATOR_ADDRESS) {
    const spectatorIdentifier: Identifier = {
      identifier: process.env.DASHBOARD_SPECTATOR_ADDRESS,
      identifierKind: IdentifierKind.Ethereum,
    };
    await (group as Group).addMembersByIdentifiers([spectatorIdentifier]);
  }

  // Cache locally
  cacheGroupId(subdomain, group.id);

  return group.id;
}

// ── Group Lookup ──

export async function getGroup(
  client: Client,
  subdomain: string,
): Promise<Group> {
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

  // Sync conversations to make sure we have latest
  await client.conversations.sync();

  const conversation = await client.conversations.getConversationById(groupId);
  if (!conversation) {
    throw new Error(
      `XMTP group "${groupId}" not found. You may not be a member of this group.`,
    );
  }

  return conversation as Group;
}

// ── Member Management ──

export async function addMember(
  group: Group,
  address: string,
): Promise<void> {
  const identifier: Identifier = {
    identifier: address,
    identifierKind: IdentifierKind.Ethereum,
  };
  await group.addMembersByIdentifiers([identifier]);
}

export async function removeMember(
  group: Group,
  address: string,
): Promise<void> {
  const identifier: Identifier = {
    identifier: address,
    identifierKind: IdentifierKind.Ethereum,
  };
  await group.removeMembersByIdentifiers([identifier]);
}

// ── Messaging ──

export async function sendEnvelope(
  group: Group,
  envelope: ChatEnvelope,
): Promise<void> {
  await group.sendText(JSON.stringify(envelope));
}

export async function sendMarkdown(
  group: Group,
  markdown: string,
): Promise<void> {
  await group.sendMarkdown(markdown);
}

export async function sendReaction(
  group: Group,
  messageId: string,
  emoji: string,
): Promise<void> {
  await group.sendReaction({
    reference: messageId,
    referenceInboxId: "",
    action: ReactionAction.Added,
    schema: ReactionSchema.Unicode,
    content: emoji,
  });
}

// ── Streaming ──

export async function streamMessages(
  group: Group,
  onMessage: (msg: DecodedMessage) => void,
): Promise<() => void> {
  const stream = await group.stream({
    onValue: onMessage,
  });

  // Return cleanup function
  return async () => {
    await stream.return();
  };
}

// ── Message History ──

export async function getRecentMessages(
  group: Group,
  limit: number = 20,
): Promise<DecodedMessage[]> {
  await group.sync();
  const messages = await group.messages({ limit });
  return messages;
}
