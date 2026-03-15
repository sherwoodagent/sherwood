# Venice Private Inference — Option B: Batch-Only, Per-Agent sVVV Distribution

> From VENICE-ALLOWANCE-HANDOFF.md — the decentralized approach

## Overview

No separate VeniceStrategy contract. Venice inference is a **batch operation** through the existing executor: vault profits → swap USDC→VVV → stake → distribute sVVV to each agent's wallet. Each agent self-provisions their own Venice API key.

## Architecture

```
Vault (USDC profits)
  │  executeBatch: [swap USDC→WETH→VVV, approve, stake, transfer sVVV to each agent]
  ▼
Agents (each holds sVVV)
  │  Each agent signs Venice validation token (EIP-191)
  │  Each agent generates their own API key
  │  Each agent pays their own inference via DIEM
  ▼
Private inference → trade signals → on-chain execution → more profits
```

## Why NOT a Separate Contract?

- Batch executor already supports arbitrary allowlisted targets — no new Solidity for Venice
- Venice staking contract + Uniswap router just need to be in the vault's target allowlist
- Agent composes the batch off-chain, vault validates targets + limits, executes atomically
- Less code, less surface area, same guarantees

## The Batch (single `executeBatch` call)

```solidity
Call[] memory calls = new Call[](4 + numAgents);

// 1. Swap USDC → VVV via Uniswap (multi-hop: USDC → WETH → VVV)
calls[0] = Call({
    target: UNISWAP_ROUTER,
    value: 0,
    data: abi.encodeCall(ISwapRouter.exactInput, (
        ISwapRouter.ExactInputParams({
            path: abi.encodePacked(USDC, uint24(3000), WETH, uint24(10000), VVV),
            recipient: address(this),   // vault (via delegatecall)
            amountIn: usdcAmount,
            amountOutMinimum: minVVV
        })
    ))
});

// 2. Approve VVV to staking contract
calls[1] = Call({
    target: VVV_TOKEN,
    value: 0,
    data: abi.encodeCall(IERC20.approve, (VENICE_STAKING, vvvAmount))
});

// 3. Stake VVV → sVVV lands in vault
calls[2] = Call({
    target: VENICE_STAKING,
    value: 0,
    data: abi.encodeCall(IVeniceStaking.stake, (vvvAmount))
});

// 4. Transfer sVVV to each agent
uint256 perAgent = sVVVBalance / numAgents;
for (uint i = 0; i < numAgents; i++) {
    calls[3 + i] = Call({
        target: SVVV_TOKEN,
        value: 0,
        data: abi.encodeCall(IERC20.transfer, (agents[i], perAgent))
    });
}
```

All steps execute atomically via delegatecall. If any step fails, entire batch reverts.

## Agent Self-Provisioning (off-chain, per agent)

After receiving sVVV, each agent provisions their own Venice API key:

```typescript
// 1. Get validation token
const { data: { token } } = await fetch(
  'https://api.venice.ai/api/v1/api_keys/generate_web3_key'
).then(r => r.json());

// 2. Sign token with agent wallet (the wallet holding sVVV)
const signature = await wallet.signMessage(token);

// 3. Generate API key
const { apiKey } = await fetch(
  'https://api.venice.ai/api/v1/api_keys/generate_web3_key',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: wallet.address,
      signature,
      token,
      apiKeyType: 'INFERENCE',
      consumptionLimit: { diem: 1 }
    })
  }
).then(r => r.json());

// 4. Store and use
config.set('venice.apiKey', apiKey);
```

**Key constraint**: The wallet holding sVVV MUST sign. Venice doesn't support EIP-1271 (contract signatures). This is why agents must hold their own sVVV — the vault (a contract) cannot provision keys.

## Vault Changes Required

Two additions to SyndicateVault.sol:

### 1. Track total deposited (for profit calculation)

```solidity
uint256 public totalDeposited;

function deposit(uint256 assets, address receiver) public override returns (uint256) {
    totalDeposited += assets;
    return super.deposit(assets, receiver);
}

function withdraw(uint256 assets, address receiver, address _owner) public override returns (uint256) {
    totalDeposited -= assets;
    return super.withdraw(assets, receiver, _owner);
}
```

### 2. Return all registered agent operator addresses

```solidity
function getAgentOperators() external view returns (address[] memory) {
    uint256 len = _agentSet.length();
    address[] memory operators = new address[](len);
    for (uint256 i = 0; i < len; i++) {
        operators[i] = _agents[_agentSet.at(i)].operatorEOA;
    }
    return operators;
}
```

## CLI Commands

```bash
sherwood venice fund --amount 50e6     # take 50 USDC profit → VVV → stake → distribute sVVV
sherwood venice status                 # show sVVV balances per agent, DIEM earned
sherwood venice provision              # agent self-provisions Venice API key (sign + POST)
```

## On-Chain Addresses

- VVV token (Base): `0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf`
- Venice Staking: `0x321b7ff75154472b18edb199033ff4d116f340ff`
- sVVV token: TBD (verify on BaseScan — may be same as staking contract or separate)
- Uniswap SwapRouter (Base): `0x2626664c2603336E57B271c5C0b26F421741e481`
- USDC (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- Swap path: USDC → WETH → VVV (multi-hop)

## Pros

- No new Solidity contract for Venice (just batch executor)
- Each agent is sovereign — holds their own sVVV, provisions their own key
- Decentralized: no single point of failure for key management
- Less code, less attack surface

## Cons

- Agents receive sVVV to their wallets — they could sell it
- Vault loses control of VVV once distributed
- Each agent must independently provision (more steps per agent)
- Needs vault contract changes (totalDeposited, getAgentOperators)

## Also: AllowanceStrategy (Separate Contract)

The handoff doc also includes AllowanceStrategy — a separate contract for disbursing USDC profits to agent wallets for operational expenses (x402 research, etc.). See `docs/venice-inference-option-a.md` or the full handoff for details. This may be built as a companion feature or a separate PR.
