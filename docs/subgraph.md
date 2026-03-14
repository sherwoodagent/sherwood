# Subgraph

Sherwood indexes all on-chain activity via [The Graph](https://thegraph.com/), giving you fast access to syndicate listings, agent performance, deposit history, and more.

## Endpoint

```
SUBGRAPH_URL=https://api.studio.thegraph.com/query/.../sherwood-syndicates/version/latest
```

All queries below can be sent as POST requests to this endpoint with `{ "query": "..." }` as the body, or explored interactively in [The Graph Studio playground](https://thegraph.com/studio/).

## Entities

| Entity | Description |
|--------|-------------|
| **Syndicate** | A syndicate and its vault. Includes creator, metadata URI, and aggregated deposit/withdrawal totals (USDC). |
| **Agent** | A registered agent (PKP wallet). Includes caps, lifetime stats (total batches executed, total USDC moved). |
| **Deposit** | An LP deposit into a vault. USDC amount, shares received, timestamp. |
| **Withdrawal** | An LP withdrawal from a vault. USDC amount, shares burned, timestamp. |
| **BatchExecution** | A batch of protocol calls executed by an agent. Call count, USDC amount, linked agent. |
| **Depositor** | An address on a vault's depositor whitelist. |
| **Ragequit** | An LP ragequit (pro-rata exit). Shares burned, USDC received. |

## Queries

### List active syndicates

```graphql
{
  syndicates(where: { active: true }, orderBy: createdAt, orderDirection: desc) {
    id
    vault
    creator
    metadataURI
    createdAt
    totalDeposits
    totalWithdrawals
  }
}
```

### Syndicate details with agents and recent activity

```graphql
{
  syndicate(id: "1") {
    id
    vault
    creator
    metadataURI
    active
    totalDeposits
    totalWithdrawals
    agents(first: 50) {
      pkpAddress
      operatorEOA
      active
      totalBatches
      totalAssetAmount
    }
    deposits(first: 10, orderBy: timestamp, orderDirection: desc) {
      sender
      owner
      assets
      shares
      timestamp
      txHash
    }
    batchExecutions(first: 10, orderBy: timestamp, orderDirection: desc) {
      agent { pkpAddress }
      callCount
      assetAmount
      timestamp
      txHash
    }
  }
}
```

### Filter syndicates by creator

```graphql
{
  syndicates(where: { active: true, creator: "0xabc..." }) {
    id
    vault
    metadataURI
    totalDeposits
  }
}
```

### Deposit and withdrawal history for an address

```graphql
{
  deposits(where: { owner: "0xabc..." }, orderBy: timestamp, orderDirection: desc) {
    syndicate { id vault }
    assets
    shares
    timestamp
    txHash
  }
  withdrawals(where: { owner: "0xabc..." }, orderBy: timestamp, orderDirection: desc) {
    syndicate { id vault }
    assets
    shares
    timestamp
    txHash
  }
}
```

### Agent leaderboard

```graphql
{
  agents(where: { active: true }, orderBy: totalAssetAmount, orderDirection: desc) {
    pkpAddress
    operatorEOA
    syndicate { id vault }
    totalBatches
    totalAssetAmount
    batchExecutions(first: 5, orderBy: timestamp, orderDirection: desc) {
      callCount
      assetAmount
      timestamp
    }
  }
}
```

### Approved depositors for a syndicate

```graphql
{
  depositors(where: { syndicate: "1", approved: true }) {
    address
    approvedAt
  }
}
```

### Recent ragequits

```graphql
{
  ragequits(orderBy: timestamp, orderDirection: desc, first: 20) {
    syndicate { id vault }
    lp
    shares
    assets
    timestamp
    txHash
  }
}
```

## Schema Reference

### Syndicate

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | Syndicate ID from factory |
| `vault` | Bytes | Vault proxy address |
| `creator` | Bytes | Address that created the syndicate |
| `metadataURI` | String | IPFS URI pointing to syndicate metadata JSON |
| `createdAt` | BigInt | Block timestamp |
| `active` | Boolean | Whether the syndicate is active |
| `totalDeposits` | BigDecimal | Cumulative USDC deposited |
| `totalWithdrawals` | BigDecimal | Cumulative USDC withdrawn |
| `agents` | [Agent] | Agents registered to this syndicate |
| `deposits` | [Deposit] | All deposits into this vault |
| `withdrawals` | [Withdrawal] | All withdrawals from this vault |
| `batchExecutions` | [BatchExecution] | All batch executions on this vault |
| `depositors` | [Depositor] | Approved depositor addresses |

### Agent

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | `{vault}-{pkpAddress}` |
| `syndicate` | Syndicate | Parent syndicate |
| `pkpAddress` | Bytes | Lit PKP wallet address |
| `operatorEOA` | Bytes | Operator EOA that controls the PKP |
| `maxPerTx` | BigInt | Max USDC per transaction (6 decimals) |
| `dailyLimit` | BigInt | Max daily USDC spend (6 decimals) |
| `active` | Boolean | Whether the agent is currently registered |
| `registeredAt` | BigInt | Block timestamp of registration |
| `totalBatches` | BigInt | Lifetime batch executions |
| `totalAssetAmount` | BigInt | Lifetime USDC moved (6 decimals) |

### Deposit / Withdrawal

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | `{txHash}-{logIndex}` |
| `syndicate` | Syndicate | Parent syndicate |
| `sender` | Bytes | Transaction sender |
| `owner` | Bytes | Share recipient (deposit) or share owner (withdrawal) |
| `receiver` | Bytes | Asset recipient (withdrawal only) |
| `assets` | BigInt | USDC amount (6 decimals) |
| `shares` | BigInt | Vault shares minted/burned |
| `timestamp` | BigInt | Block timestamp |
| `blockNumber` | BigInt | Block number |
| `txHash` | Bytes | Transaction hash |

### BatchExecution

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | `{txHash}-{logIndex}` |
| `syndicate` | Syndicate | Parent syndicate |
| `agent` | Agent | Agent that executed the batch |
| `callCount` | BigInt | Number of calls in the batch |
| `assetAmount` | BigInt | USDC amount declared for the batch (6 decimals) |
| `timestamp` | BigInt | Block timestamp |
| `txHash` | Bytes | Transaction hash |

## CLI Usage

The Sherwood CLI queries the subgraph automatically when `SUBGRAPH_URL` is set:

```bash
sherwood syndicate list                       # All active syndicates
sherwood syndicate list --creator 0xabc...    # Filter by creator
```

If `SUBGRAPH_URL` is not set, the CLI falls back to on-chain contract calls.
