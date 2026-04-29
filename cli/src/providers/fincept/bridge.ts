/**
 * Generic Python subprocess bridge for Fincept scripts.
 *
 * Calls vendored Python scripts in cli/scripts/fincept/ as one-shot
 * subprocesses, parses their JSON stdout, and returns typed results.
 */

import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the fincept scripts directory. Works both in source mode
 * (cli/src/providers/fincept/ → ../../.. → cli/scripts/fincept) and
 * bundled mode (cli/dist/ → .. → cli/scripts/fincept).
 */
function resolveScriptsDir(): string {
  // Try source layout first: cli/src/providers/fincept/ → cli/scripts/fincept
  const fromSource = join(__dirname, "..", "..", "..", "scripts", "fincept");
  if (existsSync(fromSource)) return fromSource;
  // Bundled layout: cli/dist/ → cli/scripts/fincept
  const fromDist = join(__dirname, "..", "scripts", "fincept");
  if (existsSync(fromDist)) return fromDist;
  // Fallback: relative to cwd (typically repo root or cli/)
  const fromCwd = join(process.cwd(), "scripts", "fincept");
  if (existsSync(fromCwd)) return fromCwd;
  const fromCwdCli = join(process.cwd(), "cli", "scripts", "fincept");
  if (existsSync(fromCwdCli)) return fromCwdCli;
  // Last resort
  return fromSource;
}

/** Absolute path to the vendored fincept scripts directory. */
export const FINCEPT_SCRIPTS_DIR = resolveScriptsDir();

export interface BridgeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  ts: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

/** Clear the in-memory bridge cache (useful in tests). */
export function clearFinceptCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Core bridge function
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Run a Fincept Python script and return its parsed JSON output.
 *
 * @param script   - Filename of the script inside FINCEPT_SCRIPTS_DIR (e.g. "blockchain_com_data.py")
 * @param args     - CLI arguments to pass after the script path
 * @param timeoutMs  - Subprocess timeout in milliseconds (default 30 s)
 * @param cacheTtlMs - How long to cache results in memory (0 = no cache)
 */
export async function callFincept<T = unknown>(
  script: string,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cacheTtlMs: number = 0,
): Promise<BridgeResult<T>> {
  const cacheKey = `${script}:${args.join(":")}`;

  // Check cache
  if (cacheTtlMs > 0) {
    const entry = cache.get(cacheKey);
    if (entry && Date.now() - entry.ts < cacheTtlMs) {
      return { ok: true, data: entry.data as T, latencyMs: 0 };
    }
  }

  // Validate script name — prevent path traversal
  if (script.includes('/') || script.includes('\\') || !script.endsWith('.py')) {
    return { ok: false, error: `Invalid script name: ${script}`, latencyMs: 0 };
  }
  const scriptPath = join(FINCEPT_SCRIPTS_DIR, script);
  const t0 = Date.now();

  return new Promise<BridgeResult<T>>((resolve) => {
    execFile(
      "python3",
      [scriptPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: process.env,
      },
      (error, stdout, _stderr) => {
        const latencyMs = Date.now() - t0;

        // Subprocess was killed (timeout)
        if (error && "killed" in error && error.killed) {
          resolve({
            ok: false,
            error: `Script "${script}" timed out after ${timeoutMs}ms`,
            latencyMs,
          });
          return;
        }

        // Non-zero exit or other spawn error
        if (error) {
          resolve({
            ok: false,
            error: `Script "${script}" failed: ${error.message}`,
            latencyMs,
          });
          return;
        }

        // Empty stdout
        const raw = stdout.trim();
        if (!raw) {
          resolve({
            ok: false,
            error: `Script "${script}" returned empty output`,
            latencyMs,
          });
          return;
        }

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          resolve({
            ok: false,
            error: `Script "${script}" returned invalid JSON: ${raw.slice(0, 200)}`,
            latencyMs,
          });
          return;
        }

        // Check for error field in response
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "error" in parsed &&
          typeof (parsed as Record<string, unknown>).error === "string"
        ) {
          resolve({
            ok: false,
            error: (parsed as Record<string, string>).error,
            latencyMs,
          });
          return;
        }

        // Success — cache if requested
        if (cacheTtlMs > 0) {
          cache.set(cacheKey, { ts: Date.now(), data: parsed });
        }

        resolve({ ok: true, data: parsed as T, latencyMs });
      },
    );
  });
}
