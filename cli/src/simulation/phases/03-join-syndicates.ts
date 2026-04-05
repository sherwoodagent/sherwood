/**
 * Phase 03 — Join Syndicates
 *
 * For agents 6-12 (joiners):
 *   - Assigned round-robin across the 5 syndicates (2-3 joiners each)
 *   - Run: sherwood syndicate join --subdomain <name> --message "<persona intro>"
 *   - This sends an EAS attestation request
 *
 * Idempotent: skips joiners that have already requested membership.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwoodAsync } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateAgent } from "../state.js";
import { PERSONAS } from "../personas.js";
import type { SimLogger } from "../logger.js";

/**
 * Assign joiners to syndicates round-robin.
 * Returns a map of agentIndex → syndicateSubdomain.
 */
function assignJoinersToSyndicates(
  joiners: { index: number }[],
  syndicates: { subdomain: string; creatorIndex: number }[],
): Map<number, string> {
  const assignments = new Map<number, string>();
  const availableSyndicates = syndicates.filter((s) => s.subdomain);

  joiners.forEach((joiner, i) => {
    const syndicate = availableSyndicates[i % availableSyndicates.length];
    if (syndicate) {
      assignments.set(joiner.index, syndicate.subdomain);
    }
  });

  return assignments;
}

export async function runPhase03(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 03: Join Syndicates ===\n");
  logger?.setPhase(3);
  logger?.info("phase 03 started: join syndicates");

  const joiners = state.agents.filter((a) => a.role === "joiner");
  const syndicates = state.syndicates.filter((s) => s.vault || config.dryRun);

  if (syndicates.length === 0) {
    console.log("No syndicates with vaults yet — run Phase 02 first.");
    return;
  }

  const assignments = assignJoinersToSyndicates(joiners, syndicates);

  // Also update syndicate member lists
  for (const [joinerIndex, subdomain] of assignments) {
    const syn = state.syndicates.find((s) => s.subdomain === subdomain);
    if (syn && !syn.members.includes(joinerIndex)) {
      syn.members.push(joinerIndex);
    }
  }

  if (!config.hasEas) {
    // No EAS on this chain — skip join attestation, just track assignments for phase 04
    console.log(`No EAS on ${config.chain} — recording assignments without join attestation.\n`);
    for (const joiner of joiners) {
      if (joiner.joinRequested) continue;
      const subdomain = assignments.get(joiner.index);
      if (!subdomain) continue;
      updateAgent(config.stateFile, state, joiner.index - 1, {
        joinRequested: true,
        syndicateSubdomain: subdomain,
      });
      console.log(`  [agent-${joiner.index}] Assigned to "${subdomain}" (no EAS join needed)`);
    }
  } else {
    await runInPool(joiners, config.concurrency, async (joiner) => {
      if (joiner.joinRequested) {
        console.log(
          `  [agent-${joiner.index}] Already requested join for "${joiner.syndicateSubdomain}" — skipping`,
        );
        return;
      }

      if (!joiner.identityMinted) {
        console.error(`  [agent-${joiner.index}] Identity not minted yet — skipping join`);
        return;
      }

      const subdomain = assignments.get(joiner.index);
      if (!subdomain) {
        console.error(`  [agent-${joiner.index}] No syndicate assigned — skipping`);
        return;
      }

      const persona = PERSONAS.find((p) => p.index === joiner.index);
      const message = persona
        ? `${persona.name}: ${persona.description} Ready to contribute to the syndicate.`
        : `Agent ${joiner.index} requesting to join ${subdomain}`;

      const agentHome = agentHomeDir(config.baseDir, joiner.index);

      try {
        console.log(`  [agent-${joiner.index}] Requesting to join "${subdomain}"...`);

        await execSherwoodAsync(
          agentHome,
          ["syndicate", "join", "--subdomain", subdomain, "--message", message],
          config,
          logger,
          joiner.index,
        );

        updateAgent(config.stateFile, state, joiner.index - 1, {
          joinRequested: true,
          syndicateSubdomain: subdomain,
        });

        console.log(`  [agent-${joiner.index}] Join request sent to "${subdomain}"`);
      } catch (err) {
        console.error(
          `  [agent-${joiner.index}] Join request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  logger?.info("phase 03 complete");
  console.log("\nPhase 03 complete.");
}
