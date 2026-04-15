/**
 * Shared loader for the "Active Strategy" panel. Pulls governor data,
 * finds the currently-executing proposal, enriches with P&L from the
 * activity feed, and resolves portfolio allocations if the strategy is
 * a PortfolioStrategy.
 *
 * Used by both the vault page (primary surface) and the proposals page
 * (historical — not currently rendered there after the UX change).
 */

import { type Address } from "viem";
import {
  fetchGovernorData,
  ProposalState,
  type GovernorData,
  type ProposalData,
} from "./governor-data";
import { fetchPortfolioData } from "./portfolio-data";
import { type ActivityEvent } from "./syndicate-data";

export interface PortfolioAllocSummary {
  allocations: { symbol: string; weightPct: number }[];
  totalAmount: string;
  assetSymbol: string;
}

export interface EnrichedPortfolio {
  allocations: {
    token: Address;
    symbol: string;
    decimals: number;
    weightPct: number;
    tokenAmount: string;
    investedAmount: string;
    feeTier: number;
    logo: string | null;
    marketCap: number | null;
  }[];
  totalAmount: string;
  assetSymbol: string;
  assetAddress: Address;
  assetDecimals: number;
  chainId: number;
}

export interface ActiveStrategyPayload {
  governor: GovernorData | null;
  activeProposal: ProposalData | null;
  portfolioAllocations: PortfolioAllocSummary | null;
  enrichedPortfolio: EnrichedPortfolio | null;
}

export async function loadActiveStrategy(
  vault: Address,
  chainId: number,
  assetDecimals: number,
  assetSymbol: string,
  activity: ActivityEvent[],
): Promise<ActiveStrategyPayload> {
  const governor = await fetchGovernorData(vault, chainId);
  if (!governor) {
    return {
      governor: null,
      activeProposal: null,
      portfolioAllocations: null,
      enrichedPortfolio: null,
    };
  }

  // Enrich proposals with P&L from the activity feed so the history
  // table + any future active-strategy P&L readout stays consistent.
  if (activity.length > 0) {
    for (const proposal of governor.proposals) {
      const settled = activity.find(
        (a) => a.type === "settled" && a.proposalId === proposal.id,
      );
      if (settled && settled.pnl !== undefined) {
        proposal.pnl = settled.pnl;
      }
    }
  }

  const activeProposal =
    governor.proposals.find(
      (p) => p.computedState === ProposalState.Executed,
    ) ?? null;

  if (!activeProposal) {
    return {
      governor,
      activeProposal: null,
      portfolioAllocations: null,
      enrichedPortfolio: null,
    };
  }

  const portfolioData = await fetchPortfolioData(
    governor.governorAddress,
    activeProposal.id,
    chainId,
    assetDecimals,
    assetSymbol,
  );

  if (!portfolioData) {
    return {
      governor,
      activeProposal,
      portfolioAllocations: null,
      enrichedPortfolio: null,
    };
  }

  const portfolioAllocations: PortfolioAllocSummary = {
    allocations: portfolioData.allocations.map((a) => ({
      symbol: a.symbol,
      weightPct: a.targetWeightBps / 100,
    })),
    totalAmount: portfolioData.totalAmount,
    assetSymbol: portfolioData.assetSymbol,
  };

  const enrichedPortfolio: EnrichedPortfolio = {
    allocations: portfolioData.allocations.map((a) => ({
      token: a.token,
      symbol: a.symbol,
      decimals: a.decimals,
      weightPct: a.targetWeightBps / 100,
      tokenAmount: a.tokenAmount,
      investedAmount: a.investedAmount,
      feeTier: a.feeTier,
      logo: a.logo,
      marketCap: a.marketCap,
    })),
    totalAmount: portfolioData.totalAmount,
    assetSymbol: portfolioData.assetSymbol,
    assetAddress: portfolioData.assetAddress,
    assetDecimals: portfolioData.assetDecimals,
    chainId,
  };

  return {
    governor,
    activeProposal,
    portfolioAllocations,
    enrichedPortfolio,
  };
}
