/**
 * Local registry of well-known 4-byte function selectors.
 *
 * Seeded from the function signatures Sherwood's batched strategies emit
 * (Moonwell / Aerodrome / Uniswap / Aave / Compound / WETH) plus governor
 * lifecycle calls. Avoids a runtime dependency on openchain.xyz so the
 * proposal page renders decoded selectors offline.
 *
 * Add new entries when a strategy template introduces a new external call.
 * Compute with `cast sig "<signature>"`.
 */

export const KNOWN_SELECTORS: Record<string, string> = {
  // ── ERC-20 ──
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",

  // ── ERC-4626 vaults ──
  "0x6e553f65": "deposit", // deposit(uint256,address)
  "0x94bf804d": "mint", // mint(uint256,address)
  "0xb460af94": "withdraw", // withdraw(uint256,address,address)
  "0xba087652": "redeem", // redeem(uint256,address,address)

  // ── WETH ──
  "0xd0e30db0": "deposit", // wrap ETH
  "0x2e1a7d4d": "withdraw", // unwrap ETH

  // ── Compound / Moonwell mTokens ──
  "0xa0712d68": "mint", // mint(uint256)
  "0xdb006a75": "redeem", // redeem(uint256)
  "0x852a12e3": "redeemUnderlying",
  "0xc5ebeaec": "borrow",
  "0x0e752702": "repayBorrow",
  "0xb6b55f25": "deposit", // deposit(uint256)

  // ── Aave v3 ──
  "0x617ba037": "supply",
  "0x69328dec": "withdraw", // Aave withdraw(address,uint256,address)

  // ── Uniswap v3 SwapRouter ──
  "0x414bf389": "exactInputSingle",
  "0xc04b8d59": "exactInput",
  "0xac9650d8": "multicall",
  "0x49404b7c": "unwrapWETH9",
  // Uniswap v3 NFTPositionManager
  "0x219f5d17": "increaseLiquidity",
  "0x0c49ccbe": "decreaseLiquidity",
  "0xfc6f7865": "collect",
  // Uniswap Universal Router
  "0x3593564c": "execute",

  // ── Sherwood adapters ──
  "0x2506c018": "swap", // ISwapAdapter.swap

  // ── Sherwood strategy lifecycle (BaseStrategy) ──
  "0x61461954": "execute",
  "0x11da60b4": "settle",
  "0xae490287": "onLiveDeposit",

  // ── Sherwood governor lifecycle ──
  "0x4b3ee9ac": "bindProposalAdapter",
  "0x49ceb0bd": "setActiveStrategyAdapter",
  "0x86473bdb": "executeGovernorBatch",
  "0x2473ad34": "settleProposal",
  "0xefafb22e": "voteOnProposal",
  "0x56781388": "castVote",
  "0x5c19a95c": "delegate",

  // ── Common reward / harvest ──
  "0x379607f5": "claim",
  "0xf9f031df": "claimRewards",
};

/**
 * Look up the canonical function name for a 4-byte selector. Returns null
 * when the selector isn't in the registry — callers should fall back to the
 * raw hex string.
 */
export function decodeSelector(selector: string): string | null {
  if (!selector || selector.length < 10) return null;
  const key = selector.slice(0, 10).toLowerCase();
  return KNOWN_SELECTORS[key] ?? null;
}
