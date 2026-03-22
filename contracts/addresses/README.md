# Contract Addresses

Deployed contract addresses organized by chain ID.

## Structure

Each `<chainId>.json` file contains:

- **protocol** — Core protocol contracts (factory, governor, vault implementation)
- **templates** — Strategy template contracts (used as ERC-1167 clone sources)
- **syndicates** — Active syndicates with vault addresses
- **deployer** — Deployer address used for protocol deployments

## Chains

| Chain | File | Network |
|-------|------|---------|
| 8453 | [8453.json](./8453.json) | Base Mainnet |

## Usage

```typescript
import addresses from "./addresses/8453.json";

const factory = addresses.protocol.SyndicateFactory;
const wstethTemplate = addresses.templates.WstETHMoonwellStrategy;
```
