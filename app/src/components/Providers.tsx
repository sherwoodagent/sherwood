"use client";

import { type ReactNode, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "@/lib/wagmi";
import { ToastProvider } from "@/components/ui/Toast";
import ChainGuard from "@/components/ChainGuard";

/**
 * Custom RainbowKit theme tuned to Sherwood's brand palette.
 * Overrides the default dark theme so the wallet modal matches the site
 * (accent emerald, dark ink background, hairline borders).
 */
const sherwoodRainbowTheme = darkTheme({
  accentColor: "#2EE6A6",
  accentColorForeground: "#000000",
  borderRadius: "none",
  fontStack: "system",
  overlayBlur: "small",
});

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 30s stale time — avoids cache thrash on fast re-navigations,
            // while still refreshing vault/TVL data on focus changes.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Don't retry user-initiated rejections or permission errors.
              const msg = String((error as Error)?.message || "").toLowerCase();
              if (msg.includes("user rejected") || msg.includes("denied")) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={sherwoodRainbowTheme}>
          <ToastProvider>
            <ChainGuard />
            {children}
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
