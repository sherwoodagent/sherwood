# Contract Addresses

These are also available in `cli/src/lib/addresses.ts` (resolved at runtime based on `--testnet` flag).

> See also: [Deployments reference](https://docs.sherwood.sh/reference/deployments)

## Base Mainnet

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284` |
| SyndicateGovernor | `0x358AD8B492BcC710BE0D7c902D8702164c35DC34` |
| BatchExecutorLib | `0x1E831aB61Dc423bF678a2Ff8d9ce768E1e6D2338` |
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
| SyndicateFactory | `0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069` |
| SyndicateGovernor | `0xE5ecf2B06E3f3e298B632C0cf6575f9d9422F55E` |
| BatchExecutorLib | `0x847758DDb37F1709da5bB3d3F8aC395938e6a84f` |
| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| WETH | `0x4200000000000000000000000000000000000006` |

## Robinhood L2 Testnet

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284` |
| SyndicateGovernor | `0x358AD8B492BcC710BE0D7c902D8702164c35DC34` |
| BatchExecutorLib | `0x1E831aB61Dc423bF678a2Ff8d9ce768E1e6D2338` |
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` |

## EAS (Ethereum Attestation Service)

Base predeploys (same on mainnet and Sepolia):

| Contract | Address |
|----------|---------|
| EAS | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry | `0x4200000000000000000000000000000000000020` |

Schema UIDs are stored in `cli/src/lib/addresses.ts` and differ per network. Register via `cli/scripts/register-eas-schemas.ts`.

## Strategy Templates (Base Mainnet)

ERC-1167 clonable singletons. Use `sherwood strategy list` to see current addresses.

| Template | Address |
|----------|---------|
| MoonwellSupplyStrategy | `0x25E33fAeE061E752fDFe851911ccC4C6D9FBA346` |
| AerodromeLPStrategy | `0x1c61c740702690B86b874ab929A6F04A4Ec56C1c` |
| VeniceInferenceStrategy | `0xd882056ba6b0aEd8908c541884B327121E2f2C9C` |
| WstETHMoonwellStrategy | `0x6d026e2f5Ff0C34A01690EC46Cb601B8fF391985` |

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

### Venice Inference (Strategy Template)

```bash
sherwood vault add-target --target 0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf  # VVV token
sherwood vault add-target --target 0x321b7ff75154472b18edb199033ff4d116f340ff  # VVV Staking (sVVV)
sherwood vault add-target --target 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43  # Aerodrome Router (swap path only)
sherwood vault add-target --target <strategy-clone-address>                      # Your strategy contract
```
