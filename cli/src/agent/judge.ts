/**
 * LLM Judge — confirm or veto borderline trade decisions using Claude.
 *
 * V1 scope: confirm + veto only. No score overrides, no direction flips.
 * Fallback is always pass-through — judge can never block a cycle.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { chatCompletion } from "../lib/venice.js";
import { getVeniceApiKey } from "../lib/config.js";
import type { TradeDecision } from "./scoring.js";
import type { TechnicalSignals } from "./technical.js";
import type { PortfolioState } from "./risk.js";

// ── Types ──

export interface JudgeVerdict {
  verdict: "confirm" | "veto";
  reasoning: string;
  risks: string[];
  confidence: number;
}

export interface JudgeConfig {
  enabled: boolean;
  model: string;
  topN: number;
  scoreBand: [number, number];
  timeoutMs: number;
  cacheTtlMs: number;
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: false,
  model: "llama-3.3-70b",
  topN: 3,
  scoreBand: [0.10, 0.50],
  timeoutMs: 8_000,
  cacheTtlMs: 900_000, // 15 min
};

/** Context provided to the judge for a single token decision. */
export interface JudgeContext {
  tokenId: string;
  currentPrice: number;
  decision: TradeDecision;
  technicalSignals?: TechnicalSignals;
  fearAndGreed?: number;
  sentimentZScore?: number;
  fundingRate?: number;
  regime?: string;
  btcRegime?: string;
  btcBias?: string;
  suppressionFactor?: number;
  portfolio: {
    openCount: number;
    cashPct: number;
    hasPositionThisToken: boolean;
    inStopCooldown: boolean;
    dailyPnlPct: number;
  };
  recentCloses?: number[];
}

// ── Fallback ──

const FALLBACK_VERDICT: JudgeVerdict = {
  verdict: "confirm",
  reasoning: "fallback",
  risks: [],
  confidence: 0,
};

// ── Cache ──

const CACHE_DIR = join(homedir(), ".sherwood", "agent", "cache");

function cacheKey(ctx: JudgeContext): string {
  const priceBucket = Math.round(ctx.currentPrice / (ctx.currentPrice * 0.005));
  const signalTuples = ctx.decision.signals
    .map((s) => `${s.name}:${Math.sign(s.value)}`)
    .sort()
    .join(",");
  const raw = `${ctx.tokenId}:${priceBucket}:${signalTuples}:${ctx.regime ?? "unknown"}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

async function readCache(key: string, ttlMs: number): Promise<JudgeVerdict | undefined> {
  try {
    const path = join(CACHE_DIR, `judge-${key}.json`);
    const data = JSON.parse(await readFile(path, "utf-8"));
    if (Date.now() - (data.cachedAt ?? 0) < ttlMs) {
      return data.verdict as JudgeVerdict;
    }
  } catch {
    // Cache miss or read error — fine
  }
  return undefined;
}

async function writeCache(key: string, verdict: JudgeVerdict): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const path = join(CACHE_DIR, `judge-${key}.json`);
    await writeFile(path, JSON.stringify({ cachedAt: Date.now(), verdict }), "utf-8");
  } catch {
    // Write failure is non-fatal
  }
}

// ── Prompt ──

const SYSTEM_PROMPT = `You are a crypto trade-decision reviewer. Your job is to confirm or veto a proposed trade entry.

Return ONLY valid JSON matching this schema:
{"verdict":"confirm"|"veto","reasoning":"<max 240 chars>","risks":["<max 80 chars each, 0-4 items>"],"confidence":<0-1>}

VETO conditions (veto if ANY apply):
- Regime contradicts direction (e.g., trending-down regime for a long entry)
- Token is in stop cooldown (recently stopped out)
- Daily portfolio loss exceeds -2% and this is a new entry
- Insufficient data quality (too many signals missing/zero)
- BTC bearish bias with high suppression for a long entry on an alt

CONFIRM otherwise. Default to confirm — only veto with clear justification.
No prose outside the JSON. No markdown fences.`;

function buildUserPrompt(ctx: JudgeContext): string {
  const d = ctx.decision;
  const topSignals = [...d.signals]
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((s) => `${s.name}=${s.value.toFixed(3)}(c=${s.confidence.toFixed(2)})`)
    .join(", ");

  const lines: string[] = [
    `Token: ${ctx.tokenId} | Price: $${ctx.currentPrice.toPrecision(4)}`,
    `Proposed: ${d.action} | Score: ${d.score.toFixed(3)} | Confidence: ${d.confidence.toFixed(2)}`,
    `Top signals: ${topSignals}`,
    `Regime: ${ctx.regime ?? "unknown"} | BTC regime: ${ctx.btcRegime ?? "unknown"}`,
    `BTC bias: ${ctx.btcBias ?? "neutral"} | Suppression: ${(ctx.suppressionFactor ?? 1).toFixed(2)}`,
  ];

  if (ctx.technicalSignals) {
    const t = ctx.technicalSignals;
    lines.push(`RSI: ${isNaN(t.rsi) ? "N/A" : t.rsi.toFixed(1)} | MACD hist: ${isNaN(t.macd.histogram) ? "N/A" : t.macd.histogram.toFixed(4)} | ATR: ${isNaN(t.atr) ? "N/A" : t.atr.toFixed(4)}`);
  }

  if (ctx.fearAndGreed !== undefined) {
    lines.push(`F&G: ${ctx.fearAndGreed}${ctx.sentimentZScore !== undefined ? ` (z=${ctx.sentimentZScore.toFixed(2)})` : ""}`);
  }

  if (ctx.fundingRate !== undefined) {
    lines.push(`Funding rate (8h): ${(ctx.fundingRate * 100).toFixed(4)}%`);
  }

  const p = ctx.portfolio;
  lines.push(`Portfolio: ${p.openCount} open | ${(p.cashPct * 100).toFixed(1)}% cash | dailyPnL: ${(p.dailyPnlPct * 100).toFixed(2)}%`);
  lines.push(`This token: ${p.hasPositionThisToken ? "HAS POSITION" : "no position"} | Stop cooldown: ${p.inStopCooldown ? "YES" : "no"}`);

  if (ctx.recentCloses?.length) {
    lines.push(`Recent closes (10d): ${ctx.recentCloses.map((c) => c.toPrecision(4)).join(", ")}`);
  }

  return lines.join("\n");
}

// ── Main entry point ──

/**
 * Judge a trade decision. Returns confirm/veto verdict.
 * NEVER throws — all errors return fallback confirm.
 */
export async function judge(
  ctx: JudgeContext,
  config: JudgeConfig = DEFAULT_JUDGE_CONFIG,
): Promise<{ verdict: JudgeVerdict; cached: boolean; latencyMs: number }> {
  const start = Date.now();

  try {
    // Gate: judge disabled or no Venice API key
    if (!config.enabled || !getVeniceApiKey()) {
      return { verdict: FALLBACK_VERDICT, cached: false, latencyMs: 0 };
    }

    // Gate: only judge non-HOLD actions in the score band
    const absScore = Math.abs(ctx.decision.score);
    if (ctx.decision.action === "HOLD" || absScore < config.scoreBand[0] || absScore > config.scoreBand[1]) {
      return { verdict: FALLBACK_VERDICT, cached: false, latencyMs: 0 };
    }

    // Check cache
    const key = cacheKey(ctx);
    const cached = await readCache(key, config.cacheTtlMs);
    if (cached) {
      return { verdict: cached, cached: true, latencyMs: Date.now() - start };
    }

    // Call Venice (OpenAI-compatible chat completions)
    const result = await Promise.race([
      chatCompletion({
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(ctx) },
        ],
        maxTokens: 400,
        temperature: 0.1,
        disableThinking: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Judge timeout")), config.timeoutMs),
      ),
    ]);

    // Parse response
    const parsed = parseVerdict(result.content);
    await writeCache(key, parsed);

    return { verdict: parsed, cached: false, latencyMs: Date.now() - start };
  } catch (err) {
    console.error(chalk.dim(`  [judge] Error: ${(err as Error).message} — falling back to confirm`));
    return { verdict: FALLBACK_VERDICT, cached: false, latencyMs: Date.now() - start };
  }
}

/**
 * Determine which tokens should be judged (budget gate).
 * Returns token IDs sorted by |score| descending, capped at topN.
 */
export function selectJudgeCandidates(
  results: Array<{ token: string; score: number; action: string }>,
  config: JudgeConfig,
): Set<string> {
  const candidates = results
    .filter((r) => {
      if (r.action === "HOLD") return false;
      const abs = Math.abs(r.score);
      // Upper bound is exclusive to match `judge()` gate at line 192
      // (`absScore > config.scoreBand[1]` rejects). Inclusive here would
      // pick a candidate that `judge()` then rejects → fallback confirm.
      return abs >= config.scoreBand[0] && abs < config.scoreBand[1];
    })
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, config.topN);

  return new Set(candidates.map((c) => c.token));
}

// ── Parsing ──

function parseVerdict(raw: string): JudgeVerdict {
  // Strip markdown fences if model wraps in ```json
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const obj = JSON.parse(cleaned);

  // Validate required fields
  if (obj.verdict !== "confirm" && obj.verdict !== "veto") {
    throw new Error(`Invalid verdict: ${obj.verdict}`);
  }

  return {
    verdict: obj.verdict,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 240) : "",
    risks: Array.isArray(obj.risks) ? obj.risks.slice(0, 4).map((r: unknown) => String(r).slice(0, 80)) : [],
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
  };
}
