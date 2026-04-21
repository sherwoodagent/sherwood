/**
 * Dashboard API server — serves agent state over REST + WebSocket.
 * Started via `sherwood agent serve`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { watchFile, unwatchFile } from "node:fs";

const AGENT_DIR = join(homedir(), ".sherwood", "agent");

// ── File readers ──

export async function readJsonFile(path: string): Promise<any | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function readJsonlTail(path: string, count: number): Promise<any[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-count);
  const results: any[] = [];
  for (const line of tail) {
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return results;
}

// ── REST route handler ──

async function handleRequest(req: IncomingMessage, res: ServerResponse, token?: string): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (token) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const json = (data: any, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {
    if (path === "/api/portfolio") {
      const data = await readJsonFile(join(AGENT_DIR, "portfolio.json"));
      json(data ?? { error: "No portfolio data" });
    } else if (path === "/api/trades") {
      const days = parseInt(url.searchParams.get("days") ?? "0", 10);
      const trades = (await readJsonFile(join(AGENT_DIR, "trades.json"))) as any[] ?? [];
      if (days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        json(trades.filter((t: any) => t.exitTimestamp >= cutoff));
      } else {
        json(trades);
      }
    } else if (path === "/api/cycles") {
      const last = parseInt(url.searchParams.get("last") ?? "100", 10);
      json(await readJsonlTail(join(AGENT_DIR, "cycles.jsonl"), last));
    } else if (path === "/api/signals") {
      const last = parseInt(url.searchParams.get("last") ?? "50", 10);
      json(await readJsonlTail(join(AGENT_DIR, "signal-history.jsonl"), last));
    } else if (path === "/api/grid") {
      const data = await readJsonFile(join(AGENT_DIR, "grid-portfolio.json"));
      json(data ?? { error: "No grid data" });
    } else if (path === "/api/health") {
      const cycles = await readJsonlTail(join(AGENT_DIR, "cycles.jsonl"), 1);
      const lastCycle = cycles[0] ?? null;
      const errors = lastCycle?.errors ?? [];
      json({
        agentDir: AGENT_DIR,
        lastCycleTimestamp: lastCycle?.timestamp ?? null,
        lastCycleNumber: lastCycle?.cycleNumber ?? null,
        lastCycleErrors: errors.length,
        recentErrors: errors,
      });
    } else {
      json({ error: "Not found" }, 404);
    }
  } catch (err) {
    json({ error: (err as Error).message }, 500);
  }
}

// ── WebSocket relay ──

interface WsClient { send: (data: string) => void; readyState: number; }
const OPEN = 1;

function broadcast(clients: Set<WsClient>, msg: object): void {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === OPEN) {
      try { client.send(payload); } catch { /* client gone */ }
    }
  }
}

// ── File watcher with debounce ──

type FileWatcherEntry = {
  path: string; type: string; reader: () => Promise<any>;
  lastSize: number; debounceTimer: ReturnType<typeof setTimeout> | null;
};

function startFileWatchers(clients: Set<WsClient>): () => void {
  const DEBOUNCE_MS = 2000;
  const watchers: FileWatcherEntry[] = [
    { path: join(AGENT_DIR, "portfolio.json"), type: "portfolio",
      reader: () => readJsonFile(join(AGENT_DIR, "portfolio.json")), lastSize: 0, debounceTimer: null },
    { path: join(AGENT_DIR, "cycles.jsonl"), type: "cycle",
      reader: async () => { const c = await readJsonlTail(join(AGENT_DIR, "cycles.jsonl"), 1); return c[0] ?? null; },
      lastSize: 0, debounceTimer: null },
    { path: join(AGENT_DIR, "trades.json"), type: "trade",
      reader: async () => { const t = (await readJsonFile(join(AGENT_DIR, "trades.json"))) as any[] ?? []; return t[t.length - 1] ?? null; },
      lastSize: 0, debounceTimer: null },
    { path: join(AGENT_DIR, "grid-portfolio.json"), type: "grid",
      reader: () => readJsonFile(join(AGENT_DIR, "grid-portfolio.json")), lastSize: 0, debounceTimer: null },
  ];

  for (const w of watchers) {
    stat(w.path).then((s) => { w.lastSize = s.size; }).catch(() => {});
    watchFile(w.path, { interval: 2000 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      if (w.debounceTimer) clearTimeout(w.debounceTimer);
      w.debounceTimer = setTimeout(async () => {
        const data = await w.reader();
        if (data !== null) {
          broadcast(clients, { type: w.type, data });
          if (w.type === "cycle" && data.errors?.length > 0) {
            for (const errMsg of data.errors) {
              broadcast(clients, { type: "error", data: { timestamp: new Date().toISOString(), message: errMsg } });
            }
          }
        }
      }, DEBOUNCE_MS);
    });
  }
  return () => { for (const w of watchers) { unwatchFile(w.path); if (w.debounceTimer) clearTimeout(w.debounceTimer); } };
}

// ── Public API ──

export interface ServeOptions { port: number; host: string; token?: string; }

export async function startServe(options: ServeOptions): Promise<void> {
  const { port, host, token } = options;
  const { WebSocketServer } = await import("ws");
  const server = createServer((req, res) => handleRequest(req, res, token));
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WsClient>();

  server.on("upgrade", (req, socket, head) => {
    if (token) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.searchParams.get("token") !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
  });

  wss.on("connection", (ws) => {
    clients.add(ws as unknown as WsClient);
    ws.on("close", () => clients.delete(ws as unknown as WsClient));
    ws.on("error", () => clients.delete(ws as unknown as WsClient));
  });

  const stopWatchers = startFileWatchers(clients);
  server.listen(port, host, () => {
    console.log(`Sherwood dashboard API running on http://${host}:${port}`);
    console.log(`  REST:      http://${host}:${port}/api/health`);
    console.log(`  WebSocket: ws://${host}:${port}/ws`);
    if (token) console.log(`  Auth:      Bearer token required`);
    else console.log(`  Auth:      None (localhost only)`);
  });

  const shutdown = () => { console.log("\nShutting down dashboard API..."); stopWatchers(); wss.close(); server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
