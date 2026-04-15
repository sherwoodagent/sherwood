"use client";

import { http } from "wagmi";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { Attribution } from "ox/erc8021";
import { CHAINS, getRpcUrl } from "@/lib/contracts";
import type { Chain } from "viem";

const chains = Object.values(CHAINS).map((e) => e.chain) as [
  Chain,
  ...Chain[],
];

const transports = Object.fromEntries(
  Object.keys(CHAINS).map((id) => [Number(id), http(getRpcUrl(Number(id)))]),
);

// Base Builder Code — appended to all transactions for onchain attribution
const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: ["bc_i5szbos9"],
});

// RainbowKit getDefaultConfig() rejects empty projectIds at module load time,
// which breaks `next build` in environments without WalletConnect configured.
// Falling back to a 32-char placeholder lets the build succeed; production
// deploys are expected to set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID for real
// WalletConnect support.
const WC_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  "00000000000000000000000000000000";

if (!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID && typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.warn(
    "[sherwood] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set — WalletConnect will not function.",
  );
}

export const wagmiConfig = getDefaultConfig({
  appName: "Sherwood",
  projectId: WC_PROJECT_ID,
  chains,
  transports,
  dataSuffix: DATA_SUFFIX,
});
