import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  // Run with `ANALYZE=true npm run build` to open bundle reports.
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack(config) {
    // Stub React Native modules pulled in by @metamask/sdk via wagmi's injected() connector
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
  async rewrites() {
    const spectatorUrl = process.env.SPECTATOR_URL || 'https://spectator.sherwood.sh';
    return [
      // /skill.md is now a dynamic API route (app/src/app/skill.md/route.ts)
      // that injects referral context when ?subdomain=X&ref=Y query params are present
      {
        source: '/skill-guardian.md',
        destination: 'https://raw.githubusercontent.com/imthatcarlos/sherwood/refs/heads/main/skill/skills/syndicate-owner/SKILL.md',
      },
      // Proxy spectator sidecar to avoid CORS
      {
        source: '/api/spectator/:path*',
        destination: `${spectatorUrl}/:path*`,
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
