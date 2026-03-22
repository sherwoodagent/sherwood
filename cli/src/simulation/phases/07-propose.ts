/**
 * Phase 07 — Propose
 *
 * For each creator in their syndicate:
 *   Run: sherwood strategy propose moonwell-supply
 *         --vault <addr> --amount <amount> --min-redeem <min>
 *         --name "<Strategy Name>" --performance-fee 1000 --duration 7d
 *
 * Uses the strategy propose command which clones + inits + submits proposal in one step.
 * Parses proposal ID from output and saves to state.
 *
 * Idempotent: skips syndicates that already have a proposed strategy.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood, parseProposalId } from "../exec.js";
import { updateSyndicate } from "../state.js";
import type { SimLogger } from "../logger.js";

interface ProposalSpec {
  strategy: "moonwell-supply";
  amount: string;
  minRedeem: string;
  name: string;
  description: string;
  performanceFee: string; // bps
  duration: string;
}

/**
 * Get a strategy proposal spec for a given syndicate index (1-5).
 * Varies by creator persona to add variety to the simulation.
 */
function getProposalSpec(creatorIndex: number): ProposalSpec {
  const specs: Record<number, ProposalSpec> = {
    1: {
      strategy: "moonwell-supply",
      amount: "20",
      minRedeem: "19",
      name: "Moonwell USDC Yield Cycle 1",
      description: "Conservative 7-day USDC supply to Moonwell. Capital preservation priority.",
      performanceFee: "1000", // 10%
      duration: "7d",
    },
    2: {
      strategy: "moonwell-supply",
      amount: "15",
      minRedeem: "14",
      name: "Aerodrome Base Yield",
      description: "Moonwell USDC supply as base yield while LP pool is scouted.",
      performanceFee: "1000",
      duration: "7d",
    },
    3: {
      strategy: "moonwell-supply",
      amount: "12",
      minRedeem: "11",
      name: "USDC Base Yield (Pre-Venice)",
      description: "USDC supply yield while VVV liquidity is assessed.",
      performanceFee: "800",
      duration: "7d",
    },
    4: {
      strategy: "moonwell-supply",
      amount: "15",
      minRedeem: "14",
      name: "USDC Holding Strategy",
      description: "USDC supply on Moonwell while ETH staking position is prepared.",
      performanceFee: "800",
      duration: "7d",
    },
    5: {
      strategy: "moonwell-supply",
      amount: "12",
      minRedeem: "11",
      name: "Multi-Strategy Anchor",
      description: "USDC supply anchor position. Additional strategies pending member vote.",
      performanceFee: "1000",
      duration: "7d",
    },
  };

  return specs[creatorIndex] || specs[1];
}

export async function runPhase07(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 07: Propose Strategies ===\n");
  logger?.setPhase(7);
  logger?.info("phase 07 started: propose strategies");

  const creators = state.agents.filter((a) => a.role === "creator" && a.syndicateCreated);

  for (const creator of creators) {
    const subdomain = creator.syndicateSubdomain;
    if (!subdomain) continue;

    const syndicate = state.syndicates.find((s) => s.subdomain === subdomain);
    if (!syndicate) continue;

    // Skip if syndicate already has a proposal
    if (syndicate.proposals.length > 0) {
      console.log(`  [agent-${creator.index}] "${subdomain}" already has proposals — skipping`);
      continue;
    }

    const vault = syndicate.vault;
    if (!vault && !config.dryRun) {
      console.error(`  [agent-${creator.index}] No vault for "${subdomain}" — skipping proposal`);
      continue;
    }

    const spec = getProposalSpec(creator.index);
    const creatorHome = agentHomeDir(config.baseDir, creator.index);

    try {
      console.log(
        `  [agent-${creator.index}] Proposing "${spec.name}" for "${subdomain}"...`,
      );

      const output = execSherwood(
        creatorHome,
        [
          "strategy",
          "propose",
          spec.strategy,
          "--vault",
          vault || "0x0000000000000000000000000000000000000001",
          "--amount",
          spec.amount,
          "--min-redeem",
          spec.minRedeem,
          "--name",
          spec.name,
          "--description",
          spec.description,
          "--performance-fee",
          spec.performanceFee,
          "--duration",
          spec.duration,
        ],
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
  }

  logger?.info("phase 07 complete");
  console.log("\nPhase 07 complete.");
}
