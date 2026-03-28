/**
 * Proposal specification builder for simulation.
 *
 * Maps creator personas to strategy template + CLI args.
 * Shared by phase 07 (initial propose) and phase 10 (lifecycle re-propose).
 */

import { PERSONAS } from "./personas.js";

export interface ProposalSpec {
  strategy: string; // template key: moonwell-supply, venice-inference, wsteth-moonwell
  args: string[]; // CLI args after "strategy propose <template>"
  name: string;
  description: string;
}

/**
 * Build a proposal spec for a given creator based on their persona's strategy
 * template and vault asset. The `cycle` parameter rotates proposal names so
 * successive re-proposals don't collide.
 */
export function getProposalSpec(
  creatorIndex: number,
  vault: string,
  duration: string,
  cycle: number = 1,
): ProposalSpec {
  const persona = PERSONAS.find((p) => p.index === creatorIndex);
  const template = persona?.strategyTemplate || "moonwell-supply";
  const asset = persona?.vaultAsset || "USDC";
  const cycleSuffix = cycle > 1 ? ` #${cycle}` : "";

  switch (template) {
    case "moonwell-supply": {
      const isWeth = asset === "WETH";
      const amount = isWeth ? "0.004" : "8";
      const minRedeem = isWeth ? "0.003" : "7";
      const token = isWeth ? "WETH" : "USDC";
      const name = `Moonwell ${token} Yield${cycleSuffix}`;
      return {
        strategy: "moonwell-supply",
        args: [
          "--vault", vault,
          "--amount", amount,
          "--min-redeem", minRedeem,
          "--token", token,
          "--name", name,
          "--description", `${token} supply to Moonwell lending. Duration: ${duration}.`,
          "--performance-fee", "1000",
          "--duration", duration,
        ],
        name,
        description: `${token} supply to Moonwell lending.`,
      };
    }

    case "venice-inference": {
      const name = `Venice Inference Yield${cycleSuffix}`;
      return {
        strategy: "venice-inference",
        args: [
          "--vault", vault,
          "--amount", "8",
          "--asset", "USDC",
          "--name", name,
          "--description", `VVV staking for AI inference credits. Duration: ${duration}.`,
          "--performance-fee", "800",
          "--duration", duration,
        ],
        name,
        description: "VVV staking for AI inference credits.",
      };
    }

    case "wsteth-moonwell": {
      const name = `wstETH Moonwell Yield${cycleSuffix}`;
      return {
        strategy: "wsteth-moonwell",
        args: [
          "--vault", vault,
          "--amount", "0.004",
          "--name", name,
          "--description", `WETH to wstETH to Moonwell lending. Duration: ${duration}.`,
          "--performance-fee", "800",
          "--duration", duration,
        ],
        name,
        description: "WETH to wstETH to Moonwell lending.",
      };
    }

    default:
      // Fallback to moonwell-supply USDC
      return getProposalSpec(1, vault, duration, cycle);
  }
}
