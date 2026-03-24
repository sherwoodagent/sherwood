/**
 * OpenClaw cron integration — auto-register participation crons for syndicate agents.
 *
 * When an agent creates or joins a syndicate, the CLI registers two cron jobs:
 * 1. Silent check (every 15m) — processes messages/events, responds autonomously
 * 2. Human summary (every 1h) — brief activity report delivered to the human's channel
 *
 * Non-OpenClaw agents skip silently — the caller prints guidance instead.
 */

import { execFileSync } from "node:child_process";

// ── OpenClaw detection (cached per process) ──

let _isOpenClaw: boolean | null = null;

export function isOpenClaw(): boolean {
  if (_isOpenClaw !== null) return _isOpenClaw;
  try {
    execFileSync("openclaw", ["cron", "list"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    _isOpenClaw = true;
  } catch {
    _isOpenClaw = false;
  }
  return _isOpenClaw;
}

// ── Types ──

export interface CronResult {
  registered: boolean;
  isOpenClaw: boolean;
  cronNames: string[];
}

export interface CronStatus {
  isOpenClaw: boolean;
  crons: { name: string; every: string; lastRun?: string }[];
}

// ── Cron naming ──

function cronName(subdomain: string, testnet: boolean): string {
  return `sherwood-${subdomain}${testnet ? "-testnet" : ""}`;
}

function summaryCronName(subdomain: string, testnet: boolean): string {
  return `${cronName(subdomain, testnet)}-summary`;
}

// ── Prompts ──

function silentPrompt(subdomain: string, testnet: boolean): string {
  const chainFlag = testnet ? " --chain base-sepolia" : "";
  const envPrefix = testnet ? "ENABLE_TESTNET=true " : "";
  return [
    `You are a sherwood syndicate member. Your syndicate: ${subdomain}.sherwoodagent.eth`,
    "",
    `Step 1: Run \`${envPrefix}sherwood session check ${subdomain}${chainFlag}\``,
    "Step 2: Parse the JSON output. The output is a single JSON object with fields: syndicate, messages[], events[], meta{}.",
    "  - If the command fails or returns an error, reply HEARTBEAT_ERROR with the error message.",
    "  - If meta.newMessages === 0 and meta.newEvents === 0, you may still be pending approval.",
    "    Check: `" + envPrefix + "sherwood vault info" + chainFlag + "`",
    "    If your wallet is not listed as a registered agent, you are still pending. Reply HEARTBEAT_OK.",
    "    If you ARE registered but this is your first time seeing it, alert your human that you've been approved and are now active.",
    "  - If there are new messages from OTHER agents, respond thoughtfully via:",
    `    \`${envPrefix}sherwood chat ${subdomain} send "<response>"${chainFlag}\``,
    "  - If there are on-chain events (proposals, votes, settlements), acknowledge them in chat if relevant.",
    "Step 3: If you responded to anything, summarize what you did (for your own session log).",
    "        If nothing happened, reply HEARTBEAT_OK",
    "",
    "Rules:",
    "- Be a real syndicate member — discuss strategies, share opinions, ask questions",
    "- Keep responses concise and on-topic",
    "- Do NOT alert your human unless something requires their approval (or you were just approved)",
    `- You can use \`sherwood research\` commands if you need data to back up your response`,
  ].join("\n");
}

function summaryPrompt(subdomain: string, testnet: boolean): string {
  const chainFlag = testnet ? " --chain base-sepolia" : "";
  const envPrefix = testnet ? "ENABLE_TESTNET=true " : "";
  return [
    "You are reporting syndicate activity to your human operator.",
    "",
    `Run: \`${envPrefix}sherwood session check ${subdomain}${chainFlag}\``,
    "",
    "The output is a single JSON object with fields: syndicate, messages[], events[], meta{}.",
    "If the command fails, report the error to your human.",
    "",
    "If there was activity (messages, events, proposals) since last check:",
    "  Send a brief summary — who said what, any decisions made, any actions you took.",
    "  Keep it to 3-5 lines max.",
    "",
    "If there was no activity:",
    "  Reply HEARTBEAT_OK",
    "",
    "Only escalate (flag as urgent) if:",
    "- A proposal needs human sign-off",
    "- An agent left the syndicate",
    "- Risk alert or health factor warning",
    "- Human was directly asked for input",
  ].join("\n");
}

// ── Helpers ──

/** Parse `openclaw cron list --json` and return job names. */
function listCronNames(): string[] {
  try {
    const raw = execFileSync("openclaw", ["cron", "list", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    const jobs: { name: string }[] = parsed.jobs || parsed || [];
    return jobs.map((j) => j.name);
  } catch {
    return [];
  }
}

/** Parse `openclaw cron list --json` with full details for status display. */
function listCronDetails(): { name: string; every: string; lastRun?: string }[] {
  try {
    const raw = execFileSync("openclaw", ["cron", "list", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    const jobs: { name: string; every?: string; interval?: string; lastRun?: string }[] =
      parsed.jobs || parsed || [];
    return jobs.map((j) => ({
      name: j.name,
      every: j.every || j.interval || "unknown",
      lastRun: j.lastRun,
    }));
  } catch {
    return [];
  }
}

// ── Public API ──

export function registerSyndicateCrons(
  subdomain: string,
  testnet: boolean,
  notifyTo?: string,
): CronResult {
  if (!isOpenClaw()) {
    return { registered: false, isOpenClaw: false, cronNames: [] };
  }

  const checkName = cronName(subdomain, testnet);
  const summaryName = summaryCronName(subdomain, testnet);
  const existing = listCronNames();
  const created: string[] = [];

  // Cron 1: Silent participation check (every 15m)
  if (!existing.includes(checkName)) {
    try {
      execFileSync("openclaw", [
        "cron", "create",
        "--name", checkName,
        "--every", "15m",
        "--session", "isolated",
        "--timeout-seconds", "120",
        "--no-deliver",
        "--message", silentPrompt(subdomain, testnet),
      ], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      created.push(checkName);
    } catch (err) {
      console.warn(`Could not create silent cron: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Cron 2: Human summary (every 1h)
  if (!existing.includes(summaryName)) {
    try {
      const args = [
        "cron", "create",
        "--name", summaryName,
        "--every", "1h",
        "--session", "isolated",
        "--timeout-seconds", "90",
        "--announce",
      ];

      // Use explicit destination if configured, otherwise auto-route via --channel last
      if (notifyTo) {
        args.push("--to", notifyTo);
      } else {
        args.push("--channel", "last");
      }

      args.push("--message", summaryPrompt(subdomain, testnet));

      execFileSync("openclaw", args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      created.push(summaryName);
    } catch (err) {
      console.warn(`Could not create summary cron: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    registered: created.length > 0,
    isOpenClaw: true,
    cronNames: created,
  };
}

export function unregisterSyndicateCrons(
  subdomain: string,
  testnet: boolean,
): { removed: boolean; isOpenClaw: boolean } {
  if (!isOpenClaw()) {
    return { removed: false, isOpenClaw: false };
  }

  const names = [cronName(subdomain, testnet), summaryCronName(subdomain, testnet)];
  let removed = false;

  for (const name of names) {
    try {
      execFileSync("openclaw", ["cron", "remove", "--name", name], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      removed = true;
    } catch {
      // Cron may not exist — that's fine
    }
  }

  return { removed, isOpenClaw: true };
}

export function getSyndicateCronStatus(
  subdomain: string,
  testnet: boolean,
): CronStatus {
  if (!isOpenClaw()) {
    return { isOpenClaw: false, crons: [] };
  }

  const prefix = cronName(subdomain, testnet);
  const all = listCronDetails();
  const matching = all.filter((c) => c.name.startsWith(prefix));

  return { isOpenClaw: true, crons: matching };
}
