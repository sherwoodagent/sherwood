/**
 * Phase 09 — Heartbeat (Ongoing Loop)
 *
 * Continuous loop for Claude to run. Each round:
 *   1. For each syndicate: check XMTP log for recent messages
 *   2. If new messages since last heartbeat: send a contextual reply
 *   3. Check proposals: sherwood proposal list --vault <addr>
 *   4. If pending proposal needs vote: vote
 *   5. If no active proposals and agent is creator: consider proposing
 *   6. Update lastHeartbeat per agent
 *
 * Designed to be called repeatedly (e.g. every 5-10 minutes).
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood } from "../exec.js";
import { updateAgent, updateSyndicate, saveState } from "../state.js";
import { getPersona } from "../personas.js";
import type { SimLogger } from "../logger.js";

/**
 * Parse proposal list output to find pending proposals.
 * Returns IDs of proposals with state "Pending" or "Approved".
 */
function parsePendingProposals(output: string): number[] {
  const ids: number[] = [];
  // Match lines like "  5    0x123...  Pending   ..."
  const linePattern = /^\s{2}(\d+)\s+.*(Pending|Approved)\s*/gm;
  for (const match of output.matchAll(linePattern)) {
    ids.push(parseInt(match[1], 10));
  }
  return ids;
}

/**
 * Parse message log output to see if there are recent messages (by count).
 */
function hasRecentMessages(output: string, since: number): boolean {
  // Simple heuristic: if output has any content with a recent timestamp
  // (within since ms), treat as "new messages"
  if (!output.trim()) return false;

  // Look for timestamps in output (HH:MM format)
  const timePattern = /\[(\d{2}):(\d{2})\]/g;
  const now = new Date();
  const sinceMinutes = since / (1000 * 60);

  for (const match of output.matchAll(timePattern)) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const msgMinutes = hours * 60 + minutes;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    // Within the last `sinceMinutes` — rough heuristic (ignores date rollover)
    if (Math.abs(nowMinutes - msgMinutes) <= sinceMinutes) {
      return true;
    }
  }

  return false;
}

/**
 * Pick a contextual reply from a persona's chat lines (excluding the last
 * one already used in phase 06).
 */
function pickReply(personaIndex: number, chain?: string): string {
  const persona = getPersona(personaIndex, chain);
  if (!persona || persona.chatLines.length === 0) {
    return "Acknowledged. Monitoring strategy progress.";
  }
  // Rotate through chat lines
  const idx = Math.floor(Math.random() * persona.chatLines.length);
  return persona.chatLines[idx];
}

export interface HeartbeatRoundResult {
  round: number;
  messagesChecked: number;
  repliesSent: number;
  votescast: number;
  errors: string[];
}

/**
 * Run a single heartbeat round across all syndicates.
 */
export async function runHeartbeatRound(
  config: SimConfig,
  state: SimState,
  round: number,
  logger?: SimLogger,
): Promise<HeartbeatRoundResult> {
  const result: HeartbeatRoundResult = {
    round,
    messagesChecked: 0,
    repliesSent: 0,
    votescast: 0,
    errors: [],
  };

  const now = Date.now();
  const heartbeatWindowMs = 10 * 60 * 1000; // 10 minutes

  for (const syndicate of state.syndicates) {
    if (!syndicate.vault && !config.dryRun) continue;

    const memberAgents = state.agents.filter(
      (a) => syndicate.members.includes(a.index) && a.deposited,
    );

    if (memberAgents.length === 0) continue;

    // 1. Check XMTP chat log
    const chatChecker = memberAgents[0];
    const chatHome = agentHomeDir(config.baseDir, chatChecker.index);

    try {
      const logOutput = execSherwood(
        chatHome,
        ["chat", syndicate.subdomain, "log", "--limit", "5"],
        config,
        logger,
        chatChecker.index,
      );
      result.messagesChecked++;

      // If there are recent messages, pick a random agent to reply
      const lastHeartbeat = chatChecker.lastHeartbeat || 0;
      if (hasRecentMessages(logOutput, now - lastHeartbeat) && memberAgents.length > 1) {
        const replier = memberAgents[Math.floor(Math.random() * memberAgents.length)];
        const reply = pickReply(replier.index, config.chain);
        const replierHome = agentHomeDir(config.baseDir, replier.index);

        try {
          execSherwood(
            replierHome,
            ["chat", syndicate.subdomain, "send", reply, "--markdown"],
            config,
            logger,
            replier.index,
          );
          result.repliesSent++;
        } catch (chatErr) {
          // XMTP errors are non-fatal
        }
      }
    } catch (chatErr) {
      // Chat check failures are non-fatal
    }

    // 2. Check proposals
    if (syndicate.vault) {
      try {
        const proposalOutput = execSherwood(
          chatHome,
          ["proposal", "list", "--vault", syndicate.vault],
          config,
          logger,
          chatChecker.index,
        );

        const pendingIds = parsePendingProposals(proposalOutput);

        // Vote on any pending proposals
        for (const proposalId of pendingIds) {
          // Check if the proposal is tracked in state as already voted
          const tracked = syndicate.proposals.find(
            (p) => p.id === proposalId && (p.state === "voted" || p.state === "executed" || p.state === "settled"),
          );
          if (tracked) continue;

          // Vote with all deposited members
          for (const voter of memberAgents) {
            const voterHome = agentHomeDir(config.baseDir, voter.index);
            try {
              execSherwood(
                voterHome,
                ["proposal", "vote", "--id", String(proposalId), "--support", "for"],
                config,
                logger,
                voter.index,
              );
              result.votescast++;
            } catch (voteErr) {
              const msg = voteErr instanceof Error ? voteErr.message : String(voteErr);
              if (!msg.toLowerCase().includes("already voted") && !msg.toLowerCase().includes("not pending")) {
                result.errors.push(`vote #${proposalId} agent-${voter.index}: ${msg}`);
              }
            }
          }

          // Mark as voted in state — preserve existing proposal data
          const existing = syndicate.proposals.find((p) => p.id === proposalId);
          updateSyndicate(config.stateFile, state, syndicate.subdomain, {
            proposals: [
              ...syndicate.proposals.filter((p) => p.id !== proposalId),
              {
                id: proposalId,
                proposerIndex: existing?.proposerIndex ?? syndicate.creatorIndex,
                strategy: existing?.strategy ?? "unknown",
                state: "voted",
                duration: existing?.duration,
              },
            ],
          });
        }
      } catch (propErr) {
        // Proposal list failure is non-fatal
      }
    }

    // Proposal lifecycle (execute, settle, re-propose) is handled by phase 10 (lifecycle).
  }

  // Update lastHeartbeat for all agents
  for (const agent of state.agents) {
    updateAgent(config.stateFile, state, agent.index - 1, { lastHeartbeat: now });
  }

  return result;
}

/**
 * Run N heartbeat rounds with a delay between each.
 */
export async function runPhase09(
  config: SimConfig,
  state: SimState,
  rounds: number = 3,
  logger?: SimLogger,
): Promise<void> {
  console.log(`\n=== Phase 09: Heartbeat (${rounds} rounds) ===\n`);
  logger?.setPhase(9);
  logger?.info(`phase 09 started: heartbeat x${rounds}`);

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n--- Heartbeat Round ${round}/${rounds} ---`);

    const result = await runHeartbeatRound(config, state, round, logger);

    console.log(`  Messages checked:  ${result.messagesChecked}`);
    console.log(`  Replies sent:      ${result.repliesSent}`);
    console.log(`  Votes cast:        ${result.votescast}`);

    if (result.errors.length > 0) {
      console.log(`  Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }

    if (round < rounds) {
      console.log("\n  Waiting 30s before next round...");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  logger?.info("phase 09 complete");
  console.log("\nPhase 09 complete.");
}
