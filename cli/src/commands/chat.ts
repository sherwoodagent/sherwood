/**
 * Chat commands — sherwood chat <syndicate-name> [action] [args...]
 *
 * Uses XMTP for encrypted group messaging tied to syndicates.
 * Shells out to the @xmtp/cli binary for all XMTP operations.
 *
 * Commander can't dispatch subcommands when the parent has a positional <name> arg
 * (it always runs the parent action). So we use manual dispatch: a single .action()
 * that routes based on the [action] argument.
 *
 * Usage:
 *   sherwood chat <name>                          — stream messages (default)
 *   sherwood chat <name> send "hello"             — send a text message
 *   sherwood chat <name> send "hello" --markdown  — send formatted markdown
 *   sherwood chat <name> react <id> <emoji>       — react to a message
 *   sherwood chat <name> log [--limit 50]         — show recent messages
 *   sherwood chat <name> members                  — list group members
 *   sherwood chat <name> add <address>            — add member (creator only)
 *   sherwood chat <name> init [--force] [--public] — create XMTP group + write ENS record
 *   sherwood chat <name> public on/off             — toggle dashboard spectator access
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getAccount, formatContractError } from "../lib/client.js";
import { resolveSyndicate, setTextRecord, getTextRecord } from "../lib/ens.js";
import { cacheGroupId, getCachedGroupId } from "../lib/config.js";
import { fetchMetadata, uploadMetadata } from "../lib/ipfs.js";
import * as factoryLib from "../lib/factory.js";
import { ENS } from "../lib/addresses.js";
import type { ChatEnvelope, MessageType } from "../lib/types.js";
import type { XmtpMessage } from "../lib/xmtp.js";

// Lazy-load XMTP to avoid breaking non-chat commands when @xmtp/cli is missing
async function loadXmtp() {
  return import("../lib/xmtp.js");
}

// ── Formatting ──

function formatTimestamp(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function colorByType(type: MessageType): (text: string) => string {
  switch (type) {
    case "TRADE_EXECUTED":
      return chalk.green;
    case "RISK_ALERT":
      return chalk.red;
    case "TRADE_SIGNAL":
      return chalk.yellow;
    case "POSITION_UPDATE":
      return chalk.cyan;
    case "LP_REPORT":
      return chalk.magenta;
    case "X402_RESEARCH":
      return chalk.cyan;
    case "AGENT_REGISTERED":
    case "MEMBER_JOIN":
      return chalk.blue;
    case "RAGEQUIT_NOTICE":
      return chalk.red;
    default:
      return chalk.white;
  }
}

function formatMessage(msg: XmtpMessage): string {
  const time = chalk.dim(`[${formatTimestamp(msg.sentAt)}]`);
  const sender = chalk.dim(truncateAddress(msg.senderInboxId));

  const text = msg.content;
  try {
    const envelope: ChatEnvelope = JSON.parse(text);
    const color = colorByType(envelope.type);
    const from = envelope.from ? truncateAddress(envelope.from) : sender;

    if (envelope.type === "REACTION") {
      const data = envelope.data as { reference?: string; emoji?: string } | undefined;
      return `${time} ${sender} reacted ${data?.emoji || "?"} to ${truncateAddress(data?.reference || "?")}`;
    }

    if (envelope.type === "MESSAGE") {
      if ((envelope.data as Record<string, unknown>)?.format === "markdown") {
        return `${time} ${chalk.dim(from)}\n${envelope.text || ""}`;
      }
      return `${time} ${chalk.dim(from)}: ${envelope.text || ""}`;
    }

    if (envelope.type === "AGENT_REGISTERED") {
      return `${time} ${color(`[${envelope.type}]`)} Agent ${truncateAddress(envelope.agent?.address || "?")} registered`;
    }

    if (envelope.type === "MEMBER_JOIN") {
      return `${time} ${color(`[${envelope.type}]`)} ${truncateAddress(envelope.from || "?")} joined`;
    }

    if (envelope.type === "X402_RESEARCH") {
      const d = envelope.data as { provider?: string; queryType?: string; costUsdc?: string; attestationUid?: string } | undefined;
      const label = `${d?.provider || "?"} ${d?.queryType || "?"}`;
      return `${time} ${color(`[RESEARCH]`)} ${chalk.dim(from)}: ${label} ($${d?.costUsdc || "?"} USDC)`;
    }

    const summary = envelope.text || envelope.type;
    return `${time} ${color(`[${envelope.type}]`)} ${chalk.dim(from)}: ${summary}`;
  } catch {
    return `${time} ${sender}: ${text}`;
  }
}

// ── Action handlers ──

async function handleStream(name: string): Promise<void> {
  const spinner = ora("Connecting to chat...").start();
  try {
    await resolveSyndicate(name);
    const xmtp = await loadXmtp();
    const client = await xmtp.getXmtpClient();
    const group = await xmtp.getGroup(client, name);
    spinner.succeed(`Connected to ${name}.sherwoodagent.eth`);
    console.log(chalk.dim("Streaming messages... (Ctrl+C to exit)\n"));

    const cleanup = await xmtp.streamMessages(group, (msg) => {
      console.log(formatMessage(msg));
    });

    process.on("SIGINT", async () => {
      console.log(chalk.dim("\nDisconnecting..."));
      cleanup();
      process.exit(0);
    });

    await new Promise(() => {});
  } catch (err) {
    spinner.fail("Failed to connect to chat");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleSend(name: string, message: string, markdown: boolean): Promise<void> {
  const spinner = ora("Sending...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);

    if (markdown) {
      await xmtp.sendMarkdown(group, message);
    } else {
      const envelope: ChatEnvelope = {
        type: "MESSAGE",
        from: getAccount().address,
        text: message,
        timestamp: Math.floor(Date.now() / 1000),
      };
      await xmtp.sendEnvelope(group, envelope);
    }

    spinner.succeed("Message sent");
  } catch (err) {
    spinner.fail("Failed to send message");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleReact(name: string, messageId: string, emoji: string): Promise<void> {
  const spinner = ora("Reacting...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);
    await xmtp.sendReaction(group, messageId, emoji);
    spinner.succeed(`Reacted ${emoji}`);
  } catch (err) {
    spinner.fail("Failed to send reaction");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleLog(name: string, limit: number): Promise<void> {
  const spinner = ora("Loading messages...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);
    const messages = await xmtp.getRecentMessages(group, limit);

    spinner.stop();
    console.log();
    console.log(chalk.bold(`Chat log: ${name}.sherwoodagent.eth`));
    console.log(chalk.dim("─".repeat(50)));

    if (messages.length === 0) {
      console.log(chalk.dim("  No messages yet"));
    } else {
      for (const msg of messages.reverse()) {
        console.log(formatMessage(msg));
      }
    }
    console.log();
  } catch (err) {
    spinner.fail("Failed to load messages");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleMembers(name: string): Promise<void> {
  const spinner = ora("Loading members...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);
    const members = await xmtp.getMembers(group);

    spinner.stop();
    console.log();
    console.log(chalk.bold(`Members: ${name}.sherwoodagent.eth`));
    console.log(chalk.dim("─".repeat(50)));

    for (const member of members) {
      const role = member.permissionLevel === "super_admin"
        ? chalk.yellow(" (super admin)")
        : member.permissionLevel === "admin"
          ? chalk.blue(" (admin)")
          : "";
      console.log(`  ${member.inboxId}${role}`);
    }

    console.log(chalk.dim(`\n  Total: ${members.length} members`));
    console.log();
  } catch (err) {
    spinner.fail("Failed to load members");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleAdd(name: string, address: string): Promise<void> {
  const spinner = ora("Adding member...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);
    await xmtp.addMember(group, address);

    await xmtp.sendEnvelope(group, {
      type: "MEMBER_JOIN",
      from: address,
      syndicate: name,
      timestamp: Math.floor(Date.now() / 1000),
    });

    spinner.succeed(`Member added: ${address}`);
  } catch (err) {
    spinner.fail("Failed to add member");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleRemove(name: string, address: string): Promise<void> {
  const spinner = ora("Removing member...").start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);
    await xmtp.removeMember(group, address);
    spinner.succeed(`Member removed: ${address}`);
  } catch (err) {
    spinner.fail("Failed to remove member");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

/**
 * Notify the spectator service to sync new groups.
 * Called after adding the spectator wallet to an XMTP group so the service
 * invalidates its cache, calls syncAll(), and discovers the new group.
 */
async function notifySpectatorSync(): Promise<void> {
  const spectatorUrl =
    process.env.SPECTATOR_URL || "https://spectator.sherwood.sh";
  try {
    const res = await fetch(`${spectatorUrl}/sync`, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { groups?: number };
      console.log(
        chalk.dim(
          `  Spectator synced — ${data.groups ?? "?"} groups discovered`,
        ),
      );
    }
  } catch {
    // Non-fatal — spectator will self-sync within 60 s via cache TTL
    console.log(
      chalk.dim("  (Spectator sync skipped — will auto-discover within 60 s)"),
    );
  }
}

async function handlePublic(name: string, on: boolean): Promise<void> {
  const spectatorAddress = process.env.DASHBOARD_SPECTATOR_ADDRESS;
  if (!spectatorAddress) {
    console.error(chalk.red("DASHBOARD_SPECTATOR_ADDRESS env var is required"));
    process.exit(1);
  }

  const spinner = ora(`${on ? "Enabling" : "Disabling"} public chat...`).start();
  try {
    const xmtp = await loadXmtp();
    const group = await xmtp.getGroup("", name);

    if (on) {
      await xmtp.addMember(group, spectatorAddress);
      spinner.succeed("Public chat enabled — dashboard spectator added");
      await notifySpectatorSync();
    } else {
      await xmtp.removeMember(group, spectatorAddress);
      spinner.succeed("Public chat disabled — dashboard spectator removed");
    }
  } catch (err) {
    spinner.fail("Failed to toggle public chat");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

async function handleInit(name: string, force: boolean, isPublic: boolean): Promise<void> {
  const spinner = ora("Initializing chat group...").start();
  try {
    const syndicate = await resolveSyndicate(name);
    const callerAddress = getAccount().address.toLowerCase();
    if (syndicate.creator.toLowerCase() !== callerAddress) {
      spinner.fail("Only the syndicate creator can initialize the chat group");
      process.exit(1);
    }

    // Idempotency check
    if (!force) {
      const existingId = getCachedGroupId(name) || await getTextRecord(name, "xmtpGroupId");
      if (existingId) {
        spinner.succeed("XMTP group already exists for this syndicate");
        console.log(chalk.dim(`  Group ID: ${existingId}`));
        return;
      }
    }

    // Create the group
    spinner.text = "Creating XMTP group...";
    const xmtp = await loadXmtp();
    const client = await xmtp.getXmtpClient();
    const groupId = await xmtp.createSyndicateGroup(client, name, isPublic);

    cacheGroupId(name, groupId);

    // Persist group ID: ENS on chains with L2 Registry, IPFS metadata otherwise
    const hasENS = ENS().L2_REGISTRY !== "0x0000000000000000000000000000000000000000";
    if (hasENS) {
      try {
        spinner.text = "Writing group ID to ENS...";
        await setTextRecord(name, "xmtpGroupId", groupId, syndicate.vault);
      } catch (ensErr) {
        console.warn(chalk.yellow("\n  ⚠ Could not write ENS text record"));
        console.warn(chalk.dim(`    ${ensErr instanceof Error ? ensErr.message : String(ensErr)}`));
      }
    } else {
      // No ENS (e.g. HyperEVM) — persist in IPFS metadata
      try {
        spinner.text = "Saving group ID to syndicate metadata...";
        const info = await factoryLib.getSyndicate(syndicate.id);
        let metadata;
        try {
          metadata = await fetchMetadata(info.metadataURI);
        } catch {
          metadata = { schema: "sherwood/syndicate/v1", name, description: "", chain: "", strategies: [], terms: {}, links: {} };
        }
        metadata.xmtpGroupId = groupId;
        const newURI = await uploadMetadata(metadata);
        await factoryLib.updateMetadata(syndicate.id, newURI);
        console.log(chalk.dim(`\n  Group ID saved to metadata: ${newURI}`));
      } catch (metaErr) {
        console.warn(chalk.yellow("\n  ⚠ Could not persist group ID (cached locally only)"));
        console.warn(chalk.dim(`    ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`));
      }
    }

    spinner.succeed(`Chat group created for ${name}.sherwoodagent.eth`);
    console.log(chalk.dim(`  Group ID: ${groupId}`));
    console.log(chalk.dim(`  Stream:   sherwood chat ${name}`));

    // Notify spectator to sync and discover the new public group
    if (isPublic) {
      await notifySpectatorSync();
    }
  } catch (err) {
    spinner.fail("Failed to initialize chat group");
    console.error(chalk.red(formatContractError(err)));
    process.exit(1);
  }
}

// ── Command Registration ──

export function registerChatCommands(program: Command): void {
  program
    .command("chat <name> [action] [actionArgs...]")
    .description("Syndicate chat — stream, send, log, members, add, remove, init, public")
    .option("--markdown", "Send as rich markdown (for send)", false)
    .option("--limit <n>", "Number of messages to show (for log)", "20")
    .option("--force", "Recreate group even if one exists (for init)", false)
    .option("--public", "Enable public chat — adds dashboard spectator (for init)", false)
    .action(async (name: string, action: string | undefined, actionArgs: string[], opts: { markdown: boolean; limit: string; force: boolean; public: boolean }) => {
      switch (action) {
        case "send": {
          const message = actionArgs[0];
          if (!message) {
            console.error(chalk.red("Usage: sherwood chat <name> send <message> [--markdown]"));
            process.exit(1);
          }
          await handleSend(name, message, opts.markdown);
          break;
        }

        case "react": {
          const [messageId, emoji] = actionArgs;
          if (!messageId || !emoji) {
            console.error(chalk.red("Usage: sherwood chat <name> react <messageId> <emoji>"));
            process.exit(1);
          }
          await handleReact(name, messageId, emoji);
          break;
        }

        case "log":
          await handleLog(name, parseInt(opts.limit, 10));
          break;

        case "members":
          await handleMembers(name);
          break;

        case "add": {
          const address = actionArgs[0];
          if (!address) {
            console.error(chalk.red("Usage: sherwood chat <name> add <address>"));
            process.exit(1);
          }
          await handleAdd(name, address);
          break;
        }

        case "remove": {
          const removeAddr = actionArgs[0];
          if (!removeAddr) {
            console.error(chalk.red("Usage: sherwood chat <name> remove <address>"));
            process.exit(1);
          }
          await handleRemove(name, removeAddr);
          break;
        }

        case "init":
          await handleInit(name, opts.force, opts.public);
          break;

        case "public": {
          const flag = actionArgs[0];
          if (flag !== "on" && flag !== "off") {
            console.error(chalk.red("Usage: sherwood chat <name> public on/off"));
            process.exit(1);
          }
          await handlePublic(name, flag === "on");
          break;
        }

        case undefined:
        default:
          await handleStream(name);
          break;
      }
    });
}
