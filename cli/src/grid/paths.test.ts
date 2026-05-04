import { describe, it, expect } from 'vitest';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_GRID_STATE_DIR, gridStateDir, gridStatePath } from './paths.js';

const HOME_DEFAULT = join(homedir(), '.sherwood', 'grid');

describe('paths', () => {
  it('defaults to ~/.sherwood/grid when override is undefined', () => {
    expect(DEFAULT_GRID_STATE_DIR).toBe(HOME_DEFAULT);
    expect(gridStateDir()).toBe(HOME_DEFAULT);
    expect(gridStateDir(undefined)).toBe(HOME_DEFAULT);
  });

  it('treats empty / whitespace overrides as falsy', () => {
    expect(gridStateDir('')).toBe(HOME_DEFAULT);
    expect(gridStateDir('   ')).toBe(HOME_DEFAULT);
  });

  it('honors absolute overrides verbatim', () => {
    expect(gridStateDir('/tmp/foo')).toBe('/tmp/foo');
  });

  it('resolves relative overrides against the current CWD', () => {
    const out = gridStateDir('./relative/dir');
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(resolve('./relative/dir'));
  });

  it('joins file onto resolved state dir', () => {
    expect(gridStatePath('portfolio.json', '/tmp/foo')).toBe('/tmp/foo/portfolio.json');
    expect(gridStatePath('cycles.jsonl')).toBe(join(HOME_DEFAULT, 'cycles.jsonl'));
  });
});
