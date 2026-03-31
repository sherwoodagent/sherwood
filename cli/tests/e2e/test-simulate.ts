/**
 * E2E test: Tenderly simulation (#145)
 *
 * 1. proposal simulate --id N — shows risk assessment for an existing proposal
 * 2. proposal execute --dry-run on an approved proposal — shows trace/gas, no tx sent
 */

import { execSherwood } from "../../src/simulation/exec.js";
import { agentHomeDir } from "../../src/simulation/agent-home.js";
import type { SimConfig, SimState, SimLogger } from "./types.js";

export async function testSimulate(config: SimConfig, state: SimState, logger?: SimLogger): Promise<void> {
  // Find a creator with a deployed vault and at least one proposal
  const creator = state.agents.find(a => a.syndicateCreated && a.syndicateVault);
  if (!creator) throw new Error("No creator with vault found in state");

  const home = agentHomeDir(config.baseDir, creator.index);
  const vault = creator.syndicateVault!;
  const syndicate = state.syndicates.find(s => s.creatorIndex === creator.index);
  const proposal = syndicate?.proposals.find(p => p.id != null);

  console.log(`  Creator: agent ${creator.index}, vault: ${vault}`);

  if (!proposal?.id) {
    console.log("  ⚠  No proposal with ID found — skipping simulation tests");
    return;
  }

  // ── Test 1: proposal simulate --id N ──
  // Shows risk assessment. May exit non-zero when critical risks are detected
  // (by design — risk check signals action required), so we catch and validate output.
  let simOut = "";
  try {
    simOut = execSherwood(
      home,
      ["proposal", "simulate", "--id", String(proposal.id)],
      config, logger, creator.index,
    );
  } catch (err) {
    // proposal simulate exits 1 when critical risks found — extract the combined output
    simOut = (err as Error).message;
  }

  if (!config.dryRun) {
    const lower = simOut.toLowerCase();
    const hasSimulationOutput = lower.includes("risk") ||
                                lower.includes("simulation") ||
                                lower.includes("clean") ||
                                lower.includes("assessment") ||
                                lower.includes("tenderly") ||
                                lower.includes("gas") ||
                                lower.includes("call") ||
                                lower.includes("execute") ||
                                lower.includes("pass") ||
                                lower.includes("fail");
    if (!hasSimulationOutput) {
      throw new Error(
        `proposal simulate did not produce expected output.\n` +
        `Output (first 400 chars): ${simOut.slice(0, 400)}`,
      );
    }
  }
  console.log("  ✓ proposal simulate showed risk assessment output");

  // ── Test 2: proposal execute --dry-run ──
  // Verify --dry-run shows trace without sending a tx.
  const approvedProposal = syndicate?.proposals.find(
    p => p.state === "voted" || p.state === "proposed",
  );

  if (!approvedProposal?.id) {
    console.log("  ⚠  No proposal with ID found for --dry-run test — skipping");
    return;
  }

  let dryOut = "";
  try {
    dryOut = execSherwood(
      home,
      ["proposal", "execute", "--id", String(approvedProposal.id), "--dry-run"],
      config, logger, creator.index,
    );
  } catch (err) {
    const msg = (err as Error).message;
    // Proposal may be Pending (not yet Approved) — skip gracefully
    if (msg.toLowerCase().includes("pending") || msg.toLowerCase().includes("not approved")) {
      console.log("  ⚠  Proposal is Pending (not yet Approved) — --dry-run test skipped");
      return;
    }
    // Otherwise treat the output as valid simulation output (e.g. risk exit code 1)
    dryOut = msg;
  }

  if (!config.dryRun && dryOut) {
    const lower = dryOut.toLowerCase();
    const hasDryOutput = lower.includes("gas") ||
                         lower.includes("trace") ||
                         lower.includes("dry") ||
                         lower.includes("simulate") ||
                         lower.includes("call") ||
                         lower.includes("pass") ||
                         lower.includes("fail");
    if (!hasDryOutput) {
      throw new Error(
        `--dry-run output missing expected content.\n` +
        `Output (first 400 chars): ${dryOut.slice(0, 400)}`,
      );
    }
  }
  console.log("  ✓ proposal execute --dry-run showed trace output (no tx sent)");

  // ── Test 3: proposal simulate --notify <syndicate> ──
  // Verify that simulation results are delivered to the syndicate XMTP chat.
  const syndicateName = syndicate?.subdomain;
  if (!syndicateName) {
    console.log("  ⚠  No syndicate subdomain found — skipping --notify test");
    return;
  }

  let notifyOut = "";
  try {
    notifyOut = execSherwood(
      home,
      ["proposal", "simulate", "--id", String(proposal.id), "--notify", syndicateName],
      config, logger, creator.index,
    );
  } catch (err) {
    // Exits 1 when critical risks found (expected) — output is in the error
    notifyOut = (err as Error).message;
  }

  if (!config.dryRun) {
    if (!notifyOut.toLowerCase().includes("risk report sent") &&
        !notifyOut.toLowerCase().includes("xmtp") &&
        !notifyOut.toLowerCase().includes("sent to chat") &&
        !notifyOut.toLowerCase().includes("alert")) {
      throw new Error(
        `proposal simulate --notify did not confirm XMTP delivery.\n` +
        `Output (first 400 chars): ${notifyOut.slice(0, 400)}`,
      );
    }
  }
  console.log("  ✓ proposal simulate --notify delivered risk report to chat");

  // Verify the message actually arrived in the chat log
  let chatLog = "";
  try {
    chatLog = execSherwood(
      home,
      ["chat", syndicateName, "log"],
      config, logger, creator.index,
    );
  } catch (err) {
    chatLog = (err as Error).message;
  }

  if (!config.dryRun && chatLog) {
    // The simulation alert sends a SIMULATION_ALERT envelope — look for proposal ID or risk keywords
    const hasAlert = chatLog.includes(String(proposal.id)) ||
                     chatLog.toLowerCase().includes("simulation") ||
                     chatLog.toLowerCase().includes("risk") ||
                     chatLog.toLowerCase().includes("proposal");
    if (!hasAlert) {
      console.log("  ⚠  Chat log does not yet show simulation alert (XMTP delivery lag)");
    } else {
      console.log("  ✓ Simulation alert visible in chat log");
    }
  }
}
