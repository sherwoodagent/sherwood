"use client";

/**
 * ProposalNotifier — fires toast notifications when proposals the connected
 * wallet voted on transition state.
 *
 * Polls `getProposalState` for each tracked proposal every 30s and compares
 * against the previously seen state. The very first observation is silent
 * — toasts only fire on transitions, never on the initial read.
 *
 * No persistence across reloads; this is intentional. We don't want to
 * spam the user with stale notifications when they reopen the app.
 */

import { useEffect, useMemo, useRef } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { type Address } from "viem";
import {
  ProposalState,
  PROPOSAL_STATE_LABELS,
  type ProposalData,
} from "@/lib/governor-data";
import { SYNDICATE_GOVERNOR_ABI } from "@/lib/contracts";
import { useToast } from "@/components/ui/Toast";

interface Props {
  governorAddress: Address;
  proposals: ProposalData[];
  chainId: number;
}

const POLL_MS = 30_000;
const TERMINAL_STATES = new Set<ProposalState>([
  ProposalState.Settled,
  ProposalState.Rejected,
  ProposalState.Cancelled,
  ProposalState.Expired,
]);

export default function ProposalNotifier({
  governorAddress,
  proposals,
  chainId,
}: Props) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId });
  const toast = useToast();

  // proposalId → last seen state. Map persists across renders.
  const lastSeen = useRef<Map<string, ProposalState>>(new Map());
  // Track which proposals we've already confirmed the user voted on.
  const userVoted = useRef<Map<string, boolean>>(new Map());

  // Stable key summarising the proposal set. Parent re-renders (e.g. the
  // router.refresh() VoteButton fires on confirm) create a new proposals
  // array every time; depending on that array identity would tear down the
  // interval + reset lastSeen/userVoted on every vote, causing spurious
  // toasts and bursty RPC polling.
  const proposalsKey = useMemo(
    () => proposals.map((p) => p.id.toString()).join(","),
    [proposals],
  );
  const proposalsRef = useRef(proposals);
  // Keep the ref in sync via an effect — mutating refs during render is a
  // React 19 rule violation and breaks concurrent rendering guarantees.
  useEffect(() => {
    proposalsRef.current = proposals;
  }, [proposals]);

  useEffect(() => {
    if (!client || !address) return;
    if (!proposalsRef.current.length) return;

    let cancelled = false;

    async function poll() {
      if (!client || !address) return;

      // Step 1: Resolve which proposals this user voted on (one-time per
      // proposal). Skip terminal proposals — there's nothing left to notify.
      const live = proposalsRef.current.filter(
        (p) => !TERMINAL_STATES.has(p.computedState),
      );
      const toCheck = live.filter(
        (p) => !userVoted.current.has(p.id.toString()),
      );

      if (toCheck.length > 0) {
        try {
          const calls = toCheck.map((p) => ({
            address: governorAddress,
            abi: SYNDICATE_GOVERNOR_ABI,
            functionName: "hasVoted" as const,
            args: [p.id, address] as const,
          }));
          const results = await client.multicall({ contracts: calls });
          results.forEach((r, i) => {
            const pid = toCheck[i].id.toString();
            userVoted.current.set(pid, r.status === "success" && !!r.result);
          });
        } catch {
          // network blip — try again next tick
        }
      }

      // Step 2: For each live proposal the user voted on, read current state.
      const watch = live.filter((p) => userVoted.current.get(p.id.toString()));
      if (watch.length === 0) return;

      try {
        const stateCalls = watch.map((p) => ({
          address: governorAddress,
          abi: SYNDICATE_GOVERNOR_ABI,
          functionName: "getProposalState" as const,
          args: [p.id] as const,
        }));
        const results = await client.multicall({ contracts: stateCalls });

        if (cancelled) return;

        results.forEach((r, i) => {
          if (r.status !== "success") return;
          const next = Number(r.result) as ProposalState;
          const pid = watch[i].id.toString();
          const prev = lastSeen.current.get(pid);

          // First observation — record without firing.
          if (prev === undefined) {
            lastSeen.current.set(pid, next);
            return;
          }

          if (prev === next) return;

          lastSeen.current.set(pid, next);

          // Pick a toast variant + message per transition.
          const proposal = watch[i];
          const title = proposal.metadata?.title || `Proposal #${pid}`;

          if (next === ProposalState.Settled) {
            toast.success(
              "Strategy settled",
              `${title} has settled onchain.`,
            );
          } else if (next === ProposalState.Rejected) {
            toast.info("Proposal rejected", `${title} was vetoed.`);
          } else if (next === ProposalState.Approved) {
            toast.info(
              "Proposal approved",
              `${title} passed voting and is awaiting execution.`,
            );
          } else if (next === ProposalState.Executed) {
            toast.success(
              "Strategy executing",
              `${title} is now live onchain.`,
            );
          } else if (next === ProposalState.Cancelled || next === ProposalState.Expired) {
            toast.info(
              `Proposal ${PROPOSAL_STATE_LABELS[next].toLowerCase()}`,
              title,
            );
          }
        });
      } catch {
        // ignore transient errors
      }
    }

    // Kick off + interval
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `proposalsKey` is a stable summary of the proposal set. Depending on
    // the raw `proposals` array would reset the interval + user-vote cache
    // every time the parent re-renders (router.refresh() after a vote).
  }, [client, address, governorAddress, proposalsKey, toast]);

  return null;
}
