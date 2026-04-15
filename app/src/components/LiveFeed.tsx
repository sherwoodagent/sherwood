"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useCallback, useState } from "react";

// ── Types ──

interface SpectatorMessage {
  id: string;
  groupId: string;
  senderInboxId: string;
  content: string;
  sentAt: string;
}

interface ChatEnvelope {
  type:
    | "MESSAGE"
    | "REACTION"
    | "TRADE_EXECUTED"
    | "TRADE_SIGNAL"
    | "POSITION_UPDATE"
    | "RISK_ALERT"
    | "LP_REPORT"
    | "APPROVAL_REQUEST"
    | "STRATEGY_PROPOSAL"
    | "MEMBER_JOIN"
    | "RAGEQUIT_NOTICE"
    | "AGENT_REGISTERED";
  from?: string;
  text?: string;
  agent?: { erc8004Id?: number; address: string };
  syndicate?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

interface FeedItem {
  id: string;
  sender: string;
  message: string;
  time: string;
  source: string;
  type: string;
  dimmed?: boolean;
}

// ── Known inbox IDs to filter ──

const SPECTATOR_INBOX_PREFIX = "744cfb";

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

/** Format an ISO timestamp as relative time. */
function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) return "now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Determine if a raw message is a group membership event (not a ChatEnvelope). */
function isGroupEvent(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return !!(parsed.addedInboxes || parsed.removedInboxes);
  } catch {
    return false;
  }
}

/** Resolve a sender name from the envelope + address map. */
function resolveSender(
  envelope: ChatEnvelope | null,
  addressNames?: Record<string, string>,
): string {
  // Try agent address from envelope
  if (envelope?.agent?.address && addressNames) {
    const name = addressNames[envelope.agent.address.toLowerCase()];
    if (name) return name;
  }
  // Try from field
  if (envelope?.from && addressNames) {
    const name = addressNames[envelope.from.toLowerCase()];
    if (name) return name;
  }
  // Fallback to truncated address or empty
  if (envelope?.from) {
    return `${envelope.from.slice(0, 6)}...${envelope.from.slice(-4)}`;
  }
  return "";
}

/** Parse a SpectatorMessage into a FeedItem for rendering. */
function toFeedItem(
  msg: SpectatorMessage,
  addressNames?: Record<string, string>,
  dimmed = false,
): FeedItem | null {
  // Filter spectator bot messages
  if (msg.senderInboxId.startsWith(SPECTATOR_INBOX_PREFIX)) return null;

  // Filter group membership events
  if (isGroupEvent(msg.content)) return null;

  let envelope: ChatEnvelope | null = null;
  try {
    envelope = JSON.parse(msg.content);
  } catch {
    // Not a valid ChatEnvelope — show raw content
  }

  // For reactions, show the reaction target
  if (envelope?.type === "REACTION") {
    return null; // Skip reactions in the feed for now
  }

  return {
    id: msg.id,
    sender: resolveSender(envelope, addressNames),
    message: envelope?.text || envelope?.type || msg.content,
    time: relativeTime(msg.sentAt),
    source: envelope ? sourceLabel(envelope.type) : "UNKNOWN",
    type: envelope?.type || "UNKNOWN",
    dimmed,
  };
}

/** Color for envelope type indicator dot */
function indicatorColor(type: string): string {
  switch (type) {
    case "TRADE_EXECUTED":
      return "var(--color-accent)";
    case "TRADE_SIGNAL":
      return "#4dd0e1";
    case "RISK_ALERT":
      return "#ff4d4d";
    case "RAGEQUIT_NOTICE":
      return "#ff4d4d";
    case "POSITION_UPDATE":
      return "#ffa726";
    case "APPROVAL_REQUEST":
    case "STRATEGY_PROPOSAL":
      return "#ab47bc";
    case "AGENT_REGISTERED":
    case "MEMBER_JOIN":
      return "#78909c";
    default:
      return "var(--color-accent)";
  }
}

// ── Mock fallback data ──

const MOCK_FEED: FeedItem[] = [
  {
    id: "mock-1",
    sender: "",
    message: "Waiting for spectator connection...",
    time: "—",
    source: "SYSTEM",
    type: "MESSAGE",
    dimmed: true,
  },
];

// ── WebSocket URL builder ──

function getWsUrl(groupId: string): string {
  // In the browser, derive the WS URL from the spectator service
  // Next.js rewrites don't proxy WebSockets, so we use the direct URL
  const spectatorWs =
    process.env.NEXT_PUBLIC_SPECTATOR_WS_URL ||
    "wss://spectator.sherwood.sh";
  return `${spectatorWs}/messages/${groupId}/stream`;
}

// ── Component ──

export default function LiveFeed({
  groupId,
  addressNames,
}: {
  groupId?: string;
  /** Map of lowercase address → display name for sender resolution */
  addressNames?: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // Fetch recent messages via the Next.js proxy
  const { data: messages } = useQuery<SpectatorMessage[]>({
    queryKey: ["feed", groupId],
    queryFn: async () => {
      if (!groupId) return [];
      const res = await fetch(
        `/api/spectator/messages/${groupId}?limit=20`,
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
        // Skip handshake / control frames
        if (msg.type === "connected" || msg.type === "pong") return;

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

    const ws = new WebSocket(getWsUrl(groupId));
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onmessage = onWsMessage;
    ws.onerror = () => {
      console.warn("Spectator WS error");
      setWsConnected(false);
    };
    ws.onclose = () => {
      console.log("Spectator WS closed");
      setWsConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [groupId, onWsMessage]);

  // Build feed items (filter nulls from spectator/group events)
  const feed: FeedItem[] =
    messages && messages.length > 0
      ? (messages.map((m) => toFeedItem(m, addressNames)).filter(Boolean) as FeedItem[])
      : MOCK_FEED;

  // If all messages were filtered, show placeholder
  const displayFeed = feed.length > 0 ? feed : MOCK_FEED;

  const isLive = wsConnected || (messages && messages.length > 0);

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="panel-title">
        <span>Agent communication</span>
        <span
          style={{
            color: isLive ? "var(--color-accent)" : "#ff4d4d",
            fontSize: "10px",
          }}
        >
          {isLive ? "● REAL-TIME" : "● OFFLINE"}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, maxHeight: "480px" }}>
        {displayFeed.map((item) => (
          <div
            className={`feed-item ${item.dimmed ? "" : "feed-item-enter"}`}
            key={item.id}
            style={
              item.dimmed
                ? { opacity: 0.5, borderBottom: "none" }
                : undefined
            }
          >
            <div
              className="feed-indicator"
              style={{
                background: item.dimmed
                  ? "rgba(255,255,255,0.2)"
                  : indicatorColor(item.type),
                boxShadow: item.dimmed
                  ? "none"
                  : `0 0 6px ${indicatorColor(item.type)}`,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "11px",
                  lineHeight: "1.4",
                  wordBreak: "break-word",
                }}
              >
                {item.sender && (
                  <span style={{ color: "var(--color-accent)", marginRight: "6px" }}>
                    {item.sender}
                  </span>
                )}
                <span style={{ color: "#fff" }}>{item.message}</span>
              </div>
              <div
                style={{
                  color: "rgba(255,255,255,0.55)",
                  fontSize: "9px",
                  marginTop: "2px",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {item.time} {"// "}{item.source}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
