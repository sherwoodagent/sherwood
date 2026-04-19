/**
 * Signal logger — appends every token analysis to a JSONL file for tracking.
 * Fire-and-forget: never blocks analysis, never crashes on failure.
 */

import { appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TokenAnalysis } from './index.js';
import type { ScoringWeights } from './scoring.js';
import type { JudgeVerdict } from './judge.js';
import type { CalibrationFactor, UncertaintyMetrics } from './calibration-live.js';

const SIGNAL_DIR = join(homedir(), '.sherwood', 'agent');
const SIGNAL_FILE = join(SIGNAL_DIR, 'signal-history.jsonl');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface SignalLogEntry {
  timestamp: string;
  tokenId: string;
  tokenSymbol: string;
  price: number;
  decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  score: number;
  confidence: number;
  signals: { name: string; value: number; confidence: number }[];
  regime: string;
  btcCorrelation: number;
  weights: { smartMoney: number; technical: number; sentiment: number; onchain: number; fundamental: number; event: number };
  // LLM judge fields (v1 — additive, ignored by older consumers)
  judgeVerdict?: "confirm" | "veto";
  judgeReasoning?: string;
  judgeConfidence?: number;
  preJudgeAction?: string;
  preJudgeScore?: number;
  judgeLatencyMs?: number;
  judgeCached?: boolean;
  // Calibration fields (v2 — regime-aware performance tracking)
  calibrationFactor?: number;
  calibrationReason?: string;
  uncertaintyLevel?: 'low' | 'medium' | 'high';
  uncertaintyScore?: number;
  sizeMultiplier?: number;
}

export interface JudgeLogData {
  verdict: JudgeVerdict;
  preJudgeAction: string;
  preJudgeScore: number;
  latencyMs: number;
  cached: boolean;
}

export interface CalibrationLogData {
  calibrationFactor: CalibrationFactor;
  uncertaintyMetrics: UncertaintyMetrics;
}

/**
 * Log a signal entry after token analysis completes.
 * Fire-and-forget — call without await. Errors are swallowed with a warning.
 */
export function logSignal(
  analysis: TokenAnalysis,
  price: number,
  weights: ScoringWeights,
  judgeData?: JudgeLogData,
  calibrationData?: CalibrationLogData,
): void {
  // Fire-and-forget — do not await
  _writeSignal(analysis, price, weights, judgeData, calibrationData).catch((err) => {
    console.error(`[signal-logger] Warning: failed to log signal: ${(err as Error).message}`);
  });
}

async function _writeSignal(
  analysis: TokenAnalysis,
  price: number,
  weights: ScoringWeights,
  judgeData?: JudgeLogData,
  calibrationData?: CalibrationLogData,
): Promise<void> {
  await mkdir(SIGNAL_DIR, { recursive: true });

  // Auto-rotate if file exceeds 10MB
  try {
    const stats = await stat(SIGNAL_FILE);
    if (stats.size > MAX_FILE_SIZE) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const rotatedName = join(SIGNAL_DIR, `signal-history-${dateStr}.jsonl`);
      await rename(SIGNAL_FILE, rotatedName);
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  const entry: SignalLogEntry = {
    timestamp: new Date().toISOString(),
    tokenId: analysis.token,
    tokenSymbol: analysis.token.toUpperCase().slice(0, 6),
    price,
    decision: analysis.decision.action,
    score: analysis.decision.score,
    confidence: analysis.decision.confidence,
    signals: analysis.decision.signals.map((s) => ({
      name: s.name,
      value: s.value,
      confidence: s.confidence,
    })),
    regime: analysis.regime?.regime ?? 'unknown',
    btcCorrelation: analysis.correlation?.btcScore ?? 0,
    weights: {
      smartMoney: weights.smartMoney,
      technical: weights.technical,
      sentiment: weights.sentiment,
      onchain: weights.onchain,
      fundamental: weights.fundamental,
      event: weights.event,
    },
    // Judge fields (additive — omitted when judge is off)
    ...(judgeData ? {
      judgeVerdict: judgeData.verdict.verdict,
      judgeReasoning: judgeData.verdict.reasoning,
      judgeConfidence: judgeData.verdict.confidence,
      preJudgeAction: judgeData.preJudgeAction,
      preJudgeScore: judgeData.preJudgeScore,
      judgeLatencyMs: judgeData.latencyMs,
      judgeCached: judgeData.cached,
    } : {}),
    // Calibration fields (additive — omitted when calibration is off)
    ...(calibrationData ? {
      calibrationFactor: calibrationData.calibrationFactor.factor,
      calibrationReason: calibrationData.calibrationFactor.reason,
      uncertaintyLevel: calibrationData.uncertaintyMetrics.level,
      uncertaintyScore: calibrationData.uncertaintyMetrics.scoreDispersion +
                      calibrationData.uncertaintyMetrics.recentVolatility,
      sizeMultiplier: calibrationData.uncertaintyMetrics.sizeMultiplier,
    } : {}),
  };

  const line = JSON.stringify(entry) + '\n';
  await appendFile(SIGNAL_FILE, line, 'utf-8');
}

/** Get the path to the signal history file. */
export function getSignalFilePath(): string {
  return SIGNAL_FILE;
}

/** Get the signal directory path. */
export function getSignalDir(): string {
  return SIGNAL_DIR;
}
