/**
 * Minimal contract ABIs for viem type inference.
 * Extracted from contracts/src/ — keep in sync if contracts change.
 */

// ── SyndicateVault (ERC-4626 + ERC20Votes + governor integration) ──

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
  // Batch execution (owner-only, via delegatecall to shared executor lib)
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
    ],
    outputs: [],
  },
  // Governor-initiated batch execution (governor-only)
  {
    name: "executeGovernorBatch",
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
    outputs: [],
  },
  // Agent management
  {
    name: "registerAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "agentAddress", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "removeAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [],
  },
  // Views
  {
    name: "getAgentConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "agentAddress", type: "address" },
          { name: "active", type: "bool" },
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
    name: "isAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
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
    name: "totalDeposited",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAgentAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
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
  {
    name: "paused",
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
  {
    name: "previewRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "maxRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  // ── Events ──
  {
    name: "AgentRegistered",
    type: "event",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentAddress", type: "address", indexed: true },
    ],
  },
  {
    name: "AgentRemoved",
    type: "event",
    inputs: [{ name: "agentAddress", type: "address", indexed: true }],
  },
  {
    name: "DepositorApproved",
    type: "event",
    inputs: [{ name: "depositor", type: "address", indexed: true }],
  },
  {
    name: "DepositorRemoved",
    type: "event",
    inputs: [{ name: "depositor", type: "address", indexed: true }],
  },
  // Governor integration
  {
    name: "governor",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "redemptionsLocked",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "managementFeeBps",
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
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// ── Uniswap SwapRouter (multi-hop) ──

export const SWAP_ROUTER_ABI = [
  {
    name: "exactInput",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// ── Uniswap SwapRouter (single-hop) ──

export const SWAP_ROUTER_EXACT_INPUT_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
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
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ── SyndicateFactory ──

export const SYNDICATE_FACTORY_ABI = [
  {
    name: "createSyndicate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "creatorAgentId", type: "uint256" },
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "metadataURI", type: "string" },
          { name: "asset", type: "address" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "openDeposits", type: "bool" },
          { name: "subdomain", type: "string" },
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
      { name: "subdomain", type: "string" },
    ],
  },
  {
    name: "getAllActiveSyndicates",
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
          { name: "subdomain", type: "string" },
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
  {
    name: "subdomainToSyndicate",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "subdomain", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isSubdomainAvailable",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "subdomain", type: "string" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "SyndicateCreated",
    type: "event",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "metadataURI", type: "string", indexed: false },
      { name: "subdomain", type: "string", indexed: false },
    ],
  },
] as const;

// ── L2 Registry (Durin ENS — text records) ──

export const L2_REGISTRY_ABI = [
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "string" }],
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

// ── Venice Staking (sVVV = staking contract ERC-20) ──

export const VENICE_STAKING_ABI = [
  {
    name: "stake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "initiateUnstake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "finalizeUnstake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "mintDiem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sVVVAmountToLock", type: "uint256" },
      { name: "minDiemAmountOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "pendingRewards",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "cooldownDuration",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getDiemAmountOut",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "sVVVAmountToLock", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

// ── EAS (Ethereum Attestation Service) ──

export const EAS_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "revoke",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "getAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

// ── SyndicateGovernor ──

export const SYNDICATE_GOVERNOR_ABI = [
  // Proposal lifecycle
  {
    name: "propose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "vault", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "performanceFeeBps", type: "uint256" },
      { name: "strategyDuration", type: "uint256" },
      {
        name: "executeCalls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      {
        name: "settlementCalls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      {
        name: "coProposers",
        type: "tuple[]",
        components: [
          { name: "agent", type: "address" },
          { name: "splitBps", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "proposalId", type: "uint256" }],
  },
  {
    name: "vote",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "executeProposal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "settleProposal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "emergencySettle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
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
    outputs: [],
  },
  {
    name: "cancelProposal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "emergencyCancel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  // Views
  {
    name: "getProposal",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "proposer", type: "address" },
          { name: "vault", type: "address" },
          { name: "metadataURI", type: "string" },
          { name: "performanceFeeBps", type: "uint256" },
          { name: "strategyDuration", type: "uint256" },
          { name: "votesFor", type: "uint256" },
          { name: "votesAgainst", type: "uint256" },
          { name: "votesAbstain", type: "uint256" },
          { name: "snapshotTimestamp", type: "uint256" },
          { name: "voteEnd", type: "uint256" },
          { name: "executeBy", type: "uint256" },
          { name: "executedAt", type: "uint256" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
  {
    name: "getProposalState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "getProposalCalls",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getVoteWeight",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "hasVoted",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "proposalCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getGovernorParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "votingPeriod", type: "uint256" },
          { name: "executionWindow", type: "uint256" },
          { name: "vetoThresholdBps", type: "uint256" },
          { name: "maxPerformanceFeeBps", type: "uint256" },
          { name: "cooldownPeriod", type: "uint256" },
          { name: "collaborationWindow", type: "uint256" },
          { name: "maxCoProposers", type: "uint256" },
          { name: "minStrategyDuration", type: "uint256" },
          { name: "maxStrategyDuration", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getRegisteredVaults",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getActiveProposal",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCooldownEnd",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getCapitalSnapshot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isRegisteredVault",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  // Vault management
  {
    name: "addVault",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [],
  },
  {
    name: "removeVault",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "vault", type: "address" }],
    outputs: [],
  },
  // ── Events ──
  {
    name: "ProposalCreated",
    type: "event",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "proposer", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "performanceFeeBps", type: "uint256", indexed: false },
      { name: "strategyDuration", type: "uint256", indexed: false },
      { name: "executeCallCount", type: "uint256", indexed: false },
      { name: "settlementCallCount", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    name: "VoteCast",
    type: "event",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "voter", type: "address", indexed: true },
      { name: "support", type: "uint8", indexed: false },
      { name: "weight", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ProposalExecuted",
    type: "event",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "capitalSnapshot", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ProposalSettled",
    type: "event",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "pnl", type: "int256", indexed: false },
      { name: "performanceFee", type: "uint256", indexed: false },
      { name: "duration", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ProposalCancelled",
    type: "event",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "cancelledBy", type: "address", indexed: true },
    ],
  },
  // Parameter setters (owner-only)
  {
    name: "setVotingPeriod",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newVotingPeriod", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setExecutionWindow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newExecutionWindow", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setVetoThresholdBps",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newVetoThresholdBps", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setMaxPerformanceFeeBps",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newMaxPerformanceFeeBps", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setMaxStrategyDuration",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newMaxStrategyDuration", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setCooldownPeriod",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newCooldownPeriod", type: "uint256" }],
    outputs: [],
  },
  {
    name: "vetoProposal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setProtocolFeeBps",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "newProtocolFeeBps", type: "uint256" }],
    outputs: [],
  },
  {
    name: "getExecuteCalls",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getSettlementCalls",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
    ],
  },
] as const;

// ── EAS Schema Registry ──

export const SCHEMA_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "Registered",
    type: "event",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "registerer", type: "address", indexed: true },
    ],
  },
] as const;

// ── BaseStrategy (IStrategy + lifecycle views) ──

export const BASE_STRATEGY_ABI = [
  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "vault", type: "address" },
      { name: "proposer", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "settle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "updateParams",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
  },
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "vault",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "proposer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "executed",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "state",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// ── PortfolioStrategy (extends BaseStrategy with rebalancing + views) ──

export const PORTFOLIO_STRATEGY_ABI = [
  // Inherited from BaseStrategy
  ...BASE_STRATEGY_ABI,
  // Rebalancing
  {
    name: "rebalance",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "rebalanceDelta",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "priceReports", type: "bytes[]" }],
    outputs: [],
  },
  // View functions
  {
    name: "getAllocations",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "targetWeightBps", type: "uint256" },
          { name: "tokenAmount", type: "uint256" },
          { name: "investedAmount", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "allocationCount",
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
  {
    name: "totalAmount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxSlippageBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "swapAdapter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getSwapExtraData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes[]" }],
  },
  // Events
  {
    name: "WeightsUpdated",
    type: "event",
    inputs: [
      { name: "tokens", type: "address[]", indexed: false },
      { name: "oldWeights", type: "uint256[]", indexed: false },
      { name: "newWeights", type: "uint256[]", indexed: false },
    ],
  },
  {
    name: "Rebalanced",
    type: "event",
    inputs: [
      { name: "tokens", type: "address[]", indexed: false },
      { name: "oldWeights", type: "uint256[]", indexed: false },
      { name: "newWeights", type: "uint256[]", indexed: false },
      { name: "oldBalances", type: "uint256[]", indexed: false },
      { name: "newBalances", type: "uint256[]", indexed: false },
      { name: "totalAssetValue", type: "uint256", indexed: false },
    ],
  },
  {
    name: "RebalancedDelta",
    type: "event",
    inputs: [
      { name: "tokens", type: "address[]", indexed: false },
      { name: "oldWeights", type: "uint256[]", indexed: false },
      { name: "newWeights", type: "uint256[]", indexed: false },
      { name: "oldBalances", type: "uint256[]", indexed: false },
      { name: "newBalances", type: "uint256[]", indexed: false },
      { name: "totalAssetValue", type: "uint256", indexed: false },
      { name: "swapsExecuted", type: "uint256", indexed: false },
    ],
  },
] as const;

// ── Synthra QuoterV2 (Robinhood testnet — different ABI from Uniswap) ──
// Flat params (not struct), returns only amountOut (not 4-tuple).
// Confirmed by ISynthraQuoter in contracts/src/adapters/SynthraSwapAdapter.sol:33-41.

export const SYNTHRA_QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;
