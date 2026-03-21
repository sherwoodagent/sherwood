/**
 * Session state management — ~/.sherwood/session.json
 *
 * Tracks per-syndicate cursors for XMTP messages and on-chain events.
 * Enables agents to catch up on what they missed between sessions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_DIR = path.join(os.homedir(), ".sherwood");
const SESSION_PATH = path.join(SESSION_DIR, "session.json");

export interface SyndicateSession {
  subdomain: string;
  vault: string; // vault address for event filtering
  governor: string; // governor address for proposal events
  // XMTP cursors
  lastMessageId: string;
  lastMessageTimestamp: number; // unix seconds
  // On-chain cursors
  lastBlockNumber: number;
  // Session metadata
  lastCheckAt: number; // unix seconds
  totalMessagesProcessed: number;
  totalEventsProcessed: number;
}

interface SessionState {
  version: 1;
  syndicates: Record<string, SyndicateSession>;
}

export function loadSessionState(): SessionState {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { version: 1, syndicates: {} };
}

export function saveSessionState(state: SessionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
}

export function getSession(subdomain: string): SyndicateSession | undefined {
  const state = loadSessionState();
  return state.syndicates[subdomain];
}

export function updateSession(
  subdomain: string,
  update: Partial<SyndicateSession>,
): void {
  const state = loadSessionState();
  const existing = state.syndicates[subdomain] || {
    subdomain,
    vault: "",
    governor: "",
    lastMessageId: "",
    lastMessageTimestamp: 0,
    lastBlockNumber: 0,
    lastCheckAt: 0,
    totalMessagesProcessed: 0,
    totalEventsProcessed: 0,
  };
  state.syndicates[subdomain] = { ...existing, ...update };
  saveSessionState(state);
}

export function resetSession(
  subdomain: string,
  sinceBlock?: number,
): void {
  const state = loadSessionState();
  if (sinceBlock !== undefined) {
    // Partial reset — just move the block cursor
    if (state.syndicates[subdomain]) {
      state.syndicates[subdomain].lastBlockNumber = sinceBlock;
      saveSessionState(state);
    }
  } else {
    // Full reset
    delete state.syndicates[subdomain];
    saveSessionState(state);
  }
}

export function getAllSessions(): Record<string, SyndicateSession> {
  return loadSessionState().syndicates;
}
