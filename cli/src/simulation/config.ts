/**
 * Load SimConfig from environment variables with defaults.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SimConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the CLI entry point (cli/src/index.ts), relative to this file
const DEFAULT_SHERWOOD_BIN = path.resolve(__dirname, "..", "index.ts");

export function loadSimConfig(): SimConfig {
  const mnemonic = process.env.SIM_MNEMONIC;
  if (!mnemonic) {
    throw new Error("SIM_MNEMONIC env var is required (12-word BIP-39 mnemonic)");
  }

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    throw new Error("BASE_RPC_URL env var is required");
  }

  return {
    mnemonic,
    agentCount: parseInt(process.env.SIM_AGENT_COUNT || "12", 10),
    syndicateCount: parseInt(process.env.SIM_SYNDICATE_COUNT || "5", 10),
    baseDir: process.env.SIM_BASE_DIR || "/tmp/sherwood-sim/agents",
    stateFile: process.env.SIM_STATE_FILE || "/tmp/sherwood-sim/state.json",
    logFile: process.env.SIM_LOG_FILE || "/tmp/sherwood-sim/sim.log",
    sherwoodBin: process.env.SIM_SHERWOOD_BIN || DEFAULT_SHERWOOD_BIN,
    rpcUrl,
    dryRun: process.env.SIM_DRY_RUN === "true",
    fundAmountEth: process.env.SIM_FUND_ETH || "0.002",
    fundAmountUsdc: process.env.SIM_FUND_USDC || "50",
  };
}
