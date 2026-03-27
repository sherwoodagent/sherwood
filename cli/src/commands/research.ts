/**
 * Research commands — sherwood research <subcommand>
 *
 * Query DeFi research providers (Messari, Nansen) using x402 micropayments.
 * Agent pays per-query with USDC from its own wallet — no vault interaction needed.
 *
 * --post <syndicate>: pins result to IPFS, creates EAS attestation, posts
 * lightweight notification to syndicate XMTP chat (not the full result).
 *
 * --yes: skip the cost confirmation prompt (for non-interactive / agent use).
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm } from "@inquirer/prompts";
import { isAddress } from "viem";
import { getAccount, formatContractError } from "../lib/client.js";
import type { MessageType } from "../lib/types.js";
import { getResearchProvider } from "../providers/research/index.js";
import type { ResearchResult } from "../providers/research/index.js";
import { MESSARI_COST_ESTIMATE } from "../providers/research/messari.js";
import { NANSEN_COST_ESTIMATE } from "../providers/research/nansen.js";

// Lazy-load XMTP to avoid breaking non-chat commands when @xmtp/cli is missing
async function loadXmtp() {
  return import("../lib/xmtp.js");
}

// ── Cost estimates ──

const COST_ESTIMATES: Record<string, Record<string, string>> = {
  messari: MESSARI_COST_ESTIMATE,
  nansen: NANSEN_COST_ESTIMATE,
};

function getEstimatedCost(provider: string, queryType: string): string {
  return COST_ESTIMATES[provider]?.[queryType] ?? "unknown";
}

/**
 * Confirm cost with the user before executing the x402 query.
 * Skipped when --yes is passed (non-interactive / agent mode).
 */
async function confirmCost(
  provider: string,
  queryType: string,
  target: string,
  skipConfirm: boolean,
): Promise<boolean> {
  const estimate = getEstimatedCost(provider, queryType);

  console.log();
  console.log(chalk.bold(`Research Query`));
  console.log(chalk.dim("─".repeat(40)));
  console.log(`  Provider:  ${provider}`);
  console.log(`  Type:      ${queryType}`);
  console.log(`  Target:    ${target}`);
  console.log(`  Est. cost: ${chalk.yellow(estimate + " USDC")} (x402 micropayment)`);
  console.log();

  if (skipConfirm) return true;

  return confirm({
    message: `Pay ${estimate} USDC to ${provider} for this query?`,
    default: true,
  });
}

// ── Output formatting ──

function formatResearchResult(result: ResearchResult): void {
  console.log();
  console.log(
    chalk.bold(`Research: ${result.queryType} ${result.target} (${result.provider})`),
  );
  console.log(chalk.dim("─".repeat(50)));

  // Flatten the top-level data keys into a readable summary
  const data = result.data;
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    if (typeof value === "object" && !Array.isArray(value)) {
      // Nested object — show as sub-section
      console.log(chalk.bold(`\n  ${key}`));
      for (const [subKey, subValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        console.log(`    ${subKey}: ${formatValue(subValue)}`);
      }
    } else if (Array.isArray(value)) {
      console.log(`  ${key}: ${chalk.dim(`[${value.length} items]`)}`);
    } else {
      console.log(`  ${key}: ${formatValue(value)}`);
    }
  }

  console.log();
  console.log(
    chalk.dim(
      `  Cost: $${result.costUsdc} USDC  •  Provider: ${result.provider}`,
    ),
  );
  console.log();
}

function formatValue(value: unknown): string {
  if (typeof value === "number") {
    // Format large numbers with commas
    return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  if (typeof value === "bigint") {
    return value.toLocaleString("en-US");
  }
  return String(value);
}

// ── Post flow: IPFS → EAS → XMTP ──

async function postResearch(
  syndicateName: string,
  result: ResearchResult,
  prompt: string,
): Promise<void> {
  const { pinJSON } = await import("../lib/ipfs.js");
  const { createResearchAttestation, getEasScanUrl } = await import(
    "../lib/eas.js"
  );
  const xmtp = await loadXmtp();

  // 1. Pin full research result to IPFS
  const pinSpinner = ora("Pinning research result to IPFS...").start();
  let resultUri: string;
  try {
    resultUri = await pinJSON(
      {
        schema: "sherwood/research/v1",
        provider: result.provider,
        queryType: result.queryType,
        target: result.target,
        prompt,
        costUsdc: result.costUsdc,
        data: result.data,
        timestamp: result.timestamp,
      } as Record<string, unknown>,
      `sherwood-research-${result.provider}-${result.queryType}-${Date.now()}`,
    );
    pinSpinner.succeed(`Pinned to IPFS: ${chalk.dim(resultUri)}`);
  } catch (err) {
    pinSpinner.fail("Failed to pin to IPFS");
    console.error(
      chalk.red(formatContractError(err)),
    );
    return;
  }

  // 2. Create EAS attestation with prompt, cost, provider, and IPFS URI
  //    Recipient is vault so dashboard can display it under the syndicate
  const easSpinner = ora("Creating EAS attestation...").start();
  let attestationUid: string;
  try {
    const { getChainContracts } = await import("../lib/config.js");
    const { getChain } = await import("../lib/network.js");
    const vaultRecipient = getChainContracts(getChain().id).vault as `0x${string}` | undefined;
    const { uid } = await createResearchAttestation(
      result.provider,
      result.queryType,
      prompt,
      result.costUsdc,
      resultUri,
      vaultRecipient,
    );
    attestationUid = uid;
    easSpinner.succeed(
      `Attested: ${chalk.dim(getEasScanUrl(uid))}`,
    );
  } catch (err) {
    easSpinner.fail("Failed to create EAS attestation");
    console.error(
      chalk.red(formatContractError(err)),
    );
    return;
  }

  // 3. Post lightweight notification to XMTP chat
  const chatSpinner = ora("Posting to syndicate chat...").start();
  try {
    const group = await xmtp.getGroup("", syndicateName);
    await xmtp.sendEnvelope(group, {
      type: "X402_RESEARCH" as MessageType,
      from: getAccount().address,
      text: `Ran ${result.provider} ${result.queryType} on ${result.target} ($${result.costUsdc} USDC)`,
      data: {
        provider: result.provider,
        queryType: result.queryType,
        target: result.target,
        costUsdc: result.costUsdc,
        resultUri,
        attestationUid,
      },
      timestamp: result.timestamp,
    });
    chatSpinner.succeed("Posted to syndicate chat");
  } catch (err) {
    chatSpinner.fail("Failed to post to chat");
    console.error(
      chalk.red(formatContractError(err)),
    );
  }
}

// ── Command registration ──

export function registerResearchCommands(program: Command): void {
  const research = program
    .command("research")
    .description(
      "Query DeFi research providers via x402 micropayments (USDC on Base)",
    );

  // ── research token <target> ──

  research
    .command("token <target>")
    .description("Token report — profile, market data, on-chain metrics")
    .requiredOption(
      "--provider <name>",
      "Research provider (messari, nansen)",
    )
    .option(
      "--post <syndicate>",
      "Post result to syndicate chat (pin to IPFS + attest to EAS)",
    )
    .option("--yes", "Skip cost confirmation prompt", false)
    .action(async (target: string, opts: { provider: string; post?: string; yes: boolean }) => {
      const ok = await confirmCost(opts.provider, "token", target, opts.yes);
      if (!ok) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      const spinner = ora(
        `Querying ${opts.provider} for token ${target}...`,
      ).start();

      try {
        const provider = getResearchProvider(opts.provider);
        const result = await provider.query({ type: "token", target });
        spinner.succeed(`Token data received from ${opts.provider}`);
        formatResearchResult(result);

        if (opts.post) {
          await postResearch(opts.post, result, `token ${target}`);
        }
      } catch (err) {
        spinner.fail(`Token query failed`);
        console.error(
          chalk.red(formatContractError(err)),
        );
        process.exit(1);
      }
    });

  // ── research market <asset> ──

  research
    .command("market <asset>")
    .description("Market overview — price, volume, market cap, ROI, ATH")
    .requiredOption(
      "--provider <name>",
      "Research provider (messari, nansen)",
    )
    .option(
      "--post <syndicate>",
      "Post result to syndicate chat (pin to IPFS + attest to EAS)",
    )
    .option("--yes", "Skip cost confirmation prompt", false)
    .action(async (asset: string, opts: { provider: string; post?: string; yes: boolean }) => {
      const ok = await confirmCost(opts.provider, "market", asset, opts.yes);
      if (!ok) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      const spinner = ora(
        `Querying ${opts.provider} for ${asset} market data...`,
      ).start();

      try {
        const provider = getResearchProvider(opts.provider);
        const result = await provider.query({ type: "market", target: asset });
        spinner.succeed(`Market data received from ${opts.provider}`);
        formatResearchResult(result);

        if (opts.post) {
          await postResearch(opts.post, result, `market ${asset}`);
        }
      } catch (err) {
        spinner.fail(`Market query failed`);
        console.error(
          chalk.red(formatContractError(err)),
        );
        process.exit(1);
      }
    });

  // ── research smart-money ──

  research
    .command("smart-money")
    .description(
      "Smart money flows — net flow, DEX trades, holdings from labeled wallets",
    )
    .requiredOption("--token <symbol>", "Token symbol to analyze (e.g. WETH)")
    .requiredOption(
      "--provider <name>",
      "Research provider (messari, nansen)",
    )
    .option(
      "--post <syndicate>",
      "Post result to syndicate chat (pin to IPFS + attest to EAS)",
    )
    .option("--yes", "Skip cost confirmation prompt", false)
    .action(async (opts: { token: string; provider: string; post?: string; yes: boolean }) => {
      const ok = await confirmCost(opts.provider, "smart-money", opts.token, opts.yes);
      if (!ok) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      const spinner = ora(
        `Querying ${opts.provider} for ${opts.token} smart money flows...`,
      ).start();

      try {
        const provider = getResearchProvider(opts.provider);
        const result = await provider.query({
          type: "smart-money",
          target: opts.token,
          options: { token: opts.token },
        });
        spinner.succeed(
          `Smart money data received from ${opts.provider}`,
        );
        formatResearchResult(result);

        if (opts.post) {
          await postResearch(
            opts.post,
            result,
            `smart-money --token ${opts.token}`,
          );
        }
      } catch (err) {
        spinner.fail(`Smart money query failed`);
        console.error(
          chalk.red(formatContractError(err)),
        );
        process.exit(1);
      }
    });

  // ── research wallet <address> ──

  research
    .command("wallet <address>")
    .description(
      "Wallet due diligence — PnL history, transaction patterns, counterparties",
    )
    .requiredOption(
      "--provider <name>",
      "Research provider (messari, nansen)",
    )
    .option(
      "--post <syndicate>",
      "Post result to syndicate chat (pin to IPFS + attest to EAS)",
    )
    .option("--yes", "Skip cost confirmation prompt", false)
    .action(async (address: string, opts: { provider: string; post?: string; yes: boolean }) => {
      if (!isAddress(address)) {
        console.error(chalk.red(`Invalid wallet address: ${address}`));
        process.exit(1);
      }

      const ok = await confirmCost(opts.provider, "wallet", address, opts.yes);
      if (!ok) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      const spinner = ora(
        `Querying ${opts.provider} for wallet ${address.slice(0, 8)}...`,
      ).start();

      try {
        const provider = getResearchProvider(opts.provider);
        const result = await provider.query({
          type: "wallet",
          target: address,
        });
        spinner.succeed(`Wallet data received from ${opts.provider}`);
        formatResearchResult(result);

        if (opts.post) {
          await postResearch(opts.post, result, `wallet ${address}`);
        }
      } catch (err) {
        spinner.fail(`Wallet query failed`);
        console.error(
          chalk.red(formatContractError(err)),
        );
        process.exit(1);
      }
    });
}
