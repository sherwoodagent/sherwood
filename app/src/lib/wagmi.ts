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

export const wagmiConfig = getDefaultConfig({
  appName: "Sherwood",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
  chains,
  transports,
  dataSuffix: DATA_SUFFIX,
});
