/**
 * Shared types for the multi-agent simulation orchestrator.
 */

export interface SimConfig {
  mnemonic: string; // from SIM_MNEMONIC env
  chain: "base" | "base-sepolia" | "robinhood-testnet"; // from --chain or SIM_CHAIN
  agentCount: number; // default 12
  syndicateCount: number; // default 5
  baseDir: string; // default /tmp/sherwood-sim/agents
  stateFile: string; // default /tmp/sherwood-sim/state.json
  logFile: string; // default /tmp/sherwood-sim/sim.log (JSONL)
  sherwoodBin: string; // path to CLI entry (cli/src/index.ts)
  rpcUrl: string; // resolved from chain config or env
  dryRun: boolean; // from SIM_DRY_RUN
  fundAmountEth: string; // default "0.007" (gas + WETH deposit buffer)
  fundAmountUsdc: string; // default "10"
  strategyDuration: string; // default "3h", from SIM_STRATEGY_DURATION
  concurrency: number; // max parallel agent ops per batch, from SIM_CONCURRENCY (default 4)
  compiled: boolean; // use dist/index.js instead of npx tsx src/index.ts (from SIM_COMPILED)
  hasIdentityRegistry: boolean; // false on chains without ERC-8004 (Robinhood testnet)
  hasEas: boolean; // false on chains without EAS (Robinhood testnet)
}

/** A single structured log entry written as a JSONL line. */
export interface LogEntry {
  ts: number; // unix ms
  phase: number; // simulation phase (0 = setup, etc.)
  agentIndex?: number; // which agent, if applicable
  command: string; // full CLI args string or description
  status: "ok" | "error" | "skip" | "info";
  output?: string; // stdout (trimmed)
  error?: string; // error message on failure
  durationMs?: number; // how long the command took
}

export interface AgentState {
  index: number;
  address: string;
  privateKey: string;
  role: "creator" | "joiner";
  persona: string;
  agentId?: number; // ERC-8004 token ID
  syndicateSubdomain?: string;
  syndicateVault?: string;
  funded: boolean;
  identityMinted: boolean;
  syndicateCreated: boolean;
  joinRequested: boolean;
  approved: boolean;
  deposited: boolean;
  lastHeartbeat?: number;
}

export interface SyndicateState {
  subdomain: string;
  name: string;
  creatorIndex: number;
  vault?: string;
  asset?: "USDC" | "WETH"; // vault denomination
  members: number[]; // agent indices
  proposals: ProposalState[];
}

export interface ProposalState {
  id?: number;
  proposerIndex: number;
  strategy: string;
  state: "proposed" | "voted" | "executed" | "settled";
  executedAt?: number; // unix ms
  settledAt?: number; // unix ms
  duration?: string; // "3h", "2h", etc.
}

export interface SimState {
  agents: AgentState[];
  syndicates: SyndicateState[];
  phase: number;
  lastRun: number;
}
