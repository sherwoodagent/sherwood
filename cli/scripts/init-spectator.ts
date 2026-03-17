/**
 * One-time script to initialize an XMTP identity for the dashboard spectator wallet.
 *
 * The spectator is a read-only bot added to syndicate XMTP groups so the
 * dashboard can stream messages. This script registers the spectator's wallet
 * on the XMTP network (creates an MLS installation + KeyPackage).
 *
 * Usage (run from cli/ directory):
 *   SPECTATOR_PRIVATE_KEY=0x... npx tsx scripts/init-spectator.ts [--testnet]
 *
 * Idempotent — safe to re-run. If the identity already exists it just prints
 * the inbox ID.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ── Parse args ──

const isTestnet = process.argv.includes("--testnet");
const xmtpEnv = isTestnet ? "dev" : "production";

// ── Resolve spectator private key ──

const rawKey = process.env.SPECTATOR_PRIVATE_KEY;
if (!rawKey) {
  console.error("Error: SPECTATOR_PRIVATE_KEY env var is required.");
  console.error("Usage: SPECTATOR_PRIVATE_KEY=0x... npx tsx scripts/init-spectator.ts [--testnet]");
  process.exit(1);
}
const walletKey = rawKey.replace(/^0x/, "");

// ── Resolve XMTP CLI binary ──

function findXmtpBinary(): string {
  const searchPaths = [
    path.resolve(import.meta.dirname, "..", "node_modules", "@xmtp", "cli", "bin", "run.js"),
    path.resolve(process.cwd(), "node_modules", "@xmtp", "cli", "bin", "run.js"),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const which = execSync("which xmtp", { encoding: "utf8" }).trim();
    if (which) return which;
  } catch {}

  throw new Error("XMTP CLI not found. Install with: npm install -g @xmtp/cli");
}

// ── Spectator XMTP data directory ──

const spectatorDir = path.join(homedir(), ".xmtp-spectator");
const spectatorEnvFile = path.join(spectatorDir, ".env");

// ── Ensure env file ──

fs.mkdirSync(spectatorDir, { recursive: true });

if (fs.existsSync(spectatorEnvFile)) {
  // Update wallet key, preserve DB encryption key
  const existing = fs.readFileSync(spectatorEnvFile, "utf8");
  const lines = existing.split("\n").filter((l) => !l.startsWith("XMTP_WALLET_KEY="));
  lines.push(`XMTP_WALLET_KEY=${walletKey}`);
  fs.writeFileSync(spectatorEnvFile, lines.filter(Boolean).join("\n") + "\n", { mode: 0o600 });
} else {
  fs.writeFileSync(spectatorEnvFile, `XMTP_WALLET_KEY=${walletKey}\n`, { mode: 0o600 });
}

// ── Run xmtp client info ──

const bin = findXmtpBinary();

function execXmtp(args: string[]): string {
  const fullArgs = [...args, "--env", xmtpEnv, "--env-file", spectatorEnvFile];
  if (bin.endsWith(".js")) {
    return execFileSync("node", [bin, ...fullArgs], { encoding: "utf8", timeout: 30_000 }).trim();
  }
  return execFileSync(bin, fullArgs, { encoding: "utf8", timeout: 30_000 }).trim();
}

console.log(`Initializing spectator XMTP identity (env: ${xmtpEnv})...`);

try {
  // client info creates the installation if it doesn't exist
  const raw = execXmtp(["client", "info", "--json", "--log-level", "off"]);
  const result = JSON.parse(raw) as {
    properties: { inboxId: string; installationId: string };
  };

  const { inboxId, installationId } = result.properties;

  console.log("\nSpectator identity ready:");
  console.log(`  Inbox ID:        ${inboxId}`);
  console.log(`  Installation ID: ${installationId}`);
  console.log(`  Data dir:        ${spectatorDir}`);
  console.log(`  Environment:     ${xmtpEnv}`);
  console.log("\nSet this in your CLI environment:");
  console.log(`  export DASHBOARD_SPECTATOR_ADDRESS=<spectator-eth-address>`);
} catch (err) {
  console.error("Failed to initialize spectator identity:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
