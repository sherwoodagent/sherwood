/**
 * Verified contract addresses on Base.
 * Source: Moonwell docs, Uniswap docs, ethskills/addresses
 */

import type { Address } from "viem";

export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  WETH: "0x4200000000000000000000000000000000000006" as Address,
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Address,
  wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address,
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address,
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address,
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as Address,
} as const;

export const MOONWELL = {
  COMPTROLLER: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as Address,
  mUSDC: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22" as Address,
  mWETH: "0x628ff693426583D9a7FB391E54366292F509D457" as Address,
  mCbETH: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5" as Address,
  mWstETH: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b" as Address,
  mCbBTC: "0xF877ACaFA28c19b96727966690b2f44d35aD5976" as Address,
  mDAI: "0x73b06D8d18De422E269645eaCe15400DE7462417" as Address,
  mAERO: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6" as Address,
} as const;

export const UNISWAP = {
  // Uniswap V3 SwapRouter02 on Base
  SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
  // Uniswap V3 Quoter V2 on Base
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address,
} as const;

export const INFRA = {
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;
