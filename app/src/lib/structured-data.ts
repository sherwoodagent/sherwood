/**
 * JSON-LD structured-data builders for rich-result SEO.
 *
 * Each function returns a plain serializable object matching a schema.org
 * type. Pair with the <JsonLd> component which serializes + emits the
 * `<script type="application/ld+json">` tag. Builders are pure so the same
 * object can feed both the FAQ UI and the FAQPage schema (single source
 * of truth — don't drift).
 */

export const SITE_URL = "https://sherwood.sh";

export interface FaqItem {
  q: string;
  a: string;
}

export interface SyndicateLdInput {
  subdomain: string;
  name: string;
  description?: string;
  tvl?: string; // display-formatted, e.g. "$1.2M" — schema.org "Product" allows free-text
  agentCount?: number;
  assetSymbol?: string;
  chainId?: number;
}

export interface BreadcrumbTrailItem {
  name: string;
  path: string; // absolute path starting with /
}

/** Organization — rendered in the root layout. Drives the Google
    "who is this" panel. */
export function buildOrgLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Sherwood",
    url: SITE_URL,
    logo: `${SITE_URL}/icon.svg`,
    description:
      "Sherwood lets AI agents pool capital into onchain vaults, propose DeFi strategies through governance, and build verifiable track records.",
    sameAs: [
      "https://twitter.com/sherwoodagent",
      "https://github.com/sherwoodagent/sherwood",
      "https://docs.sherwood.sh",
    ],
  } as const;
}

/** FAQPage — rendered on the landing page alongside the visual FAQ. */
export function buildFaqLd(items: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  } as const;
}

/** Per-syndicate schema. Product is the closest schema.org type that
    doesn't require review aggregates / brand fields. FinancialProduct
    is stricter and rejects many of our fields; Google accepts Product
    generically for non-e-commerce listings. */
export function buildSyndicateLd(input: SyndicateLdInput) {
  const {
    subdomain,
    name,
    description,
    tvl,
    agentCount,
    assetSymbol,
    chainId,
  } = input;
  const url = `${SITE_URL}/syndicate/${subdomain}`;
  const additionalProperties = [
    tvl && { "@type": "PropertyValue", name: "TVL", value: tvl },
    typeof agentCount === "number" && {
      "@type": "PropertyValue",
      name: "Agents",
      value: String(agentCount),
    },
    assetSymbol && {
      "@type": "PropertyValue",
      name: "Asset",
      value: assetSymbol,
    },
    typeof chainId === "number" && {
      "@type": "PropertyValue",
      name: "Chain ID",
      value: String(chainId),
    },
  ].filter(Boolean);
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    description:
      description ||
      `${name} — a Sherwood syndicate managed by AI agents through onchain governance.`,
    url,
    brand: {
      "@type": "Brand",
      name: "Sherwood",
    },
    additionalProperty: additionalProperties,
  } as const;
}

/** BreadcrumbList — add on sub-pages so search results show a path. */
export function buildBreadcrumbLd(trail: readonly BreadcrumbTrailItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  } as const;
}
