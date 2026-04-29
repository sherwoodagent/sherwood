/**
 * Signal activity audit — reads signal-history.jsonl and reports which
 * signal categories are actually firing, so dead weights can be pruned.
 *
 * A signal that contributes ~0 on every run isn't "neutral information" —
 * it's noise that compresses the aggregate score. Drop it from the weight
 * vector and renormalize so real signals aren't diluted.
 */

import { readFile } from "node:fs/promises";
import { getSignalFilePath } from "./signal-logger.js";
import type { SignalLogEntry } from "./signal-logger.js";

const FIRE_EPSILON = 0.05; // |value| below this counts as "silent"

/** Category each strategy signal maps to (mirrors scoring.ts SIGNAL_CATEGORY_MAP). */
const SIGNAL_TO_CATEGORY: Record<string, string> = {
  // Direct categories
  technical: "technical",
  sentiment: "sentiment",
  onchain: "onchain",
  fundamental: "fundamental",
  event: "event",
  smartMoney: "smartMoney",

  // Active strategy signals
  breakoutOnChain: "technical",
  multiTimeframe: "technical",
  crossSectionalMomentum: "technical",
  tradingviewSignal: "technical",
  btcNetworkHealth: "technical",
  kronosVolForecast: "technical",
  dexFlow: "onchain",
  fundingRate: "onchain",
  hyperliquidFlow: "onchain",
  narrativeVacuum: "onchain",
  sentimentContrarian: "sentiment",
  socialVolume: "sentiment",
  predictionMarket: "event",
  whaleIntent: "smartMoney",
  flowIntelligence: "smartMoney",
};

export interface SignalStats {
  name: string;
  category: string;
  observations: number;
  fireRate: number; // fraction of observations where |value| > epsilon
  meanAbsValue: number; // average |value|
  meanConfidence: number;
  directionalBias: number; // mean(value) — negative = mostly bearish, positive = bullish
}

export interface CategoryStats {
  category: string;
  signalNames: string[];
  observations: number; // total signal-observations (multiple signals per category possible)
  fireRate: number;
  meanAbsValue: number;
  recommendation: "keep" | "drop" | "review";
}

export interface AuditResult {
  filePath: string;
  totalEntries: number;
  dateRange: { from: string; to: string } | null;
  perSignal: SignalStats[];
  perCategory: CategoryStats[];
}

/**
 * Read the signal-history JSONL file and compute per-signal + per-category
 * activity statistics.
 */
export async function auditSignalHistory(
  filePath: string = getSignalFilePath(),
): Promise<AuditResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        filePath,
        totalEntries: 0,
        dateRange: null,
        perSignal: [],
        perCategory: [],
      };
    }
    throw err;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: SignalLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SignalLogEntry);
    } catch {
      // skip malformed lines
    }
  }

  if (entries.length === 0) {
    return {
      filePath,
      totalEntries: 0,
      dateRange: null,
      perSignal: [],
      perCategory: [],
    };
  }

  // Per-signal aggregation
  const bySignal = new Map<
    string,
    { values: number[]; confidences: number[] }
  >();

  for (const entry of entries) {
    for (const sig of entry.signals) {
      if (!bySignal.has(sig.name)) {
        bySignal.set(sig.name, { values: [], confidences: [] });
      }
      const bucket = bySignal.get(sig.name)!;
      bucket.values.push(sig.value);
      bucket.confidences.push(sig.confidence);
    }
  }

  const perSignal: SignalStats[] = [];
  for (const [name, bucket] of bySignal) {
    const obs = bucket.values.length;
    const fires = bucket.values.filter((v) => Math.abs(v) > FIRE_EPSILON).length;
    const meanAbsValue =
      bucket.values.reduce((a, v) => a + Math.abs(v), 0) / obs;
    const meanConfidence =
      bucket.confidences.reduce((a, c) => a + c, 0) / obs;
    const directionalBias = bucket.values.reduce((a, v) => a + v, 0) / obs;

    perSignal.push({
      name,
      category: SIGNAL_TO_CATEGORY[name] ?? "unknown",
      observations: obs,
      fireRate: fires / obs,
      meanAbsValue,
      meanConfidence,
      directionalBias,
    });
  }

  perSignal.sort((a, b) => b.fireRate - a.fireRate);

  // Per-category aggregation
  const byCategory = new Map<
    string,
    { signals: Set<string>; obs: number; fires: number; absSum: number }
  >();

  for (const sig of perSignal) {
    if (!byCategory.has(sig.category)) {
      byCategory.set(sig.category, {
        signals: new Set(),
        obs: 0,
        fires: 0,
        absSum: 0,
      });
    }
    const bucket = byCategory.get(sig.category)!;
    bucket.signals.add(sig.name);
    bucket.obs += sig.observations;
    bucket.fires += sig.fireRate * sig.observations;
    bucket.absSum += sig.meanAbsValue * sig.observations;
  }

  const perCategory: CategoryStats[] = [];
  for (const [category, bucket] of byCategory) {
    const fireRate = bucket.obs > 0 ? bucket.fires / bucket.obs : 0;
    const meanAbsValue = bucket.obs > 0 ? bucket.absSum / bucket.obs : 0;

    let recommendation: "keep" | "drop" | "review";
    if (fireRate >= 0.4) recommendation = "keep";
    else if (fireRate < 0.1) recommendation = "drop";
    else recommendation = "review";

    perCategory.push({
      category,
      signalNames: [...bucket.signals],
      observations: bucket.obs,
      fireRate,
      meanAbsValue,
      recommendation,
    });
  }

  perCategory.sort((a, b) => b.fireRate - a.fireRate);

  const timestamps = entries.map((e) => e.timestamp).sort();

  return {
    filePath,
    totalEntries: entries.length,
    dateRange: {
      from: timestamps[0]!,
      to: timestamps[timestamps.length - 1]!,
    },
    perSignal,
    perCategory,
  };
}

// ── Diff against a saved baseline ──

export interface SignalDiffEntry {
  name: string;
  category: string;
  baseline: { fireRate: number; meanAbsValue: number; observations: number };
  current: { fireRate: number; meanAbsValue: number; observations: number };
  fireRateDelta: number;
  meanAbsValueDelta: number;
  status: "improved" | "regressed" | "stable" | "new" | "removed";
}

export interface AuditDiff {
  baselineDateRange: { from: string; to: string } | null;
  currentDateRange: { from: string; to: string } | null;
  perSignal: SignalDiffEntry[];
  perCategory: SignalDiffEntry[];
}

const DELTA_EPSILON = 0.05; // fire-rate deltas under 5pp are "stable"

function classifyStatus(
  baselineRate: number | null,
  currentRate: number | null,
): SignalDiffEntry["status"] {
  if (baselineRate === null) return "new";
  if (currentRate === null) return "removed";
  const delta = currentRate - baselineRate;
  if (Math.abs(delta) < DELTA_EPSILON) return "stable";
  return delta > 0 ? "improved" : "regressed";
}

/** Compare a current audit result against a saved baseline. */
export function diffAudits(baseline: AuditResult, current: AuditResult): AuditDiff {
  const baseSignals = new Map(baseline.perSignal.map((s) => [s.name, s]));
  const currSignals = new Map(current.perSignal.map((s) => [s.name, s]));
  const allSignalNames = new Set([...baseSignals.keys(), ...currSignals.keys()]);

  const perSignal: SignalDiffEntry[] = [];
  for (const name of allSignalNames) {
    const b = baseSignals.get(name);
    const c = currSignals.get(name);
    perSignal.push({
      name,
      category: (c ?? b)?.category ?? "unknown",
      baseline: {
        fireRate: b?.fireRate ?? 0,
        meanAbsValue: b?.meanAbsValue ?? 0,
        observations: b?.observations ?? 0,
      },
      current: {
        fireRate: c?.fireRate ?? 0,
        meanAbsValue: c?.meanAbsValue ?? 0,
        observations: c?.observations ?? 0,
      },
      fireRateDelta: (c?.fireRate ?? 0) - (b?.fireRate ?? 0),
      meanAbsValueDelta: (c?.meanAbsValue ?? 0) - (b?.meanAbsValue ?? 0),
      status: classifyStatus(b?.fireRate ?? null, c?.fireRate ?? null),
    });
  }
  perSignal.sort((a, b) => Math.abs(b.fireRateDelta) - Math.abs(a.fireRateDelta));

  const baseCats = new Map(baseline.perCategory.map((c) => [c.category, c]));
  const currCats = new Map(current.perCategory.map((c) => [c.category, c]));
  const allCats = new Set([...baseCats.keys(), ...currCats.keys()]);

  const perCategory: SignalDiffEntry[] = [];
  for (const cat of allCats) {
    const b = baseCats.get(cat);
    const c = currCats.get(cat);
    perCategory.push({
      name: cat,
      category: cat,
      baseline: {
        fireRate: b?.fireRate ?? 0,
        meanAbsValue: b?.meanAbsValue ?? 0,
        observations: b?.observations ?? 0,
      },
      current: {
        fireRate: c?.fireRate ?? 0,
        meanAbsValue: c?.meanAbsValue ?? 0,
        observations: c?.observations ?? 0,
      },
      fireRateDelta: (c?.fireRate ?? 0) - (b?.fireRate ?? 0),
      meanAbsValueDelta: (c?.meanAbsValue ?? 0) - (b?.meanAbsValue ?? 0),
      status: classifyStatus(b?.fireRate ?? null, c?.fireRate ?? null),
    });
  }
  perCategory.sort((a, b) => Math.abs(b.fireRateDelta) - Math.abs(a.fireRateDelta));

  return {
    baselineDateRange: baseline.dateRange,
    currentDateRange: current.dateRange,
    perSignal,
    perCategory,
  };
}

/** Renormalize weights after dropping categories with fireRate below threshold. */
export function suggestRenormalizedWeights(
  currentWeights: Record<string, number>,
  perCategory: CategoryStats[],
  dropThreshold: number = 0.1,
): Record<string, number> {
  const keepCategories = new Set(
    perCategory
      .filter((c) => c.fireRate >= dropThreshold && c.category !== "unknown")
      .map((c) => c.category),
  );

  // Sum retained weight
  let retainedSum = 0;
  for (const [cat, w] of Object.entries(currentWeights)) {
    if (keepCategories.has(cat)) retainedSum += w;
  }

  if (retainedSum === 0) return currentWeights; // nothing to renormalize

  const out: Record<string, number> = {};
  for (const [cat, w] of Object.entries(currentWeights)) {
    out[cat] = keepCategories.has(cat) ? w / retainedSum : 0;
  }
  return out;
}
