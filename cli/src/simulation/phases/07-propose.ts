/**
 * Phase 07 — Propose
 *
 * For each creator in their syndicate:
 *   Run: sherwood strategy propose <template> --vault <addr> ...
 *
 * Each creator's strategy template comes from their persona definition.
 * Uses the shared proposal-specs module for CLI arg building.
 *
 * Idempotent: skips syndicates that already have a proposed strategy.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwoodAsync, parseProposalId } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateSyndicate } from "../state.js";
import { getProposalSpec } from "../proposal-specs.js";
import type { SimLogger } from "../logger.js";

export async function runPhase07(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 07: Propose Strategies ===\n");
  logger?.setPhase(7);
  logger?.info("phase 07 started: propose strategies");

  const creators = state.agents.filter((a) => a.role === "creator" && a.syndicateCreated);

  await runInPool(creators, config.concurrency, async (creator) => {
    const subdomain = creator.syndicateSubdomain;
    if (!subdomain) return;

    const syndicate = state.syndicates.find((s) => s.subdomain === subdomain);
    if (!syndicate) return;

    if (syndicate.proposals.length > 0) {
      console.log(`  [agent-${creator.index}] "${subdomain}" already has proposals — skipping`);
      return;
    }

    const vault = syndicate.vault;
    if (!vault && !config.dryRun) {
      console.error(`  [agent-${creator.index}] No vault for "${subdomain}" — skipping proposal`);
      return;
    }

    const spec = getProposalSpec(
      creator.index,
      vault || "0x0000000000000000000000000000000000000001",
      config.strategyDuration,
      1,
      config.chain,
    );
    const creatorHome = agentHomeDir(config.baseDir, creator.index);

    try {
      console.log(
        `  [agent-${creator.index}] Proposing "${spec.name}" (${spec.strategy}) for "${subdomain}"...`,
      );

      const output = await execSherwoodAsync(
        creatorHome,
        ["strategy", "propose", spec.strategy, ...spec.args],
        config,
        logger,
        creator.index,
      );

      const proposalId = config.dryRun ? creator.index * 10 : parseProposalId(output);

      updateSyndicate(config.stateFile, state, subdomain, {
        proposals: [
          ...syndicate.proposals,
          {
            id: proposalId,
            proposerIndex: creator.index,
            strategy: spec.strategy,
            state: "proposed",
            duration: config.strategyDuration,
          },
        ],
      });

      console.log(
        `  [agent-${creator.index}] Proposal submitted${proposalId !== undefined ? ` (#${proposalId})` : ""}`,
      );
    } catch (err) {
      console.error(
        `  [agent-${creator.index}] Proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  logger?.info("phase 07 complete");
  console.log("\nPhase 07 complete.");
}
