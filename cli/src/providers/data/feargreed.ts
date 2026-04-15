/**
 * Dedicated Fear & Greed Index provider with history tracking and caching.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface FearGreedEntry {
  value: number;
  classification: string;
  timestamp: string;
}

interface FearGreedApiResponse {
  name: string;
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

const API_URL = 'https://api.alternative.me/fng/';

export class FearGreedProvider {
  private cacheDir: string;
  private cacheFile: string;
  private cacheTTL = 30 * 60 * 1000; // 30 minutes

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
    this.cacheFile = join(this.cacheDir, 'feargreed.json');
  }

  /** Get current Fear & Greed data. */
  async getCurrent(): Promise<FearGreedEntry> {
    const data = await this.fetchWithCache(1);
    if (!data.length) throw new Error('No Fear & Greed data available');
    return data[0]!;
  }

  /** Get historical data for the last N days. */
  async getHistory(days: number = 30): Promise<FearGreedEntry[]> {
    return this.fetchWithCache(days);
  }

  /**
   * Check if F&G has been in extreme zone for N consecutive days.
   * @param threshold - Value boundary (e.g. 25 for fear, 75 for greed)
   * @param days - Minimum consecutive days in extreme zone
   */
  async isExtreme(
    threshold: number = 25,
    days: number = 3,
  ): Promise<{ extreme: boolean; direction: 'fear' | 'greed' | null; consecutive: number }> {
    const history = await this.getHistory(Math.max(days + 5, 30));

    if (history.length === 0) {
      return { extreme: false, direction: null, consecutive: 0 };
    }

    // Check consecutive days of extreme fear (below threshold)
    let fearStreak = 0;
    for (const entry of history) {
      if (entry.value <= threshold) {
        fearStreak++;
      } else {
        break;
      }
    }

    // Check consecutive days of extreme greed (above 100 - threshold)
    const greedThreshold = 100 - threshold;
    let greedStreak = 0;
    for (const entry of history) {
      if (entry.value >= greedThreshold) {
        greedStreak++;
      } else {
        break;
      }
    }

    if (fearStreak >= days) {
      return { extreme: true, direction: 'fear', consecutive: fearStreak };
    }
    if (greedStreak >= days) {
      return { extreme: true, direction: 'greed', consecutive: greedStreak };
    }

    return {
      extreme: false,
      direction: null,
      consecutive: Math.max(fearStreak, greedStreak),
    };
  }

  /** Fetch data with local file cache. */
  private async fetchWithCache(limit: number): Promise<FearGreedEntry[]> {
    // Try reading cache
    try {
      const raw = await readFile(this.cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as { ts: number; data: FearGreedEntry[] };
      if (Date.now() - cached.ts < this.cacheTTL && cached.data.length >= limit) {
        return cached.data.slice(0, limit);
      }
    } catch {
      // No cache or invalid — fetch fresh
    }

    const data = await this.fetchFromApi(Math.max(limit, 30));

    // Write cache
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf-8');
    } catch {
      // Cache write failure is non-fatal
    }

    return data.slice(0, limit);
  }

  /** Fetch from the alternative.me API. */
  private async fetchFromApi(limit: number): Promise<FearGreedEntry[]> {
    const url = `${API_URL}?limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Fear & Greed API error: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as FearGreedApiResponse;
    return json.data.map((d) => ({
      value: Number(d.value),
      classification: d.value_classification,
      timestamp: d.timestamp,
    }));
  }
}
