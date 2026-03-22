/**
 * Run the sherwood CLI as a subprocess with per-agent HOME isolation.
 *
 * Each invocation:
 *   - Sets HOME to the agent's isolated directory
 *   - Sets BASE_RPC_URL from config
 *   - Calls: npx tsx <sherwoodBin> <args...>
 *   - Appends a structured LogEntry to the SimLogger (if provided)
 *
 * This keeps XMTP DBs and sherwood configs per-agent without modifying the CLI.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { SimConfig } from "./types.js";
import type { SimLogger } from "./logger.js";

/**
 * Execute a sherwood CLI command for a specific agent.
 *
 * @param agentHome - The HOME directory for this agent
 * @param args - CLI arguments (e.g. ["identity", "mint", "--name", "Alpha"])
 * @param config - SimConfig
 * @param logger - Optional SimLogger for structured log output
 * @param agentIndex - Agent index for log attribution
 * @returns stdout as string
 */
export function execSherwood(
  agentHome: string,
  args: string[],
  config: SimConfig,
  logger?: SimLogger,
  agentIndex?: number,
): string {
  const agentLabel = path.basename(agentHome);
  const cliPath = path.resolve(config.sherwoodBin);
  // cwd should be the cli/ directory so tsx/tsconfig resolves correctly
  const cliDir = path.resolve(cliPath, "../..");

  const displayArgs = args.join(" ");
  console.log(`  [${agentLabel}] sherwood ${displayArgs}`);

  if (config.dryRun) {
    console.log(`  [${agentLabel}] [DRY RUN] skipped`);
    logger?.skip(`sherwood ${displayArgs}`, agentIndex);
    return "";
  }

  const env: Record<string, string> = {
    ...filterEnv(process.env),
    HOME: agentHome,
    BASE_RPC_URL: config.rpcUrl,
    // Suppress interactive prompts
    CI: "true",
  };

  const t0 = Date.now();
  try {
    const output = execFileSync("npx", ["tsx", cliPath, ...args], {
      encoding: "utf8",
      timeout: 180_000, // 3 minutes per command
      env,
      cwd: cliDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const result = (output || "").trim();
    logger?.ok(`sherwood ${displayArgs}`, result.slice(0, 500), agentIndex, Date.now() - t0);
    return result;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = execErr.stderr || "";
    const stdout = execErr.stdout || "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const message = `sherwood ${displayArgs} failed:\n${combined || execErr.message}`;
    logger?.err(`sherwood ${displayArgs}`, message, agentIndex, Date.now() - t0);
    throw new Error(message);
  }
}

/**
 * Filter process.env to only string values (removes undefined entries).
 */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

/**
 * Parse an agent ID from CLI output.
 * Looks for patterns like "Agent identity registered: #123" or "agentId: 123".
 */
export function parseAgentId(output: string): number | undefined {
  // Pattern: "#123" after "registered:" or "identity #"
  const patterns = [
    /registered[:\s]+#(\d+)/i,
    /identity #(\d+)/i,
    /agent.*?#(\d+)/i,
    /token.*?id[:\s]+(\d+)/i,
    /agentId[:\s"]+(\d+)/i,
    /"agentId":\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

/**
 * Parse a vault address from CLI output.
 * Looks for patterns like "Vault: 0x..." or "vault address: 0x...".
 */
export function parseVaultAddress(output: string): string | undefined {
  const patterns = [
    /vault[:\s]+0x([0-9a-fA-F]{40})/i,
    /deployed[:\s]+0x([0-9a-fA-F]{40})/i,
    /address[:\s]+0x([0-9a-fA-F]{40})/i,
    /0x([0-9a-fA-F]{40})/,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return `0x${m[1]}`;
  }
  return undefined;
}

/**
 * Parse a proposal ID from CLI output.
 * Looks for patterns like "Proposal #5 created" or "proposalId: 5".
 */
export function parseProposalId(output: string): number | undefined {
  const patterns = [
    /proposal\s*#(\d+)/i,
    /proposal\s+id[:\s]+(\d+)/i,
    /proposalId[:\s"]+(\d+)/i,
    /#(\d+)\s+created/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}
