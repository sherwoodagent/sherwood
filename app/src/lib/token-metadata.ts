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
        }
        marketCap
        liquidity
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
    return {
      logo: result?.token?.info?.imageSmallUrl || null,
      marketCap: result?.marketCap ? Number(result.marketCap) : null,
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

// ── Price History (Codex getBars) ──

export interface PriceBar {
  timestamp: number;
  value: number; // portfolio value in USD at this point
}

/**
 * Fetch portfolio value time-series using Codex getBars.
 * Fetches candles from proposal execution to now for each token,
 * multiplies close price by held amount, sums across tokens.
 *
 * Resolution is adaptive based on strategy duration:
 *   < 6h → "5" (5-min bars), < 24h → "15", < 7d → "60", else → "240"
 *
 * Returns an array of { timestamp, value } sorted by time.
 */
export async function fetchPortfolioPriceHistory(
  tokens: { address: string; amount: number }[],
  chainId: number,
  executedAt: number,
): Promise<PriceBar[]> {
  const codexKey = process.env.CODEX_API_KEY;
  if (!codexKey || tokens.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  const duration = now - executedAt;

  // Adaptive resolution based on strategy duration
  let resolution: string;
  if (duration < 6 * 3600) resolution = "5";
  else if (duration < 24 * 3600) resolution = "15";
  else if (duration < 7 * 86400) resolution = "60";
  else resolution = "240";

  try {
    const barResults = await Promise.all(
      tokens.map(async (t) => {
        const res = await fetch(CODEX_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: codexKey,
          },
          body: JSON.stringify({
            query: `{ getBars(symbol: "${t.address}:${chainId}", from: ${executedAt}, to: ${now}, resolution: "${resolution}") { t c } }`,
          }),
        });
        const data = await res.json();
        return {
          amount: t.amount,
          timestamps: (data.data?.getBars?.t as number[]) || [],
          closes: (data.data?.getBars?.c as number[]) || [],
        };
      }),
    );

    // Use timestamps from the first token (all should align)
    const timestamps = barResults[0]?.timestamps || [];
    if (timestamps.length === 0) return [];

    return timestamps.map((ts, i) => {
      let value = 0;
      for (const r of barResults) {
        const price = r.closes[i] ?? 0;
        value += r.amount * price;
      }
      return { timestamp: ts, value };
    });
  } catch {
    return [];
  }
}

/**
 * Batch-fetch Codex data for multiple tokens in a single GraphQL call.
 * Uses multiple filterTokens queries aliased per token.
 */
async function fetchBatchCodexData(
  tokens: string[],
  chainId: number,
): Promise<Map<string, CodexTokenData>> {
  const codexKey = process.env.CODEX_API_KEY;
  const result = new Map<string, CodexTokenData>();
  if (!codexKey || tokens.length === 0) return result;

  // Build a single query with aliased sub-queries
  const fragments = tokens.map((addr, i) =>
    `t${i}: filterTokens(filters: { network: [${chainId}], liquidity: { gt: 0 }, marketCap: { gt: 0 } }, phrase: "${addr}", limit: 1, rankings: [{ attribute: liquidity, direction: DESC }]) { results { token { info { imageSmallUrl } } marketCap } }`
  );

  try {
    const res = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: codexKey },
      body: JSON.stringify({ query: `{ ${fragments.join("\n")} }` }),
    });
    const data = await res.json();
    for (let i = 0; i < tokens.length; i++) {
      const entry = data?.data?.[`t${i}`]?.results?.[0];
      result.set(tokens[i].toLowerCase(), {
        logo: entry?.token?.info?.imageSmallUrl || null,
        marketCap: entry?.marketCap ? Number(entry.marketCap) : null,
      });
    }
  } catch {
    // Non-fatal
  }
  return result;
}

/**
 * Batch-fetch Alchemy token metadata for multiple tokens in parallel.
 */
async function fetchBatchAlchemyMetadata(
  tokens: string[],
  chainId: number,
): Promise<Map<string, { name: string; symbol: string; decimals: number; logo: string | null }>> {
  const alchemyUrl = getAlchemyUrl(chainId);
  const result = new Map<string, { name: string; symbol: string; decimals: number; logo: string | null }>();
  if (!alchemyUrl || tokens.length === 0) return result;

  // Alchemy supports JSON-RPC batch
  const batch = tokens.map((addr, i) => ({
    jsonrpc: "2.0",
    method: "alchemy_getTokenMetadata",
    params: [addr],
    id: i,
  }));

  try {
    const res = await fetch(alchemyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    const responses = await res.json() as { id: number; result?: { name: string; symbol: string; decimals: number; logo: string | null } }[];
    for (const r of responses) {
      if (r.result) {
        result.set(tokens[r.id].toLowerCase(), {
          name: r.result.name || "Unknown",
          symbol: r.result.symbol || "???",
          decimals: r.result.decimals ?? 18,
          logo: r.result.logo || null,
        });
      }
    }
  } catch {
    // Non-fatal
  }
  return result;
}

/**
 * Fetch metadata for multiple tokens with batched API calls.
 * 1 Alchemy batch call + 1 Codex batch query (instead of N+N).
 */
export async function fetchAllTokenMetadata(
  tokens: string[],
  chainId: number,
): Promise<Map<string, TokenMetadata>> {
  // Run both batch calls in parallel
  const [alchemyMap, codexMap] = await Promise.all([
    fetchBatchAlchemyMetadata(tokens, chainId),
    fetchBatchCodexData(tokens, chainId),
  ]);

  const metaMap = new Map<string, TokenMetadata>();
  for (const addr of tokens) {
    const key = addr.toLowerCase();
    const alchemy = alchemyMap.get(key);
    const codex = codexMap.get(key);

    if (alchemy || codex) {
      metaMap.set(key, {
        name: alchemy?.name || "Unknown",
        symbol: alchemy?.symbol || "???",
        decimals: alchemy?.decimals ?? 18,
        logo: alchemy?.logo || codex?.logo || LOGO_PLACEHOLDER,
        marketCap: codex?.marketCap ?? null,
      });
    }
  }

  return metaMap;
}
