import type { NextConfig } from "next";

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
      {
        source: '/skill.md',
        destination: 'https://raw.githubusercontent.com/imthatcarlos/sherwood/refs/heads/main/skill/SKILL.md',
      },
      // Proxy spectator sidecar to avoid CORS
      {
        source: '/api/spectator/:path*',
        destination: `${spectatorUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
