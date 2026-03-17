"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useCallback } from "react";

// ── Types ──

interface SpectatorMessage {
  id: string;
  groupId: string;
  senderInboxId: string;
  content: string;
  sentAt: string;
}

interface ChatEnvelope {
  type: string;
  from?: string;
  text?: string;
  agent?: { erc8004Id?: number; address: string };
  data?: Record<string, unknown>;
  timestamp: number;
}

interface FeedItem {
  id: string;
  message: string;
  time: string;
  source: string;
  dimmed?: boolean;
}

// ── Env ──

const SPECTATOR_URL =
  process.env.NEXT_PUBLIC_SPECTATOR_URL || "http://localhost:3100";

// ── Helpers ──

/** Map a ChatEnvelope type to a human-readable source label. */
function sourceLabel(type: string): string {
  const labels: Record<string, string> = {
    TRADE_EXECUTED: "EXECUTION",
    TRADE_SIGNAL: "SCANNER",
    POSITION_UPDATE: "POSITIONS",
    RISK_ALERT: "RISK_ENGINE",
    LP_REPORT: "LP_REPORT",
    APPROVAL_REQUEST: "GOVERNANCE",
    STRATEGY_PROPOSAL: "GOVERNANCE",
    MEMBER_JOIN: "SYSTEM",
    RAGEQUIT_NOTICE: "SYSTEM",
    AGENT_REGISTERED: "SYSTEM",
    MESSAGE: "CHAT",
    REACTION: "CHAT",
  };
  return labels[type] || type;
}

/** Format an ISO timestamp as relative time (e.g. "3.2s ago", "2m ago"). */
function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${diff.toFixed(1)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/** Parse a SpectatorMessage into a FeedItem for rendering. */
function toFeedItem(msg: SpectatorMessage, dimmed = false): FeedItem {
  let envelope: ChatEnvelope | null = null;
  try {
    envelope = JSON.parse(msg.content);
  } catch {
    // Not a valid ChatEnvelope — show raw content
  }

  return {
    id: msg.id,
    message: envelope?.text || envelope?.type || msg.content,
    time: relativeTime(msg.sentAt),
    source: envelope ? sourceLabel(envelope.type) : "UNKNOWN",
    dimmed,
  };
}

// ── Mock fallback data ──

const MOCK_FEED: FeedItem[] = [
  {
    id: "mock-1",
    message: "Waiting for spectator connection...",
    time: "—",
    source: "SYSTEM",
    dimmed: true,
  },
];

// ── Component ──

export default function LiveFeed({ groupId }: { groupId?: string }) {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch recent messages on mount
  const { data: messages } = useQuery<SpectatorMessage[]>({
    queryKey: ["feed", groupId],
    queryFn: async () => {
      if (!groupId) return [];
      const res = await fetch(
        `${SPECTATOR_URL}/messages/${groupId}?limit=20`,
      );
      if (!res.ok) throw new Error("Failed to fetch messages");
      const json = await res.json();
      return json.messages || [];
    },
    enabled: !!groupId,
    refetchInterval: 10_000, // poll every 10s as fallback
  });

  // WebSocket for real-time updates
  const onWsMessage = useCallback(
    (event: MessageEvent) => {
      if (!groupId) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "connected") return; // handshake

        queryClient.setQueryData<SpectatorMessage[]>(
          ["feed", groupId],
          (old) => {
            const prev = old || [];
            // Deduplicate
            if (prev.some((m) => m.id === msg.id)) return prev;
            // Prepend (newest first)
            return [msg, ...prev].slice(0, 50);
          },
        );
      } catch {
        // Ignore unparseable messages
      }
    },
    [groupId, queryClient],
  );

  useEffect(() => {
    if (!groupId) return;

    const wsUrl = SPECTATOR_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/messages/${groupId}/stream`);
    wsRef.current = ws;

    ws.onmessage = onWsMessage;
    ws.onerror = () => console.warn("Spectator WS error");
    ws.onclose = () => console.log("Spectator WS closed");

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [groupId, onWsMessage]);

  // Build feed items
  const feed: FeedItem[] =
    messages && messages.length > 0
      ? messages.map((m, i) => toFeedItem(m, i >= messages.length - 1))
      : MOCK_FEED;

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Live Intelligence Feed</span>
        <span style={{ color: "var(--color-accent)" }}>
          {messages && messages.length > 0 ? "REAL-TIME" : "OFFLINE"}
        </span>
      </div>
      {feed.map((item) => (
        <div
          className="feed-item"
          key={item.id}
          style={
            item.dimmed
              ? { opacity: 0.5, borderBottom: "none" }
              : undefined
          }
        >
          <div
            className="feed-indicator"
            style={
              item.dimmed
                ? {
                    background: "rgba(255,255,255,0.2)",
                    boxShadow: "none",
                  }
                : undefined
            }
          />
          <div>
            <div style={{ color: "#fff" }}>{item.message}</div>
            <div
              style={{
                color: "rgba(255,255,255,0.3)",
                fontSize: "9px",
                marginTop: "2px",
              }}
            >
              {item.time} // {item.source}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
