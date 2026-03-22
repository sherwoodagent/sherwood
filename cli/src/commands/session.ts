/**
 * Session commands — sherwood session check|status|reset
 *
 * Provides agent awareness: catch up on XMTP messages and on-chain events
 * since the last session. Supports one-shot polling (default) and persistent
 * streaming (--stream).
 *
 * Usage:
 *   sherwood session check <name>             — one-shot catch-up (JSON to stdout)
 *   sherwood session check <name> --stream    — persistent stream (JSON lines to stdout)
 *   sherwood session status [name]            — show session cursor positions
 *   sherwood session reset <name> [--full]    — reset session cursors
 */

import { Command } from "commander";
import chalk from "chalk";
import type { Address } from "viem";
import { resolveSyndicate } from "../lib/ens.js";
import { SHERWOOD } from "../lib/addresses.js";
import { getPublicClient } from "../lib/client.js";
import { SYNDICATE_VAULT_ABI } from "../lib/abis.js";
import {
  getSession,
  updateSession,
  resetSession,
  getAllSessions,
} from "../lib/session.js";
import {
  getVaultEvents,
  getGovernorEvents,
  getCurrentBlock,
  enrichProposalEvents,
  type ChainEvent,
} from "../lib/events.js";
import type { ChatEnvelope } from "../lib/types.js";
import { loadConfig } from "../lib/config.js";

// Lazy-load XMTP to avoid breaking session commands when @xmtp/cli is missing
async function loadXmtp() {
  return import("../lib/xmtp.js");
}

// ── Output types ──

interface SessionMessage {
  source: "xmtp";
  id: string;
  from: string;
  type: string;
  text: string;
  sentAt: string; // ISO 8601
}

interface SessionCheckResult {
  syndicate: string;
  messages: SessionMessage[];
  events: ChainEvent[];
  meta: {
    newMessages: number;
    newEvents: number;
    blocksScanned: number;
    lastCheckAt: string; // ISO 8601
  };
}

// ── Helpers ──

/** Resolve the governor address from the vault contract. */
async function resolveGovernor(vaultAddress: Address): Promise<Address> {
  const client = getPublicClient();
  try {
    const governor = await client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "governor",
    });
    return governor as Address;
  } catch {
    // Vault might not have a governor set
    return SHERWOOD().GOVERNOR;
  }
}

/** Convert an XMTP message to session output format. */
function toSessionMessage(msg: {
  id: string;
  senderInboxId: string;
  content: string;
  sentAt: Date;
}): SessionMessage {
  let type = "MESSAGE";
  let text = msg.content;
  let from = msg.senderInboxId;

  try {
    const envelope: ChatEnvelope = JSON.parse(msg.content);
    type = envelope.type;
    text = envelope.text || envelope.type;
    from = envelope.from || msg.senderInboxId;
  } catch {
    // Plain text message
  }

  return {
    source: "xmtp",
    id: msg.id,
    from,
    type,
    text,
    sentAt: msg.sentAt.toISOString(),
  };
}

// ── Command handlers ──

async function handleCheck(name: string, stream: boolean): Promise<void> {
  // Resolve syndicate
  const syndicate = await resolveSyndicate(name);
  const vaultAddress = syndicate.vault;
  const governorAddress = await resolveGovernor(vaultAddress);

  // Load or initialize session
  const session = getSession(name);
  const currentBlock = await getCurrentBlock();

  // On first run: look back ~1000 blocks (~8 min on Base)
  const fromBlock = session?.lastBlockNumber
    ? BigInt(session.lastBlockNumber) + 1n
    : currentBlock > 1000n
      ? currentBlock - 1000n
      : 0n;

  const lastMessageTimestamp = session?.lastMessageTimestamp || 0;

  // ── Fetch XMTP messages ──
  let messages: SessionMessage[] = [];
  try {
    const xmtp = await loadXmtp();
    const groupId = await xmtp.getGroup("", name);
    const recent = await xmtp.getRecentMessages(groupId, 100);

    // Filter to messages after our cursor, excluding our own messages
    const cursorMs = lastMessageTimestamp * 1000;
    const ownInboxId = loadConfig().xmtpInboxId;
    const newMessages = recent.filter(
      (m) =>
        m.sentAt.getTime() > cursorMs &&
        (!ownInboxId || m.senderInboxId !== ownInboxId),
    );
    messages = newMessages.map(toSessionMessage);
  } catch {
    // XMTP not available or group not found — skip messages
  }

  // ── Fetch on-chain events ──
  let events: ChainEvent[] = [];
  if (fromBlock <= currentBlock) {
    const vaultEvents = await getVaultEvents(
      vaultAddress,
      fromBlock,
      currentBlock,
    );
    const govEvents = await getGovernorEvents(
      governorAddress,
      vaultAddress,
      fromBlock,
      currentBlock,
    );
    events = [...vaultEvents, ...govEvents].sort((a, b) => a.block - b.block);

    // Enrich proposal events with IPFS metadata (name, description, state)
    try {
      events = await enrichProposalEvents(events);
    } catch {
      // IPFS/RPC unreachable — continue with raw events
    }
  }

  // ── Output initial catch-up result ──
  const result: SessionCheckResult = {
    syndicate: name,
    messages,
    events,
    meta: {
      newMessages: messages.length,
      newEvents: events.length,
      blocksScanned: Number(currentBlock - fromBlock),
      lastCheckAt: session?.lastCheckAt
        ? new Date(session.lastCheckAt * 1000).toISOString()
        : "never",
    },
  };

  process.stdout.write(JSON.stringify(result) + "\n");

  // ── Update session state ──
  // Find the newest message timestamp (messages may not be sorted)
  // Use ceil to ensure we don't re-fetch the same message due to sub-second precision
  let newestTimestamp = lastMessageTimestamp;
  let newestMessageId = session?.lastMessageId || "";
  for (const msg of messages) {
    const ts = Math.ceil(new Date(msg.sentAt).getTime() / 1000);
    if (ts > newestTimestamp) {
      newestTimestamp = ts;
      newestMessageId = msg.id;
    }
  }

  updateSession(name, {
    vault: vaultAddress,
    governor: governorAddress,
    lastBlockNumber: Number(currentBlock),
    lastCheckAt: Math.floor(Date.now() / 1000),
    lastMessageId: newestMessageId,
    lastMessageTimestamp: newestTimestamp,
    totalMessagesProcessed:
      (session?.totalMessagesProcessed || 0) + messages.length,
    totalEventsProcessed:
      (session?.totalEventsProcessed || 0) + events.length,
  });

  // ── If --stream, stay alive ──
  if (stream) {
    await startStream(name, vaultAddress, governorAddress);
  }
}

async function startStream(
  name: string,
  vaultAddress: Address,
  governorAddress: Address,
): Promise<void> {
  // Cache for proposal metadata — immutable once pinned, safe to reuse across polls
  const metadataCache = new Map<string, { name: string; description: string }>();

  // Start XMTP message stream
  let xmtpCleanup: (() => void) | undefined;
  try {
    const xmtp = await loadXmtp();
    const groupId = await xmtp.getGroup("", name);

    const streamOwnInboxId = loadConfig().xmtpInboxId;
    xmtpCleanup = await xmtp.streamMessages(groupId, (msg) => {
      // Skip own messages to prevent self-replies
      if (streamOwnInboxId && msg.senderInboxId === streamOwnInboxId) return;

      const sessionMsg = toSessionMessage(msg);
      process.stdout.write(JSON.stringify(sessionMsg) + "\n");

      // Update session state incrementally
      updateSession(name, {
        lastMessageId: msg.id,
        lastMessageTimestamp: Math.floor(msg.sentAt.getTime() / 1000),
        lastCheckAt: Math.floor(Date.now() / 1000),
        totalMessagesProcessed:
          (getSession(name)?.totalMessagesProcessed || 0) + 1,
      });
    });
  } catch {
    // XMTP not available — continue with event polling only
  }

  // Start on-chain event polling (~30s interval)
  const pollInterval = setInterval(async () => {
    try {
      const session = getSession(name);
      const fromBlock = BigInt(session?.lastBlockNumber || 0) + 1n;
      const toBlock = await getCurrentBlock();

      if (fromBlock > toBlock) return; // No new blocks

      const vaultEvents = await getVaultEvents(
        vaultAddress,
        fromBlock,
        toBlock,
      );
      const govEvents = await getGovernorEvents(
        governorAddress,
        vaultAddress,
        fromBlock,
        toBlock,
      );

      let events = [...vaultEvents, ...govEvents].sort(
        (a, b) => a.block - b.block,
      );

      // Enrich proposal events with IPFS metadata (reuse cache across polls)
      try {
        events = await enrichProposalEvents(events, metadataCache);
      } catch {
        // IPFS/RPC unreachable — continue with raw events
      }

      for (const event of events) {
        process.stdout.write(JSON.stringify(event) + "\n");
      }

      updateSession(name, {
        lastBlockNumber: Number(toBlock),
        lastCheckAt: Math.floor(Date.now() / 1000),
        totalEventsProcessed:
          (getSession(name)?.totalEventsProcessed || 0) + events.length,
      });
    } catch {
      // RPC error — skip this poll cycle
    }
  }, 30_000);

  // Clean up on exit
  const cleanup = () => {
    clearInterval(pollInterval);
    xmtpCleanup?.();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep alive
  await new Promise(() => {});
}

async function handleStatus(name?: string): Promise<void> {
  const sessions = getAllSessions();

  if (name) {
    const session = sessions[name];
    if (!session) {
      console.log(
        chalk.dim(`No session found for "${name}". Run "sherwood session check ${name}" first.`),
      );
      return;
    }
    console.log(JSON.stringify({ [name]: formatSessionStatus(session) }, null, 2));
    return;
  }

  // Show all sessions
  if (Object.keys(sessions).length === 0) {
    console.log(chalk.dim("No sessions found. Run \"sherwood session check <name>\" to start."));
    return;
  }

  const output: Record<string, ReturnType<typeof formatSessionStatus>> = {};
  for (const [subdomain, session] of Object.entries(sessions)) {
    output[subdomain] = formatSessionStatus(session);
  }
  console.log(JSON.stringify(output, null, 2));
}

function formatSessionStatus(session: {
  lastCheckAt: number;
  lastBlockNumber: number;
  totalMessagesProcessed: number;
  totalEventsProcessed: number;
}) {
  return {
    lastCheckAt: session.lastCheckAt
      ? new Date(session.lastCheckAt * 1000).toISOString()
      : "never",
    lastBlockNumber: session.lastBlockNumber,
    totalMessagesProcessed: session.totalMessagesProcessed,
    totalEventsProcessed: session.totalEventsProcessed,
  };
}

async function handleReset(
  name: string,
  sinceBlock?: string,
  full?: boolean,
): Promise<void> {
  if (full || !sinceBlock) {
    resetSession(name);
    console.log(chalk.green(`Session for "${name}" has been reset.`));
  } else {
    const block = parseInt(sinceBlock, 10);
    if (isNaN(block)) {
      console.error(chalk.red("--since-block must be a number"));
      process.exit(1);
    }
    resetSession(name, block);
    console.log(
      chalk.green(`Block cursor for "${name}" reset to ${block}.`),
    );
  }
}

// ── Command Registration ──

export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Agent session — catch up on messages + on-chain events");

  session
    .command("check <name>")
    .description("Fetch new XMTP messages and on-chain events since last check")
    .option("--stream", "Stay alive streaming messages and polling events", false)
    .action(async (name: string, opts: { stream: boolean }) => {
      await handleCheck(name, opts.stream);
    });

  session
    .command("status [name]")
    .description("Show session cursor positions")
    .action(async (name?: string) => {
      await handleStatus(name);
    });

  session
    .command("reset <name>")
    .description("Reset session cursors")
    .option("--since-block <n>", "Reset block cursor to a specific block")
    .option("--full", "Reset everything (messages + events)", false)
    .action(
      async (
        name: string,
        opts: { sinceBlock?: string; full: boolean },
      ) => {
        await handleReset(name, opts.sinceBlock, opts.full);
      },
    );

  session
    .command("cron <name>")
    .description("Manage participation crons (OpenClaw agents)")
    .option("--remove", "Remove participation crons", false)
    .option("--status", "Show cron status", false)
    .action(async (name: string, opts: { remove: boolean; status: boolean }) => {
      const { isOpenClaw, registerSyndicateCrons, unregisterSyndicateCrons, getSyndicateCronStatus } =
        await import("../lib/cron.js");
      const { isTestnet } = await import("../lib/network.js");
      const { getNotifyTo } = await import("../lib/config.js");

      if (!isOpenClaw()) {
        console.log(chalk.yellow("Not running on OpenClaw — cron commands unavailable"));
        console.log(chalk.dim(`  Set up your own scheduler: sherwood session check ${name} --stream`));
        return;
      }

      if (opts.status) {
        const status = getSyndicateCronStatus(name, isTestnet());
        if (status.crons.length === 0) {
          console.log(chalk.dim("No participation crons found for " + name));
          return;
        }
        console.log();
        console.log(chalk.bold(`Participation Crons — ${name}`));
        console.log(chalk.dim("─".repeat(50)));
        for (const cron of status.crons) {
          console.log(`  ${chalk.green(cron.name)}  every ${cron.every}${cron.lastRun ? `  last: ${cron.lastRun}` : ""}`);
        }
        console.log();
        return;
      }

      if (opts.remove) {
        const result = unregisterSyndicateCrons(name, isTestnet());
        if (result.removed) {
          console.log(chalk.green("Participation crons removed"));
        } else {
          console.log(chalk.dim("No crons found to remove"));
        }
        return;
      }

      // Register/update
      const result = registerSyndicateCrons(name, isTestnet(), getNotifyTo());
      if (result.registered) {
        console.log(chalk.green("Participation crons registered: " + result.cronNames.join(", ")));
      } else {
        console.log(chalk.dim("Crons already registered"));
      }
    });
}
