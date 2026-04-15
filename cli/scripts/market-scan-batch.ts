import { config as loadDotenv } from "dotenv";
try { loadDotenv(); } catch {}

import { TradingAgent } from "../src/agent/index.js";
import { CoinGeckoProvider } from "../src/providers/data/coingecko.js";
import { SentimentProvider } from "../src/providers/data/sentiment.js";

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const tokens = args.filter((arg) => arg !== "--json");

if (tokens.length === 0 || tokens.length > 3) {
  console.error("Usage: node --import tsx scripts/market-scan-batch.ts <token...max3> --json");
  process.exit(1);
}

const agent = new TradingAgent({
  tokens,
  cycle: "4h",
  dryRun: true,
  maxPositionPct: 5,
  maxRiskPct: 20,
  useX402: false,
});

const coingecko = new CoinGeckoProvider();
const sentiment = new SentimentProvider();

try {
  const [analyses, prices, fearGreed] = await Promise.all([
    agent.analyzeAll(),
    coingecko.getPrice(tokens, ["usd"]),
    sentiment.getFearAndGreedCurrent().catch(() => null),
  ]);

  const payload = {
    timestamp: new Date().toISOString(),
    fearGreed,
    results: analyses.map((analysis) => ({
      token: analysis.token,
      decision: analysis.decision,
      regime: analysis.regime,
      correlation: analysis.correlation,
      technicalSignals: analysis.data.technicalSignals,
      fearAndGreed: analysis.data.fearAndGreed,
      tvl: analysis.data.tvl,
      price: prices?.[analysis.token]?.usd ?? null,
      priceChange24h: prices?.[analysis.token]?.usd_24h_change ?? null,
      volume24h: prices?.[analysis.token]?.usd_24h_vol ?? null,
      marketCap: prices?.[analysis.token]?.usd_market_cap ?? null,
    })),
  };

  if (jsonFlag) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(payload);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message, tokens }, null, 2));
  process.exit(1);
}
