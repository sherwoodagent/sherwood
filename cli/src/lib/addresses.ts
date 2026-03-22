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
} as const;

const BASE_SEPOLIA_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address, // Deterministic, same everywhere
} as const;

// ── Robinhood L2 Testnet (Arbitrum Orbit, chain 46630) ──
// No Moonwell, no Uniswap, no Venice, no ENS/Durin, no ERC-8004, no EAS.
// USDC: Circle testnet, WETH: canonical bridged.

const ROBINHOOD_TESTNET_TOKENS = {
  USDC: ZERO, // no Circle USDC on Robinhood L2
  WETH: "0x7943e237c7F95DA44E0301572D358911207852Fa" as Address,
  cbETH: ZERO,
  wstETH: ZERO,
  cbBTC: ZERO,
  DAI: ZERO,
  AERO: ZERO,
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
} as const;

const ROBINHOOD_TESTNET_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address, // Deterministic, same everywhere
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

// ── Sherwood Protocol (our deployed contracts) ──

const BASE_SHERWOOD = {
  FACTORY: "0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284" as Address,
  GOVERNOR: "0x358AD8B492BcC710BE0D7c902D8702164c35DC34" as Address,
} as const;

const BASE_SEPOLIA_SHERWOOD = {
  FACTORY: "0x121AaC2B96Ec365e457fcCc1C2ED5a6142064069" as Address,
  GOVERNOR: "0xE5ecf2B06E3f3e298B632C0cf6575f9d9422F55E" as Address,
} as const;

const ROBINHOOD_TESTNET_SHERWOOD = {
  FACTORY: "0xd5C4eE2E4c5B606b9401E69A3B3FeE169037C284" as Address,
  GOVERNOR: "0x358AD8B492BcC710BE0D7c902D8702164c35DC34" as Address,
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

// ── Strategy Templates (ERC-1167 clonable singletons) ──
// Populated after running script/DeployTemplates.s.sol

const BASE_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: "0x25E33fAeE061E752fDFe851911ccC4C6D9FBA346" as Address,
  AERODROME_LP: "0x1c61c740702690B86b874ab929A6F04A4Ec56C1c" as Address,
  VENICE_INFERENCE: "0xd882056ba6b0aEd8908c541884B327121E2f2C9C" as Address,
  WSTETH_MOONWELL: "0x3e9aFad2DAAD410F9aeF997ebeE6cE9c46D63163" as Address,
} as const;

const BASE_SEPOLIA_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: ZERO as Address,
  AERODROME_LP: ZERO as Address,
  VENICE_INFERENCE: ZERO as Address,
  WSTETH_MOONWELL: ZERO as Address,
} as const;

const ROBINHOOD_TESTNET_STRATEGY_TEMPLATES = {
  MOONWELL_SUPPLY: ZERO as Address,
  AERODROME_LP: ZERO as Address,
  VENICE_INFERENCE: ZERO as Address,
  WSTETH_MOONWELL: ZERO as Address,
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

// ── EAS Schema UIDs (populated after running scripts/register-eas-schemas.ts) ──

const BASE_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST:
    "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef" as `0x${string}`,
  AGENT_APPROVED:
    "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607" as `0x${string}`,
  X402_RESEARCH:
    "0x86c67f0a59acb3093ecbeb6c4d1d4352e4a48143672e92ef9dd2fdfc8a9ca708" as `0x${string}`,
} as const;

const BASE_SEPOLIA_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST:
    "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef" as `0x${string}`,
  AGENT_APPROVED:
    "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607" as `0x${string}`,
  X402_RESEARCH:
    "0x86c67f0a59acb3093ecbeb6c4d1d4352e4a48143672e92ef9dd2fdfc8a9ca708" as `0x${string}`,
} as const;

const ROBINHOOD_TESTNET_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST: ZERO_BYTES32,
  AGENT_APPROVED: ZERO_BYTES32,
  X402_RESEARCH: ZERO_BYTES32,
} as const;

// ── Registries (map-based lookup) ──

const TOKEN_REGISTRY: Record<Network, typeof BASE_TOKENS> = {
  base: BASE_TOKENS,
  "base-sepolia": BASE_SEPOLIA_TOKENS,
  "robinhood-testnet": ROBINHOOD_TESTNET_TOKENS,
};

const MOONWELL_REGISTRY: Record<Network, typeof BASE_MOONWELL> = {
  base: BASE_MOONWELL,
  "base-sepolia": BASE_SEPOLIA_MOONWELL,
  "robinhood-testnet": ROBINHOOD_TESTNET_MOONWELL,
};

const UNISWAP_REGISTRY: Record<Network, typeof BASE_UNISWAP> = {
  base: BASE_UNISWAP,
  "base-sepolia": BASE_SEPOLIA_UNISWAP,
  "robinhood-testnet": ROBINHOOD_TESTNET_UNISWAP,
};

const INFRA_REGISTRY: Record<Network, typeof BASE_INFRA> = {
  base: BASE_INFRA,
  "base-sepolia": BASE_SEPOLIA_INFRA,
  "robinhood-testnet": ROBINHOOD_TESTNET_INFRA,
};

const ENS_REGISTRY: Record<Network, typeof BASE_ENS> = {
  base: BASE_ENS,
  "base-sepolia": BASE_SEPOLIA_ENS,
  "robinhood-testnet": ROBINHOOD_TESTNET_ENS,
};

const AGENT_REGISTRY_MAP: Record<Network, typeof BASE_AGENT_REGISTRY> = {
  base: BASE_AGENT_REGISTRY,
  "base-sepolia": BASE_SEPOLIA_AGENT_REGISTRY,
  "robinhood-testnet": ROBINHOOD_TESTNET_AGENT_REGISTRY,
};

const SHERWOOD_REGISTRY: Record<Network, typeof BASE_SHERWOOD> = {
  base: BASE_SHERWOOD,
  "base-sepolia": BASE_SEPOLIA_SHERWOOD,
  "robinhood-testnet": ROBINHOOD_TESTNET_SHERWOOD,
};

const VENICE_REGISTRY: Record<Network, typeof BASE_VENICE> = {
  base: BASE_VENICE,
  "base-sepolia": BASE_SEPOLIA_VENICE,
  "robinhood-testnet": ROBINHOOD_TESTNET_VENICE,
};

const AERODROME_REGISTRY: Record<Network, typeof BASE_AERODROME> = {
  base: BASE_AERODROME,
  "base-sepolia": BASE_SEPOLIA_AERODROME,
  "robinhood-testnet": ROBINHOOD_TESTNET_AERODROME,
};

const STRATEGY_TEMPLATE_REGISTRY: Record<Network, typeof BASE_STRATEGY_TEMPLATES> = {
  base: BASE_STRATEGY_TEMPLATES,
  "base-sepolia": BASE_SEPOLIA_STRATEGY_TEMPLATES,
  "robinhood-testnet": ROBINHOOD_TESTNET_STRATEGY_TEMPLATES,
};

const EAS_CONTRACT_REGISTRY: Record<Network, typeof BASE_EAS> = {
  base: BASE_EAS,
  "base-sepolia": BASE_SEPOLIA_EAS,
  "robinhood-testnet": ROBINHOOD_TESTNET_EAS,
};

const EAS_SCHEMA_REGISTRY: Record<Network, typeof BASE_EAS_SCHEMAS> = {
  base: BASE_EAS_SCHEMAS,
  "base-sepolia": BASE_SEPOLIA_EAS_SCHEMAS,
  "robinhood-testnet": ROBINHOOD_TESTNET_EAS_SCHEMAS,
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
