/**
 * Proposal commands — sherwood proposal <subcommand>
 *
 * Manages the full proposal lifecycle: create, list, show, vote,
 * execute, settle, cancel, simulate.
 */

import { Command } from "commander";
import type { Address, Hex } from "viem";
import { isAddress, encodeFunctionData } from "viem";
import { getVaultOwner, getAssetAddress } from "../lib/vault.js";
import { ERC20_ABI } from "../lib/abis.js";
import chalk from "chalk";
import ora from "ora";
import { readFileSync } from "node:fs";
import { getAccount, formatContractError } from "../lib/client.js";
import { getExplorerUrl, getNetwork } from "../lib/network.js";
import { uploadMetadata } from "../lib/ipfs.js";
import type { SyndicateMetadata } from "../lib/ipfs.js";
import { fetchMetadata } from "../lib/ipfs.js";
import {
  getGovernorAddress,
  getGovernorParams,
  getProposal,
  getProposalState,
  proposalCount,
  propose,
  vote,
  executeProposal,
  settleProposal,
  emergencySettle,
  getExecuteCalls,
  getSettlementCalls,
  cancelProposal,
  emergencyCancel,
  getVoteWeight,
  hasVoted,
  getCapitalSnapshot,
  getActiveProposal,
  parseDuration,
  PROPOSAL_STATES,
  PROPOSAL_STATE,
  VOTE_TYPE,
} from "../lib/governor.js";
import type { BatchCall } from "../lib/governor.js";
import { formatDurationShort as formatDuration, formatShares, formatUSDC, parseBigIntArg } from "../lib/format.js";
import { simulateBatchCalls, printSimulationResult, sendSimulationAlert } from "../lib/simulate.js";
import type { RiskContext } from "../lib/simulate.js";

const G = chalk.green;
const W = chalk.white;
const DIM = chalk.gray;
const BOLD = chalk.white.bold;
const LABEL = chalk.green.bold;
const SEP = () => console.log(DIM("─".repeat(60)));

function formatTimestamp(ts: bigint): string {
  if (ts === 0n) return "—";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function parseCallsFile(path: string): BatchCall[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as { target: string; data: string; value: string }[];
  return parsed.map((c) => ({
    target: c.target as Address,
    data: c.data as Hex,
    value: BigInt(c.value || "0"),
  }));
}

export function registerProposalCommands(program: Command): void {
  const proposal = program.command("proposal").description("Governance proposals — create, vote, execute, settle");

  // ── proposal create ──

  proposal
    .command("create")
    .description("Submit a strategy proposal")
    .requiredOption("--vault <address>", "Vault address the proposal targets")
    .requiredOption("--name <name>", "Strategy name")
    .requiredOption("--description <text>", "Strategy rationale and risk summary")
    .requiredOption("--performance-fee <bps>", "Agent fee in bps (e.g. 1500 = 15%)")
    .requiredOption("--duration <duration>", "Strategy duration (e.g. 7d, 24h, 3600)")
    .requiredOption("--execute-calls <path>", "Path to JSON file with execute Call[] array")
    .requiredOption("--settle-calls <path>", "Path to JSON file with settlement Call[] array")
    .option("--metadata-uri <uri>", "Override — skip IPFS upload and use this URI directly")
    .option("--simulate", "Simulate calls via Tenderly before submitting")
    .option("--force", "Submit even if simulation fails (requires --simulate)")
    .action(async (opts) => {
      try {
        const vault = opts.vault as Address;
        if (!isAddress(vault)) {
          console.error(chalk.red(`Invalid vault address: ${opts.vault}`));
          process.exit(1);
        }

        const performanceFeeBps = parseBigIntArg(opts.performanceFee, "performance-fee");
        const strategyDuration = parseDuration(opts.duration);
        const executeCalls = parseCallsFile(opts.executeCalls);
        const settleCalls = parseCallsFile(opts.settleCalls);

        // ── Pin metadata ──
        let metadataURI = opts.metadataUri || "";

        if (!metadataURI) {
          const spinner = ora({ text: W("Uploading metadata to IPFS..."), color: "green" }).start();
          try {
            const account = getAccount();
            const metadata: SyndicateMetadata = {
              schema: "sherwood/proposal/v1",
              name: opts.name,
              description: opts.description,
              chain: getNetwork(),
              strategies: [],
              terms: {},
              links: {},
            };
            // Attach proposal-specific fields
            const proposalMeta = {
              ...metadata,
              proposer: account.address,
              vault,
              performanceFeeBps: Number(performanceFeeBps),
              strategyDuration: Number(strategyDuration),
              createdAt: Math.floor(Date.now() / 1000),
            };
            // Use the existing upload function — it accepts SyndicateMetadata shape
            metadataURI = await uploadMetadata(proposalMeta as unknown as SyndicateMetadata);
            spinner.succeed(G(`Metadata pinned: ${DIM(metadataURI)}`));
          } catch (err) {
            spinner.warn(chalk.yellow("IPFS upload failed — using inline metadata"));
            const json = JSON.stringify({ name: opts.name, description: opts.description, vault });
            metadataURI = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
          }
        }

        // ── Summary ──
        console.log();
        console.log(LABEL("  ◆ Proposal Summary"));
        SEP();
        console.log(W(`  Name:             ${BOLD(opts.name)}`));
        console.log(W(`  Vault:            ${G(vault)}`));
        console.log(W(`  Performance Fee:  ${Number(performanceFeeBps) / 100}%`));
        console.log(W(`  Duration:         ${formatDuration(strategyDuration)}`));
        console.log(W(`  Calls:            ${executeCalls.length} execute + ${settleCalls.length} settle`));
        console.log(W(`  Metadata:         ${DIM(metadataURI.length > 50 ? metadataURI.slice(0, 50) + "..." : metadataURI)}`));
        SEP();

        // ── Simulate (optional) ──
        if (opts.simulate) {
          // Build risk context from the proposal parameters
          let createRiskContext: RiskContext = { vault, performanceFeeBps, strategyDuration };
          try {
            const govParams = await getGovernorParams();
            createRiskContext = { ...createRiskContext, governorParams: govParams };
          } catch { /* non-fatal — skip parameter bounds checks */ }

          const simSpinner = ora({ text: W("Simulating execute calls..."), color: "green" }).start();
          const execResult = await simulateBatchCalls(vault, executeCalls, "execute", createRiskContext);
          simSpinner.stop();
          printSimulationResult(execResult, "execute");

          if (settleCalls.length > 0) {
            const settleSpinner = ora({ text: W("Simulating settlement calls..."), color: "green" }).start();
            const settleResult = await simulateBatchCalls(vault, settleCalls, "settlement", createRiskContext);
            settleSpinner.stop();
            printSimulationResult(settleResult, "settlement");

            if (!settleResult.success && !opts.force) {
              console.error(chalk.red("\n  ✖ Settlement simulation failed. Use --force to submit anyway."));
              process.exit(1);
            }
          }

          if (!execResult.success && !opts.force) {
            console.error(chalk.red("\n  ✖ Execution simulation failed. Use --force to submit anyway."));
            process.exit(1);
          }

          // Block on critical risks
          const hasCriticalRisks = execResult.risks.some((r) => r.level === "critical");
          if (hasCriticalRisks && !opts.force) {
            console.error(chalk.red("\n  ✖ Critical risks detected. Use --force to submit anyway."));
            process.exit(1);
          }
        }

        // ── Submit ──
        const spinner = ora({ text: W("Submitting proposal..."), color: "green" }).start();
        const result = await propose(vault, metadataURI, performanceFeeBps, strategyDuration, executeCalls, settleCalls);
        spinner.succeed(G("Proposal submitted"));

        console.log();
        console.log(LABEL("  ◆ Proposal Created"));
        SEP();
        console.log(W(`  Proposal ID:  ${G(`#${result.proposalId}`)}`));
        console.log(W(`  Tx:           ${DIM(getExplorerUrl(result.hash))}`));
        SEP();
        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal list ──

  proposal
    .command("list")
    .description("List proposals")
    .option("--vault <address>", "Filter by vault")
    .option("--state <filter>", "Filter by state: draft, pending, approved, executed, settled, all", "all")
    .action(async (opts) => {
      const spinner = ora("Loading proposals...").start();
      try {
        const count = await proposalCount();
        if (count === 0n) {
          spinner.stop();
          console.log(DIM("\n  No proposals found.\n"));
          return;
        }

        const vaultFilter = opts.vault ? (opts.vault as string).toLowerCase() : null;
        const stateFilter = opts.state.toLowerCase();
        const stateIndex = PROPOSAL_STATES.findIndex((s) => s.toLowerCase() === stateFilter);

        // Fetch all proposals + computed states concurrently
        const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
        const results = await Promise.all(
          ids.map(async (id) => {
            const [p, state] = await Promise.all([getProposal(id), getProposalState(id)]);
            return { ...p, computedState: state };
          }),
        );

        const proposals = results.filter((p) => {
          if (vaultFilter && p.vault.toLowerCase() !== vaultFilter) return false;
          if (stateFilter !== "all" && stateIndex >= 0 && p.computedState !== stateIndex) return false;
          return true;
        });

        spinner.stop();

        if (proposals.length === 0) {
          console.log(DIM("\n  No matching proposals.\n"));
          return;
        }

        console.log();
        console.log(BOLD(`Proposals (${proposals.length})`));
        console.log(DIM("─".repeat(90)));
        console.log(
          DIM("  ID  ") +
          DIM("Agent".padEnd(14)) +
          DIM("State".padEnd(12)) +
          DIM("Votes (For/Against)".padEnd(22)) +
          DIM("Fee".padEnd(8)) +
          DIM("Duration".padEnd(10)) +
          DIM("Created"),
        );
        console.log(DIM("─".repeat(90)));

        for (const p of proposals) {
          const state = PROPOSAL_STATES[p.computedState] || "Unknown";
          const created = p.snapshotTimestamp > 0n
            ? new Date(Number(p.snapshotTimestamp) * 1000).toLocaleDateString()
            : "—";
          const agent = `${p.proposer.slice(0, 6)}...${p.proposer.slice(-4)}`;
          const fee = `${Number(p.performanceFeeBps) / 100}%`;
          const dur = formatDuration(p.strategyDuration);
          const votes = `${formatShares(p.votesFor)}/${formatShares(p.votesAgainst)}`;

          console.log(
            `  ${String(p.id).padEnd(4)}` +
            `${agent.padEnd(14)}` +
            `${state.padEnd(12)}` +
            `${votes.padEnd(22)}` +
            `${fee.padEnd(8)}` +
            `${dur.padEnd(10)}` +
            `${created}`,
          );
        }
        console.log();
      } catch (err) {
        spinner.fail("Failed to load proposals");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── proposal show ──

  proposal
    .command("show")
    .description("Show full proposal details")
    .argument("<id>", "Proposal ID")
    .action(async (idStr) => {
      const spinner = ora("Loading proposal...").start();
      try {
        const id = parseBigIntArg(idStr, "proposal ID");
        const p = await getProposal(id);
        const state = await getProposalState(id);
        const params = await getGovernorParams();

        spinner.stop();

        const stateLabel = PROPOSAL_STATES[state] || "Unknown";
        const totalVotes = p.votesFor + p.votesAgainst;
        const quorumNeeded = totalVotes > 0n ? `${Number(params.vetoThresholdBps) / 100}%` : "—";

        console.log();
        console.log(LABEL(`  ◆ Proposal #${p.id}`));
        SEP();

        // Try to resolve IPFS metadata
        if (p.metadataURI && p.metadataURI.startsWith("ipfs://")) {
          try {
            const meta = await fetchMetadata(p.metadataURI);
            console.log(W(`  Name:             ${BOLD(meta.name)}`));
            console.log(W(`  Description:      ${DIM(meta.description)}`));
          } catch {
            console.log(W(`  Metadata:         ${DIM(p.metadataURI)}`));
          }
        } else if (p.metadataURI) {
          console.log(W(`  Metadata:         ${DIM(p.metadataURI)}`));
        }

        console.log(W(`  State:            ${BOLD(stateLabel)}`));
        console.log(W(`  Proposer:         ${G(p.proposer)}`));
        console.log(W(`  Vault:            ${G(p.vault)}`));
        console.log(W(`  Performance Fee:  ${Number(p.performanceFeeBps) / 100}%`));
        console.log(W(`  Duration:         ${formatDuration(p.strategyDuration)}`));

        console.log();
        console.log(LABEL("  Timestamps"));
        console.log(W(`  Snapshot:         ${formatTimestamp(p.snapshotTimestamp)}`));
        console.log(W(`  Vote End:         ${formatTimestamp(p.voteEnd)}`));
        console.log(W(`  Execute By:       ${formatTimestamp(p.executeBy)}`));
        console.log(W(`  Executed At:      ${formatTimestamp(p.executedAt)}`));

        console.log();
        console.log(LABEL("  Votes"));
        console.log(W(`  For:              ${formatShares(p.votesFor)}`));
        console.log(W(`  Against:          ${formatShares(p.votesAgainst)}`));
        console.log(W(`  Abstain:          ${formatShares(p.votesAbstain)}`));
        console.log(W(`  Veto Threshold:   ${quorumNeeded}`));

        if (state === PROPOSAL_STATE.Executed || state === PROPOSAL_STATE.Settled) {
          try {
            const cap = await getCapitalSnapshot(id);
            console.log();
            console.log(LABEL("  Capital"));
            // TODO: formatUSDC hardcodes 6 decimals — should use the vault's actual asset decimals
            console.log(W(`  Snapshot:         ${formatUSDC(cap)}`));
          } catch { /* no snapshot */ }
        }

        const execCalls = await getExecuteCalls(id);
        const settlCalls = await getSettlementCalls(id);

        console.log();
        console.log(LABEL(`  Execute Calls (${execCalls.length})`));
        for (let i = 0; i < execCalls.length; i++) {
          console.log(DIM(`  [${i}] target=${execCalls[i].target}`));
          console.log(DIM(`       data=${execCalls[i].data.slice(0, 20)}...  value=${execCalls[i].value}`));
        }
        console.log(LABEL(`  Settlement Calls (${settlCalls.length})`));
        for (let i = 0; i < settlCalls.length; i++) {
          console.log(DIM(`  [${i}] target=${settlCalls[i].target}`));
          console.log(DIM(`       data=${settlCalls[i].data.slice(0, 20)}...  value=${settlCalls[i].value}`));
        }

        SEP();
        console.log();
      } catch (err) {
        spinner.fail("Failed to load proposal");
        console.error(chalk.red(formatContractError(err)));
        process.exit(1);
      }
    });

  // ── proposal vote ──

  proposal
    .command("vote")
    .description("Cast a vote on a pending proposal")
    .requiredOption("--id <proposalId>", "Proposal ID")
    .requiredOption("--support <for|against|abstain>", "Vote direction: for, against, or abstain")
    .action(async (opts) => {
      try {
        const proposalId = parseBigIntArg(opts.id, "proposal ID");
        const supportRaw = String(opts.support).toLowerCase();
        const support = supportRaw === "yes" || supportRaw === "for"
          ? VOTE_TYPE.For
          : supportRaw === "no" || supportRaw === "against"
            ? VOTE_TYPE.Against
            : supportRaw === "abstain"
              ? VOTE_TYPE.Abstain
              : null;
        if (support === null) {
          console.error(chalk.red(`Invalid support value "${opts.support}". Use for|against|abstain.`));
          process.exit(1);
        }
        const account = getAccount();

        const spinner = ora("Loading proposal...").start();
        const p = await getProposal(proposalId);
        const state = await getProposalState(proposalId);

        if (state !== PROPOSAL_STATE.Pending) {
          spinner.fail(`Proposal is ${PROPOSAL_STATES[state] || "Unknown"}, not Pending`);
          process.exit(1);
        }

        const alreadyVoted = await hasVoted(proposalId, account.address);
        if (alreadyVoted) {
          spinner.fail("You have already voted on this proposal");
          process.exit(1);
        }

        const weight = await getVoteWeight(proposalId, account.address);
        spinner.stop();

        console.log();
        console.log(LABEL("  ◆ Cast Vote"));
        SEP();
        console.log(W(`  Proposal:  #${proposalId}`));
        console.log(W(`  Vault:     ${G(p.vault)}`));
        console.log(W(
          `  Support:   ${
            support === VOTE_TYPE.For ? G("FOR")
              : support === VOTE_TYPE.Against ? chalk.red("AGAINST")
                : DIM("ABSTAIN")
          }`,
        ));
        console.log(W(`  Weight:    ${formatShares(weight)} shares`));
        SEP();

        const voteSpinner = ora({ text: W("Submitting vote..."), color: "green" }).start();
        const hash = await vote(proposalId, support);
        voteSpinner.succeed(G("Vote cast"));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));
        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal execute ──

  proposal
    .command("execute")
    .description("Execute an approved proposal")
    .requiredOption("--id <proposalId>", "Proposal ID")
    .option("--dry-run", "Simulate execution without sending a transaction")
    .action(async (opts) => {
      try {
        const proposalId = parseBigIntArg(opts.id, "proposal ID");

        const spinner = ora("Loading proposal...").start();
        const state = await getProposalState(proposalId);

        if (state !== PROPOSAL_STATE.Approved) {
          spinner.fail(`Proposal is ${PROPOSAL_STATES[state] || "Unknown"}, not Approved`);
          process.exit(1);
        }

        // Dry run — simulate instead of executing
        if (opts.dryRun) {
          const p = await getProposal(proposalId);
          const execCalls = await getExecuteCalls(proposalId);
          const dryRunContext: RiskContext = {
            vault: p.vault,
            performanceFeeBps: p.performanceFeeBps,
            strategyDuration: p.strategyDuration,
          };
          spinner.text = W("Simulating execution...");
          const result = await simulateBatchCalls(p.vault, execCalls, "execute", dryRunContext);
          spinner.stop();
          printSimulationResult(result, "execute");
          const hasCritical = result.risks.some((r) => r.level === "critical");
          process.exit(result.success && !hasCritical ? 0 : 1);
        }

        spinner.text = W("Executing proposal...");
        const hash = await executeProposal(proposalId);
        spinner.succeed(G("Proposal executed"));

        console.log(DIM(`  ${getExplorerUrl(hash)}`));

        try {
          const cap = await getCapitalSnapshot(proposalId);
          // TODO: formatUSDC hardcodes 6 decimals — should use the vault's actual asset decimals
          console.log(DIM(`  Capital snapshot: ${formatUSDC(cap)}`));
        } catch { /* no snapshot yet */ }

        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal settle ──

  proposal
    .command("settle")
    .description("Settle an executed proposal (auto-routes settlement path)")
    .requiredOption("--id <proposalId>", "Proposal ID")
    .option("--calls <path>", "Path to JSON file with settle Call[] (for agent/emergency settle)")
    .action(async (opts) => {
      try {
        const proposalId = parseBigIntArg(opts.id, "proposal ID");
        const account = getAccount();

        const spinner = ora("Loading proposal...").start();
        const p = await getProposal(proposalId);
        const state = await getProposalState(proposalId);

        if (state !== PROPOSAL_STATE.Executed) {
          spinner.fail(`Proposal is ${PROPOSAL_STATES[state] || "Unknown"}, not Executed`);
          process.exit(1);
        }

        const isProposer = account.address.toLowerCase() === p.proposer.toLowerCase();
        const now = BigInt(Math.floor(Date.now() / 1000));
        const durationElapsed = p.executedAt > 0n && now >= p.executedAt + p.strategyDuration;

        let hash: Hex;

        if (isProposer && !durationElapsed) {
          // Proposer can settle anytime
          spinner.text = W("Settling (proposer)...");
          hash = await settleProposal(proposalId);
          spinner.succeed(G("Settled by proposer"));
        } else if (durationElapsed && !opts.calls) {
          // Permissionless settle after duration
          spinner.text = W("Settling (permissionless)...");
          hash = await settleProposal(proposalId);
          spinner.succeed(G("Settled (permissionless)"));
        } else if (durationElapsed && opts.calls) {
          // Emergency settle — owner with custom calls
          spinner.text = W("Emergency settling...");
          const calls = parseCallsFile(opts.calls);
          hash = await emergencySettle(proposalId, calls);
          spinner.succeed(G("Emergency settled"));
        } else {
          spinner.fail("Cannot settle: duration not elapsed and you are not the proposer.");
          process.exit(1);
        }

        console.log(DIM(`  ${getExplorerUrl(hash)}`));
        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal unstick ──
  // Guardian-only recovery path. Hidden from `--help` on purpose: this is a
  // last-resort command used by the syndicate-owner skill when an Executed
  // proposal's pre-committed settlement calls revert, leaving the vault
  // locked (`redemptionsLocked() == true`, `getActiveProposal(vault) != 0`).
  //
  // It calls `emergencySettle(id, [noopCall])` where `noopCall` is a
  // harmless `asset.balanceOf(vault)` view-call on the vault's underlying
  // asset. The governor's `_tryPrecommittedThenFallback` catches the
  // pre-committed revert and runs this no-op fallback, causing
  // `_finishSettlement` to mark the proposal `Settled` and clear
  // `_activeProposal[vault]`. LPs can redeem afterwards.
  //
  // Docs: skill/skills/syndicate-owner/SKILL.md § "Recovering a stuck proposal"

  proposal
    .command("unstick", { hidden: true })
    .description(
      "Guardian-only: unstick a vault whose Executed proposal cannot settle (no funds moved)",
    )
    .requiredOption("--id <proposalId>", "Proposal ID to unstick")
    .option("--yes", "Skip the interactive confirmation")
    .option(
      "--dry-run",
      "Check preconditions and print the fallback call without broadcasting",
    )
    .action(async (opts) => {
      try {
        const proposalId = parseBigIntArg(opts.id, "proposal ID");
        const account = getAccount();

        const spinner = ora("Loading proposal...").start();
        const p = await getProposal(proposalId);
        const state = await getProposalState(proposalId);

        // 1. State must be Executed
        if (state !== PROPOSAL_STATE.Executed) {
          spinner.fail(
            `Proposal ${proposalId} is ${PROPOSAL_STATES[state] || "Unknown"} — unstick only applies to Executed proposals.`,
          );
          console.error(
            DIM(
              "\n  Other states have their own recovery path:\n" +
                "    Draft/Pending    → sherwood proposal cancel --id <id>\n" +
                "    Approved         → sherwood proposal veto <id>\n" +
                "    Expired          → vault is not locked, nothing to do\n" +
                "    Settled          → already settled\n" +
                "    Cancelled        → governor upgrade required (issue #177)\n",
            ),
          );
          process.exit(1);
        }

        // 2. Strategy duration must have elapsed (emergencySettle requires it)
        const now = BigInt(Math.floor(Date.now() / 1000));
        const expiresAt = p.executedAt + p.strategyDuration;
        if (p.executedAt === 0n || now < expiresAt) {
          spinner.fail("Strategy duration has not elapsed yet.");
          const remaining = expiresAt - now;
          console.error(
            DIM(
              `\n  Can unstick after: ${new Date(Number(expiresAt) * 1000).toLocaleString()} (in ~${formatDuration(remaining)})\n`,
            ),
          );
          process.exit(1);
        }

        // 3. Vault must actually be locked by this proposal
        const vault = p.vault as Address;
        const active = await getActiveProposal(vault);
        if (active !== proposalId) {
          spinner.fail(
            `Vault ${vault} active proposal is ${active}, not ${proposalId} — nothing to unstick for this proposal.`,
          );
          process.exit(1);
        }

        // 4. Caller must be vault owner
        const vaultOwner = await getVaultOwner(vault);
        if (account.address.toLowerCase() !== vaultOwner.toLowerCase()) {
          spinner.fail("Only the vault owner can unstick a proposal.");
          console.error(
            DIM(`\n  Vault owner: ${vaultOwner}\n  Your wallet: ${account.address}\n`),
          );
          process.exit(1);
        }

        // 5. Craft the no-op fallback call: asset.balanceOf(vault)
        // Cannot revert, costs ~2.5k gas, satisfies fallbackCalls.length > 0
        // requirement in _tryPrecommittedThenFallback.
        const asset = await getAssetAddress();
        const noopCalldata = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [vault],
        });
        const fallbackCalls: BatchCall[] = [
          { target: asset, data: noopCalldata, value: 0n },
        ];

        spinner.stop();

        // Print plan
        console.log();
        console.log(BOLD("Unstick plan"));
        SEP();
        console.log(`  Proposal:     ${proposalId}`);
        console.log(`  Vault:        ${vault}`);
        console.log(`  Asset:        ${asset}`);
        console.log(`  State:        ${PROPOSAL_STATES[state]} (duration elapsed)`);
        console.log(`  Caller:       ${account.address} (vault owner ✓)`);
        console.log();
        console.log(LABEL("  Fallback call (no-op, cannot revert):"));
        console.log(DIM(`    target: ${asset}`));
        console.log(DIM(`    data:   ${noopCalldata}  // balanceOf(${vault})`));
        console.log(DIM("    value:  0"));
        console.log();
        console.log(
          DIM(
            "  This calls emergencySettle(id, [noop]). The governor catches any revert\n" +
              "  from the pre-committed settlement calls and runs the no-op instead. No\n" +
              "  funds move. The proposal transitions to Settled and the vault unlocks.\n" +
              "  LPs can then redeem via `sherwood vault redeem`.",
          ),
        );
        console.log();

        if (opts.dryRun) {
          console.log(G("  (dry-run) Preconditions OK — not broadcasting.\n"));
          return;
        }

        if (!opts.yes) {
          process.stdout.write(chalk.yellow("  Proceed? [y/N] "));
          const answer = await new Promise<string>((resolve) => {
            process.stdin.resume();
            process.stdin.setEncoding("utf-8");
            process.stdin.once("data", (d) => resolve(String(d).trim().toLowerCase()));
          });
          process.stdin.pause();
          if (answer !== "y" && answer !== "yes") {
            console.log(DIM("  Cancelled.\n"));
            return;
          }
        }

        const send = ora("Broadcasting emergencySettle...").start();
        const hash = await emergencySettle(proposalId, fallbackCalls);
        send.succeed(G("Vault unstuck — proposal Settled"));
        console.log(DIM(`  ${getExplorerUrl(hash)}`));

        // Verify unlock
        const stillActive = await getActiveProposal(vault);
        if (stillActive === 0n) {
          console.log(G("  redemptionsLocked cleared ✓"));
        } else {
          console.log(
            chalk.yellow(
              `  ⚠ getActiveProposal(vault) still returns ${stillActive} — check manually.`,
            ),
          );
        }
        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal cancel ──

  proposal
    .command("cancel")
    .description("Cancel a proposal (proposer or vault owner)")
    .requiredOption("--id <proposalId>", "Proposal ID")
    .option("--emergency", "Emergency cancel (vault owner only, any non-settled state)")
    .action(async (opts) => {
      try {
        const proposalId = parseBigIntArg(opts.id, "proposal ID");

        const spinner = ora("Loading proposal...").start();
        const state = await getProposalState(proposalId);

        if (state === PROPOSAL_STATE.Settled || state === PROPOSAL_STATE.Cancelled) {
          spinner.fail(`Proposal is already ${PROPOSAL_STATES[state]}`);
          process.exit(1);
        }

        let hash: Hex;

        if (opts.emergency) {
          spinner.text = W("Emergency cancelling...");
          hash = await emergencyCancel(proposalId);
          spinner.succeed(G("Emergency cancelled"));
        } else {
          if (state !== PROPOSAL_STATE.Draft && state !== PROPOSAL_STATE.Pending) {
            spinner.fail(`Proposal is ${PROPOSAL_STATES[state] || "Unknown"} — use --emergency for non-pending/approved`);
            process.exit(1);
          }
          spinner.text = W("Cancelling proposal...");
          hash = await cancelProposal(proposalId);
          spinner.succeed(G("Proposal cancelled"));
        }

        console.log(DIM(`  ${getExplorerUrl(hash)}`));
        console.log();
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${formatContractError(err)}`));
        process.exit(1);
      }
    });

  // ── proposal simulate ──

  proposal
    .command("simulate")
    .description("Simulate proposal calls via Tenderly (or eth_call fallback)")
    .option("--id <proposalId>", "Proposal ID to simulate")
    .option("--vault <address>", "Vault address (required with --execute-calls)")
    .option("--execute-calls <path>", "Path to JSON execute calls file")
    .option("--settle-calls <path>", "Path to JSON settlement calls file")
    .option("--notify <subdomain>", "Send results to syndicate XMTP chat")
    .action(async (opts) => {
      try {
        let vault: Address;
        let executeCalls: BatchCall[];
        let settlementCalls: BatchCall[] = [];
        let riskContext: RiskContext = {};
        let proposalId: bigint | undefined;

        if (opts.id) {
          // By proposal ID — fetch calls and build full risk context
          proposalId = parseBigIntArg(opts.id, "proposal ID");
          const spinner = ora("Loading proposal...").start();

          const p = await getProposal(proposalId);
          vault = p.vault;
          executeCalls = await getExecuteCalls(proposalId);
          settlementCalls = await getSettlementCalls(proposalId);

          riskContext = {
            vault,
            performanceFeeBps: p.performanceFeeBps,
            strategyDuration: p.strategyDuration,
          };

          try {
            const govParams = await getGovernorParams();
            riskContext.governorParams = govParams;
          } catch { /* non-fatal */ }

          spinner.stop();
          console.log(DIM(`\n  Simulating proposal #${proposalId} on vault ${vault.slice(0, 10)}...`));
        } else if (opts.executeCalls) {
          // By call files — minimal risk context (no proposal params)
          if (!opts.vault || !isAddress(opts.vault)) {
            console.error(chalk.red("\n  ✖ --vault is required when using --execute-calls"));
            process.exit(1);
          }
          vault = opts.vault as Address;
          executeCalls = parseCallsFile(opts.executeCalls);
          if (opts.settleCalls) {
            settlementCalls = parseCallsFile(opts.settleCalls);
          }
          riskContext = { vault };
        } else {
          console.error(chalk.red("\n  ✖ Provide --id <proposalId> or --execute-calls <path>"));
          process.exit(1);
        }

        // Simulate execute calls
        const spinner = ora({ text: W("Simulating execute calls..."), color: "green" }).start();
        const execResult = await simulateBatchCalls(vault, executeCalls, "execute", riskContext);
        spinner.stop();
        printSimulationResult(execResult, "execute");

        // Simulate settlement calls if present
        let settleResult;
        if (settlementCalls.length > 0) {
          const settleSpinner = ora({ text: W("Simulating settlement calls..."), color: "green" }).start();
          settleResult = await simulateBatchCalls(vault, settlementCalls, "settlement", riskContext);
          settleSpinner.stop();
          printSimulationResult(settleResult, "settlement");
        }

        // Send XMTP notification if requested
        if (opts.notify && proposalId !== undefined) {
          const notifySpinner = ora({ text: W("Sending XMTP alert..."), color: "green" }).start();
          await sendSimulationAlert(opts.notify, proposalId, vault, execResult, settleResult);
          notifySpinner.succeed(G("Risk report sent to chat"));
        }

        // Exit with failure code if simulation or risks are critical
        const hasCritical = execResult.risks.some((r) => r.level === "critical")
          || (settleResult?.risks.some((r) => r.level === "critical") ?? false);

        if (!execResult.success || (settleResult && !settleResult.success) || hasCritical) {
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red(`\n  ✖ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
