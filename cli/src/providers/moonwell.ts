import type { Address, Chain } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { LendingProvider, ProviderInfo, DepositParams, BorrowParams, RepayParams, WithdrawParams, TxResult, LendingPosition } from "../types.js";
import { MOONWELL as getMoonwell } from "../lib/addresses.js";

export class MoonwellProvider implements LendingProvider {
  info(): ProviderInfo {
    return {
      name: "moonwell",
      type: "lending",
      capabilities: [
        "lend.deposit",
        "lend.borrow",
        "lend.repay",
        "lend.withdraw",
        "lend.positions",
      ],
      supportedChains: [base, baseSepolia],
    };
  }

  async depositCollateral(params: DepositParams): Promise<TxResult> {
    // TODO: Build and send tx via viem
    throw new Error("Not implemented — wire up viem client");
  }

  async borrow(params: BorrowParams): Promise<TxResult> {
    throw new Error("Not implemented");
  }

  async repay(params: RepayParams): Promise<TxResult> {
    throw new Error("Not implemented");
  }

  async withdrawCollateral(params: WithdrawParams): Promise<TxResult> {
    throw new Error("Not implemented");
  }

  async getPosition(account: Address): Promise<LendingPosition> {
    throw new Error("Not implemented");
  }
}
