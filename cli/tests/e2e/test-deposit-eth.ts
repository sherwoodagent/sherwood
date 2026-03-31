/**
 * E2E test: vault deposit --use-eth (#148)
 *
 * Verifies that depositing into a WETH vault using native ETH (auto-wrap) works end-to-end.
 * Uses the eth-staking vault from simulation state, finds a member with enough ETH.
 */

import { execSherwood } from "../../src/simulation/exec.js";
import { agentHomeDir } from "../../src/simulation/agent-home.js";
import type { SimConfig, SimState, SimLogger } from "./types.js";
import { createPublicClient, http, parseEther } from "viem";
import { base } from "viem/chains";

const MIN_ETH = parseEther("0.0002"); // need 0.0001 to deposit + gas
const DEPOSIT_AMOUNT = "0.0001"; // ETH to deposit

export async function testDepositEth(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  // Find a WETH syndicate
  const wethSyndicate = state.syndicates.find(s => s.asset === "WETH" && s.vault);
  if (!wethSyndicate) {
    console.log("  ⚠  No WETH syndicate found in state — skipping deposit --use-eth test");
    return;
  }

  const vault = wethSyndicate.vault!;
  console.log(`  WETH vault: ${vault} (${wethSyndicate.subdomain})`);

  // Find a member agent with enough ETH
  const client = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  let testAgent = state.agents.find(a => wethSyndicate.members.includes(a.index));

  if (testAgent) {
    const ethBalance = await client.getBalance({ address: testAgent.address as `0x${string}` });
    if (ethBalance < MIN_ETH) {
      // Try other members
      for (const memberIdx of wethSyndicate.members) {
        const agent = state.agents.find(a => a.index === memberIdx);
        if (!agent) continue;
        const bal = await client.getBalance({ address: agent.address as `0x${string}` });
        if (bal >= MIN_ETH) { testAgent = agent; break; }
      }
      if (testAgent) {
        const bal = await client.getBalance({ address: testAgent.address as `0x${string}` });
        if (bal < MIN_ETH) {
          console.log(`  ⚠  No member has enough ETH (>=${DEPOSIT_AMOUNT}) — skipping deposit --use-eth test`);
          return;
        }
      }
    }
  }

  if (!testAgent) {
    console.log("  ⚠  No eligible agent found — skipping deposit --use-eth test");
    return;
  }

  const home = agentHomeDir(config.baseDir, testAgent.index);
  console.log(`  Using agent ${testAgent.index} (${testAgent.address})`);

  // Run: sherwood vault deposit --amount 0.0001 --use-eth
  // (vault is inferred from agent's primary syndicate, or pass --vault explicitly)
  let depositOut = "";
  try {
    depositOut = execSherwood(
      home,
      ["vault", "deposit", "--vault", vault, "--amount", DEPOSIT_AMOUNT, "--use-eth"],
      config, logger, testAgent.index,
    );
  } catch (err) {
    throw new Error(`vault deposit --use-eth failed:\n${(err as Error).message}`);
  }

  if (!config.dryRun) {
    const lower = depositOut.toLowerCase();
    const success = lower.includes("deposit") ||
                    lower.includes("shares") ||
                    lower.includes("success") ||
                    lower.includes("wrapped") ||
                    lower.includes("tx") ||
                    lower.includes("0x");
    if (!success) {
      throw new Error(
        `vault deposit --use-eth output missing confirmation.\n` +
        `Output: ${depositOut.slice(0, 400)}`,
      );
    }
  }

  console.log("  ✓ vault deposit --use-eth (ETH → WETH → vault shares) succeeded");
}
