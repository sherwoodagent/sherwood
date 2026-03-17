/**
 * HTTP + WebSocket server for the spectator sidecar.
 *
 * REST endpoints:
 *   GET /health                     — service health
 *   GET /groups                     — list groups spectator belongs to
 *   GET /messages/:groupId          — fetch recent messages from XMTP DB
 *
 * WebSocket:
 *   WS /messages/:groupId/stream    — real-time messages for one group
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Agent } from "@xmtp/agent-sdk";
import type { HealthResponse, GroupInfo, SpectatorMessage } from "./types.js";

// ── CORS ──

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

function setCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const origin = req.headers.origin || "";
  if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── URL parsing ──

function parsePath(url: string): { segments: string[]; query: URLSearchParams } {
  const parsed = new URL(url, "http://localhost");
  return {
    segments: parsed.pathname.split("/").filter(Boolean),
    query: parsed.searchParams,
  };
}

// ── JSON response helpers ──

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// ── Groups cache ──

let groupsCache: GroupInfo[] = [];
let groupsCacheTime = 0;
const GROUPS_CACHE_TTL = 60_000; // 60 seconds

async function getGroups(agent: Agent): Promise<GroupInfo[]> {
  if (Date.now() - groupsCacheTime < GROUPS_CACHE_TTL) return groupsCache;

  await agent.client.conversations.sync();
  const conversations = await agent.client.conversations.list();

  groupsCache = await Promise.all(
    conversations
      .filter((c: any) => c.name || c.description) // only named groups (syndicates)
      .map(async (c: any) => ({
        id: c.id,
        name: c.name || "",
        description: c.description || "",
        memberCount: (await c.members()).length,
      })),
  );
  groupsCacheTime = Date.now();
  return groupsCache;
}

// ── Messages ──

async function getMessages(
  agent: Agent,
  groupId: string,
  limit: number,
  beforeNs?: string,
): Promise<SpectatorMessage[]> {
  const conv = await agent.client.conversations.getConversationById(groupId);
  if (!conv) throw new Error("Group not found");
  await conv.sync();

  const opts: Record<string, unknown> = {
    limit: BigInt(limit),
    direction: "descending",
  };
  if (beforeNs) {
    opts.sentBeforeNs = BigInt(beforeNs);
  }

  const raw = await (conv as any).messages(opts);
  return (Array.isArray(raw) ? raw : []).map((m: any) => ({
    id: String(m.id || ""),
    groupId,
    senderInboxId: String(m.senderInboxId || ""),
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    sentAt: m.sentAt ? new Date(m.sentAt).toISOString() : new Date().toISOString(),
  }));
}

// ── Server factory ──

export function startServer(
  agent: Agent,
  wsClients: Map<string, Set<WebSocket>>,
  streamAlive: { value: boolean },
): http.Server {
  const startTime = Date.now();
  const port = Number(process.env.PORT) || 3100;

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(req, res);

    // Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      error(res, "Method not allowed", 405);
      return;
    }

    const { segments, query } = parsePath(req.url || "/");

    try {
      // GET /health
      if (segments[0] === "health") {
        const groups = await getGroups(agent);
        const health: HealthResponse = {
          status: streamAlive.value ? "ok" : "degraded",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          groups: groups.length,
          streamAlive: streamAlive.value,
          address: agent.address || "",
        };
        json(res, health);
        return;
      }

      // GET /groups
      if (segments[0] === "groups" && segments.length === 1) {
        const groups = await getGroups(agent);
        json(res, { groups });
        return;
      }

      // GET /messages/:groupId
      if (segments[0] === "messages" && segments[1] && segments.length === 2) {
        const groupId = segments[1];
        const limit = Math.min(Number(query.get("limit")) || 20, 200);
        const beforeNs = query.get("before") || undefined;

        const messages = await getMessages(agent, groupId, limit, beforeNs);
        json(res, { messages, count: messages.length });
        return;
      }

      error(res, "Not found", 404);
    } catch (err) {
      console.error("Request error:", err);
      error(res, err instanceof Error ? err.message : "Internal error", 500);
    }
  });

  // ── WebSocket ──

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { segments } = parsePath(req.url || "/");

    // WS /messages/:groupId/stream
    if (segments[0] === "messages" && segments[1] && segments[2] === "stream") {
      const groupId = segments[1];

      wss.handleUpgrade(req, socket, head, (ws) => {
        // Register client
        if (!wsClients.has(groupId)) {
          wsClients.set(groupId, new Set());
        }
        wsClients.get(groupId)!.add(ws);
        console.log(`WS connected: ${groupId} (${wsClients.get(groupId)!.size} clients)`);

        // Send connected confirmation
        ws.send(JSON.stringify({ type: "connected", groupId }));

        // Ping/pong keepalive
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);

        ws.on("close", () => {
          wsClients.get(groupId)?.delete(ws);
          if (wsClients.get(groupId)?.size === 0) {
            wsClients.delete(groupId);
          }
          clearInterval(pingInterval);
          console.log(`WS disconnected: ${groupId}`);
        });

        ws.on("error", (err) => {
          console.error(`WS error (${groupId}):`, err.message);
        });
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    console.log(`Spectator server listening on port ${port}`);
  });

  return server;
}
