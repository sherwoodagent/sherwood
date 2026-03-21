# Contract Addresses

These are also available in `cli/src/lib/addresses.ts` (resolved at runtime based on `--testnet` flag).

> See also: [Deployments reference](https://docs.sherwood.sh/reference/deployments)

## Base Mainnet

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| Moonwell mWETH | `0x628ff693426583D9a7FB391E54366292F509D457` |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Aerodrome Default Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| AERO Token | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| Uniswap SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| VVV | `0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf` |
| VVV Staking (sVVV) | `0x321b7ff75154472b18edb199033ff4d116f340ff` |

## Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0x2efD194ADb3Db40E0e6faAe06c4e602c7a3D9199` |
| SyndicateGovernor | `0x6fc67a9aD15eD3A9DE25c29CCe10D662079129E2` |
| BatchExecutorLib | `0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284` |
| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| WETH | `0x4200000000000000000000000000000000000006` |

## Robinhood L2 Testnet

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0x72981ce06d9c183953F6a8Cc587a8C28C785670e` |
| SyndicateGovernor | `0x7E1F71A72a88Ce8418cf82CACDE9ce5Bbbcf5772` |
| BatchExecutorLib | `0xfb5d298e13D79aa5960F4c6233348b86b3B23e99` |
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` |

## EAS (Ethereum Attestation Service)

Base predeploys (same on mainnet and Sepolia):

| Contract | Address |
|----------|---------|
| EAS | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry | `0x4200000000000000000000000000000000000020` |

Schema UIDs are stored in `cli/src/lib/addresses.ts` and differ per network. Register via `cli/scripts/register-eas-schemas.ts`.

## Allowlist Targets by Strategy

### Levered Swap (Moonwell + Uniswap)

```bash
sherwood vault add-target --target 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # USDC
sherwood vault add-target --target 0x4200000000000000000000000000000000000006  # WETH
sherwood vault add-target --target 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22  # Moonwell mUSDC
sherwood vault add-target --target 0x628ff693426583D9a7FB391E54366292F509D457  # Moonwell mWETH
sherwood vault add-target --target 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C  # Moonwell Comptroller
sherwood vault add-target --target 0x2626664c2603336E57B271c5C0b26F421741e481  # Uniswap SwapRouter
```

### Aerodrome LP (Strategy Template)

```bash
sherwood vault add-target --target 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43  # Aerodrome Router
sherwood vault add-target --target 0x940181a94A35A4569E4529A3CDfB74e38FD98631  # AERO Token
sherwood vault add-target --target <strategy-clone-address>                      # Your strategy contract
sherwood vault add-target --target <gauge-address>                               # Pool-specific gauge
sherwood vault add-target --target <lp-token-address>                            # Pool LP token
```

### Moonwell Supply (Strategy Template)

```bash
sherwood vault add-target --target 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22  # Moonwell mUSDC
sherwood vault add-target --target 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # USDC
sherwood vault add-target --target <strategy-clone-address>                      # Your strategy contract
```

### Venice Funding (VVV Staking)

```bash
sherwood vault add-target --target 0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf  # VVV token
sherwood vault add-target --target 0x321b7ff75154472b18edb199033ff4d116f340ff  # VVV Staking (sVVV)
```
