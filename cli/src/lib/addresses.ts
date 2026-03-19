/**
 * Contract addresses by network.
 *
 * All exports are functions — they resolve at call time based on the
 * current network set via setNetwork(). This ensures --testnet works
 * even when modules are imported before the flag is parsed.
 */

import type { Address } from "viem";
import { getNetwork } from "./network.js";

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
// Zero addresses = protocol not deployed on testnet. Strategies that need them
// (e.g. levered-swap) will fail at execution time with a clear allowlist error.

const BASE_SEPOLIA_TOKENS = {
  USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, // Circle test USDC
  WETH: "0x4200000000000000000000000000000000000006" as Address, // Canonical bridged WETH
  cbETH: "0x0000000000000000000000000000000000000000" as Address,
  wstETH: "0x0000000000000000000000000000000000000000" as Address,
  cbBTC: "0x0000000000000000000000000000000000000000" as Address,
  DAI: "0x0000000000000000000000000000000000000000" as Address,
  AERO: "0x0000000000000000000000000000000000000000" as Address,
} as const;

const BASE_SEPOLIA_MOONWELL = {
  COMPTROLLER: "0x0000000000000000000000000000000000000000" as Address,
  mUSDC: "0x0000000000000000000000000000000000000000" as Address,
  mWETH: "0x0000000000000000000000000000000000000000" as Address,
  mCbETH: "0x0000000000000000000000000000000000000000" as Address,
  mWstETH: "0x0000000000000000000000000000000000000000" as Address,
  mCbBTC: "0x0000000000000000000000000000000000000000" as Address,
  mDAI: "0x0000000000000000000000000000000000000000" as Address,
  mAERO: "0x0000000000000000000000000000000000000000" as Address,
} as const;

const BASE_SEPOLIA_UNISWAP = {
  SWAP_ROUTER: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address, // Uniswap V3 SwapRouter02
  QUOTER_V2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as Address, // Uniswap V3 QuoterV2
} as const;

const BASE_SEPOLIA_INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address, // Deterministic, same everywhere
} as const;

// ── ENS / Durin ──

const BASE_ENS = {
  L2_REGISTRAR: "0x0000000000000000000000000000000000000000" as Address, // TODO: set after mainnet deploy
  L2_REGISTRY: "0x0000000000000000000000000000000000000000" as Address, // TODO: set after mainnet deploy
} as const;

const BASE_SEPOLIA_ENS = {
  L2_REGISTRAR: "0x1fCbe9dFC25e3fa3F7C55b26c7992684A4758b47" as Address,
  L2_REGISTRY: "0x06eb7b85b59bc3e50fe4837be776cdd26de602cf" as Address,
} as const;

// ── ERC-8004 Agent Identity ──

const BASE_AGENT_REGISTRY = {
  IDENTITY_REGISTRY: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
} as const;

const BASE_SEPOLIA_AGENT_REGISTRY = {
  IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
} as const;

// ── Sherwood Protocol (our deployed contracts) ──

const BASE_SHERWOOD = {
  FACTORY: "0x0000000000000000000000000000000000000000" as Address, // TODO: set after mainnet deploy
  STRATEGY_REGISTRY: "0x0000000000000000000000000000000000000000" as Address, // TODO: set after mainnet deploy
  GOVERNOR: "0x0000000000000000000000000000000000000000" as Address, // TODO: set after mainnet deploy
} as const;

const BASE_SEPOLIA_SHERWOOD = {
  FACTORY: "0x60bf54dDce61ece85BE5e66CBaA17cC312DEa6C8" as Address,
  STRATEGY_REGISTRY: "0xf1e6E9bd1a735B54F383b18ad6603Ddd566C71cE" as Address,
  GOVERNOR: "0xB478cdb99260F46191C9e5Da405F7E70eEA23dE4" as Address,
} as const;

// ── Venice (VVV governance + sVVV staking + DIEM compute) ──

const BASE_VENICE = {
  VVV: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf" as Address,
  STAKING: "0x321b7ff75154472b18edb199033ff4d116f340ff" as Address, // also the sVVV ERC-20
  DIEM: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024" as Address,
} as const;

const BASE_SEPOLIA_VENICE = {
  VVV: "0x0000000000000000000000000000000000000000" as Address,
  STAKING: "0x0000000000000000000000000000000000000000" as Address,
  DIEM: "0x0000000000000000000000000000000000000000" as Address,
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

// ── EAS Schema UIDs (populated after running scripts/register-eas-schemas.ts) ──

const BASE_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  AGENT_APPROVED: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  X402_RESEARCH: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
} as const;

const BASE_SEPOLIA_EAS_SCHEMAS = {
  SYNDICATE_JOIN_REQUEST: "0x1e7ce17b16233977ba913b156033e98f52029f4bee273a4abefe6c15ce11d5ef" as `0x${string}`,
  AGENT_APPROVED: "0x1013f7b38f433b2a93fc5ac162482813081c64edd67cea9b5a90698531ddb607" as `0x${string}`,
  X402_RESEARCH: "0x86c67f0a59acb3093ecbeb6c4d1d4352e4a48143672e92ef9dd2fdfc8a9ca708" as `0x${string}`,
} as const;

// ── Exports (functions, resolved at call time) ──

export function TOKENS() {
  return getNetwork() === "base" ? BASE_TOKENS : BASE_SEPOLIA_TOKENS;
}

export function MOONWELL() {
  return getNetwork() === "base" ? BASE_MOONWELL : BASE_SEPOLIA_MOONWELL;
}

export function UNISWAP() {
  return getNetwork() === "base" ? BASE_UNISWAP : BASE_SEPOLIA_UNISWAP;
}

export function INFRA() {
  return getNetwork() === "base" ? BASE_INFRA : BASE_SEPOLIA_INFRA;
}

export function ENS() {
  return getNetwork() === "base" ? BASE_ENS : BASE_SEPOLIA_ENS;
}

export function AGENT_REGISTRY() {
  return getNetwork() === "base" ? BASE_AGENT_REGISTRY : BASE_SEPOLIA_AGENT_REGISTRY;
}

export function VENICE() {
  return getNetwork() === "base" ? BASE_VENICE : BASE_SEPOLIA_VENICE;
}

export function SHERWOOD() {
  return getNetwork() === "base" ? BASE_SHERWOOD : BASE_SEPOLIA_SHERWOOD;
}

export function EAS_CONTRACTS() {
  return getNetwork() === "base" ? BASE_EAS : BASE_SEPOLIA_EAS;
}

export function EAS_SCHEMAS() {
  return getNetwork() === "base" ? BASE_EAS_SCHEMAS : BASE_SEPOLIA_EAS_SCHEMAS;
}
