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
import { formatUnits, isAddress, parseUnits } from "viem";
import chalk from "chalk";
import ora from "ora";
import { getPublicClient, getAccount, writeContractWithRetry, waitForReceipt, formatContractError } from "../lib/client.js";
import { getChain } from "../lib/network.js";
import { VENICE } from "../lib/addresses.js";
import { SYNDICATE_VAULT_ABI, ERC20_ABI, VENICE_STAKING_ABI } from "../lib/abis.js";
import { provisionApiKey, checkApiKeyValid, chatCompletion, listModels } from "../lib/venice.js";
import { getVeniceApiKey } from "../lib/config.js";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

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
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

      // Provision API key
      const keySpinner = ora("Provisioning Venice API key...").start();
      try {
        const apiKey = await provisionApiKey();
        keySpinner.succeed("Venice API key provisioned");
        console.log(chalk.dim(`  Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`));
        console.log(chalk.dim("  Saved to ~/.sherwood/config.json"));

        // Create EAS attestation
        try {
          const { createVeniceProvisionAttestation, getEasScanUrl } = await import("../lib/eas.js");
          const { uid } = await createVeniceProvisionAttestation(account.address);
          if (uid !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
            console.log(chalk.dim(`  Attested: ${getEasScanUrl(uid)}`));
          }
        } catch {
          // Attestation is best-effort
        }
      } catch (err) {
        keySpinner.fail("Failed to provision API key");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── venice stake ──

  venice
    .command("stake")
    .description("Stake VVV tokens to receive sVVV (required for API key provisioning)")
    .requiredOption("--amount <n>", "Amount of VVV to stake (human-readable, e.g. 13)")
    .action(async (opts) => {
      const account = getAccount();
      const client = getPublicClient();
      const chain = getChain();
      const veniceAddrs = VENICE();
      const amount = parseUnits(opts.amount, 18);

      // Check VVV balance
      const balSpinner = ora("Checking VVV balance...").start();
      try {
        const vvvBalance = await client.readContract({
          address: veniceAddrs.VVV,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;

        if (vvvBalance < amount) {
          balSpinner.fail(`Insufficient VVV: have ${formatUnits(vvvBalance, 18)}, need ${opts.amount}`);
          process.exit(1);
        }
        balSpinner.succeed(`VVV balance: ${formatUnits(vvvBalance, 18)}`);
      } catch (err) {
        balSpinner.fail("Failed to check VVV balance");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

      // Approve VVV spend
      const approveSpinner = ora("Approving VVV for staking contract...").start();
      try {
        const approveHash = await writeContractWithRetry({
          account,
          chain,
          address: veniceAddrs.VVV,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [veniceAddrs.STAKING, amount],
        });
        await waitForReceipt(approveHash);
        approveSpinner.succeed("VVV approved");
      } catch (err) {
        approveSpinner.fail("Approve failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }

      // Stake VVV → sVVV
      const stakeSpinner = ora(`Staking ${opts.amount} VVV...`).start();
      try {
        const stakeHash = await writeContractWithRetry({
          account,
          chain,
          address: veniceAddrs.STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "stake",
          args: [account.address, amount],
        });
        await waitForReceipt(stakeHash);

        // Read new sVVV balance
        const sVvvBalance = await client.readContract({
          address: veniceAddrs.STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;

        stakeSpinner.succeed(`Staked ${opts.amount} VVV → ${formatUnits(sVvvBalance, 18)} sVVV`);
        console.log(chalk.dim("  You can now run: sherwood venice provision"));
      } catch (err) {
        stakeSpinner.fail("Stake failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── venice mint-diem ──

  venice
    .command("mint-diem")
    .description("Lock sVVV to mint DIEM (Venice inference credits; ~1d cooldown)")
    .requiredOption("--amount <n>", "Amount of sVVV to lock (human-readable, 18 decimals)")
    .option("--slippage <bps>", "Slippage tolerance in bps (default 500 = 5%)", "500")
    .option("--yes", "Skip the cooldown confirmation prompt")
    .action(async (opts) => {
      const account = getAccount();
      const client = getPublicClient();
      const chain = getChain();
      const { STAKING, DIEM } = VENICE();

      const amount = parseUnits(opts.amount, 18);
      const slippageBps = BigInt(opts.slippage ?? "500");
      if (slippageBps < 0n || slippageBps > 10000n) {
        console.error(chalk.red(`Invalid slippage bps: ${opts.slippage} (must be 0–10000)`));
        process.exit(1);
      }

      // 1. Check sVVV balance
      const balSpinner = ora("Checking sVVV balance...").start();
      let sVvvBalance: bigint;
      try {
        sVvvBalance = await client.readContract({
          address: STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;
      } catch (err) {
        balSpinner.fail("Failed to read sVVV balance");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
      if (sVvvBalance < amount) {
        balSpinner.fail(
          `Insufficient sVVV: have ${formatUnits(sVvvBalance, 18)}, need ${opts.amount}`,
        );
        console.log(chalk.yellow("  Stake VVV first (see VeniceInferenceStrategy proposal flow)."));
        process.exit(1);
      }
      balSpinner.succeed(`sVVV balance: ${formatUnits(sVvvBalance, 18)}`);

      // 2. Quote DIEM out
      const quoteSpinner = ora("Quoting DIEM output...").start();
      let expected: bigint;
      try {
        expected = await client.readContract({
          address: STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "getDiemAmountOut",
          args: [amount],
        }) as bigint;
      } catch (err) {
        quoteSpinner.fail("Failed to quote DIEM output");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
      if (expected === 0n) {
        quoteSpinner.fail("Quote returned 0 DIEM — refusing to mint");
        process.exit(1);
      }
      const minOut = (expected * (10000n - slippageBps)) / 10000n;
      quoteSpinner.succeed(
        `Expected: ${formatUnits(expected, 18)} DIEM  (minOut @ ${slippageBps}bps: ${formatUnits(minOut, 18)})`,
      );

      // 3. Spendability check — Venice requires >= 0.1 DIEM minimum before any
      //    DIEM credit becomes spendable on inference calls. Warn the agent
      //    upfront so they can size up sVVV (or switch to x402) before locking.
      const MIN_SPENDABLE_DIEM = parseUnits("0.1", 18);
      let currentDiem = 0n;
      try {
        currentDiem = await client.readContract({
          address: DIEM,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;
      } catch {
        // best-effort
      }
      const projectedDiem = currentDiem + expected;
      if (projectedDiem < MIN_SPENDABLE_DIEM) {
        const shortfall = MIN_SPENDABLE_DIEM - projectedDiem;
        // Linear extrapolation: scale up amount by the ratio shortfall/expected
        const sVvvNeeded = (amount * shortfall + expected - 1n) / expected; // ceil-div
        console.log();
        console.log(chalk.red("  ⚠  Venice requires ≥ 0.1 DIEM minimum before ANY DIEM credit"));
        console.log(chalk.red("     becomes spendable on inference calls."));
        console.log(chalk.red(`     Projected DIEM after mint: ${formatUnits(projectedDiem, 18)}  (short by ${formatUnits(shortfall, 18)})`));
        console.log(chalk.red(`     Approx additional sVVV needed: ${formatUnits(sVvvNeeded, 18)}`));
        console.log(chalk.dim("     Below threshold, this DIEM sits idle — consider acquiring"));
        console.log(chalk.dim("     more sVVV first, or use x402 USDC pay-per-request."));
      }

      // 4. Lockup warning + confirmation
      console.log();
      console.log(chalk.yellow("  ⚠  Locked sVVV cannot be unstaked directly. To recover it you must"));
      console.log(chalk.yellow("     first call `staking.burnDiem(amount)` (burns DIEM, unlocks sVVV"));
      console.log(chalk.yellow("     at your average mint rate), then `initiateUnstake` + wait the"));
      console.log(chalk.yellow("     7-day staking cooldown, then `finalizeUnstake`."));
      console.log(chalk.dim("     x402 alternative (pay-per-request in USDC, no DIEM lock):"));
      console.log(chalk.dim("     https://docs.venice.ai/overview/guides/generating-api-key-agent#paying-for-inference"));
      console.log();

      if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`  Lock ${opts.amount} sVVV for DIEM credits? [y/N] `)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            console.log(chalk.dim("  Aborted."));
            process.exit(0);
          }
        } finally {
          rl.close();
        }
      }

      // 5. Mint DIEM (reuses `currentDiem` read in step 3 as the pre-balance)
      const diemBefore = currentDiem;
      const mintSpinner = ora(`Minting DIEM from ${opts.amount} sVVV...`).start();
      try {
        const hash = await writeContractWithRetry({
          account,
          chain,
          address: STAKING,
          abi: VENICE_STAKING_ABI,
          functionName: "mintDiem",
          args: [amount, minOut],
        });
        await waitForReceipt(hash);

        const diemAfter = await client.readContract({
          address: DIEM,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }) as bigint;
        const delta = diemAfter - diemBefore;

        mintSpinner.succeed(
          `Minted ${formatUnits(delta > 0n ? delta : diemAfter, 18)} DIEM` +
          (delta > 0n ? ` (balance: ${formatUnits(diemAfter, 18)})` : ""),
        );
        console.log(chalk.dim(`  Tx: ${hash}`));
        console.log(chalk.yellow("  Note: Venice requires ≥ 0.1 DIEM to spend ANY DIEM credit, and"));
        console.log(chalk.yellow("        refreshes daily allocation at 00:00 UTC. Below threshold,"));
        console.log(chalk.yellow("        inference will continue to 402."));
        console.log(chalk.dim("  Once over threshold: sherwood venice infer --model <id> --prompt \"...\""));
      } catch (err) {
        mintSpinner.fail("mintDiem failed");
        console.error(chalk.red(formatContractError(err)));
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

        // Check current agent's sVVV + pending rewards + DIEM
        const [mySvvv, myPending, myDiem] = await Promise.all([
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
          client.readContract({
            address: VENICE().DIEM,
            abi: ERC20_ABI,
            functionName: "balanceOf",
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
        console.log(`    DIEM (credits):    ${formatUnits(myDiem, 18)}`);
        console.log(chalk.dim("    (mint via `sherwood venice mint-diem --amount <sVVV>`)"));

        console.log(chalk.bold("\n  Venice API"));
        console.log(`    Key:     ${apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : chalk.dim("not provisioned")}`);
        console.log(`    Status:  ${apiKeyValid ? chalk.green("valid") : chalk.red("invalid/missing")}`);
        console.log();
      } catch (err) {
        spinner.fail("Failed to load status");
        console.error(chalk.red(formatContractError(err)));
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
        console.error(chalk.red(formatContractError(err)));
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
    .option("--vault <address>", "Vault address — attestation recipient (defaults to config vault)")
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
          console.error(chalk.red(formatContractError(err)));
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

        // Create EAS attestation (best-effort)
        try {
          const { createVeniceInferenceAttestation, getEasScanUrl } = await import("../lib/eas.js");
          const { keccak256, toHex, isAddress: isAddr } = await import("viem");
          const { getChainContracts } = await import("../lib/config.js");
          const { getChain: getActiveChain } = await import("../lib/network.js");
          const vaultRecipient = (opts.vault && isAddr(opts.vault)) ? opts.vault : getChainContracts(getActiveChain().id).vault;
          const promptHash = keccak256(toHex(userContent)).slice(0, 18); // short hash
          const { uid } = await createVeniceInferenceAttestation(
            result.model,
            result.usage.promptTokens,
            result.usage.completionTokens,
            promptHash,
            vaultRecipient as `0x${string}` | undefined,
          );
          if (uid !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
            console.log(chalk.dim(`Attested: ${getEasScanUrl(uid)}`));
          }
        } catch {
          // Attestation is best-effort
        }
      } catch (err) {
        spinner.fail("Inference failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });
}
