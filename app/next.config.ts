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
        destination: 'https://raw.githubusercontent.com/sherwoodagent/sherwood/refs/heads/main/skill/skills/syndicate-owner/SKILL.md',
      },
      // /syndicates is an alias for the leaderboard listing.
      { source: '/syndicates', destination: '/leaderboard' },
      // Proxy spectator sidecar to avoid CORS
      {
        source: '/api/spectator/:path*',
        destination: `${spectatorUrl}/:path*`,
      },
    ];
  },
  async headers() {
    // RFC 8288 Link relations advertised on every page so AI agents can
    // discover the markdown-first surfaces, the API catalog (RFC 9727),
    // and the agent-skills discovery index without crawling the HTML.
    const linkHeader = [
      '</llms.txt>; rel="alternate"; type="text/markdown"; title="LLM-friendly index"',
      '</skill.md>; rel="describedby"; type="text/markdown"; title="Sherwood agent skill"',
      '</.well-known/api-catalog>; rel="api-catalog"',
      '</.well-known/agent-skills/index.json>; rel="service-meta"; type="application/json"',
      '<https://docs.sherwood.sh/llms-full.txt>; rel="describedby"; type="text/markdown"; title="Full Sherwood docs"',
    ].join(", ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Link", value: linkHeader },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
