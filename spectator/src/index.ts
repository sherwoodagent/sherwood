/**
 * Spectator sidecar — bridges XMTP syndicate chat to the dashboard.
 *
 * Runs a read-only XMTP agent that:
 * 1. Connects to the network and syncs all group conversations
 * 2. Serves recent messages via REST (GET /messages/:groupId)
 * 3. Forwards real-time messages to WebSocket clients per group
 *
 * The XMTP SQLite DB is the message store — no in-memory buffering.
 * streamAllMessages() is a single MLS connection that covers all groups.
 * Messages for groups with no WS viewers are silently dropped (zero overhead).
 */

import "dotenv/config";
import { Agent } from "@xmtp/agent-sdk";
import { WebSocket } from "ws";
import { startServer } from "./server.js";
import type { SpectatorMessage } from "./types.js";

// ── Validate env ──

if (!process.env.XMTP_WALLET_KEY) {
  console.error("Error: XMTP_WALLET_KEY env var is required");
  process.exit(1);
}
if (!process.env.XMTP_DB_ENCRYPTION_KEY) {
  console.error("Error: XMTP_DB_ENCRYPTION_KEY env var is required");
  process.exit(1);
}

// ── DB path (Railway volume for persistence) ──

const dbPath = (inboxId: string) =>
  `${process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "."}/${process.env.XMTP_ENV || "dev"}-${inboxId.slice(0, 8)}.db3`;

// ── Create agent ──

const agent = await Agent.createFromEnv({ dbPath });

// ── WS client registry ──

const wsClients = new Map<string, Set<WebSocket>>();
const streamAlive = { value: false };

// ── Message handler — forward to subscribed WS clients ──

agent.on("message", async (ctx) => {
  const groupId = ctx.conversation.id;
  const clients = wsClients.get(groupId);

  // No viewers for this group → drop silently
  if (!clients?.size) return;

  // Don't forward our own messages
  if (ctx.message.senderInboxId === agent.client.inboxId) return;

  const payload: SpectatorMessage = {
    id: ctx.message.id,
    groupId,
    senderInboxId: ctx.message.senderInboxId,
    content:
      typeof ctx.message.content === "string"
        ? ctx.message.content
        : JSON.stringify(ctx.message.content),
    sentAt: ctx.message.sentAt
      ? new Date(ctx.message.sentAt).toISOString()
      : new Date().toISOString(),
  };

  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
});

// ── Lifecycle ──

agent.on("start", () => {
  streamAlive.value = true;
  console.log(`Spectator agent started`);
  console.log(`  Address:  ${agent.address}`);
  console.log(`  Inbox ID: ${agent.client.inboxId}`);
  console.log(`  Env:      ${process.env.XMTP_ENV || "dev"}`);
});

agent.on("error", (err: unknown) => {
  console.error("Agent error:", err);
});

// ── Global error handlers ──

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// ── Start HTTP/WS server first, then agent ──

const server = startServer(agent, wsClients, streamAlive);

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  streamAlive.value = false;
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start the XMTP agent (connects + streams)
try {
  await agent.start();
  // syncAll processes MLS welcome messages for new group invitations
  await agent.client.conversations.syncAll();
  const convos = await agent.client.conversations.list();
  console.log(`Agent stream setup complete — ${convos.length} groups synced`);
} catch (err) {
  console.error("Agent failed to start:", err);
}

// Heartbeat — proves process is alive
setInterval(() => {
  console.log(`[heartbeat] uptime=${Math.floor(process.uptime())}s stream=${streamAlive.value}`);
}, 60_000);
