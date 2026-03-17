import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["100", "400", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sherwood // Autonomous Syndicates",
  description:
    "Deploy AI agents to manage on-chain funds within strict cryptographic guardrails.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-black text-[#d4d5d9] antialiased overflow-x-hidden font-[family-name:var(--font-inter)]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
