/**
 * Token metadata fetching via Alchemy + Codex API fallback.
 *
 * - Alchemy: `alchemy_getTokenMetadata` for name, symbol, decimals, logo
 * - Codex: `graph.codex.io` GraphQL for token images when Alchemy has no logo
 */

const CODEX_API_URL = "https://graph.codex.io/graphql";
const LOGO_PLACEHOLDER = "https://link.storjshare.io/raw/jvyvfodxg4mej4tk32buvragnvza/token-images/unknown-logo.jpg";

// ── Types ──

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logo: string;
  marketCap: number | null;
}

// ── Codex GraphQL ──

const FILTER_TOKENS_QUERY = `
  query FilterTokens(
    $phrase: String!
    $networkIds: [Int!]
    $liquidity: Float!
    $marketCap: Float!
  ) {
    filterTokens(
      filters: {
        network: $networkIds
        liquidity: { gt: $liquidity }
        marketCap: { gt: $marketCap }
      }
      phrase: $phrase
      limit: 1
      rankings: [{ attribute: liquidity, direction: DESC }]
    ) {
      results {
        token {
          address
          decimals
          name
          networkId
          symbol
          info {
            imageSmallUrl
          }
          marketCap
        }
      }
    }
  }
`;

interface CodexTokenData {
  logo: string | null;
  marketCap: number | null;
}

async function fetchTokenFromCodex(
  tokenAddress: string,
  chainId: number,
): Promise<CodexTokenData> {
  const codexKey = process.env.CODEX_API_KEY;
  if (!codexKey) return { logo: null, marketCap: null };

  try {
    const res = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: codexKey,
      },
      body: JSON.stringify({
        query: FILTER_TOKENS_QUERY,
        variables: {
          phrase: tokenAddress,
          networkIds: [chainId],
          marketCap: 0,
          liquidity: 0,
        },
      }),
    });

    const data = await res.json();
    const result = data?.data?.filterTokens?.results?.[0];
    const token = result?.token;
    return {
      logo: token?.info?.imageSmallUrl || null,
      marketCap: token?.marketCap ? Number(token.marketCap) : null,
    };
  } catch {
    return { logo: null, marketCap: null };
  }
}

// ── Alchemy ──

function getAlchemyUrl(chainId: number): string | null {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (apiKey) {
    const host = chainId === 84532 ? "base-sepolia" : "base-mainnet";
    return `https://${host}.g.alchemy.com/v2/${apiKey}`;
  }
  // Fallback: extract from RPC URL env vars
  const rpcUrl =
    chainId === 8453
      ? process.env.NEXT_PUBLIC_RPC_URL_BASE
      : chainId === 84532
        ? process.env.NEXT_PUBLIC_RPC_URL_BASE_SEPOLIA
        : null;
  if (!rpcUrl || !rpcUrl.includes("alchemy.com")) return null;
  return rpcUrl;
}

// ── Public API ──

/**
 * Fetch token metadata using Alchemy + Codex fallback for logo.
 * Returns null if all sources fail.
 */
export async function fetchTokenMetadata(
  tokenAddress: string,
  chainId: number,
): Promise<TokenMetadata | null> {
  const alchemyUrl = getAlchemyUrl(chainId);
  if (!alchemyUrl) return null;

  try {
    const response = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "alchemy_getTokenMetadata",
        params: [tokenAddress],
        id: 1,
      }),
    });

    const data = await response.json();
    if (!data.result) return null;

    let logo = data.result.logo;
    let marketCap: number | null = null;

    // Fetch from Codex for logo fallback + market cap
    const codexData = await fetchTokenFromCodex(tokenAddress, chainId);
    if (!logo) logo = codexData.logo;
    marketCap = codexData.marketCap;

    return {
      name: data.result.name || "Unknown",
      symbol: data.result.symbol || "???",
      decimals: data.result.decimals ?? 18,
      logo: logo || LOGO_PLACEHOLDER,
      marketCap,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch metadata for multiple tokens in parallel.
 * Returns a Map from token address (lowercased) to metadata.
 */
export async function fetchAllTokenMetadata(
  tokens: string[],
  chainId: number,
): Promise<Map<string, TokenMetadata>> {
  const results = await Promise.allSettled(
    tokens.map((t) => fetchTokenMetadata(t, chainId)),
  );

  const metaMap = new Map<string, TokenMetadata>();
  for (let i = 0; i < tokens.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      metaMap.set(tokens[i].toLowerCase(), result.value);
    }
  }

  return metaMap;
}
