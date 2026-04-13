"use client";

/**
 * Glossary — central definitions for jargon that surfaces in the UI.
 * <Term k="vault">Vault</Term> renders the label with a dotted underline
 * and a hover tooltip pulled from the dictionary below.
 *
 * Add new terms here so the same canonical phrasing appears everywhere.
 */

import { type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

const GLOSSARY: Record<string, string> = {
  vault:
    "ERC-4626 vault that holds depositor assets. Each syndicate has one. Shares are minted on deposit and burned on redeem.",
  "voting-period":
    "Time window during which LPs can cast FOR or AGAINST votes on a new proposal.",
  "veto-threshold":
    "Optimistic governance: a proposal passes by default unless AGAINST votes reach this percentage of share supply.",
  "max-fee":
    "Maximum performance fee (basis points) any agent may set when proposing a strategy in this syndicate.",
  cooldown:
    "Forced delay between strategy settlements before the next proposal can execute. Prevents back-to-back rugs.",
  "optimistic-governance":
    "Proposals require no quorum to pass. They pass automatically when the voting window ends, unless veto-threshold AGAINST votes are recorded.",
  "performance-fee":
    "Cut of profit (basis points) the proposing agent earns when their strategy settles in the green.",
  "execution-window":
    "After approval, the time the agent has to actually execute the strategy onchain. If they miss it, the proposal expires.",
  "strategy-duration":
    "How long the strategy runs onchain before it can be settled. Redemptions are locked during this period.",
  "settlement":
    "Closing the strategy onchain — pulling capital back to the vault and distributing performance + protocol fees.",
  "snapshot":
    "Block at which voting weight is frozen. Prevents flash-loan governance attacks.",
  "redemptions-locked":
    "While a strategy is executing, deposits and withdrawals are paused so the vault accounting stays consistent.",
  erc4626:
    "Tokenized vault standard (EIP-4626). Deposits mint shares; redeems burn shares for a pro-rata claim on assets.",
  erc8004:
    "Onchain agent identity standard. Agents register an NFT proving they're the same entity across syndicates.",
};

interface TermProps {
  k: keyof typeof GLOSSARY | string;
  children?: ReactNode;
}

/**
 * Inline glossary term. Renders children with a dotted underline and a hover
 * tooltip. Falls back to children-only if the key is unknown.
 */
export function Term({ k, children }: TermProps) {
  const definition = GLOSSARY[k];
  if (!definition) return <>{children}</>;
  return (
    <Tooltip content={definition}>
      <span
        style={{
          borderBottom: "1px dotted rgba(255,255,255,0.4)",
          cursor: "help",
        }}
      >
        {children}
      </span>
    </Tooltip>
  );
}

export { GLOSSARY };
