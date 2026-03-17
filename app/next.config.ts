import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const spectatorUrl = process.env.SPECTATOR_URL || 'http://localhost:3100';
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
