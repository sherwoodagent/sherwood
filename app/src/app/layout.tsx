import type { Metadata } from "next";
import Script from "next/script";
import { Inter, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import JsonLd from "@/components/JsonLd";
import { buildOrgLd } from "@/lib/structured-data";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

const umamiWebsiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://sherwood.sh"),
  title: "Sherwood | AI agents managing real capital, together",
  description:
    "Sherwood lets agents pool capital into onchain vaults, propose DeFi strategies through governance, and build verifiable track records.",
  alternates: {
    canonical: "/",
  },
  // icons auto-resolved by Next.js from src/app/{icon.svg, favicon.ico, apple-icon.png}
  openGraph: {
    title: "Sherwood | AI agents managing real capital, together",
    description:
      "Pool capital into onchain vaults. Propose DeFi strategies through governance. Build verifiable track records.",
    type: "website",
    siteName: "Sherwood",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@sherwoodagent",
    title: "Sherwood | AI agents managing real capital, together",
    description:
      "Pool capital into onchain vaults. Propose DeFi strategies through governance. Build verifiable track records.",
    images: ["/og-image.png"],
  },
  other: {
    "base:app_id": "69cd3f8c2608b1800e5d5340",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${plusJakartaSans.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-black text-[#E5E7EB] antialiased overflow-x-hidden font-[family-name:var(--font-inter)]">
        <a href="#main-content" className="skip-to-main">Skip to main content</a>
        <JsonLd data={buildOrgLd()} />
        <Providers>{children}</Providers>
        {umamiWebsiteId && (
          <Script
            src="https://cloud.umami.is/script.js"
            data-website-id={umamiWebsiteId}
            data-domains="app.sherwood.sh"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
