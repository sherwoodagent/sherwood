import type { MetadataRoute } from "next";
import { getActiveSyndicates } from "@/lib/syndicates";

const BASE = "https://sherwood.sh";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticUrls: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "weekly", priority: 1.0 },
    { url: `${BASE}/leaderboard`, changeFrequency: "hourly", priority: 0.9 },
  ];

  // Fail-soft — sitemap should never block deployment if data is unavailable
  try {
    const syndicates = await getActiveSyndicates();
    const syndicateUrls = syndicates.flatMap((s) => [
      {
        url: `${BASE}/syndicate/${s.subdomain}`,
        changeFrequency: "hourly" as const,
        priority: 0.8,
      },
      {
        url: `${BASE}/syndicate/${s.subdomain}/proposals`,
        changeFrequency: "hourly" as const,
        priority: 0.7,
      },
      {
        url: `${BASE}/syndicate/${s.subdomain}/agents`,
        changeFrequency: "daily" as const,
        priority: 0.6,
      },
    ]);
    return [...staticUrls, ...syndicateUrls];
  } catch {
    return staticUrls;
  }
}
