/**
 * Phase 05 — Deposit
 *
 * For ALL agents (creators + approved joiners) in their respective syndicate:
 *   Run: sherwood vault deposit --amount <amount> --vault <addr>
 *
 * The CLI handles USDC approval internally.
 * Idempotent: skips agents that have already deposited.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood } from "../exec.js";
import { updateAgent } from "../state.js";
import { PERSONAS } from "../personas.js";
import type { SimLogger } from "../logger.js";

export async function runPhase05(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 05: Deposit ===\n");
  logger?.setPhase(5);
  logger?.info("phase 05 started: deposit");

  // All agents that are eligible to deposit:
  // - Creators: already have their vault
  // - Joiners: must be approved
  const eligibleAgents = state.agents.filter((agent) => {
    if (agent.deposited) return false;
    if (agent.role === "creator") {
      return agent.syndicateCreated && agent.syndicateVault;
    }
    return agent.approved && agent.syndicateSubdomain;
  });

  if (eligibleAgents.length === 0) {
    console.log("No eligible agents to deposit — all already deposited or not yet approved.");
    return;
  }

  console.log(`Depositing for ${eligibleAgents.length} agents...\n`);

  for (const agent of eligibleAgents) {
    // Resolve vault address
    let vault: string | undefined;

    if (agent.role === "creator") {
      vault = agent.syndicateVault;
    } else {
      // Joiner: get vault from their assigned syndicate
      const syn = state.syndicates.find((s) => s.subdomain === agent.syndicateSubdomain);
      vault = syn?.vault;
    }

    if (!vault) {
      console.error(`  [agent-${agent.index}] No vault address found — skipping deposit`);
      continue;
    }

    // Determine vault asset type
    const syn = state.syndicates.find((s) => s.subdomain === agent.syndicateSubdomain);
    const isWethVault = syn?.asset === "WETH";

    // Get deposit amount — WETH vaults use a fixed ETH amount (~$10 at ~$2500/ETH)
    const persona = PERSONAS.find((p) => p.index === agent.index);
    const amount = isWethVault ? "0.004" : (persona?.depositAmount || "10");
    const assetLabel = isWethVault ? "ETH (->WETH)" : "USDC";

    const agentHome = agentHomeDir(config.baseDir, agent.index);

    try {
      console.log(`  [agent-${agent.index}] Depositing ${amount} ${assetLabel} into ${vault}...`);

      const depositArgs = [
        "vault",
        "deposit",
        "--amount",
        amount,
        "--vault",
        vault,
      ];

      // For WETH vaults, --use-eth wraps native ETH to WETH
      if (isWethVault) {
        depositArgs.push("--use-eth");
      }

      execSherwood(
        agentHome,
        depositArgs,
        config,
        logger,
        agent.index,
      );

      updateAgent(config.stateFile, state, agent.index - 1, { deposited: true });
      console.log(`  [agent-${agent.index}] Deposited ${amount} ${assetLabel}`);
    } catch (err) {
      console.error(
        `  [agent-${agent.index}] Deposit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger?.info("phase 05 complete");
  console.log("\nPhase 05 complete.");
}
