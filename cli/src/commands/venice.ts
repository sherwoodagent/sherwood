/**
 * Venice commands — sherwood venice <subcommand>
 *
 * Manages Venice private inference: provision API keys, check status,
 * list models, run inference.
 *
 * Venice funding uses the VeniceInferenceStrategy template via the
 * proposal flow (sherwood proposal create).
 */

import { Command } from "commander";
import type { Address } from "viem";
import { formatUnits, isAddress } from "viem";
import chalk from "chalk";
import ora from "ora";
import { getPublicClient, getAccount } from "../lib/client.js";
import { VENICE } from "../lib/addresses.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI, VENICE_STAKING_ABI } from "../lib/abis.js";
import { provisionApiKey, checkApiKeyValid, chatCompletion, listModels } from "../lib/venice.js";
import { getVeniceApiKey } from "../lib/config.js";
import { readFileSync } from "node:fs";

export function registerVeniceCommands(program: Command): void {
  const venice = program.command("venice").description("Venice private inference — provision API keys, run inference");

  // ── venice provision ──

  venice
    .command("provision")
    .description("Self-provision a Venice API key (requires sVVV in wallet)")
    .action(async () => {
      const account = getAccount();
      const client = getPublicClient();

      // Check sVVV balance
      const checkSpinner = ora("Checking sVVV balance...").start();
      try {
        const sVvvBalance = await client.readContract({
          address: VENICE().STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;

        if (sVvvBalance === 0n) {
          checkSpinner.fail("No sVVV found in wallet");
          console.log(chalk.yellow("  Your wallet must hold staked VVV (sVVV) to provision a Venice API key."));
          console.log(chalk.yellow("  Use the VeniceInferenceStrategy via a proposal to distribute sVVV to agents."));
          process.exit(1);
        }

        checkSpinner.succeed(`sVVV balance: ${formatUnits(sVvvBalance, 18)}`);
      } catch (err) {
        checkSpinner.fail("Failed to check sVVV balance");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Provision API key
      const keySpinner = ora("Provisioning Venice API key...").start();
      try {
        const apiKey = await provisionApiKey();
        keySpinner.succeed("Venice API key provisioned");
        console.log(chalk.dim(`  Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`));
        console.log(chalk.dim("  Saved to ~/.sherwood/config.json"));
      } catch (err) {
        keySpinner.fail("Failed to provision API key");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── venice status ──

  venice
    .command("status")
    .description("Show Venice inference status: sVVV balances, DIEM, API key")
    .requiredOption("--vault <address>", "Vault address")
    .action(async (opts) => {
      const vaultAddress = opts.vault as Address;
      if (!isAddress(vaultAddress)) {
        console.error(chalk.red(`Invalid vault address: ${opts.vault}`));
        process.exit(1);
      }

      const client = getPublicClient();
      const account = getAccount();
      const spinner = ora("Loading Venice status...").start();

      try {
        // Read vault state
        const [assetAddress, totalDeposited, agents] = await Promise.all([
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "asset" }) as Promise<Address>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "totalDeposited" }) as Promise<bigint>,
          client.readContract({ address: vaultAddress, abi: SYNDICATE_VAULT_ABI, functionName: "getAgentAddresses" }) as Promise<Address[]>,
        ]);

        const [assetDecimals, assetSymbol, assetBalance] = await Promise.all([
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
          client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress] }) as Promise<bigint>,
        ]);

        // Read VVV balance on vault
        const vaultVvvBalance = await client.readContract({
          address: VENICE().VVV,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [vaultAddress],
        }) as bigint;

        // Read per-agent sVVV balances
        const agentBalances = await Promise.all(
          agents.map(async (agent) => {
            const bal = await client.readContract({
              address: VENICE().STAKING,
              abi: VENICE_STAKING_ABI,
              functionName: "balanceOf",
              args: [agent],
            }) as bigint;
            return { agent, balance: bal };
          })
        );

        // Check current agent's sVVV + pending rewards
        const [mySvvv, myPending] = await Promise.all([
          client.readContract({
            address: VENICE().STAKING,
            abi: VENICE_STAKING_ABI,
            functionName: "balanceOf",
            args: [account.address],
          }) as Promise<bigint>,
          client.readContract({
            address: VENICE().STAKING,
            abi: VENICE_STAKING_ABI,
            functionName: "pendingRewards",
            args: [account.address],
          }) as Promise<bigint>,
        ]);

        // Check API key
        const apiKeyValid = await checkApiKeyValid();
        const apiKey = getVeniceApiKey();

        spinner.stop();

        const profit = assetBalance > totalDeposited ? assetBalance - totalDeposited : 0n;

        console.log();
        console.log(chalk.bold("Venice Inference Status"));
        console.log(chalk.dim("─".repeat(50)));

        console.log(chalk.bold("\n  Vault"));
        console.log(`    Profit available:  ${formatUnits(profit, assetDecimals)} ${assetSymbol}`);
        console.log(`    VVV (unstaked):    ${formatUnits(vaultVvvBalance, 18)}`);

        console.log(chalk.bold("\n  Agent sVVV Balances"));
        for (const { agent, balance } of agentBalances) {
          const isMe = agent.toLowerCase() === account.address.toLowerCase();
          const label = isMe ? chalk.green(`${agent} (you)`) : agent;
          console.log(`    ${label}: ${formatUnits(balance, 18)} sVVV`);
        }

        console.log(chalk.bold("\n  Your Wallet"));
        console.log(`    sVVV:              ${formatUnits(mySvvv, 18)}`);
        console.log(`    Pending rewards:   ${formatUnits(myPending, 18)} VVV`);

        console.log(chalk.bold("\n  Venice API"));
        console.log(`    Key:     ${apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : chalk.dim("not provisioned")}`);
        console.log(`    Status:  ${apiKeyValid ? chalk.green("valid") : chalk.red("invalid/missing")}`);
        console.log();
      } catch (err) {
        spinner.fail("Failed to load status");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── venice models ──

  venice
    .command("models")
    .description("List available Venice inference models")
    .action(async () => {
      const spinner = ora("Fetching Venice models...").start();
      try {
        const models = await listModels();
        spinner.succeed(`${models.length} models available`);
        console.log();
        for (const model of models) {
          console.log(`  ${model}`);
        }
        console.log();
      } catch (err) {
        spinner.fail("Failed to list models");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── venice infer ──

  venice
    .command("infer")
    .description("Run private inference via Venice chat completions")
    .requiredOption("--prompt <text>", "User prompt")
    .requiredOption("--model <id>", "Venice model ID (use 'venice models' to list)")
    .option("--system <text>", "System prompt")
    .option("--data <path>", "Path to data file — contents prepended to prompt as context")
    .option("--web-search", "Enable Venice web search", false)
    .option("--no-thinking", "Disable chain-of-thought reasoning")
    .option("--temperature <n>", "Sampling temperature (0-2)")
    .option("--max-tokens <n>", "Maximum completion tokens")
    .option("--json", "Output raw JSON response", false)
    .action(async (opts) => {
      // Build messages
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

      if (opts.system) {
        messages.push({ role: "system", content: opts.system });
      }

      let userContent = opts.prompt;
      if (opts.data) {
        try {
          const data = readFileSync(opts.data, "utf-8");
          userContent = `Context data:\n\`\`\`\n${data}\n\`\`\`\n\n${opts.prompt}`;
        } catch (err) {
          console.error(chalk.red(`Failed to read data file: ${opts.data}`));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
      messages.push({ role: "user", content: userContent });

      const spinner = ora(`Running inference (${opts.model})...`).start();
      try {
        const result = await chatCompletion({
          model: opts.model,
          messages,
          temperature: opts.temperature !== undefined ? Number(opts.temperature) : undefined,
          maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
          enableWebSearch: opts.webSearch,
          disableThinking: opts.thinking === false,
        });

        spinner.succeed("Inference complete");

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log();
          console.log(result.content);
          console.log();
          console.log(chalk.dim(`Model: ${result.model} | Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out, ${result.usage.totalTokens} total`));
        }
      } catch (err) {
        spinner.fail("Inference failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
