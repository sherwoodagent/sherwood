import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { TradingProvider, ProviderInfo, SwapParams, SwapQuoteParams, TxResult, SwapQuote } from "../types.js";

export class UniswapProvider implements TradingProvider {
  info(): ProviderInfo {
    return {
      name: "uniswap",
      type: "trading",
      capabilities: [
        "swap.exact-input",
        "swap.quote",
      ],
      supportedChains: [base, baseSepolia],
    };
  }

  async swap(params: SwapParams): Promise<TxResult> {
    // TODO: Build and send tx via viem
    throw new Error("Not implemented — wire up viem client");
  }

  async quote(params: SwapQuoteParams): Promise<SwapQuote> {
    throw new Error("Not implemented");
  }
}
