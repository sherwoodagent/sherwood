import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_GRID_STATE_DIR = join(homedir(), '.sherwood', 'grid');

export function gridStateDir(override?: string): string {
  return override && override.length > 0 ? override : DEFAULT_GRID_STATE_DIR;
}

export function gridStatePath(file: string, override?: string): string {
  return join(gridStateDir(override), file);
}
