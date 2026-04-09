/**
 * Portfolio strategy data fetching.
 *
 * Detects if a proposal uses a PortfolioStrategy by reading its execute calls,
 * calling name() on the strategy clone, and fetching allocation data.
 */

import { type Address, formatUnits } from "viem";
import {
  getPublicClient,
  SYNDICATE_GOVERNOR_ABI,
  PORTFOLIO_STRATEGY_ABI,
  ERC20_ABI,
} from "./contracts";
import { fetchAllTokenMetadata } from "./token-metadata";

// ── Types ──────────────────────────────────────────────────

export interface TokenAllocation {
  token: Address;
  symbol: string;
  decimals: number;
  targetWeightBps: number;
  tokenAmount: string;
  investedAmount: string;
  feeTier: number;
  logo: string | null;
  marketCap: number | null;
}

export interface PortfolioData {
  strategyAddress: Address;
  allocations: TokenAllocation[];
  totalAmount: string;
  assetSymbol: string;
  assetAddress: Address;
  assetDecimals: number;
}

// ── Main fetch ─────────────────────────────────────────────

/**
 * Detect if a proposal uses a PortfolioStrategy and fetch its allocation data.
 * Returns null if the proposal is not a portfolio strategy or if detection fails.
 */
export async function fetchPortfolioData(
  governorAddress: Address,
  proposalId: bigint,
  chainId: number,
  assetDecimals: number,
  assetSymbol: string,
): Promise<PortfolioData | null> {
  const client = getPublicClient(chainId);

  try {
    // Step 1: Get execute calls from the proposal
    const calls = (await client.readContract({
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "getExecuteCalls",
      args: [proposalId],
    })) as { target: Address; data: `0x${string}`; value: bigint }[];

    if (!calls || calls.length < 2) return null;

    // Step 2: Try to detect portfolio strategy
    // The second call's target is typically the strategy clone
    // (first call is usually the asset approval)
    let strategyAddress: Address | null = null;

    for (let i = 1; i < calls.length; i++) {
      try {
        const name = await client.readContract({
          address: calls[i].target,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "name",
        });
        if (name === "Portfolio") {
          strategyAddress = calls[i].target;
          break;
        }
      } catch {
        // Not a strategy contract — expected, continue
      }
    }

    if (!strategyAddress) return null;

    // Step 3: Read strategy data
    const [allocationsRaw, totalAmountRaw, swapExtraDataRaw, assetRaw] = await client.multicall({
      contracts: [
        {
          address: strategyAddress,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "getAllocations",
        },
        {
          address: strategyAddress,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "totalAmount",
        },
        {
          address: strategyAddress,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "getSwapExtraData",
        },
        {
          address: strategyAddress,
          abi: PORTFOLIO_STRATEGY_ABI,
          functionName: "asset",
        },
      ],
    });

    if (allocationsRaw.status !== "success" || !allocationsRaw.result)
      return null;

    const rawAllocations = allocationsRaw.result as {
      token: Address;
      targetWeightBps: bigint;
      tokenAmount: bigint;
      investedAmount: bigint;
    }[];

    const totalAmount =
      totalAmountRaw.status === "success"
        ? (totalAmountRaw.result as bigint)
        : 0n;

    const swapExtraData =
      swapExtraDataRaw.status === "success"
        ? (swapExtraDataRaw.result as `0x${string}`[])
        : [];

    const assetAddress =
      assetRaw.status === "success"
        ? (assetRaw.result as Address)
        : ("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address); // fallback USDC

    if (rawAllocations.length === 0) return null;

    // Step 4: Batch-read token metadata (symbol + decimals)
    const tokenMetaCalls = rawAllocations.flatMap((a) => [
      {
        address: a.token,
        abi: ERC20_ABI,
        functionName: "symbol" as const,
      },
      {
        address: a.token,
        abi: ERC20_ABI,
        functionName: "decimals" as const,
      },
    ]);

    const metaResults = await client.multicall({ contracts: tokenMetaCalls });

    // Step 5: Fetch token metadata (logos) via Alchemy + Codex
    const tokenAddresses = rawAllocations.map((a) => a.token);
    const metadataMap = await fetchAllTokenMetadata(tokenAddresses, chainId);

    // Step 6: Assemble allocation data
    const allocations: TokenAllocation[] = rawAllocations.map((a, i) => {
      const symbolResult = metaResults[i * 2];
      const decimalsResult = metaResults[i * 2 + 1];

      const meta = metadataMap.get(a.token.toLowerCase());
      const symbol = meta?.symbol
        ?? (symbolResult.status === "success" ? (symbolResult.result as string) : `0x${a.token.slice(2, 8)}`);
      const decimals = meta?.decimals
        ?? (decimalsResult.status === "success" ? Number(decimalsResult.result) : 18);

      // Parse fee tier from swapExtraData
      let feeTier = 3000; // default
      if (swapExtraData[i]) {
        try {
          const bytes = swapExtraData[i];
          const mode = parseInt(bytes.slice(2, 4), 16);
          if (mode === 0 && bytes.length >= 68) {
            // Single-hop: 0x00 + abi.encode(uint24) — fee is in last 3 bytes of 32-byte word
            feeTier = parseInt(bytes.slice(bytes.length - 6), 16);
          }
          // mode 1 = multi-hop, default fee tier is fine for quoting
        } catch {
          // keep default
        }
      }

      return {
        token: a.token,
        symbol,
        decimals,
        targetWeightBps: Number(a.targetWeightBps),
        tokenAmount: formatUnits(a.tokenAmount, decimals),
        investedAmount: formatUnits(a.investedAmount, assetDecimals),
        feeTier,
        logo: meta?.logo ?? null,
        marketCap: meta?.marketCap ?? null,
      };
    });

    return {
      strategyAddress,
      allocations,
      totalAmount: formatUnits(totalAmount, assetDecimals),
      assetSymbol,
      assetAddress,
      assetDecimals,
    };
  } catch {
    // Graceful failure — governor may not support getExecuteCalls or RPC may be down
    return null;
  }
}
