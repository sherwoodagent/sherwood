/**
 * Governor commands — sherwood governor <subcommand>
 *
 * View and manage SyndicateGovernor parameters (owner-only setters).
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getExplorerUrl } from "../lib/network.js";
import { formatContractError } from "../lib/errors.js";
import {
  getGovernorAddress,
  getGovernorParams,
  getRegisteredVaults,
  setVotingPeriod,
  setExecutionWindow,
  setVetoThresholdBps,
  setProtocolFeeBps,
  setMaxPerformanceFeeBps,
  setMaxStrategyDuration,
  setCooldownPeriod,
} from "../lib/governor.js";
import { formatDurationLong as formatDuration, parseBigIntArg } from "../lib/format.js";

const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const SEP = () => console.log(DIM("─".repeat(60)));

export function registerGovernorCommands(program: Command): void {
  const governor = program.command("governor").description("Governor parameters and vault management");

  // ── governor info ──

  governor
    .command("info")
    .description("Display current governor parameters and registered vaults")
    .action(async () => {
      const spinner = ora("Loading governor info...").start();
      try {
        const [params, vaults] = await Promise.all([
          getGovernorParams(),
          getRegisteredVaults(),
        ]);

        spinner.stop();

        console.log();
        console.log(LABEL("  ◆ Governor Parameters"));
        SEP();
        console.log(W(`  Address:              ${G(getGovernorAddress())}`));
        console.log(W(`  Voting Period:        ${BOLD(formatDuration(params.votingPeriod))}`));
        console.log(W(`  Execution Window:     ${BOLD(formatDuration(params.executionWindow))}`));
        console.log(W(`  Veto Threshold:         ${BOLD(`${Number(params.vetoThresholdBps) / 100}%`)}`));
        console.log(W(`  Max Performance Fee:  ${BOLD(`${Number(params.maxPerformanceFeeBps) / 100}%`)}`));
        console.log(W(`  Max Strategy Duration:${BOLD(` ${formatDuration(params.maxStrategyDuration)}`)}`));
        console.log(W(`  Cooldown Period:      ${BOLD(formatDuration(params.cooldownPeriod))}`));

        console.log();
        console.log(LABEL(`  Registered Vaults (${vaults.length})`));
        if (vaults.length === 0) {
          console.log(DIM("  (none)"));
        } else {
          for (const v of vaults) {
            console.log(W(`    ${G(v)}`));
          }
        }

        SEP();
        console.log();
      } catch (err) {
        spinner.fail("Failed to load governor info");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-voting-period ──

  governor
    .command("set-voting-period")
    .description("Set the voting period (owner only)")
    .requiredOption("--seconds <n>", "New voting period in seconds")
    .action(async (opts) => {
      const spinner = ora("Setting voting period...").start();
      try {
        const hash = await setVotingPeriod(parseBigIntArg(opts.seconds, "seconds"));
        spinner.succeed(G(`Voting period change queued (${opts.seconds}s). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set voting period");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-execution-window ──

  governor
    .command("set-execution-window")
    .description("Set the execution window (owner only)")
    .requiredOption("--seconds <n>", "New execution window in seconds")
    .action(async (opts) => {
      const spinner = ora("Setting execution window...").start();
      try {
        const hash = await setExecutionWindow(parseBigIntArg(opts.seconds, "seconds"));
        spinner.succeed(G(`Execution window change queued (${opts.seconds}s). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set execution window");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-veto-threshold ──

  governor
    .command("set-veto-threshold")
    .description("Set the veto threshold in bps (owner only)")
    .requiredOption("--bps <n>", "New veto threshold in bps (e.g. 4000 = 40%)")
    .action(async (opts) => {
      const spinner = ora("Setting veto threshold...").start();
      try {
        const hash = await setVetoThresholdBps(parseBigIntArg(opts.bps, "bps"));
        spinner.succeed(G(`Veto threshold change queued (${Number(opts.bps) / 100}%). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set veto threshold");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-max-fee ──

  governor
    .command("set-max-fee")
    .description("Set the max performance fee in bps (owner only)")
    .requiredOption("--bps <n>", "New max fee in bps (e.g. 3000 = 30%)")
    .action(async (opts) => {
      const spinner = ora("Setting max fee...").start();
      try {
        const hash = await setMaxPerformanceFeeBps(parseBigIntArg(opts.bps, "bps"));
        spinner.succeed(G(`Max performance fee change queued (${Number(opts.bps) / 100}%). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set max fee");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-max-duration ──

  governor
    .command("set-max-duration")
    .description("Set the max strategy duration in seconds (owner only)")
    .requiredOption("--seconds <n>", "New max duration in seconds")
    .action(async (opts) => {
      const spinner = ora("Setting max duration...").start();
      try {
        const hash = await setMaxStrategyDuration(parseBigIntArg(opts.seconds, "seconds"));
        spinner.succeed(G(`Max strategy duration change queued (${opts.seconds}s). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set max duration");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-cooldown ──

  governor
    .command("set-cooldown")
    .description("Set the cooldown period in seconds (owner only)")
    .requiredOption("--seconds <n>", "New cooldown in seconds")
    .action(async (opts) => {
      const spinner = ora("Setting cooldown...").start();
      try {
        const hash = await setCooldownPeriod(parseBigIntArg(opts.seconds, "seconds"));
        spinner.succeed(G(`Cooldown period change queued (${opts.seconds}s). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set cooldown");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── governor set-protocol-fee ──

  governor
    .command("set-protocol-fee")
    .description("Set the protocol fee in bps (owner only)")
    .requiredOption("--bps <n>", "New protocol fee in bps (e.g. 500 = 5%, max 1000 = 10%)")
    .action(async (opts) => {
      const spinner = ora("Setting protocol fee...").start();
      try {
        const hash = await setProtocolFeeBps(parseBigIntArg(opts.bps, "bps"));
        spinner.succeed(G(`Protocol fee change queued (${Number(opts.bps) / 100}%). Finalize after the timelock delay with \`sherwood governor finalize-param\`.`));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
      } catch (err) {
        spinner.fail("Failed to set protocol fee");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });
}
