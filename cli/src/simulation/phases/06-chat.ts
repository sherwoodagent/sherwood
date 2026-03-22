/**
 * Phase 06 — Chat
 *
 * For each syndicate, pick random members and send XMTP messages
 * themed to their persona. Messages are sent sequentially per syndicate
 * to avoid XMTP DB concurrency issues.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood } from "../exec.js";
import { PERSONAS } from "../personas.js";
import type { SimLogger } from "../logger.js";

/**
 * Pick a random element from an array.
 */
function pickRandom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function runPhase06(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 06: Chat ===\n");
  logger?.setPhase(6);
  logger?.info("phase 06 started: chat");

  for (const syndicate of state.syndicates) {
    if (!syndicate.vault && !config.dryRun) {
      console.log(`  [${syndicate.subdomain}] No vault yet — skipping chat`);
      continue;
    }

    // Find all members of this syndicate
    const memberAgents = state.agents.filter((a) => syndicate.members.includes(a.index));

    if (memberAgents.length === 0) {
      console.log(`  [${syndicate.subdomain}] No members yet — skipping chat`);
      continue;
    }

    console.log(
      `  [${syndicate.subdomain}] Sending chat messages (${memberAgents.length} members)...`,
    );

    // Pick 2-3 random members to send messages
    const shuffled = [...memberAgents].sort(() => Math.random() - 0.5);
    const speakers = shuffled.slice(0, Math.min(3, memberAgents.length));

    for (const agent of speakers) {
      const persona = PERSONAS.find((p) => p.index === agent.index);
      if (!persona) continue;

      const message = pickRandom(persona.chatLines);
      if (!message) continue;

      const agentHome = agentHomeDir(config.baseDir, agent.index);

      try {
        console.log(`    [agent-${agent.index}] sending: "${message.slice(0, 60)}..."`);

        execSherwood(
          agentHome,
          [
            "chat",
            syndicate.subdomain,
            "send",
            message,
            "--markdown",
          ],
          config,
          logger,
          agent.index,
        );
      } catch (err) {
        // XMTP chat failures are non-fatal
        console.warn(
          `    [agent-${agent.index}] Chat failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  logger?.info("phase 06 complete");
  console.log("\nPhase 06 complete.");
}
