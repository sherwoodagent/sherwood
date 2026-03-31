/**
 * E2E test runner for PR #147 mainnet launch.
 *
 * Reads state.json produced by the simulation orchestrator (run-all), then
 * drives each test against the live Base mainnet deployment.
 *
 * Usage:
 *   SIM_CHAIN=base npx tsx tests/e2e/runner.ts
 *   SIM_CHAIN=base npx tsx tests/e2e/runner.ts --only referral
 *   SIM_CHAIN=base npx tsx tests/e2e/runner.ts --dry-run
 */

import "dotenv/config";
import { loadSimConfig } from "../../src/simulation/config.js";
import { loadState } from "../../src/simulation/state.js";
import { SimLogger } from "../../src/simulation/logger.js";
import type { SimConfig, SimState } from "../../src/simulation/types.js";

import { testErrors } from "./test-errors.js";
import { testReferral } from "./test-referral.js";
import { testLeave } from "./test-leave.js";
import { testXmtp } from "./test-xmtp.js";
import { testSimulate } from "./test-simulate.js";
import { testTrade } from "./test-trade.js";
import { testDepositEth } from "./test-deposit-eth.js";
import { testDocs } from "./test-docs.js";

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const config = loadSimConfig();
const state = loadState(config.stateFile);
if (!state) {
  console.error("No state.json found — run orchestrator run-all first:");
  console.error("  SIM_CHAIN=base npx tsx src/simulation/orchestrator.ts --chain base run-all");
  process.exit(1);
}

const logFile = config.logFile.replace("sim.log", "e2e.log");
const logger = new SimLogger(logFile);

console.log(`E2E test suite — chain: ${config.chain}, agents: ${state.agents.length}, syndicates: ${state.syndicates.length}`);
console.log(`State file: ${config.stateFile}`);
console.log(`Log file:   ${logFile}`);
if (config.dryRun) console.log("DRY RUN mode — no real transactions\n");

type TestFn = (c: SimConfig, s: SimState, l: SimLogger) => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [
  { name: "errors",       fn: testErrors },
  { name: "referral",     fn: testReferral },
  { name: "leave",        fn: testLeave },
  { name: "xmtp",         fn: testXmtp },
  { name: "simulate",     fn: testSimulate },
  { name: "trade",        fn: testTrade },
  { name: "deposit-eth",  fn: testDepositEth },
  { name: "docs",         fn: testDocs },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const { name, fn } of tests) {
  if (only && name !== only) continue;
  console.log(`\n=== e2e: ${name} ===`);
  try {
    await fn(config, state, logger);
    console.log(`✓ ${name} passed`);
    passed++;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`✗ ${name} FAILED: ${msg}`);
    failures.push(`${name}: ${msg}`);
    failed++;
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
