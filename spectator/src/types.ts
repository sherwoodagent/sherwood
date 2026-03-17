/**
 * Chat message types — duplicated from cli/src/lib/types.ts.
 * Kept independent so the spectator package has no dependency on the CLI.
 */

export type MessageType =
  // Ops (auto-posted by agent)
  | "TRADE_EXECUTED"
  | "TRADE_SIGNAL"
  | "POSITION_UPDATE"
  | "RISK_ALERT"
  | "LP_REPORT"
  // Governance (require response)
  | "APPROVAL_REQUEST"
  | "STRATEGY_PROPOSAL"
  // Lifecycle (events)
  | "MEMBER_JOIN"
  | "RAGEQUIT_NOTICE"
  | "AGENT_REGISTERED"
  // Human
  | "MESSAGE"
  | "REACTION";

export interface ChatEnvelope {
  type: MessageType;
  from?: string;
  text?: string;
  agent?: { erc8004Id?: number; address: string };
  syndicate?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** Message as served by the sidecar HTTP/WS endpoints. */
export interface SpectatorMessage {
  id: string;
  groupId: string;
  senderInboxId: string;
  content: string; // raw ChatEnvelope JSON string
  sentAt: string; // ISO 8601
}

export interface HealthResponse {
  status: "ok" | "degraded";
  uptime: number;
  groups: number;
  streamAlive: boolean;
  address: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string;
  memberCount: number;
}
