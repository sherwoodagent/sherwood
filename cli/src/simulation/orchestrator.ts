#!/usr/bin/env node
/**
 * Multi-Agent Simulation Orchestrator
 *
 * CLI entry point for running simulation phases.
 *
 * Usage:
 *   npx tsx cli/src/simulation/orchestrator.ts <command> [options]
 *
 * Commands:
 *   setup       Phase 01 — derive wallets, fund, mint identities
 *   syndicates  Phase 02 — creators deploy syndicates
 *   join        Phase 03 — joiners request membership
 *   approve     Phase 04 — creators approve pending joiners
 *   deposit     Phase 05 — all eligible agents deposit
 *   chat        Phase 06 — agents send XMTP messages
 *   propose     Phase 07 — creators submit strategy proposals
 *   vote        Phase 08 — members vote on proposals
 *   heartbeat   Phase 09 — ongoing monitoring loop
 *   status      Show current simulation state
 *   run-all     Run phases 01-08 sequentially
 *   logs        Show structured log (filterable)
 *   diagnose    Output JSON diagnostic summary for Claude to parse
 *   schedule    Run heartbeat on a fixed interval (long-running)
 *   retry       Re-run a specific phase (idempotent, skips already-done)
 */

import { Command, Option } from "commander";
import { VALID_NETWORKS, type Network } from "../lib/network.js";
import { loadSimConfig } from "./config.js";
import { loadState, saveState, advancePhase, printStateSummary } from "./state.js";
import { SimLogger } from "./logger.js";
import { runPhase01 } from "./phases/01-setup.js";
import { runPhase02 } from "./phases/02-create-syndicates.js";
import { runPhase03 } from "./phases/03-join-syndicates.js";
import { runPhase04 } from "./phases/04-approve-members.js";
import { runPhase05 } from "./phases/05-deposit.js";
import { runPhase06 } from "./phases/06-chat.js";
import { runPhase07 } from "./phases/07-propose.js";
import { runPhase08 } from "./phases/08-vote.js";
import { runPhase09 } from "./phases/09-heartbeat.js";

const program = new Command();

program
  .name("sim")
  .description("Sherwood multi-agent simulation orchestrator")
  .version("1.0.0")
  .addOption(
    new Option("--chain <network>", "Target network (base, base-sepolia, robinhood-testnet)")
      .choices(VALID_NETWORKS)
      .default("base"),
  );

/** Read the resolved --chain value from Commander globals. */
function getChain(): Network {
  return program.opts().chain as Network;
}

// ── setup ──

program
  .command("setup")
  .description("Phase 01 — derive wallets, fund, mint ERC-8004 identities")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const existingState = loadState(config.stateFile);
      const state = await runPhase01(config, existingState, logger);
      if (state.phase < 1) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── syndicates ──

program
  .command("syndicates")
  .description("Phase 02 — creators deploy syndicates")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase02(config, state, logger);
      if (state.phase < 2) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── join ──

program
  .command("join")
  .description("Phase 03 — joiners send EAS membership requests")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase03(config, state, logger);
      if (state.phase < 3) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── approve ──

program
  .command("approve")
  .description("Phase 04 — creators approve pending member requests")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase04(config, state, logger);
      if (state.phase < 4) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── deposit ──

program
  .command("deposit")
  .description("Phase 05 — agents deposit USDC into their syndicates")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase05(config, state, logger);
      if (state.phase < 5) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── chat ──

program
  .command("chat")
  .description("Phase 06 — agents send XMTP messages in their syndicates")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase06(config, state, logger);
      if (state.phase < 6) advancePhase(config.stateFile, state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── propose ──

program
  .command("propose")
  .description("Phase 07 — creators submit Moonwell supply strategy proposals")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase07(config, state, logger);
      if (state.phase < 7) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── vote ──

program
  .command("vote")
  .description("Phase 08 — members vote on pending proposals")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      await runPhase08(config, state, logger);
      if (state.phase < 8) advancePhase(config.stateFile, state);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── heartbeat ──

program
  .command("heartbeat")
  .description("Phase 09 — ongoing monitoring: check chat, vote, propose")
  .option("--rounds <n>", "Number of heartbeat rounds to run", "3")
  .action(async (opts) => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      const state = loadState(config.stateFile);
      if (!state) {
        console.error("No state found. Run 'sim setup' first.");
        process.exit(1);
      }
      const rounds = parseInt(opts.rounds, 10);
      await runPhase09(config, state, rounds, logger);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── status ──

program
  .command("status")
  .description("Show current simulation state")
  .action(() => {
    try {
      const config = loadSimConfig(getChain());
      const state = loadState(config.stateFile);
      if (!state) {
        console.log("No simulation state found. Run 'sim setup' to initialize.");
        return;
      }
      printStateSummary(state);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── run-all ──

program
  .command("run-all")
  .description("Run phases 01-08 sequentially (full simulation setup)")
  .action(async () => {
    try {
      const config = loadSimConfig(getChain());
      const logger = new SimLogger(config.logFile);
      logger.info("run-all started", 0);

      console.log(`Starting full simulation run (phases 01-08) on ${config.chain}...\n`);

      // Phase 01 — Setup
      const existingState = loadState(config.stateFile);
      const state = await runPhase01(config, existingState, logger);
      if (state.phase < 1) advancePhase(config.stateFile, state);

      // Phase 02 — Create syndicates
      await runPhase02(config, state, logger);
      if (state.phase < 2) advancePhase(config.stateFile, state);

      // Phase 03 — Join requests
      await runPhase03(config, state, logger);
      if (state.phase < 3) advancePhase(config.stateFile, state);

      // Phase 04 — Approve members
      await runPhase04(config, state, logger);
      if (state.phase < 4) advancePhase(config.stateFile, state);

      // Phase 05 — Deposit
      await runPhase05(config, state, logger);
      if (state.phase < 5) advancePhase(config.stateFile, state);

      // Phase 06 — Chat
      await runPhase06(config, state, logger);
      if (state.phase < 6) advancePhase(config.stateFile, state);

      // Phase 07 — Propose
      await runPhase07(config, state, logger);
      if (state.phase < 7) advancePhase(config.stateFile, state);

      // Phase 08 — Vote
      await runPhase08(config, state, logger);
      if (state.phase < 8) advancePhase(config.stateFile, state);
      logger.info("run-all complete", 8);

      console.log("\n=== Full simulation setup complete! ===\n");
      printStateSummary(state);

      console.log("Next: run heartbeat rounds to simulate ongoing activity:");
      console.log("  npx tsx cli/src/simulation/orchestrator.ts heartbeat --rounds 5\n");
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── logs ──

program
  .command("logs")
  .description("Show structured simulation log (JSONL)")
  .option("--errors", "Show only error entries")
  .option("--phase <n>", "Filter to a specific phase number")
  .option("--agent <n>", "Filter to a specific agent index")
  .option("--last <n>", "Show last N entries", "50")
  .option("--raw", "Output raw JSONL (machine-readable)")
  .action((opts) => {
    const config = loadSimConfig(getChain());
    const logger = new SimLogger(config.logFile);

    const filterStatus: "error" | undefined = opts.errors ? "error" : undefined;
    const phase = opts.phase !== undefined ? parseInt(opts.phase, 10) : undefined;
    const agentIndex = opts.agent !== undefined ? parseInt(opts.agent, 10) : undefined;
    const last = parseInt(opts.last, 10);

    const entries = logger.filter({
      status: filterStatus,
      phase,
      agentIndex,
      last,
    });

    if (entries.length === 0) {
      console.log("No log entries match the given filters.");
      return;
    }

    if (opts.raw) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }

    // Human-readable table
    const STATUS_ICON: Record<string, string> = {
      ok: "✓",
      error: "✗",
      skip: "~",
      info: "·",
    };

    console.log(`\n${"─".repeat(80)}`);
    console.log(`  Simulation Log  (${entries.length} entries)`);
    console.log(`${"─".repeat(80)}`);

    for (const e of entries) {
      const icon = STATUS_ICON[e.status] ?? "?";
      const time = new Date(e.ts).toLocaleTimeString();
      const agent = e.agentIndex !== undefined ? ` agent-${e.agentIndex}` : "";
      const duration = e.durationMs !== undefined ? ` (${(e.durationMs / 1000).toFixed(1)}s)` : "";
      const label = `[p${e.phase}${agent}]`;

      console.log(`  ${icon} ${time} ${label.padEnd(14)} ${e.command.slice(0, 60)}${duration}`);
      if (e.status === "error" && e.error) {
        const firstLine = e.error.split("\n")[0];
        console.log(`      └─ ${firstLine.slice(0, 100)}`);
      }
    }
    console.log(`${"─".repeat(80)}\n`);
  });

// ── diagnose ──

program
  .command("diagnose")
  .description("Output a JSON diagnostic summary — designed for Claude to parse and act on")
  .action(() => {
    const config = loadSimConfig(getChain());
    const logger = new SimLogger(config.logFile);
    const state = loadState(config.stateFile);

    const report = logger.diagnose();

    // Augment with state info if available
    const augmented = {
      ...report,
      simState: state
        ? {
            phase: state.phase,
            lastRun: new Date(state.lastRun).toISOString(),
            agentSummary: state.agents.map((a) => ({
              index: a.index,
              role: a.role,
              persona: a.persona,
              funded: a.funded,
              identityMinted: a.identityMinted,
              syndicateCreated: a.syndicateCreated,
              joinRequested: a.joinRequested,
              approved: a.approved,
              deposited: a.deposited,
              agentId: a.agentId,
              subdomain: a.syndicateSubdomain,
            })),
            syndicateSummary: state.syndicates.map((s) => ({
              subdomain: s.subdomain,
              vault: s.vault,
              memberCount: s.members.length,
              proposalCount: s.proposals.length,
              proposals: s.proposals,
            })),
          }
        : null,
    };

    console.log(JSON.stringify(augmented, null, 2));
  });

// ── retry ──

program
  .command("retry")
  .description("Re-run a specific phase (idempotent — skips already-completed agents)")
  .requiredOption("--phase <n>", "Phase number to re-run (1-9)")
  .option("--rounds <n>", "Rounds for heartbeat (phase 9 only)", "3")
  .action(async (opts) => {
    const phase = parseInt(opts.phase, 10);
    if (isNaN(phase) || phase < 1 || phase > 9) {
      console.error("--phase must be 1-9");
      process.exit(1);
    }

    const config = loadSimConfig(getChain());
    const state = loadState(config.stateFile);
    if (!state) {
      console.error("No state found. Run 'sim setup' first.");
      process.exit(1);
    }

    const logger = new SimLogger(config.logFile);
    logger.info(`retry phase ${phase} triggered`, phase);

    try {
      switch (phase) {
        case 1:
          await runPhase01(config, state, logger);
          break;
        case 2:
          await runPhase02(config, state, logger);
          break;
        case 3:
          await runPhase03(config, state, logger);
          break;
        case 4:
          await runPhase04(config, state, logger);
          break;
        case 5:
          await runPhase05(config, state, logger);
          break;
        case 6:
          await runPhase06(config, state, logger);
          break;
        case 7:
          await runPhase07(config, state, logger);
          break;
        case 8:
          await runPhase08(config, state, logger);
          break;
        case 9:
          await runPhase09(config, state, parseInt(opts.rounds, 10), logger);
          break;
      }
      logger.info(`retry phase ${phase} complete`, phase);
      printStateSummary(state);
    } catch (err) {
      console.error(`\nRetry failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── schedule ──

program
  .command("schedule")
  .description(
    "Run heartbeat on a fixed interval — long-running process for autonomous orchestration",
  )
  .option("--interval <minutes>", "Minutes between heartbeat rounds", "30")
  .option("--rounds <n>", "Heartbeat rounds per interval", "3")
  .option("--max-cycles <n>", "Stop after N cycles (0 = run forever)", "0")
  .action(async (opts) => {
    const intervalMs = parseFloat(opts.interval) * 60 * 1000;
    const rounds = parseInt(opts.rounds, 10);
    const maxCycles = parseInt(opts.maxCycles, 10);

    if (isNaN(intervalMs) || intervalMs < 60_000) {
      console.error("--interval must be >= 1 minute");
      process.exit(1);
    }

    const config = loadSimConfig(getChain());
    const logger = new SimLogger(config.logFile);

    console.log(
      `\nSherwood Simulation Scheduler started`,
    );
    console.log(`   Chain              : ${config.chain}`);
    console.log(`   Heartbeat interval : ${opts.interval} minutes`);
    console.log(`   Rounds per cycle   : ${rounds}`);
    console.log(`   Max cycles         : ${maxCycles === 0 ? "∞ (until stopped)" : maxCycles}`);
    console.log(`   Log file           : ${config.logFile}`);
    console.log(`   State file         : ${config.stateFile}`);
    console.log(`\nPress Ctrl+C to stop.\n`);

    logger.info(`scheduler started: interval=${opts.interval}m rounds=${rounds}`);

    let cycle = 0;

    const runCycle = async () => {
      cycle++;
      const state = loadState(config.stateFile);
      if (!state) {
        logger.info("scheduler: no state found, skipping cycle");
        console.log(`[cycle ${cycle}] No state — run 'sim setup' first.\n`);
        return;
      }

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[cycle ${cycle}] ${new Date().toLocaleString()}  — heartbeat x${rounds}`);
      console.log(`${"─".repeat(60)}`);

      logger.info(`scheduler cycle ${cycle} started`, 9);

      try {
        await runPhase09(config, state, rounds, logger);
        logger.info(`scheduler cycle ${cycle} complete`, 9);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.err("scheduler heartbeat cycle", msg);
        console.error(`[cycle ${cycle}] Heartbeat error (continuing): ${msg.split("\n")[0]}`);
      }

      if (maxCycles > 0 && cycle >= maxCycles) {
        console.log(`\nReached max cycles (${maxCycles}). Exiting.\n`);
        process.exit(0);
      }

      console.log(`\n[cycle ${cycle}] Done. Next run in ${opts.interval} minutes.`);
      console.log(`  → Run 'sim logs --errors' or 'sim diagnose' to inspect.\n`);
    };

    // Run immediately, then on interval
    await runCycle();
    setInterval(runCycle, intervalMs);
  });

program.parse(process.argv);
