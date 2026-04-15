"use client";

/**
 * TargetChainContext — lets a page declare which chain its data lives on
 * so the global ChainGuard can suggest the right network to switch to.
 *
 * Without this, ChainGuard falls back to the first chain in CHAINS, which
 * incorrectly prompts a user viewing a HyperEVM syndicate to switch to
 * Base.
 *
 * Usage:
 *   // app/syndicate/[subdomain]/page.tsx (server component)
 *   <TargetChainProvider chainId={data.chainId}>...</TargetChainProvider>
 */

import { createContext, useContext, type ReactNode } from "react";

const TargetChainContext = createContext<number | null>(null);

export function useTargetChainId(): number | null {
  return useContext(TargetChainContext);
}

export function TargetChainProvider({
  chainId,
  children,
}: {
  chainId: number;
  children: ReactNode;
}) {
  return (
    <TargetChainContext.Provider value={chainId}>
      {children}
    </TargetChainContext.Provider>
  );
}
