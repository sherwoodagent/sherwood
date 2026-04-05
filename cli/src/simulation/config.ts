/**
 * Load SimConfig from environment variables (and --chain override) with defaults.
 *
 * Chain resolution:
 *   1. --chain flag passed to orchestrator (stored in SIM_CHAIN env by Commander preAction)
 *   2. SIM_CHAIN env var
 *   3. Default: "base"
 *
 * RPC resolution:
 *   1. BASE_RPC_URL / BASE_SEPOLIA_RPC_URL env vars (legacy compat)
 *   2. Public fallback from CHAIN_REGISTRY
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_REGISTRY, type Network } from "../lib/network.js";
import type { SimConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the CLI entry point (cli/src/index.ts), relative to this file
const DEFAULT_SHERWOOD_BIN = path.resolve(__dirname, "..", "index.ts");

const VALID_CHAINS: Network[] = ["base", "base-sepolia", "robinhood-testnet"];

export function loadSimConfig(chainOverride?: Network): SimConfig {
  const mnemonic = process.env.SIM_MNEMONIC;
  if (!mnemonic) {
    throw new Error("SIM_MNEMONIC env var is required (12-word BIP-39 mnemonic)");
  }

  // Resolve chain
  const chain = chainOverride || (process.env.SIM_CHAIN as Network) || "base";
  if (!VALID_CHAINS.includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Valid: ${VALID_CHAINS.join(", ")}`);
  }

  // Resolve RPC URL — check env vars first, fall back to registry
  const chainConfig = CHAIN_REGISTRY[chain];
  let rpcUrl: string | undefined;
  if (chainConfig.rpcEnvVar && process.env[chainConfig.rpcEnvVar]) {
    rpcUrl = process.env[chainConfig.rpcEnvVar];
  }
  if (!rpcUrl) {
    rpcUrl = chainConfig.rpcFallback;
  }

  return {
    mnemonic,
    chain,
    agentCount: parseInt(process.env.SIM_AGENT_COUNT || "12", 10),
    syndicateCount: parseInt(process.env.SIM_SYNDICATE_COUNT || "5", 10),
    baseDir: process.env.SIM_BASE_DIR || "/tmp/sherwood-sim/agents",
    stateFile: process.env.SIM_STATE_FILE || "/tmp/sherwood-sim/state.json",
    logFile: process.env.SIM_LOG_FILE || "/tmp/sherwood-sim/sim.log",
    sherwoodBin: process.env.SIM_SHERWOOD_BIN || DEFAULT_SHERWOOD_BIN,
    rpcUrl,
    dryRun: process.env.SIM_DRY_RUN === "true",
    fundAmountEth: process.env.SIM_FUND_ETH || "0.007",
    fundAmountUsdc: process.env.SIM_FUND_USDC || "10",
    strategyDuration: process.env.SIM_STRATEGY_DURATION || "3h",
    concurrency: parseInt(process.env.SIM_CONCURRENCY || "4", 10),
    compiled: process.env.SIM_COMPILED === "true",
    hasIdentityRegistry: chain !== "robinhood-testnet",
    hasEas: chain !== "robinhood-testnet",
  };
}
