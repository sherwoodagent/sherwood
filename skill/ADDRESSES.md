# Contract Addresses

These are also available in `cli/src/lib/addresses.ts` (resolved at runtime based on `--testnet` flag).

> See also: [Deployments reference](https://docs.sherwood.sh/reference/deployments)

## Base Mainnet

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0x4a761D4C101a3aaDE53C7aA2b5c3278b217B6C29` |
| SyndicateGovernor | `0x2F7C27007AC5Bad8400EaDBcdaa767597cfE186a` |
| BatchExecutorLib | `0x4DB19b6F8A0B299fD73c40A72B265cfBCF64664a` |
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
| SyndicateFactory | `0x6d026e2f5Ff0C34A01690EC46Cb601B8fF391985` |
| SyndicateGovernor | `0xd882056ba6b0aEd8908c541884B327121E2f2C9C` |
| BatchExecutorLib | `0x1493f5a7E5d82e1e56c34e2Ba300f56F97186017` |
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| PortfolioStrategy | `0xAe981882923E0C76A7F10E7cAa3782023c0abd9B` |
| SynthraSwapAdapter | `0x39a37537E179919cb2dDDb1D6920dD11bAf3aDF0` |
| SynthraDirectAdapter | `0xdae81cDCfcB14c56fCeB788A147Fcd6CbEdfEeca` |
| Synthra Router | `0x3Ce954107b1A675826B33bF23060Dd655e3758fE` |
| Chainlink Verifier Proxy | `0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64` |

## HyperEVM Mainnet

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0x4085EEa1E6d3D20E84D8Ae14964FAb8b899DA40a` |
| SyndicateGovernor | `0x7B4a2f3480FE101f88b2e3547A1bCf3eaaDE46bc` |
| BatchExecutorLib | `0xdE317B80E66c5E8872C63B0620E2CbB73b5Bcd49` |
| SyndicateVaultImpl | `0x09005FEF3EF1879Af207C79416ae9d5059437bd4` |
| USDC | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 decimals) |
| HyperliquidPerpStrategy | `0x2E97621f49D5b8263E244daB25f177DF739e58a9` |

HyperEVM has no Moonwell, Uniswap, Venice, Aerodrome, ENS, or ERC-8004 — the factory accepts `address(0)` for `ensRegistrar` and `agentRegistry`.

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
| MoonwellSupplyStrategy | `0x649f8d24096a5eb17b8C73ee5113825AcA259F00` |
| AerodromeLPStrategy | `0x6ccdD48C6A83cCdD6712DEB02E85FbEA8CF426CE` |
| VeniceInferenceStrategy | `0x49BFDae8353ba15954924274573D427211CCe41b` |
| WstETHMoonwellStrategy | `0xA31851Ab35F9992b0411749ec02Df053e904D1e6` |
| MamoYieldStrategy | `0x9ca8A9B75a46261F107B610b634ecE69D7E6DF42` |
| PortfolioStrategy | `0x7865eEA4063c22d0F55FdD412D345495c7b73f64` |
| UniswapSwapAdapter | `0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069` |

All clonable strategy singletons expose the `positionValue() → (uint256, bool)` view (shipped in #218). Existing clones deployed before this redeploy lack the view; frontend callers should wrap in try/catch.

## Strategy Templates (Base Sepolia)

| Template | Address |
|----------|---------|
| MoonwellSupplyStrategy | `0xf67107afd786b6CB8829e55634b1686B8Bb7937a` |
| AerodromeLPStrategy | `0xDf45018C64f5d6fd254B5d5437e96A27D5F01D09` |
| VeniceInferenceStrategy | `0xB3E20A505D6e086eaEE02a58C264D41cb746E76E` |
| WstETHMoonwellStrategy | `0x8F75B609519cEC5a9B9DF3cb74BcF095be5Ee2fD` |
| MamoYieldStrategy | `0x49ea76685D79ff41bF7F60e22d9D367d0981bD58` |

## Uniswap Trading API

The `sherwood trade` commands use the hosted Uniswap Trading API (not direct contract calls):

| Resource | Value |
|----------|-------|
| API Base URL | `https://trade-api.gateway.uniswap.org/v1` |
| Developer Portal | https://developers.uniswap.org/ |
| Auth Header | `x-api-key: <your-key>` |
| Router Version Header | `x-universal-router-version: 2.0` |

Configure via: `sherwood config set --uniswap-api-key <key>` or `UNISWAP_API_KEY` env var.

The API routes through Uniswap V2/V3/V4 pools and UniswapX (PRIORITY on Base for MEV protection). No manual pool/fee selection needed.

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
