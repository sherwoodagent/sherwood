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
import { execSherwoodAsync } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateAgent } from "../state.js";
import { getPersona } from "../personas.js";
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

  await runInPool(eligibleAgents, config.concurrency, async (agent) => {
    // Resolve vault address
    let vault: string | undefined;

    if (agent.role === "creator") {
      vault = agent.syndicateVault;
    } else {
      const syn = state.syndicates.find((s) => s.subdomain === agent.syndicateSubdomain);
      vault = syn?.vault;
    }

    if (!vault) {
      console.error(`  [agent-${agent.index}] No vault address found — skipping deposit`);
      return;
    }

    const syn = state.syndicates.find((s) => s.subdomain === agent.syndicateSubdomain);
    const isWethVault = syn?.asset === "WETH";

    const persona = getPersona(agent.index, config.chain);
    // For WETH vaults: use persona's depositAmount if ETH-denominated (< 1.0),
    // otherwise fall back to 0.004 (Base personas have USDC-denominated amounts like "10")
    const wethDeposit = persona?.depositAmount && parseFloat(persona.depositAmount) < 1
      ? persona.depositAmount
      : "0.004";
    const amount = isWethVault ? wethDeposit : (persona?.depositAmount || "10");
    const assetLabel = isWethVault ? "ETH (->WETH)" : "USDC";

    const agentHome = agentHomeDir(config.baseDir, agent.index);

    try {
      console.log(`  [agent-${agent.index}] Depositing ${amount} ${assetLabel} into ${vault}...`);

      const depositArgs = ["vault", "deposit", "--amount", amount, "--vault", vault];
      if (isWethVault) depositArgs.push("--use-eth");

      await execSherwoodAsync(agentHome, depositArgs, config, logger, agent.index);

      updateAgent(config.stateFile, state, agent.index - 1, { deposited: true });
      console.log(`  [agent-${agent.index}] Deposited ${amount} ${assetLabel}`);
    } catch (err) {
      console.error(
        `  [agent-${agent.index}] Deposit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  logger?.info("phase 05 complete");
  console.log("\nPhase 05 complete.");
}
