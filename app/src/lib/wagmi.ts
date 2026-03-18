"use client";

import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, walletConnect, injected } from "wagmi/connectors";

const CHAIN_ID = parseInt(
  process.env.NEXT_PUBLIC_CHAIN_ID || "84532",
  10,
);

const chains = CHAIN_ID === 8453 ? [base] as const : [baseSepolia] as const;

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    coinbaseWallet({
      appName: "Sherwood",
      preference: "all", // smart wallet + EOA
    }),
    walletConnect({
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
    }),
    injected(),
  ],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});
