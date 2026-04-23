/**
 * Guardian delegation commands — sherwood guardian <subcommand>
 *
 * V1.5: stake-pool delegation into GuardianRegistry, DPoS commission
 * configuration, and Merkl reward-claim navigation. Rewards claim itself
 * happens on merkl.xyz; this CLI prints a deep link + pending-reward
 * summary when the API key is configured.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { Address } from "viem";
import { formatUnits, isAddress, parseUnits } from "viem";
import { getPublicClient, getWalletClient } from "../lib/client.js";
import { getNetwork } from "../lib/network.js";
import { SHERWOOD } from "../lib/addresses.js";
import { formatContractError } from "../lib/errors.js";

const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const WARN = chalk.yellow;
const SEP = () => console.log(DIM("─".repeat(60)));

// Minimal ABI fragments — only what this command set touches.
const GUARDIAN_REGISTRY_ABI = [
  // Guardian stake
  { type: "function", name: "stakeAsGuardian", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "requestUnstakeGuardian", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelUnstakeGuardian", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimUnstakeGuardian", inputs: [], outputs: [], stateMutability: "nonpayable" },
  // Delegation
  { type: "function", name: "delegateStake", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "requestUnstakeDelegation", inputs: [{ type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelUnstakeDelegation", inputs: [{ type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimUnstakeDelegation", inputs: [{ type: "address" }], outputs: [], stateMutability: "nonpayable" },
  // Commission
  { type: "function", name: "setCommission", inputs: [{ type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // Views
  { type: "function", name: "guardianStake", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isActiveGuardian", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "commissionOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "delegationOf", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "delegatedInbound", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  // Guardian-fee claim (vault asset)
  { type: "function", name: "claimProposalReward", inputs: [{ type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimDelegatorProposalReward", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
] as const;

const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

function requireAddress(name: string, addr: Address): Address {
  if (addr === "0x0000000000000000000000000000000000000000") {
    console.error(chalk.red(`${name} is not deployed on ${getNetwork()}. Update cli/src/lib/addresses.ts after deploy.`));
    process.exit(1);
  }
  return addr;
}

function registry(): Address {
  return requireAddress("GUARDIAN_REGISTRY", SHERWOOD().GUARDIAN_REGISTRY);
}

function wood(): Address {
  return requireAddress("WOOD_TOKEN", SHERWOOD().WOOD_TOKEN);
}

async function ensureWoodAllowance(amount: bigint): Promise<void> {
  const wallet = getWalletClient();
  const pc = getPublicClient();
  const addr = wallet.account!.address;
  const current = (await pc.readContract({
    address: wood(),
    abi: [{ type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "allowance",
    args: [addr, registry()],
  })) as bigint;
  if (current >= amount) return;
  const spinner = ora("Approving WOOD...").start();
  try {
    const hash = await wallet.writeContract({
      address: wood(), abi: ERC20_ABI, functionName: "approve", args: [registry(), 2n ** 256n - 1n], chain: null, account: wallet.account!,
    });
    await pc.waitForTransactionReceipt({ hash });
    spinner.succeed("WOOD approval granted");
  } catch (err) {
    spinner.fail("WOOD approval failed");
    throw err;
  }
}

export function registerGuardianCommands(program: Command): void {
  const guardian = program.command("guardian").description("Guardian staking, delegation, and rewards (V1.5)");

  // ── status ──

  guardian
    .command("status [address]")
    .description("Show guardian stake + commission + active status for an address (default: caller)")
    .action(async (addressArg?: string) => {
      const pc = getPublicClient();
      let target: Address;
      if (addressArg) {
        if (!isAddress(addressArg)) {
          console.error(chalk.red("Invalid address"));
          process.exit(1);
        }
        target = addressArg;
      } else {
        const wallet = getWalletClient();
        target = wallet.account!.address;
      }

      const spinner = ora("Loading...").start();
      try {
        const [stake, active, commission] = await Promise.all([
          pc.readContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "guardianStake", args: [target] }) as Promise<bigint>,
          pc.readContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "isActiveGuardian", args: [target] }) as Promise<boolean>,
          pc.readContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "commissionOf", args: [target] }) as Promise<bigint>,
        ]);
        const delegatedIn = (await pc.readContract({
          address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "delegatedInbound", args: [target],
        })) as bigint;
        spinner.stop();

        console.log();
        console.log(LABEL("  ◆ Guardian Status"));
        SEP();
        console.log(W(`  Address:              ${G(target)}`));
        console.log(W(`  Active guardian:      ${active ? G("yes") : DIM("no")}`));
        console.log(W(`  Own stake:            ${BOLD(formatUnits(stake, 18))} WOOD`));
        console.log(W(`  Delegated inbound:    ${BOLD(formatUnits(delegatedIn, 18))} WOOD`));
        console.log(W(`  Commission:           ${BOLD(`${Number(commission) / 100}%`)}`));
        SEP();
        console.log();
      } catch (err) {
        spinner.fail("Failed to load");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── stake ──

  guardian
    .command("stake <amount>")
    .description("Stake as a guardian. Amount in WOOD (min = registry.minGuardianStake).")
    .option("--agent-id <id>", "ERC-8004 agent ID to associate (first-stake only)", "0")
    .action(async (amountStr: string, opts: { agentId: string }) => {
      const amount = parseUnits(amountStr, 18);
      const agentId = BigInt(opts.agentId);
      await ensureWoodAllowance(amount);
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora(`Staking ${amountStr} WOOD...`).start();
      try {
        const hash = await wallet.writeContract({
          address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "stakeAsGuardian", args: [amount, agentId], chain: null, account: wallet.account!,
        });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`Staked. Tx: ${hash}`);
      } catch (err) {
        spinner.fail("Stake failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── unstake (request / cancel / claim) ──

  guardian
    .command("unstake <action>")
    .description("Unstake flow: 'request' | 'cancel' | 'claim' (7d cooldown)")
    .action(async (action: string) => {
      const fn = { request: "requestUnstakeGuardian", cancel: "cancelUnstakeGuardian", claim: "claimUnstakeGuardian" }[action];
      if (!fn) {
        console.error(chalk.red(`Unknown action '${action}'. Use request | cancel | claim.`));
        process.exit(1);
      }
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora(`${action}...`).start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: fn as any, args: [], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`${action} confirmed. Tx: ${hash}`);
      } catch (err) {
        spinner.fail(`${action} failed`);
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── delegate ──

  guardian
    .command("delegate <delegate> <amount>")
    .description("Delegate WOOD stake to a guardian. Amount in WOOD.")
    .action(async (delegate: string, amountStr: string) => {
      if (!isAddress(delegate)) {
        console.error(chalk.red("Invalid delegate address"));
        process.exit(1);
      }
      const amount = parseUnits(amountStr, 18);
      await ensureWoodAllowance(amount);
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora(`Delegating ${amountStr} WOOD to ${delegate}...`).start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "delegateStake", args: [delegate, amount], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`Delegated. Tx: ${hash}`);
      } catch (err) {
        spinner.fail("Delegation failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  guardian
    .command("undelegate <delegate> <action>")
    .description("Unstake-delegation flow: 'request' | 'cancel' | 'claim'")
    .action(async (delegate: string, action: string) => {
      if (!isAddress(delegate)) {
        console.error(chalk.red("Invalid delegate address"));
        process.exit(1);
      }
      const fn = { request: "requestUnstakeDelegation", cancel: "cancelUnstakeDelegation", claim: "claimUnstakeDelegation" }[action];
      if (!fn) {
        console.error(chalk.red(`Unknown action '${action}'. Use request | cancel | claim.`));
        process.exit(1);
      }
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora(`${action}...`).start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: fn as any, args: [delegate], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`${action} confirmed. Tx: ${hash}`);
      } catch (err) {
        spinner.fail(`${action} failed`);
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── commission ──

  guardian
    .command("set-commission <bps>")
    .description("Set your commission rate in bps (0-5000 = 0-50%). Raises capped cumulatively at 500 bps/epoch.")
    .action(async (bpsStr: string) => {
      const bps = BigInt(bpsStr);
      if (bps > 5000n) {
        console.error(chalk.red("Commission cannot exceed 5000 bps (50%)"));
        process.exit(1);
      }
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora(`Setting commission to ${Number(bps) / 100}%...`).start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "setCommission", args: [bps], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`Commission set. Tx: ${hash}`);
      } catch (err) {
        spinner.fail("setCommission failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── reward claims ──

  guardian
    .command("claim-proposal <proposalId>")
    .description("Claim guardian-fee commission for a settled proposal you voted Approve on (vault asset).")
    .action(async (pidStr: string) => {
      const pid = BigInt(pidStr);
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora("Claiming...").start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "claimProposalReward", args: [pid], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`Claimed. Tx: ${hash}`);
      } catch (err) {
        spinner.fail("Claim failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  guardian
    .command("claim-delegator <delegate> <proposalId>")
    .description("Claim your delegator share of a delegate's guardian-fee pool for a specific proposal.")
    .action(async (delegate: string, pidStr: string) => {
      if (!isAddress(delegate)) {
        console.error(chalk.red("Invalid delegate address"));
        process.exit(1);
      }
      const pid = BigInt(pidStr);
      const wallet = getWalletClient();
      const pc = getPublicClient();
      const spinner = ora("Claiming delegator share...").start();
      try {
        const hash = await wallet.writeContract({ address: registry(), abi: GUARDIAN_REGISTRY_ABI, functionName: "claimDelegatorProposalReward", args: [delegate, pid], chain: null, account: wallet.account! });
        await pc.waitForTransactionReceipt({ hash });
        spinner.succeed(`Claimed. Tx: ${hash}`);
      } catch (err) {
        spinner.fail("Claim failed");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── WOOD epoch rewards — Merkl ──

  guardian
    .command("claim-wood")
    .description("Open merkl.xyz to claim WOOD epoch block-rewards (off-chain distribution).")
    .action(async () => {
      const wallet = getWalletClient();
      const addr = wallet.account!.address;
      const url = `https://merkl.angle.money/user/${addr}`;
      console.log();
      console.log(LABEL("  ◆ Merkl Reward Claim"));
      SEP();
      console.log(W("  WOOD epoch block-rewards are distributed off-chain via Merkl."));
      console.log(W("  Open this URL in your browser to view + claim pending rewards:"));
      console.log();
      console.log(G(`  ${url}`));
      console.log();
      console.log(WARN("  Note: guardian-fee rewards (vault assets) are claimed on-chain"));
      console.log(WARN("        via `sherwood guardian claim-proposal <pid>`."));
      SEP();
      console.log();
    });
}
