/**
 * Phase 02 — Create Syndicates
 *
 * For agents 1-5 (creators):
 *   1. Run: sherwood syndicate create --name "<Fund Name>" --subdomain <slug>
 *           --agent-id <id> --asset USDC --open-deposits --public-chat -y
 *   2. Parse vault address from output, save to state
 *
 * Idempotent: skips creators that have already created their syndicate.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir, updateAgentConfig } from "../agent-home.js";
import { execSherwoodAsync, parseVaultAddress } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateAgent, updateSyndicate } from "../state.js";
import { getPersona } from "../personas.js";
import { CHAIN_REGISTRY } from "../../lib/network.js";
import type { SimLogger } from "../logger.js";

export async function runPhase02(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 02: Create Syndicates ===\n");
  logger?.setPhase(2);
  logger?.info("phase 02 started: create syndicates");

  const creators = state.agents.filter((a) => a.role === "creator");

  await runInPool(creators, config.concurrency, async (creator) => {
    if (creator.syndicateCreated) {
      console.log(
        `  [agent-${creator.index}] Already created syndicate "${creator.syndicateSubdomain}" — skipping`,
      );
      return;
    }

    if (!creator.identityMinted || creator.agentId === undefined) {
      console.error(
        `  [agent-${creator.index}] Identity not minted yet — skipping syndicate creation`,
      );
      return;
    }

    const persona = getPersona(creator.index, config.chain);
    if (!persona || !persona.syndicateName || !persona.syndicateSubdomain) {
      console.error(`  [agent-${creator.index}] No syndicate persona — skipping`);
      return;
    }

    const agentHome = agentHomeDir(config.baseDir, creator.index);

    try {
      console.log(
        `  [agent-${creator.index}] Creating syndicate "${persona.syndicateName}" (${persona.syndicateSubdomain})...`,
      );

      const vaultAsset = persona.vaultAsset || "USDC";

      const output = await execSherwoodAsync(
        agentHome,
        [
          "syndicate", "create",
          "--name", persona.syndicateName,
          "--subdomain", persona.syndicateSubdomain,
          "--description", persona.syndicateDescription || persona.description,
          "--agent-id", String(creator.agentId),
          "--asset", vaultAsset,
          "--open-deposits",
          "--public-chat",
          "-y",
        ],
        config,
        logger,
        creator.index,
      );

      const vault = config.dryRun
        ? `0x${creator.index.toString().padStart(40, "0")}`
        : parseVaultAddress(output);

      if (vault) {
        const chainId = String(CHAIN_REGISTRY[config.chain].chain.id);
        updateAgentConfig(config.baseDir, creator.index, {
          contracts: { [chainId]: { vault } },
        });
        updateAgent(config.stateFile, state, creator.index - 1, {
          syndicateCreated: true,
          syndicateSubdomain: persona.syndicateSubdomain,
          syndicateVault: vault,
        });
        updateSyndicate(config.stateFile, state, persona.syndicateSubdomain, {
          vault,
          asset: vaultAsset,
        });
        console.log(`  [agent-${creator.index}] Syndicate created! Vault: ${vault}`);
      } else {
        console.warn(
          `  [agent-${creator.index}] Could not parse vault address — marking created without vault`,
        );
        updateAgent(config.stateFile, state, creator.index - 1, {
          syndicateCreated: true,
          syndicateSubdomain: persona.syndicateSubdomain,
        });
      }
    } catch (err) {
      console.error(
        `  [agent-${creator.index}] Syndicate creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  logger?.info("phase 02 complete");
  console.log("\nPhase 02 complete.");
}
