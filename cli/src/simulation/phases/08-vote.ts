/**
 * Phase 08 — Vote
 *
 * For each member in each syndicate with a pending proposal:
 *   Run: sherwood proposal vote --id <id> --support for
 *
 * Idempotent: tracks voted proposals per agent via state.
 * All voters vote FOR in the simulation (optimistic governance — default passes).
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwoodAsync } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateSyndicate } from "../state.js";
import { getPersona } from "../personas.js";
import type { SimLogger } from "../logger.js";

export async function runPhase08(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 08: Vote ===\n");
  logger?.setPhase(8);
  logger?.info("phase 08 started: vote");

  for (const syndicate of state.syndicates) {
    // Find proposals in "proposed" state that have an ID
    const activeProposals = syndicate.proposals.filter(
      (p) => p.state === "proposed" && p.id !== undefined,
    );

    if (activeProposals.length === 0) {
      console.log(`  [${syndicate.subdomain}] No active proposals — skipping votes`);
      continue;
    }

    // Find members that can vote (deposited = have shares)
    const voters = state.agents.filter(
      (a) =>
        syndicate.members.includes(a.index) &&
        a.deposited,
    );

    if (voters.length === 0) {
      console.log(`  [${syndicate.subdomain}] No deposited members to vote — skipping`);
      continue;
    }

    for (const proposal of activeProposals) {
      if (proposal.id === undefined) continue;

      console.log(
        `  [${syndicate.subdomain}] Voting on proposal #${proposal.id} (${voters.length} voters)...`,
      );

      let voteCount = 0;
      await runInPool(voters, config.concurrency, async (voter) => {
        const persona = getPersona(voter.index, config.chain);

        // Risk Sentinel votes AGAINST sometimes to add realism
        const isRiskSentinel = persona?.name === "Risk Sentinel";
        const support = isRiskSentinel && Math.random() < 0.3 ? "against" : "for";

        const voterHome = agentHomeDir(config.baseDir, voter.index);

        try {
          await execSherwoodAsync(
            voterHome,
            ["proposal", "vote", "--id", String(proposal.id), "--support", support],
            config,
            logger,
            voter.index,
          );
          voteCount++;

          const supportLabel = support === "for" ? "FOR" : "AGAINST";
          console.log(`    [agent-${voter.index}] Voted ${supportLabel} on #${proposal.id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.toLowerCase().includes("already voted") || msg.toLowerCase().includes("already cast")) {
            console.log(`    [agent-${voter.index}] Already voted on #${proposal.id} — skipping`);
          } else {
            console.error(`    [agent-${voter.index}] Vote failed: ${msg}`);
          }
        }
      });

      if (voteCount > 0) {
        // Mark proposal as voted
        updateSyndicate(config.stateFile, state, syndicate.subdomain, {
          proposals: syndicate.proposals.map((p) =>
            p.id === proposal.id ? { ...p, state: "voted" as const } : p,
          ),
        });

        console.log(
          `  [${syndicate.subdomain}] Voting complete for proposal #${proposal.id} (${voteCount} votes cast)`,
        );
      }
    }
  }

  logger?.info("phase 08 complete");
  console.log("\nPhase 08 complete.");
}
