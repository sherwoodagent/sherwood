/**
 * Contract addresses by network.
 *
 * All exports are functions — they resolve at call time based on the
 * current network set via setNetwork(). This ensures --chain works
 * even when modules are imported before the flag is parsed.
 *
 * Zero addresses = protocol not deployed on that chain. Strategies that
 * need them will fail at execution time with a clear allowlist error.
 */

import type { Address } from "viem";
import { type Network, getNetwork } from "./network.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// ── Base Mainnet ──

const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  WETH: "0x4200000000000000000000000000000000000006" as Address,
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Address,
  wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address,
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address,
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address,
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as Address,
} as const;

const BASE_MOONWELL = {
  COMPTROLLER: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as Address,
  mUSDC: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22" as Address,
  mWETH: "0x628ff693426583D9a7FB391E54366292F509D457" as Address,
  mCbETH: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5" as Address,
  mWstETH: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b" as Address,
  mCbBTC: "0xF877ACaFA28c19b96727966690b2f44d35aD5976" as Address,
  mDAI: "0x73b06D8d18De422E269645eaCe15400DE7462417" as Address,
  mAERO: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6" as Address,
} as const;

const BASE_UNISWAP = {
  SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address,
  SWAP_ADAPTER: "0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069" as Address,
} as const;

const BASE_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;

// ── Base Sepolia ──

const BASE_SEPOLIA_TOKENS = {
  USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, // Circle test USDC
  WETH: "0x4200000000000000000000000000000000000006" as Address, // Canonical bridged WETH
  cbETH: ZERO,
  wstETH: ZERO,
  cbBTC: ZERO,
  DAI: ZERO,
  AERO: ZERO,
} as const;

const BASE_SEPOLIA_MOONWELL = {
  COMPTROLLER: ZERO,
  mUSDC: ZERO,
  mWETH: ZERO,
  mCbETH: ZERO,
  mWstETH: ZERO,
  mCbBTC: ZERO,
  mDAI: ZERO,
  mAERO: ZERO,
} as const;

const BASE_SEPOLIA_UNISWAP = {
  SWAP_ROUTER: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address, // Uniswap V3 SwapRouter02
  QUOTER_V2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as Address, // Uniswap V3 QuoterV2
  SWAP_ADAPTER: ZERO as Address,
} as const;

const BASE_SEPOLIA_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address, // Deterministic, same everywhere
} as const;

// ── Robinhood L2 Testnet (Arbitrum Orbit, chain 46630) ──
// Synthra DEX for swaps. Stock tokens available.

const ROBINHOOD_TESTNET_TOKENS = {
  USDC: ZERO,
  WETH: "0x7943e237c7F95DA44E0301572D358911207852Fa" as Address,
  cbETH: ZERO,
  wstETH: ZERO,
  cbBTC: ZERO,
  DAI: ZERO,
  AERO: ZERO,
  TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as Address,
  AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" as Address,
  PLTR: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0" as Address,
  NFLX: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93" as Address,
  AMD: "0x71178BAc73cBeb415514eB542a8995b82669778d" as Address,
} as const;

const ROBINHOOD_TESTNET_MOONWELL = {
  COMPTROLLER: ZERO,
  mUSDC: ZERO,
  mWETH: ZERO,
  mCbETH: ZERO,
  mWstETH: ZERO,
  mCbBTC: ZERO,
  mDAI: ZERO,
  mAERO: ZERO,
} as const;

const ROBINHOOD_TESTNET_UNISWAP = {
  SWAP_ROUTER: ZERO,
  QUOTER_V2: ZERO,
  SWAP_ADAPTER: ZERO as Address,
} as const;

// ── Synthra DEX (Robinhood L2 — Uniswap V3-compatible concentrated liquidity) ──

const BASE_SYNTHRA = { ROUTER: ZERO, QUOTER: ZERO, FACTORY: ZERO } as const;
const BASE_SEPOLIA_SYNTHRA = { ROUTER: ZERO, QUOTER: ZERO, FACTORY: ZERO } as const;
const ROBINHOOD_TESTNET_SYNTHRA = {
  ROUTER: "0x3Ce954107b1A675826B33bF23060Dd655e3758fE" as Address,
  QUOTER: "0x231606c321A99DE81e28fE48B07a93F1ba49e713" as Address,
  FACTORY: "0x911b4000D3422F482F4062a913885f7b035382Df" as Address,
} as const;

// ── Chainlink (Data Streams verifier proxy) ──

const BASE_CHAINLINK = { VERIFIER_PROXY: "0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a" as Address } as const;
const BASE_SEPOLIA_CHAINLINK = { VERIFIER_PROXY: ZERO } as const;
const ROBINHOOD_TESTNET_CHAINLINK = {
  VERIFIER_PROXY: "0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64" as Address,
} as const;

const ROBINHOOD_TESTNET_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address, // Deterministic, same everywhere
} as const;

// ── HyperEVM (chain 999) ──
// No Moonwell, no Uniswap, no Venice, no ENS/Durin, no ERC-8004, no EAS.
// USDC: native USDC on HyperEVM.

const HYPEREVM_TOKENS = {
  USDC: "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as Address,
  WETH: ZERO,
  cbETH: ZERO,
  wstETH: ZERO,
  cbBTC: ZERO,
  DAI: ZERO,
  AERO: ZERO,
} as const;

const HYPEREVM_TESTNET_TOKENS = {
  USDC: ZERO,
  WETH: ZERO,
  cbETH: ZERO,
  wstETH: ZERO,
  cbBTC: ZERO,
  DAI: ZERO,
  AERO: ZERO,
} as const;

const HYPEREVM_MOONWELL = {
  COMPTROLLER: ZERO, mUSDC: ZERO, mWETH: ZERO, mCbETH: ZERO,
  mWstETH: ZERO, mCbBTC: ZERO, mDAI: ZERO, mAERO: ZERO,
} as const;

const HYPEREVM_UNISWAP = { SWAP_ROUTER: ZERO, QUOTER_V2: ZERO, SWAP_ADAPTER: ZERO as Address } as const;

const HYPEREVM_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;

// ── ENS / Durin ──

const BASE_ENS = {
  L2_REGISTRAR: "0x866996c808E6244216a3d0df15464FCF5d495394" as Address,
  L2_REGISTRY: "0x7a019ce699e27b0ad1e5b51344a58116b9f3b9b1" as Address,
} as const;

const BASE_SEPOLIA_ENS = {
  L2_REGISTRAR: "0x1fCbe9dFC25e3fa3F7C55b26c7992684A4758b47" as Address,
  L2_REGISTRY: "0x06eb7b85b59bc3e50fe4837be776cdd26de602cf" as Address,
} as const;

const ROBINHOOD_TESTNET_ENS = {
  L2_REGISTRAR: ZERO,
  L2_REGISTRY: ZERO,
} as const;

const HYPEREVM_ENS = { L2_REGISTRAR: ZERO, L2_REGISTRY: ZERO } as const;

// ── ERC-8004 Agent Identity ──

const BASE_AGENT_REGISTRY = {
  IDENTITY_REGISTRY: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  REPUTATION_REGISTRY:
    "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
} as const;

const BASE_SEPOLIA_AGENT_REGISTRY = {
  IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  REPUTATION_REGISTRY:
    "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
} as const;

const ROBINHOOD_TESTNET_AGENT_REGISTRY = {
  IDENTITY_REGISTRY: ZERO,
  REPUTATION_REGISTRY: ZERO,
} as const;

const HYPEREVM_AGENT_REGISTRY = { IDENTITY_REGISTRY: ZERO, REPUTATION_REGISTRY: ZERO } as const;

// ── Sherwood Protocol (our deployed contracts) ──

// V1.5: per-network Sherwood entries now include GUARDIAN_REGISTRY + WOOD_TOKEN +
// MERKL_DISTRIBUTOR. ZERO == not-yet-deployed on that network.
const BASE_SHERWOOD = {
  FACTORY: "0x4a761D4C101a3aaDE53C7aA2b5c3278b217B6C29" as Address,
  GOVERNOR: "0x2F7C27007AC5Bad8400EaDBcdaa767597cfE186a" as Address,
  GUARDIAN_REGISTRY: ZERO,
  WOOD_TOKEN: ZERO,
  // Merkl mainnet distributor — Angle Labs:
  // https://docs.merkl.xyz/merkl-for-providers/merkl-technical-documentation/addresses
  MERKL_DISTRIBUTOR: "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae" as Address,
} as const;

const BASE_SEPOLIA_SHERWOOD = {
  FACTORY: "0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069" as Address,
  GOVERNOR: "0xE5ecf2B06E3f3e298B632C0cf6575f9d9422F55E" as Address,
  GUARDIAN_REGISTRY: ZERO,
  WOOD_TOKEN: ZERO,
  MERKL_DISTRIBUTOR: ZERO,
} as const;

const ROBINHOOD_TESTNET_SHERWOOD = {
  FACTORY: "0x6d026e2f5Ff0C34A01690EC46Cb601B8fF391985" as Address,
  GOVERNOR: "0xd882056ba6b0aEd8908c541884B327121E2f2C9C" as Address,
  GUARDIAN_REGISTRY: ZERO,
  WOOD_TOKEN: ZERO,
  MERKL_DISTRIBUTOR: ZERO,
} as const;

const HYPEREVM_SHERWOOD = {
  FACTORY: "0x4085EEa1E6d3D20E84D8Ae14964FAb8b899DA40a" as Address,
  GOVERNOR: "0x7B4a2f3480FE101f88b2e3547A1bCf3eaaDE46bc" as Address,
  GUARDIAN_REGISTRY: ZERO,
  WOOD_TOKEN: ZERO,
  MERKL_DISTRIBUTOR: ZERO,
} as const;

// ── Venice (VVV governance + sVVV staking + DIEM compute) ──

const BASE_VENICE = {
  VVV: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf" as Address,
  STAKING: "0x321b7ff75154472b18edb199033ff4d116f340ff" as Address, // also the sVVV ERC-20
  DIEM: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024" as Address,
} as const;

const BASE_SEPOLIA_VENICE = {
  VVV: ZERO,
  STAKING: ZERO,
  DIEM: ZERO,
} as const;

const ROBINHOOD_TESTNET_VENICE = {
  VVV: ZERO,
  STAKING: ZERO,
  DIEM: ZERO,
} as const;

const HYPEREVM_VENICE = { VVV: ZERO, STAKING: ZERO, DIEM: ZERO } as const;

// ── Aerodrome (Base ve(3,3) DEX) ──

const BASE_AERODROME = {
  ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,
  FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
} as const;

const BASE_SEPOLIA_AERODROME = {
  ROUTER: ZERO,
  FACTORY: ZERO,
} as const;

const ROBINHOOD_TESTNET_AERODROME = {
  ROUTER: ZERO,
  FACTORY: ZERO,
} as const;

const HYPEREVM_AERODROME = { ROUTER: ZERO, FACTORY: ZERO } as const;

// ── Strategy Templates (ERC-1167 clonable singletons) ──
// Populated after running script/DeployTemplates.s.sol

const BASE_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: "0x649f8d24096a5eb17b8C73ee5113825AcA259F00" as Address,
  AERODROME_LP: "0x6ccdD48C6A83cCdD6712DEB02E85FbEA8CF426CE" as Address,
  VENICE_INFERENCE: "0x49BFDae8353ba15954924274573D427211CCe41b" as Address,
  WSTETH_MOONWELL: "0xA31851Ab35F9992b0411749ec02Df053e904D1e6" as Address,
  MAMO_YIELD: "0x9ca8A9B75a46261F107B610b634ecE69D7E6DF42" as Address,
  HYPERLIQUID_PERP: ZERO as Address,
  PORTFOLIO: "0x7865eEA4063c22d0F55FdD412D345495c7b73f64" as Address,
} as const;

const BASE_SEPOLIA_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: "0xf67107afd786b6CB8829e55634b1686B8Bb7937a" as Address,
  AERODROME_LP: "0xDf45018C64f5d6fd254B5d5437e96A27D5F01D09" as Address,
  VENICE_INFERENCE: "0xB3E20A505D6e086eaEE02a58C264D41cb746E76E" as Address,
  WSTETH_MOONWELL: "0x8F75B609519cEC5a9B9DF3cb74BcF095be5Ee2fD" as Address,
  MAMO_YIELD: "0x49ea76685D79ff41bF7F60e22d9D367d0981bD58" as Address,
  HYPERLIQUID_PERP: ZERO as Address,
  PORTFOLIO: ZERO as Address,
} as const;

const ROBINHOOD_TESTNET_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: ZERO as Address,
  AERODROME_LP: ZERO as Address,
  VENICE_INFERENCE: ZERO as Address,
  WSTETH_MOONWELL: ZERO as Address,
  MAMO_YIELD: ZERO as Address,
  HYPERLIQUID_PERP: ZERO as Address,
  PORTFOLIO: "0xAe981882923E0C76A7F10E7cAa3782023c0abd9B" as Address,
} as const;

const HYPEREVM_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: ZERO as Address,
  AERODROME_LP: ZERO as Address,
  VENICE_INFERENCE: ZERO as Address,
  WSTETH_MOONWELL: ZERO as Address,
  MAMO_YIELD: ZERO as Address,
  HYPERLIQUID_PERP: "0x2E97621f49D5b8263E244daB25f177DF739e58a9" as Address,
  PORTFOLIO: ZERO as Address,
} as const;

// ── EAS (Ethereum Attestation Service) — Base predeploys ──

const BASE_EAS = {
  EAS: "0x4200000000000000000000000000000000000021" as Address,
  SCHEMA_REGISTRY: "0x4200000000000000000000000000000000000020" as Address,
} as const;

const BASE_SEPOLIA_EAS = {
  EAS: "0x4200000000000000000000000000000000000021" as Address,
  SCHEMA_REGISTRY: "0x4200000000000000000000000000000000000020" as Address,
} as const;

const ROBINHOOD_TESTNET_EAS = {
  EAS: ZERO,
  SCHEMA_REGISTRY: ZERO,
} as const;

const HYPEREVM_EAS = { EAS: ZERO, SCHEMA_REGISTRY: ZERO } as const;

// ── EAS Schema UIDs (populated after running scripts/register-eas-schemas.ts) ──

const BASE_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST:
    "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef" as `0x${string}`,
  AGENT_APPROVED:
    "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607" as `0x${string}`,
  X402_RESEARCH:
    "0x86c67f0a59acb3093ecbeb6c4d1d4352e4a48143672e92ef9dd2fdfc8a9ca708" as `0x${string}`,
  VENICE_PROVISION:
    "0x76d4d6baa72307826cd2fd4ce069bb42ee54cdda6ed6ab208c8d233c893fb7f1" as `0x${string}`,
  VENICE_INFERENCE:
    "0xf9b4e530f3016c19439b67372a1c213c9339857627fb817032614b97433a2a14" as `0x${string}`,
  TRADE_EXECUTED:
    "0x06bb488363a468f7f857ddc8cfffe918d048b8746a0d59eca9cd7f58dbdb4af6" as `0x${string}`,
} as const;

const BASE_SEPOLIA_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST:
    "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef" as `0x${string}`,
  AGENT_APPROVED:
    "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607" as `0x${string}`,
  X402_RESEARCH:
    "0x86c67f0a59acb3093ecbeb6c4d1d4352e4a48143672e92ef9dd2fdfc8a9ca708" as `0x${string}`,
  VENICE_PROVISION:
    "0x76d4d6baa72307826cd2fd4ce069bb42ee54cdda6ed6ab208c8d233c893fb7f1" as `0x${string}`,
  VENICE_INFERENCE:
    "0xf9b4e530f3016c19439b67372a1c213c9339857627fb817032614b97433a2a14" as `0x${string}`,
  TRADE_EXECUTED:
    "0x06bb488363a468f7f857ddc8cfffe918d048b8746a0d59eca9cd7f58dbdb4af6" as `0x${string}`,
} as const;

const ROBINHOOD_TESTNET_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST: ZERO_BYTES32,
  AGENT_APPROVED: ZERO_BYTES32,
  X402_RESEARCH: ZERO_BYTES32,
  VENICE_PROVISION: ZERO_BYTES32,
  VENICE_INFERENCE: ZERO_BYTES32,
  TRADE_EXECUTED: ZERO_BYTES32,
} as const;

const HYPEREVM_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST: ZERO_BYTES32, AGENT_APPROVED: ZERO_BYTES32,
  X402_RESEARCH: ZERO_BYTES32, VENICE_PROVISION: ZERO_BYTES32,
  VENICE_INFERENCE: ZERO_BYTES32, TRADE_EXECUTED: ZERO_BYTES32,
} as const;

// ── Registries (map-based lookup) ──

const TOKEN_REGISTRY: Record<Network, typeof BASE_TOKENS> = {
  base: BASE_TOKENS,
  "base-sepolia": BASE_SEPOLIA_TOKENS,
  "robinhood-testnet": ROBINHOOD_TESTNET_TOKENS,
  hyperevm: HYPEREVM_TOKENS,
  "hyperevm-testnet": HYPEREVM_TESTNET_TOKENS,
};

const MOONWELL_REGISTRY: Record<Network, typeof BASE_MOONWELL> = {
  base: BASE_MOONWELL,
  "base-sepolia": BASE_SEPOLIA_MOONWELL,
  "robinhood-testnet": ROBINHOOD_TESTNET_MOONWELL,
  hyperevm: HYPEREVM_MOONWELL,
  "hyperevm-testnet": HYPEREVM_MOONWELL,
};

const UNISWAP_REGISTRY: Record<Network, typeof BASE_UNISWAP> = {
  base: BASE_UNISWAP,
  "base-sepolia": BASE_SEPOLIA_UNISWAP,
  "robinhood-testnet": ROBINHOOD_TESTNET_UNISWAP,
  hyperevm: HYPEREVM_UNISWAP,
  "hyperevm-testnet": HYPEREVM_UNISWAP,
};

const INFRA_REGISTRY: Record<Network, typeof BASE_INFRA> = {
  base: BASE_INFRA,
  "base-sepolia": BASE_SEPOLIA_INFRA,
  "robinhood-testnet": ROBINHOOD_TESTNET_INFRA,
  hyperevm: HYPEREVM_INFRA,
  "hyperevm-testnet": HYPEREVM_INFRA,
};

const ENS_REGISTRY: Record<Network, typeof BASE_ENS> = {
  base: BASE_ENS,
  "base-sepolia": BASE_SEPOLIA_ENS,
  "robinhood-testnet": ROBINHOOD_TESTNET_ENS,
  hyperevm: HYPEREVM_ENS,
  "hyperevm-testnet": HYPEREVM_ENS,
};

const AGENT_REGISTRY_MAP: Record<Network, typeof BASE_AGENT_REGISTRY> = {
  base: BASE_AGENT_REGISTRY,
  "base-sepolia": BASE_SEPOLIA_AGENT_REGISTRY,
  "robinhood-testnet": ROBINHOOD_TESTNET_AGENT_REGISTRY,
  hyperevm: HYPEREVM_AGENT_REGISTRY,
  "hyperevm-testnet": HYPEREVM_AGENT_REGISTRY,
};

const SHERWOOD_REGISTRY: Record<Network, typeof BASE_SHERWOOD> = {
  base: BASE_SHERWOOD,
  "base-sepolia": BASE_SEPOLIA_SHERWOOD,
  "robinhood-testnet": ROBINHOOD_TESTNET_SHERWOOD,
  hyperevm: HYPEREVM_SHERWOOD,
  "hyperevm-testnet": HYPEREVM_SHERWOOD,
};

const VENICE_REGISTRY: Record<Network, typeof BASE_VENICE> = {
  base: BASE_VENICE,
  "base-sepolia": BASE_SEPOLIA_VENICE,
  "robinhood-testnet": ROBINHOOD_TESTNET_VENICE,
  hyperevm: HYPEREVM_VENICE,
  "hyperevm-testnet": HYPEREVM_VENICE,
};

const AERODROME_REGISTRY: Record<Network, typeof BASE_AERODROME> = {
  base: BASE_AERODROME,
  "base-sepolia": BASE_SEPOLIA_AERODROME,
  "robinhood-testnet": ROBINHOOD_TESTNET_AERODROME,
  hyperevm: HYPEREVM_AERODROME,
  "hyperevm-testnet": HYPEREVM_AERODROME,
};

const STRATEGY_TEMPLATE_REGISTRY: Record<Network, typeof BASE_STRATEGY_TEMPLATES> = {
  base: BASE_STRATEGY_TEMPLATES,
  "base-sepolia": BASE_SEPOLIA_STRATEGY_TEMPLATES,
  "robinhood-testnet": ROBINHOOD_TESTNET_STRATEGY_TEMPLATES,
  hyperevm: HYPEREVM_STRATEGY_TEMPLATES,
  "hyperevm-testnet": HYPEREVM_STRATEGY_TEMPLATES,
};

const HYPEREVM_SYNTHRA = { ROUTER: ZERO, QUOTER: ZERO, FACTORY: ZERO } as const;
const HYPEREVM_CHAINLINK = { VERIFIER_PROXY: ZERO } as const;

const SYNTHRA_REGISTRY: Record<Network, typeof BASE_SYNTHRA> = {
  base: BASE_SYNTHRA,
  "base-sepolia": BASE_SEPOLIA_SYNTHRA,
  "robinhood-testnet": ROBINHOOD_TESTNET_SYNTHRA,
  hyperevm: HYPEREVM_SYNTHRA,
  "hyperevm-testnet": HYPEREVM_SYNTHRA,
};

const CHAINLINK_REGISTRY: Record<Network, typeof BASE_CHAINLINK> = {
  base: BASE_CHAINLINK,
  "base-sepolia": BASE_SEPOLIA_CHAINLINK,
  "robinhood-testnet": ROBINHOOD_TESTNET_CHAINLINK,
  hyperevm: HYPEREVM_CHAINLINK,
  "hyperevm-testnet": HYPEREVM_CHAINLINK,
};

const EAS_CONTRACT_REGISTRY: Record<Network, typeof BASE_EAS> = {
  base: BASE_EAS,
  "base-sepolia": BASE_SEPOLIA_EAS,
  "robinhood-testnet": ROBINHOOD_TESTNET_EAS,
  hyperevm: HYPEREVM_EAS,
  "hyperevm-testnet": HYPEREVM_EAS,
};

const EAS_SCHEMA_REGISTRY: Record<Network, typeof BASE_EAS_SCHEMAS> = {
  base: BASE_EAS_SCHEMAS,
  "base-sepolia": BASE_SEPOLIA_EAS_SCHEMAS,
  "robinhood-testnet": ROBINHOOD_TESTNET_EAS_SCHEMAS,
  hyperevm: HYPEREVM_EAS_SCHEMAS,
  "hyperevm-testnet": HYPEREVM_EAS_SCHEMAS,
};

// ── Exports (functions, resolved at call time) ──

export function TOKENS() {
  return TOKEN_REGISTRY[getNetwork()];
}

export function MOONWELL() {
  return MOONWELL_REGISTRY[getNetwork()];
}

export function UNISWAP() {
  return UNISWAP_REGISTRY[getNetwork()];
}

export function INFRA() {
  return INFRA_REGISTRY[getNetwork()];
}

export function ENS() {
  return ENS_REGISTRY[getNetwork()];
}

export function AGENT_REGISTRY() {
  return AGENT_REGISTRY_MAP[getNetwork()];
}

export function VENICE() {
  return VENICE_REGISTRY[getNetwork()];
}

export function SHERWOOD() {
  return SHERWOOD_REGISTRY[getNetwork()];
}

export function AERODROME() {
  return AERODROME_REGISTRY[getNetwork()];
}

export function STRATEGY_TEMPLATES() {
  return STRATEGY_TEMPLATE_REGISTRY[getNetwork()];
}

export function EAS_CONTRACTS() {
  return EAS_CONTRACT_REGISTRY[getNetwork()];
}

export function EAS_SCHEMAS() {
  return EAS_SCHEMA_REGISTRY[getNetwork()];
}

export function SYNTHRA() {
  return SYNTHRA_REGISTRY[getNetwork()];
}

export function CHAINLINK() {
  return CHAINLINK_REGISTRY[getNetwork()];
}
