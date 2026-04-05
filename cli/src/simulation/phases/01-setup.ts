/**
 * Phase 01 — Setup
 *
 * For each agent (1 through agentCount):
 *   1. Derive wallet from mnemonic
 *   2. Create HOME dir with sherwood config containing privateKey
 *   3. Fund from master wallet (ETH + USDC)
 *   4. Run: sherwood identity mint --name "<persona>" --description "<desc>"
 *   5. Parse agent ID from output, save to state
 *
 * Idempotent: skips agents that are already funded / have identity minted.
 */

import type { SimConfig, SimState, AgentState, SyndicateState } from "../types.js";
import { deriveWallets } from "../wallets.js";
import { setupAgentHome, updateAgentConfig } from "../agent-home.js";
import { fundAgents } from "../fund-agents.js";
import { execSherwoodAsync, parseAgentId } from "../exec.js";
import { runInPool } from "../pool.js";
import { saveState, updateAgent, initState } from "../state.js";
import { getPersona, getCreators, getJoiners } from "../personas.js";
import type { SimLogger } from "../logger.js";

export async function runPhase01(config: SimConfig, state: SimState | null, logger?: SimLogger): Promise<SimState> {
  console.log("\n=== Phase 01: Setup ===\n");
  logger?.setPhase(1);
  logger?.info("phase 01 started: setup");

  // Derive all wallets (0 = master, 1-N = agents)
  const totalWallets = config.agentCount + 1; // +1 for master
  const wallets = deriveWallets(config.mnemonic, totalWallets);
  const masterWallet = wallets[0];
  const agentWallets = wallets.slice(1, config.agentCount + 1);

  console.log(`Master wallet: ${masterWallet.address}`);
  console.log(`Agent wallets: ${agentWallets.length}`);

  // Build initial state if needed
  if (!state) {
    const agents: AgentState[] = agentWallets.map((w, i) => {
      const agentIndex = i + 1; // 1-based
      const persona = getPersona(agentIndex, config.chain);
      return {
        index: agentIndex,
        address: w.address,
        privateKey: w.privateKey,
        role: agentIndex <= config.syndicateCount ? "creator" : "joiner",
        persona: persona?.name || `Agent ${agentIndex}`,
        funded: false,
        identityMinted: false,
        syndicateCreated: false,
        joinRequested: false,
        approved: false,
        deposited: false,
      };
    });

    // Build syndicates from creator personas
    const syndicates: SyndicateState[] = getCreators(config.chain)
      .slice(0, config.syndicateCount)
      .map((p) => ({
        subdomain: p.syndicateSubdomain!,
        name: p.syndicateName!,
        creatorIndex: p.index,
        members: [p.index], // creator is always a member
        proposals: [],
      }));

    state = initState(agents, syndicates);
    saveState(config.stateFile, state);
    console.log("Initialized fresh state.");
  }

  // 1. Create HOME dirs for all agents
  console.log("\nCreating agent HOME directories...");
  for (const agent of state.agents) {
    const wallet = agentWallets[agent.index - 1];
    if (!wallet) continue;
    setupAgentHome(config.baseDir, agent.index, wallet.privateKey, agent.agentId);
  }

  // 2. Fund agents from master wallet
  const unfundedAgents = state.agents
    .filter((a) => !a.funded)
    .map((a) => ({ index: a.index, address: a.address }));

  if (unfundedAgents.length > 0) {
    console.log(`\nFunding ${unfundedAgents.length} agents...`);
    const results = await fundAgents(masterWallet.privateKey, unfundedAgents, config);

    for (const result of results) {
      if (!result.error && !result.skipped) {
        updateAgent(config.stateFile, state, result.agentIndex - 1, { funded: true });
      } else if (result.skipped) {
        updateAgent(config.stateFile, state, result.agentIndex - 1, { funded: true });
      }
    }
  } else {
    console.log("All agents already funded — skipping.");
  }

  // 3. Mint identities for agents that don't have one
  const agentsNeedingIdentity = state.agents.filter((a) => !a.identityMinted);

  if (!config.hasIdentityRegistry) {
    // No ERC-8004 registry on this chain — mark all as minted with index-based IDs
    if (agentsNeedingIdentity.length > 0) {
      console.log(`\nNo identity registry on ${config.chain} — assigning synthetic IDs to ${agentsNeedingIdentity.length} agents...`);
      for (const agent of agentsNeedingIdentity) {
        const agentId = agent.index; // use index as placeholder ID
        updateAgentConfig(config.baseDir, agent.index, { agentId });
        updateAgent(config.stateFile, state, agent.index - 1, { identityMinted: true, agentId });
      }
    } else {
      console.log("\nAll agents have identities — skipping.");
    }
  } else {
    if (agentsNeedingIdentity.length > 0) {
      console.log(`\nMinting identities for ${agentsNeedingIdentity.length} agents...`);
    } else {
      console.log("\nAll agents have identities — skipping mint.");
    }

    await runInPool(agentsNeedingIdentity, config.concurrency, async (agent) => {
      const persona = getPersona(agent.index, config.chain);
      if (!persona) {
        console.error(`  [agent-${agent.index}] No persona found — skipping`);
        return;
      }

      const agentHome = setupAgentHome(config.baseDir, agent.index, agent.privateKey);

      try {
        const output = await execSherwoodAsync(
          agentHome,
          ["identity", "mint", "--name", persona.name, "--description", persona.description],
          config,
          logger,
          agent.index,
        );

        // Parse agent ID from output
        const agentId = config.dryRun ? agent.index * 100 : parseAgentId(output);
        if (agentId !== undefined) {
          updateAgentConfig(config.baseDir, agent.index, { agentId });
          updateAgent(config.stateFile, state, agent.index - 1, { identityMinted: true, agentId });
          console.log(`  [agent-${agent.index}] Identity minted: #${agentId}`);
        } else {
          console.warn(
            `  [agent-${agent.index}] Could not parse agent ID from output — marking minted anyway`,
          );
          updateAgent(config.stateFile, state, agent.index - 1, { identityMinted: true });
        }
      } catch (err) {
        console.error(
          `  [agent-${agent.index}] Identity mint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue — idempotent, will retry on next run
      }
    });
  }

  logger?.info("phase 01 complete");
  console.log("\nPhase 01 complete.");
  return state;
}
