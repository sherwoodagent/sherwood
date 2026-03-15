/**
 * Minimal contract ABIs for viem type inference.
 * Extracted from contracts/src/ — keep in sync if contracts change.
 */

// ── SyndicateVault (includes batch execution, target management) ──

export const SYNDICATE_VAULT_ABI = [
  // ERC-4626
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  // ERC-20
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // LP
  {
    name: "ragequit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  // Batch execution (via delegatecall to shared executor lib)
  {
    name: "executeBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      { name: "assetAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "simulateBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
    ],
    outputs: [
      {
        name: "results",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
  // Target allowlist
  {
    name: "addTarget",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }],
    outputs: [],
  },
  {
    name: "addTargets",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "targets", type: "address[]" }],
    outputs: [],
  },
  {
    name: "removeTarget",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }],
    outputs: [],
  },
  {
    name: "isAllowedTarget",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "target", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getAllowedTargets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  // Agent management
  {
    name: "registerAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pkpAddress", type: "address" },
      { name: "operatorEOA", type: "address" },
      { name: "maxPerTx", type: "uint256" },
      { name: "dailyLimit", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "removeAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "pkpAddress", type: "address" }],
    outputs: [],
  },
  // Views
  {
    name: "getAgentConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pkpAddress", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "pkpAddress", type: "address" },
          { name: "operatorEOA", type: "address" },
          { name: "maxPerTx", type: "uint256" },
          { name: "dailyLimit", type: "uint256" },
          { name: "spentToday", type: "uint256" },
          { name: "lastResetDay", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "getSyndicateCaps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "maxPerTx", type: "uint256" },
          { name: "maxDailyTotal", type: "uint256" },
          { name: "maxBorrowRatio", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getAgentCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getDailySpendTotal",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pkpAddress", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getExecutorImpl",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "pause",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "unpause",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  // Depositor whitelist
  {
    name: "approveDepositor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [],
  },
  {
    name: "removeDepositor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [],
  },
  {
    name: "approveDepositors",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "depositors", type: "address[]" }],
    outputs: [],
  },
  {
    name: "isApprovedDepositor",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "depositor", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getApprovedDepositors",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "setOpenDeposits",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "open", type: "bool" }],
    outputs: [],
  },
  {
    name: "openDeposits",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  // ERC-4626 views for LP balance
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Uniswap Quoter V2 ──

export const UNISWAP_QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// ── ERC20 ──

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// ── SyndicateFactory ──

export const SYNDICATE_FACTORY_ABI = [
  {
    name: "createSyndicate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "metadataURI", type: "string" },
          { name: "asset", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          {
            name: "caps",
            type: "tuple",
            components: [
              { name: "maxPerTx", type: "uint256" },
              { name: "maxDailyTotal", type: "uint256" },
              { name: "maxBorrowRatio", type: "uint256" },
            ],
          },
          { name: "initialTargets", type: "address[]" },
          { name: "openDeposits", type: "bool" },
        ],
      },
    ],
    outputs: [
      { name: "syndicateId", type: "uint256" },
      { name: "vault", type: "address" },
    ],
  },
  {
    name: "syndicates",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "vault", type: "address" },
      { name: "creator", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "createdAt", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    name: "getActiveSyndicates",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "vault", type: "address" },
          { name: "creator", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "createdAt", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "syndicateCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "vaultToSyndicate",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "updateMetadata",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "syndicateId", type: "uint256" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "deactivate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "syndicateId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "executorImpl",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "vaultImpl",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ── StrategyRegistry ──

export const STRATEGY_REGISTRY_ABI = [
  {
    name: "registerStrategy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "strategyTypeId", type: "uint256" },
      { name: "name", type: "string" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "strategyId", type: "uint256" }],
  },
  {
    name: "getStrategy",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "strategyId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "implementation", type: "address" },
          { name: "creator", type: "address" },
          { name: "strategyTypeId", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "name", type: "string" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    name: "getStrategiesByType",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "strategyTypeId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getStrategiesByCreator",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "strategyCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isStrategyActive",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "strategyId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "deactivateStrategy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "strategyId", type: "uint256" }],
    outputs: [],
  },
] as const;
