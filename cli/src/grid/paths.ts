import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_GRID_STATE_DIR = join(homedir(), '.sherwood', 'grid');

/**
 * Resolve the grid state directory, with optional caller override.
 * Relative paths are resolved against the current working directory at the
 * moment of resolution — important for systemd / cron jobs that may set their
 * own CWD. Empty/whitespace overrides fall back to the default.
 *
 * Note: scope is intentionally narrow — only runtime mutable state
 * (`portfolio.json`, `hedge.json`, `cycles.jsonl`, `onchain-state.json`).
 * Backtest cache, sweep results, and historical-data downloads continue to
 * use `~/.sherwood/grid/` because they are not per-loop state.
 */
export function gridStateDir(override?: string): string {
  if (!override || override.trim().length === 0) return DEFAULT_GRID_STATE_DIR;
  return resolve(override);
}

export function gridStatePath(file: string, override?: string): string {
  return join(gridStateDir(override), file);
}
