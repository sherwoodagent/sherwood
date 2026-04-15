/**
 * Phase 10 — Lifecycle
 *
 * Manages the full proposal lifecycle for each syndicate:
 *   1. Fetch on-chain proposal states via `proposal list --vault <addr> --state all`
 *   2. Execute approved proposals (voting period ended, ready to deploy capital)
 *   3. Settle executed proposals (strategy duration elapsed, unwind position)
 *   4. Re-propose after all proposals are settled (start a new cycle)
 *
 * Designed to be called on a recurring schedule (e.g. every 15 minutes via
 * Claude's native cron). Each invocation does one pass — no loops or sleeps.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood, execSherwoodAsync, parseProposalId } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateSyndicate, saveState } from "../state.js";
import { getProposalSpec } from "../proposal-specs.js";
import type { SimLogger } from "../logger.js";

const ACTIVE_STATES = ["Draft", "Pending", "Approved", "Executed"];

export interface LifecycleResult {
  executed: number;
  settled: number;
  proposed: number;
  errors: string[];
}

/**
 * Parse `proposal list` table output to extract proposal IDs and on-chain states.
 */
function parseProposalList(output: string): Array<{ id: number; state: string }> {
  const results: Array<{ id: number; state: string }> = [];
  const states = [
    "Draft", "Pending", "Approved", "Executed",
    "Settled", "Rejected", "Expired", "Cancelled",
  ];
  for (const state of states) {
    const pattern = new RegExp(`^\\s*(\\d+)\\s+.*${state}`, "gm");
    for (const match of output.matchAll(pattern)) {
      results.push({ id: parseInt(match[1], 10), state });
    }
  }
  return results;
}

export async function runPhase10(
  config: SimConfig,
  state: SimState,
  logger?: SimLogger,
): Promise<LifecycleResult> {
  console.log("\n=== Phase 10: Lifecycle ===\n");
  logger?.setPhase(10);
  logger?.info("phase 10 started: lifecycle");

  const result: LifecycleResult = { executed: 0, settled: 0, proposed: 0, errors: [] };

  // Different syndicates use different creator wallets — parallelize across syndicates.
  // Within each syndicate, execute/settle/re-propose stay sequential (same wallet, ordered nonces).
  await runInPool(
    state.syndicates.filter((s) => s.vault || config.dryRun),
    config.concurrency,
    async (syndicate) => {
      const creator = state.agents.find(
        (a) => a.role === "creator" && a.syndicateSubdomain === syndicate.subdomain,
      );
      if (!creator) return;

      const creatorHome = agentHomeDir(config.baseDir, creator.index);
      const vault = syndicate.vault!;

      // 1. Fetch current on-chain proposal states
      let onChainProposals: Array<{ id: number; state: string }> = [];
      try {
        const listOutput = await execSherwoodAsync(
          creatorHome,
          ["proposal", "list", "--vault", vault, "--state", "all"],
          config,
          logger,
          creator.index,
        );
        onChainProposals = parseProposalList(listOutput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `${syndicate.subdomain}: failed to list proposals: ${msg.split("\n")[0]}`,
        );
        return;
      }

      console.log(`  [${syndicate.subdomain}] ${onChainProposals.length} proposals on-chain`);

      // 2. Execute approved proposals (sequential — same wallet)
      for (const onChain of onChainProposals.filter((p) => p.state === "Approved")) {
        try {
          console.log(`  [${syndicate.subdomain}] Executing proposal #${onChain.id}...`);
          execSherwood(
            creatorHome,
            ["proposal", "execute", "--id", String(onChain.id)],
            config,
            logger,
            creator.index,
          );

          const tracked = syndicate.proposals.find((p) => p.id === onChain.id);
          if (tracked) {
            tracked.state = "executed";
            tracked.executedAt = Date.now();
          }
          saveState(config.stateFile, state);
          result.executed++;
          console.log(`  [${syndicate.subdomain}] Proposal #${onChain.id} executed`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(
            `${syndicate.subdomain} execute #${onChain.id}: ${msg.split("\n")[0]}`,
          );
        }
      }

      // 3. Settle executed proposals (contract rejects if duration hasn't elapsed)
      for (const onChain of onChainProposals.filter((p) => p.state === "Executed")) {
        try {
          console.log(`  [${syndicate.subdomain}] Settling proposal #${onChain.id}...`);
          execSherwood(
            creatorHome,
            ["proposal", "settle", "--id", String(onChain.id)],
            config,
            logger,
            creator.index,
          );

          const tracked = syndicate.proposals.find((p) => p.id === onChain.id);
          if (tracked) {
            tracked.state = "settled";
            tracked.settledAt = Date.now();
          }
          saveState(config.stateFile, state);
          result.settled++;
          console.log(`  [${syndicate.subdomain}] Proposal #${onChain.id} settled`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const lower = msg.toLowerCase();
          if (
            lower.includes("duration") ||
            lower.includes("not elapsed") ||
            lower.includes("too early")
          ) {
            console.log(
              `  [${syndicate.subdomain}] Proposal #${onChain.id} duration not yet elapsed — skipping`,
            );
          } else {
            result.errors.push(
              `${syndicate.subdomain} settle #${onChain.id}: ${msg.split("\n")[0]}`,
            );
          }
        }
      }

      // 4. Re-propose if no active proposals remain
      const hasActiveProposal = onChainProposals.some((p) => ACTIVE_STATES.includes(p.state));

      if (!hasActiveProposal) {
        const settledCount = syndicate.proposals.filter((p) => p.state === "settled").length;
        const cycle = settledCount + 1;

        try {
          console.log(
            `  [${syndicate.subdomain}] No active proposals — creating cycle ${cycle} proposal...`,
          );
          const spec = getProposalSpec(creator.index, vault, config.strategyDuration, cycle, config.chain);

          const output = execSherwood(
            creatorHome,
            ["strategy", "propose", spec.strategy, ...spec.args],
            config,
            logger,
            creator.index,
          );

          const proposalId = config.dryRun ? Date.now() % 10000 : parseProposalId(output);

          syndicate.proposals.push({
            id: proposalId,
            proposerIndex: creator.index,
            strategy: spec.strategy,
            state: "proposed",
            duration: config.strategyDuration,
          });
          saveState(config.stateFile, state);
          result.proposed++;
          console.log(
            `  [${syndicate.subdomain}] New proposal created${proposalId !== undefined ? ` (#${proposalId})` : ""}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${syndicate.subdomain} re-propose: ${msg.split("\n")[0]}`);
        }
      }
    },
  );

  logger?.info(
    `phase 10 complete: executed=${result.executed} settled=${result.settled} proposed=${result.proposed} errors=${result.errors.length}`,
  );
  console.log(
    `\nLifecycle complete: ${result.executed} executed, ${result.settled} settled, ${result.proposed} proposed, ${result.errors.length} errors`,
  );
  return result;
}
