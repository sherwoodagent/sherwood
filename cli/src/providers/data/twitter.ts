/**
 * Twitter Sentiment Provider — fetches token-specific sentiment data from Twitter API v2.
 * Uses OAuth 1.0a for user-context authentication (higher rate limits than app-only).
 * Rate limit: 10 requests/min, 100 tweets/request (Recent Search free tier).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TwitterSentimentData {
  mentionVolume: number;           // Total tweets in last hour vs 24h hourly average
  sentimentScore: number;          // Simple keyword-based sentiment (-1 to +1)
  engagementWeightedSentiment: number; // Sentiment weighted by engagement
  volumeSpike: number;             // Ratio of last-hour volume to 24h hourly average
  tweetCount: number;              // Total tweets analyzed
  llmSentiment?: number;           // LLM-analyzed sentiment (-1 to +1)
  llmConfidence?: number;          // average LLM confidence
  llmBullishPercent?: number;      // % of tweets classified bullish
  llmBearishPercent?: number;      // % classified bearish
}

interface TwitterTweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
  author_id: string;
}

interface TwitterApiResponse {
  data: TwitterTweet[];
  meta: {
    result_count: number;
    next_token?: string;
  };
}

interface OpenAISentimentResponse {
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
}

interface TweetWithEngagement {
  text: string;
  engagement: number;
}

const TWITTER_BASE = 'https://api.twitter.com/2';

// Map CoinGecko token IDs to Twitter search queries
const TOKEN_TO_SEARCH: Record<string, string> = {
  bitcoin: '$BTC OR #bitcoin',
  ethereum: '$ETH OR #ethereum',
  solana: '$SOL OR #solana',
  arbitrum: '$ARB OR #arbitrum',
  uniswap: '$UNI OR #uniswap',
  aave: '$AAVE OR #aave',
  chainlink: '$LINK OR #chainlink',
  cardano: '$ADA OR #cardano',
  polkadot: '$DOT OR #polkadot',
  avalanche: '$AVAX OR #avalanche',
  near: '$NEAR OR #near',
  cosmos: '$ATOM OR #cosmos',
  sui: '$SUI OR #sui',
  aptos: '$APT OR #aptos',
  maker: '$MKR OR #maker',
  optimism: '$OP OR #optimism',
  polygon: '$MATIC OR #polygon',
  dogecoin: '$DOGE OR #dogecoin',
  litecoin: '$LTC OR #litecoin',
  filecoin: '$FIL OR #filecoin',
  render: '$RENDER OR #render',
  injective: '$INJ OR #injective',
  jupiter: '$JUP OR #jupiter',
  pendle: '$PENDLE OR #pendle',
  pepe: '$PEPE OR #pepe',
};

// Sentiment keywords
const BULLISH_WORDS = [
  'bullish', 'moon', 'pump', 'buy', 'long', 'breakout', 'ath', 'send it', 'lfg', 'wagmi', 'undervalued',
  'hodl', 'diamond hands', 'to the moon', 'rocket', 'bull run', 'green', 'gainz', 'surge', 'rally'
];

const BEARISH_WORDS = [
  'bearish', 'dump', 'sell', 'short', 'crash', 'dead', 'rekt', 'ngmi', 'overvalued', 'scam',
  'paper hands', 'bear market', 'red', 'dip', 'correction', 'bubble', 'rugpull', 'bloodbath'
];

export class TwitterSentimentProvider {
  private cacheDir: string;
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
  }

  /** Get Twitter sentiment data for a token. Returns null if no data or API failure. */
  async getSentiment(tokenId: string): Promise<TwitterSentimentData | null> {
    const query = TOKEN_TO_SEARCH[tokenId];
    if (!query) {
      // For unknown tokens, try to use the token symbol if available
      return null;
    }

    // Check cache first
    const cached = await this.readCache(tokenId);
    if (cached) return cached;

    try {
      // Fetch recent tweets (last 24 hours for volume analysis)
      const tweets = await this.fetchTweets(query, new Date(Date.now() - 24 * 60 * 60 * 1000));
      if (!tweets || tweets.length === 0) return null;

      // Calculate metrics
      const data = await this.analyzeTweets(tweets);

      // Cache results
      await this.writeCache(tokenId, data);

      return data;
    } catch (err) {
      console.error(`Twitter API error for ${tokenId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Fetch tweets using Twitter API v2 Recent Search with OAuth 1.0a. */
  private async fetchTweets(query: string, startTime: Date): Promise<TwitterTweet[] | null> {
    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecret = process.env.TWITTER_API_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error('Twitter API credentials not found in environment variables');
    }

    const url = new URL(`${TWITTER_BASE}/tweets/search/recent`);
    url.searchParams.set('query', query);
    url.searchParams.set('start_time', startTime.toISOString());
    url.searchParams.set('max_results', '100');
    url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id');

    // Generate OAuth 1.0a signature
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: apiKey,
      oauth_token: accessToken,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_version: '1.0',
    };

    // Create signature base string
    const params = { ...oauthParams, ...Object.fromEntries(url.searchParams) };
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');

    const signatureBaseString = `GET&${encodeURIComponent(url.origin + url.pathname)}&${encodeURIComponent(sortedParams)}`;

    // Create signing key
    const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessTokenSecret)}`;

    // Generate signature
    const signature = createHmac('sha1', signingKey).update(signatureBaseString).digest('base64');

    // Create Authorization header
    const authHeader = 'OAuth ' + Object.entries({ ...oauthParams, oauth_signature: signature })
      .map(([key, value]) => `${encodeURIComponent(key)}="${encodeURIComponent(value)}"`)
      .join(', ');

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': authHeader,
        'User-Agent': 'Sherwood-Agent/1.0'
      }
    });

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limited
        return null;
      }
      throw new Error(`Twitter API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as TwitterApiResponse;
    return data.data || [];
  }

  /** Analyze sentiment using OpenAI GPT-4o-mini. */
  private async analyzeSentimentWithLLM(tweets: TwitterTweet[]): Promise<{
    llmSentiment: number;
    llmConfidence: number;
    llmBullishPercent: number;
    llmBearishPercent: number;
  } | null> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return null;
    }

    try {
      // Prepare tweets with engagement data
      const tweetsWithEngagement: TweetWithEngagement[] = tweets.map(tweet => ({
        text: tweet.text,
        engagement: tweet.public_metrics.like_count +
                   tweet.public_metrics.retweet_count +
                   tweet.public_metrics.reply_count,
      }));

      // Keep LLM pass bounded so full scanner doesn't timeout under 10-token auto mode.
      // Use top-engagement tweets first because they carry the most signal.
      const llmTweets = [...tweetsWithEngagement]
        .sort((a, b) => b.engagement - a.engagement)
        .slice(0, 40);
      if (llmTweets.length === 0) {
        return null;
      }

      // Batch tweets into groups of 20
      const batchSize = 20;
      const batches: TweetWithEngagement[][] = [];
      for (let i = 0; i < llmTweets.length; i += batchSize) {
        batches.push(llmTweets.slice(i, i + batchSize));
      }

      const allResults: (OpenAISentimentResponse & { engagement: number })[] = [];
      let consecutiveBatchFailures = 0;
      const MAX_CONSECUTIVE_BATCH_FAILURES = 2;

      // Process each batch
      for (const batch of batches) {
        // Sanitize tweet text to prevent prompt injection:
        // 1. Strip dangerous chars first (bidi overrides, zero-width, control chars)
        // 2. Flatten newlines
        // 3. Escape quotes/backslashes
        // 4. Truncate
        const sanitizeTweet = (text: string): string => {
          return text
            .replace(/[\x00-\x1f\x7f]/g, '') // strip control chars
            .replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069\u00AD\uFEFF]/g, '') // strip bidi overrides + zero-width chars
            .replace(/\n/g, ' ') // flatten newlines
            .replace(/["\\]/g, (c) => `\\${c}`) // escape quotes/backslashes
            .slice(0, 280); // truncate last (after stripping, not before)
        };

        const tweetTexts = batch.map((tweet, idx) => `${idx + 1}. "${sanitizeTweet(tweet.text)}"`).join('\n');

        const systemPrompt = `You are a crypto market sentiment analyzer. For each tweet, classify sentiment as BULLISH, BEARISH, or NEUTRAL with confidence 0-100. Consider sarcasm, irony, and CT slang.
Return ONLY valid JSON with this exact shape:
{"results":[{"sentiment":"BULLISH|BEARISH|NEUTRAL","confidence":0-100}]}`;

        const userPrompt = `Analyze these ${batch.length} tweets:\n${tweetTexts}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          console.warn(`OpenAI API error: ${response.status} ${response.statusText}`);
          consecutiveBatchFailures++;
          if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) return null;
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          console.warn('OpenAI API returned no content');
          consecutiveBatchFailures++;
          if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) return null;
          continue;
        }

        // Parse JSON response — strip markdown code blocks if present
        let batchResults: OpenAISentimentResponse[];
        try {
          let jsonStr = content.trim();
          // OpenAI sometimes wraps JSON in ```json ... ``` markdown blocks
          if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          const parsed = JSON.parse(jsonStr) as unknown;
          let parsedResults: unknown[] | null = null;

          if (Array.isArray(parsed)) {
            parsedResults = parsed;
          } else if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            if (Array.isArray(obj.results)) {
              parsedResults = obj.results;
            } else if (Array.isArray(obj.tweets)) {
              parsedResults = obj.tweets;
            } else if (Array.isArray(obj.sentiments)) {
              parsedResults = obj.sentiments;
            }
          }

          if (!parsedResults) {
            const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
            if (arrMatch) {
              const recovered = JSON.parse(arrMatch[0]) as unknown;
              if (Array.isArray(recovered)) {
                parsedResults = recovered;
              }
            }
          }

          if (!parsedResults) {
            throw new Error('No parseable sentiment array');
          }

          batchResults = parsedResults.map((item) => {
            const row = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
            const sentimentRaw = String(row.sentiment ?? row.label ?? row.classification ?? 'NEUTRAL').toUpperCase();
            const confidenceRaw = Number(row.confidence ?? row.score ?? 50);
            return {
              sentiment: sentimentRaw as OpenAISentimentResponse['sentiment'],
              confidence: confidenceRaw,
            };
          });

          if (batchResults.length > batch.length) {
            batchResults = batchResults.slice(0, batch.length);
          } else if (batchResults.length < batch.length) {
            while (batchResults.length < batch.length) {
              batchResults.push({ sentiment: 'NEUTRAL', confidence: 50 });
            }
          }

          // Validate each element to prevent NaN propagation from malformed responses
          const VALID_SENTIMENTS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
          for (const r of batchResults) {
            if (!VALID_SENTIMENTS.has(r.sentiment)) r.sentiment = 'NEUTRAL';
            if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence)) r.confidence = 50;
            r.confidence = Math.max(0, Math.min(100, r.confidence));
          }
          consecutiveBatchFailures = 0;
        } catch (parseErr) {
          console.warn(`Failed to parse OpenAI response: ${parseErr}`);
          consecutiveBatchFailures++;
          if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) return null;
          // Continue using neutral placeholders for this batch instead of failing whole token scan.
          batchResults = batch.map(() => ({ sentiment: 'NEUTRAL', confidence: 50 }));
        }

        // Combine with engagement data
        for (let i = 0; i < batchResults.length; i++) {
          allResults.push({
            ...batchResults[i],
            engagement: batch[i].engagement,
          });
        }
      }

      // Calculate weighted sentiment metrics
      const bullishTweets = allResults.filter(r => r.sentiment === 'BULLISH');
      const bearishTweets = allResults.filter(r => r.sentiment === 'BEARISH');

      const totalTweets = allResults.length;
      const llmBullishPercent = (bullishTweets.length / totalTweets) * 100;
      const llmBearishPercent = (bearishTweets.length / totalTweets) * 100;

      // Calculate engagement-weighted sentiment score
      let totalWeightedScore = 0;
      let totalWeight = 0;
      let totalConfidence = 0;

      for (const result of allResults) {
        let sentimentMultiplier = 0;
        if (result.sentiment === 'BULLISH') {
          sentimentMultiplier = 1;
        } else if (result.sentiment === 'BEARISH') {
          sentimentMultiplier = -1;
        }

        const weight = (result.confidence / 100) * (1 + Math.log10(result.engagement + 1));
        totalWeightedScore += sentimentMultiplier * weight;
        totalWeight += weight;
        totalConfidence += result.confidence;
      }

      const llmSentiment = totalWeight > 0 ? Math.max(-1, Math.min(1, totalWeightedScore / totalWeight)) : 0;
      const llmConfidence = totalTweets > 0 ? totalConfidence / totalTweets : 0;

      return {
        llmSentiment,
        llmConfidence,
        llmBullishPercent,
        llmBearishPercent,
      };

    } catch (error) {
      console.warn(`LLM sentiment analysis failed: ${error}`);
      return null;
    }
  }

  /** Analyze tweets to calculate sentiment metrics. */
  private async analyzeTweets(tweets: TwitterTweet[]): Promise<TwitterSentimentData> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Separate recent (last hour) vs all tweets
    const recentTweets = tweets.filter(t => new Date(t.created_at).getTime() > oneHourAgo);
    const allTweets = tweets;

    // Calculate mention volume (recent vs average)
    const recentVolume = recentTweets.length;
    const avgHourlyVolume = allTweets.length / 24; // 24 hours of data
    const volumeSpike = avgHourlyVolume > 0 ? recentVolume / avgHourlyVolume : 1;

    // Analyze sentiment for all tweets (keyword-based)
    let bullishCount = 0;
    let bearishCount = 0;
    let totalEngagement = 0;
    let engagementWeightedBullish = 0;
    let engagementWeightedBearish = 0;

    for (const tweet of allTweets) {
      const text = tweet.text.toLowerCase();
      const engagement = tweet.public_metrics.like_count +
                       tweet.public_metrics.retweet_count +
                       tweet.public_metrics.reply_count;

      let tweetBullish = 0;
      let tweetBearish = 0;

      // Count sentiment words
      for (const word of BULLISH_WORDS) {
        if (text.includes(word)) tweetBullish++;
      }
      for (const word of BEARISH_WORDS) {
        if (text.includes(word)) tweetBearish++;
      }

      if (tweetBullish > tweetBearish) {
        bullishCount++;
        engagementWeightedBullish += engagement;
      } else if (tweetBearish > tweetBullish) {
        bearishCount++;
        engagementWeightedBearish += engagement;
      }

      totalEngagement += engagement;
    }

    // Calculate keyword-based sentiment scores
    const totalAnalyzed = bullishCount + bearishCount;
    const sentimentScore = totalAnalyzed > 0
      ? Math.max(-1, Math.min(1, (bullishCount - bearishCount) / totalAnalyzed))
      : 0;

    const engagementWeightedSentiment = totalEngagement > 0
      ? Math.max(-1, Math.min(1, (engagementWeightedBullish - engagementWeightedBearish) / totalEngagement))
      : sentimentScore;

    // Try LLM sentiment analysis
    const llmResult = await this.analyzeSentimentWithLLM(allTweets);

    const baseData: TwitterSentimentData = {
      mentionVolume: recentVolume,
      sentimentScore,
      engagementWeightedSentiment,
      volumeSpike,
      tweetCount: allTweets.length,
    };

    // Add LLM results if available
    if (llmResult) {
      return {
        ...baseData,
        llmSentiment: llmResult.llmSentiment,
        llmConfidence: llmResult.llmConfidence,
        llmBullishPercent: llmResult.llmBullishPercent,
        llmBearishPercent: llmResult.llmBearishPercent,
      };
    }

    return baseData;
  }

  /** Read cached sentiment data. */
  private async readCache(tokenId: string): Promise<TwitterSentimentData | null> {
    try {
      const cacheFile = join(this.cacheDir, `twitter-${tokenId}.json`);
      const raw = await readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as { ts: number; data: TwitterSentimentData };

      if (Date.now() - cached.ts < this.cacheTTL) {
        return cached.data;
      }
    } catch {
      // No cache or invalid cache
    }
    return null;
  }

  /** Write sentiment data to cache. */
  private async writeCache(tokenId: string, data: TwitterSentimentData): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const cacheFile = join(this.cacheDir, `twitter-${tokenId}.json`);
      await writeFile(cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf-8');
    } catch {
      // Cache write failure is non-fatal
    }
  }

  /** Get sentiment data with fallback to token symbol for unknown tokens. */
  async getSentimentWithSymbol(tokenId: string, tokenSymbol?: string): Promise<TwitterSentimentData | null> {
    // Try with known token mapping first
    let result = await this.getSentiment(tokenId);

    // If no result and we have a symbol, try searching with symbol
    if (!result && tokenSymbol) {
      const symbolQuery = `$${tokenSymbol.toUpperCase()} OR #${tokenSymbol.toLowerCase()}`;
      try {
        const tweets = await this.fetchTweets(symbolQuery, new Date(Date.now() - 24 * 60 * 60 * 1000));
        if (tweets && tweets.length > 0) {
          result = await this.analyzeTweets(tweets);
          await this.writeCache(tokenId, result);
        }
      } catch {
        // Symbol-based search failed
      }
    }

    return result;
  }
}
