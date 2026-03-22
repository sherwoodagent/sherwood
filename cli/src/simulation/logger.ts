/**
 * Structured JSONL logger for the simulation orchestrator.
 *
 * Every command execution, success, failure, and phase transition is written
 * as a single JSON line to `logFile`. This lets Claude (or any tool) read
 * the file and reason about what happened, what failed, and what to retry.
 *
 * Format: one JSON object per line (JSONL / ndjson).
 *
 * Claude workflow:
 *   1. Run a phase command
 *   2. `sim logs --errors` to see what failed
 *   3. `sim diagnose` to get a machine-readable JSON summary
 *   4. Fix config or env, then `sim retry --phase <n>` to re-run only failures
 */

import fs from "node:fs";
import path from "node:path";
import type { LogEntry } from "./types.js";

export class SimLogger {
  private logFile: string;
  private currentPhase = 0;

  constructor(logFile: string) {
    this.logFile = logFile;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  setPhase(phase: number): void {
    this.currentPhase = phase;
  }

  /** Append a structured entry. */
  write(entry: Omit<LogEntry, "ts" | "phase"> & { phase?: number }): void {
    const line: LogEntry = {
      ts: Date.now(),
      phase: entry.phase ?? this.currentPhase,
      ...entry,
    };
    fs.appendFileSync(this.logFile, JSON.stringify(line) + "\n");
  }

  /** Convenience: log a successful command. */
  ok(command: string, output?: string, agentIndex?: number, durationMs?: number): void {
    this.write({ command, status: "ok", output, agentIndex, durationMs });
  }

  /** Convenience: log a failed command. */
  err(command: string, error: string, agentIndex?: number, durationMs?: number): void {
    this.write({ command, status: "error", error, agentIndex, durationMs });
    // Also print to stderr so it's visible in real-time
    const label = agentIndex !== undefined ? `[agent-${agentIndex}]` : "[sim]";
    console.error(`  ${label} ERROR: ${error.split("\n")[0]}`);
  }

  /** Convenience: log a skipped step (idempotent). */
  skip(command: string, agentIndex?: number): void {
    this.write({ command, status: "skip", agentIndex });
  }

  /** Convenience: log an informational message. */
  info(message: string, phase?: number): void {
    this.write({ command: message, status: "info", phase });
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Read all log entries from disk. */
  readAll(): LogEntry[] {
    if (!fs.existsSync(this.logFile)) return [];
    return fs
      .readFileSync(this.logFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LogEntry => e !== null);
  }

  /** Filter entries. All filters are ANDed together. */
  filter(opts: {
    status?: LogEntry["status"] | LogEntry["status"][];
    phase?: number;
    agentIndex?: number;
    last?: number;
  }): LogEntry[] {
    let entries = this.readAll();

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      entries = entries.filter((e) => statuses.includes(e.status));
    }
    if (opts.phase !== undefined) {
      entries = entries.filter((e) => e.phase === opts.phase);
    }
    if (opts.agentIndex !== undefined) {
      entries = entries.filter((e) => e.agentIndex === opts.agentIndex);
    }
    if (opts.last) {
      entries = entries.slice(-opts.last);
    }
    return entries;
  }

  /**
   * Produce a machine-readable diagnostic summary.
   *
   * Claude reads this JSON to decide what to do next:
   * - Which phase is in progress
   * - Which agents have failures and what the errors were
   * - Which agents still need work (not yet funded / no identity / etc.)
   * - Suggested next commands to run
   */
  diagnose(): DiagnosticReport {
    const all = this.readAll();
    const errors = all.filter((e) => e.status === "error");

    // Group errors by phase
    const errorsByPhase: Record<number, LogEntry[]> = {};
    for (const e of errors) {
      (errorsByPhase[e.phase] ??= []).push(e);
    }

    // Group errors by agent
    const errorsByAgent: Record<number, LogEntry[]> = {};
    for (const e of errors) {
      if (e.agentIndex !== undefined) {
        (errorsByAgent[e.agentIndex] ??= []).push(e);
      }
    }

    // Unique error patterns (first line of each error message)
    const errorPatterns = [
      ...new Set(errors.map((e) => e.error?.split("\n")[0] ?? "unknown").filter(Boolean)),
    ];

    // Most recent phase seen in logs
    const maxPhase = all.reduce((m, e) => Math.max(m, e.phase), 0);

    // Recent info messages (last 5) for context
    const recentInfo = all
      .filter((e) => e.status === "info")
      .slice(-5)
      .map((e) => e.command);

    const suggestions: string[] = [];
    if (errors.length === 0) {
      suggestions.push("No errors found. Run 'sim heartbeat --rounds 3' to continue activity.");
    } else {
      const phases = Object.keys(errorsByPhase)
        .map(Number)
        .sort((a, b) => a - b);
      for (const p of phases) {
        suggestions.push(`sim retry --phase ${p}  # re-run phase ${p} for failed agents`);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      totalEntries: all.length,
      errorCount: errors.length,
      currentPhase: maxPhase,
      errorsByPhase: Object.fromEntries(
        Object.entries(errorsByPhase).map(([k, v]) => [
          k,
          v.map((e) => ({
            agentIndex: e.agentIndex,
            command: e.command,
            error: e.error?.slice(0, 300),
            ts: new Date(e.ts).toISOString(),
          })),
        ]),
      ),
      agentsWithErrors: Object.keys(errorsByAgent).map(Number),
      errorPatterns,
      recentInfo,
      suggestions,
    };
  }
}

export interface DiagnosticReport {
  generatedAt: string;
  totalEntries: number;
  errorCount: number;
  currentPhase: number;
  errorsByPhase: Record<
    string,
    Array<{
      agentIndex?: number;
      command: string;
      error?: string;
      ts: string;
    }>
  >;
  agentsWithErrors: number[];
  errorPatterns: string[];
  recentInfo: string[];
  suggestions: string[];
}
