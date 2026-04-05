/**
 * Phase 04 — Approve Members
 *
 * For each creator:
 *   1. Run: sherwood syndicate requests --subdomain <name>
 *   2. For each pending: sherwood syndicate approve --agent-id <id> --wallet <addr> --subdomain <name>
 *
 * This auto-registers the agent on vault + adds to XMTP group.
 * Idempotent: skips joiners that are already approved.
 */

import type { SimConfig, SimState } from "../types.js";
import { agentHomeDir } from "../agent-home.js";
import { execSherwood, execSherwoodAsync } from "../exec.js";
import { runInPool } from "../pool.js";
import { updateAgent } from "../state.js";
import type { SimLogger } from "../logger.js";

interface JoinRequest {
  agentId: number;
  walletAddress: string;
  attestationUid?: string;
}

/**
 * Parse join requests from `syndicate requests` output.
 * Output format varies — try to parse JSON or text patterns.
 */
function parseJoinRequests(output: string): JoinRequest[] {
  const requests: JoinRequest[] = [];

  // Try JSON array format
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.agentId && item.walletAddress) {
          requests.push({
            agentId: Number(item.agentId),
            walletAddress: item.walletAddress,
            attestationUid: item.uid || item.attestationUid,
          });
        }
      }
      return requests;
    }
  } catch {
    // Not JSON — try text parsing
  }

  // Text pattern: "Agent #123 from 0x..." or "agentId: 123, wallet: 0x..."
  const agentIdPattern = /agent.*?#(\d+)/gi;
  const walletPattern = /0x[0-9a-fA-F]{40}/g;

  const agentIds = [...output.matchAll(agentIdPattern)].map((m) => parseInt(m[1], 10));
  const wallets = [...output.matchAll(walletPattern)].map((m) => m[0]);

  for (let i = 0; i < Math.min(agentIds.length, wallets.length); i++) {
    requests.push({ agentId: agentIds[i], walletAddress: wallets[i] });
  }

  return requests;
}

export async function runPhase04(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  console.log("\n=== Phase 04: Approve Members ===\n");
  logger?.setPhase(4);
  logger?.info("phase 04 started: approve members");

  const creators = state.agents.filter((a) => a.role === "creator" && a.syndicateCreated);

  if (creators.length === 0) {
    console.log("No creators with syndicates — run Phase 02 first.");
    return;
  }

  // Different creators use different wallets — parallelize across creators.
  // Within each creator, approvals must be sequential (same wallet, sequential nonces).
  await runInPool(creators, config.concurrency, async (creator) => {
    const subdomain = creator.syndicateSubdomain;
    if (!subdomain) return;

    const syndicate = state.syndicates.find((s) => s.subdomain === subdomain);
    if (!syndicate) return;

    const pendingJoiners = state.agents.filter(
      (a) =>
        a.role === "joiner" &&
        a.syndicateSubdomain === subdomain &&
        a.joinRequested &&
        !a.approved,
    );

    if (pendingJoiners.length === 0) {
      console.log(`  [agent-${creator.index}] No pending joiners for "${subdomain}" — skipping`);
      return;
    }

    const creatorHome = agentHomeDir(config.baseDir, creator.index);

    // List pending requests (EAS only — skip on chains without EAS)
    let requests: JoinRequest[] = [];

    if (!config.hasEas) {
      console.log(`  [agent-${creator.index}] No EAS on ${config.chain} — using direct add for "${subdomain}"`);
    } else if (!config.dryRun) {
      console.log(`  [agent-${creator.index}] Checking requests for "${subdomain}"...`);
      try {
        const requestsOutput = await execSherwoodAsync(
          creatorHome,
          ["syndicate", "requests", "--subdomain", subdomain],
          config,
          logger,
          creator.index,
        );
        requests = parseJoinRequests(requestsOutput);
        console.log(`  [agent-${creator.index}] Found ${requests.length} pending requests`);
      } catch (err) {
        console.error(
          `  [agent-${creator.index}] Failed to fetch requests: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Approve each pending joiner — sequential within a creator (same wallet, nonce order)
    for (const joiner of pendingJoiners) {
      const agentId = joiner.agentId ?? joiner.index; // fallback to index if no ERC-8004 ID

      try {
        if (!config.hasEas) {
          // No EAS — use `syndicate add` (direct registration, no attestation)
          const vault = syndicate.vault;
          if (!vault) {
            console.error(
              `  [agent-${creator.index}] No vault address for "${subdomain}" — skipping add`,
            );
            continue;
          }

          console.log(
            `  [agent-${creator.index}] Adding agent-${joiner.index} (${joiner.address}) to "${subdomain}" via syndicate add...`,
          );

          execSherwood(
            creatorHome,
            [
              "syndicate", "add",
              "--vault", vault,
              "--agent-id", String(agentId),
              "--wallet", joiner.address,
            ],
            config,
            logger,
            creator.index,
          );
        } else {
          if (!joiner.agentId) {
            console.error(
              `  [agent-${creator.index}] Joiner agent-${joiner.index} has no agentId — skipping approve`,
            );
            continue;
          }

          console.log(
            `  [agent-${creator.index}] Approving agent-${joiner.index} (id:${joiner.agentId}, ${joiner.address}) for "${subdomain}"...`,
          );

          execSherwood(
            creatorHome,
            [
              "syndicate", "approve",
              "--agent-id", String(joiner.agentId),
              "--wallet", joiner.address,
              "--subdomain", subdomain,
            ],
            config,
            logger,
            creator.index,
          );
        }

        updateAgent(config.stateFile, state, joiner.index - 1, { approved: true });
        console.log(`  [agent-${creator.index}] Registered agent-${joiner.index}`);
      } catch (err) {
        console.error(
          `  [agent-${creator.index}] Registration failed for agent-${joiner.index}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  logger?.info("phase 04 complete");
  console.log("\nPhase 04 complete.");
}
